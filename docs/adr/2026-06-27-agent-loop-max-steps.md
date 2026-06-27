# ADR-004:Agent Loop 步数上限与截断处理策略

**状态**:Accepted
**日期**:2026-06-27

---

## Context(背景)

用户反馈"模型跑到一半停了"——StatusLine 显示"就绪"但模型回复不完整,无任何提示。

经四阶段根因排查(systematic-debugging),确认三个叠加根因:

1. **MAX_STEPS = 10 硬编码过低** — 知识库场景工具调用密集(1 次 glob + 9 次 read_note = 10 步),循环条件 `step < 10` 失败后直接退出,模型没有机会产出最终回答,且退出时无任何用户提示。
2. **不支持并行工具调用** — `let toolCall: ToolCall | null = null` 只保留最后一个 toolCall,一轮内 LLM 返回多个工具调用时前面的全部丢失。
3. **未检测 `finish_reason: 'length'`** — 当模型输出被 max_tokens 截断时,适配器和 agent-loop 都没有识别,半截文本直接当作"完成"入库。

### 业界调研

| 框架 | MAX_STEPS / 迭代上限 | 性质 |
|------|----------------------|------|
| LangChain AgentExecutor | 15 | 通用 Agent,配套 `early_stopping_method` |
| Trae Agent | 20 | Coding Agent |
| AutoGPT | 50(`--max-iterations`) | 自主长任务 |
| Claude Code | 可配 `max_turns` | Coding Agent,终止原因表里有明确 `max_turns` 项 |

规律:**通用对话 Agent 偏低(15),Coding/自主 Agent 偏高(20–50),纯自主长任务最高(50+)**。

### Claude Code 的截断恢复机制(长期参照)

Claude Code 对 `finish_reason: 'length'`(输出截断)采用三级阶梯式自愈:

1. **第 1 级:升级 max_output_tokens 上限** → 原样重试(几乎零成本,不改上下文)
2. **第 2 级:注入续写元消息** → 模型从断点继续(提示词专门要求:不道歉、不复述、直接续写、拆小块)
3. **终止**:可恢复策略全部用完 → 明确告知用户

另有"单次尝试守卫",防止"压缩失败→重试→再失败"的死亡螺旋。

---

## Decision(决策)

**短期:MAX_STEPS 默认值 50,通过 settings 可配置。**

**长期(参照 Claude Code):实现截断自动续传 + 步数耗尽自动生成最终答案。**

### 短期落地(本次实施)

1. **MAX_STEPS 从硬编码常量改为可配置参数**:
   - `RatelVaultSettings` 新增 `agentMaxSteps: number`,默认 `50`
   - `agentLoop()` 函数签名新增 `maxSteps?: number` 参数,未传时降级 50(向后兼容)
   - 设置面板「开发者」区域添加滑块(范围 5–200,步长 5)

2. **步数耗尽时不静默退出**:
   - 追加 ⚠️ 提示文本到 assistant 消息
   - yield `error` 事件告知 UI
   - 用 `loopExitedViaBreak` 标志区分"正常 break 退出"和"步数耗尽退出",避免取消/错误场景误报

3. **`finish_reason: 'length'` 检测**:
   - 适配器层解析 `finish_reason` 并通过 `ChatDelta.finishReason` 传递
   - agent-loop 检测到 `length` 时追加截断提示,若无工具调用则 yield error + break

4. **支持一轮多工具调用**:
   - `toolCalls: ToolCall[]` 数组收集所有 toolCall delta
   - 逐个执行,结果逐条入库

### 选 50 的理由

- 知识库场景工具调用密集:读 30+ 文件做分析一般需要 15-30 步(1 glob/list + N read + 分析 + write),50 步足够覆盖
- 与 AutoGPT(50)持平,高于 LangChain(15)和 Trae(20),符合"知识库管理 = 中等复杂度自主任务"的定位
- 仍然能防止无限循环

### 长期目标(不在本次实施)

参照 Claude Code 机制,优先级排序:

1. **步数耗尽时自动生成最终答案**(LangChain `early_stopping_method: "generate"` 模式):
   - 步数耗尽后,再调一次 LLM(不带工具),让它基于已有工具结果产出总结
   - 解决"跑到一半停了"的核心痛点,无需用户手动发"继续"

2. **截断自动续传**(Claude Code 第 2 级):
   - `finish_reason: 'length'` 时自动注入续写消息(防道歉/重复)让模型接着写
   - 而非等用户手动触发

3. **升级 max_output_tokens**(Claude Code 第 1 级):
   - 截断时先尝试拉高输出上限原样重试

4. **单次尝试守卫**:
   - 防止恢复策略无限重试的死亡螺旋

### 不采纳

- **MAX_STEPS = 10(原值)**:知识库场景工具调用密集,10 步频繁触发,用户反复手动"继续"
- **MAX_STEPS = 无限**:安全风险,API 账单失控(已有真实事故:Claude Code 跑通宵 $400 账单)
- **当前实现截断自动续传**:短期优先保证"不静默退出",自动续传涉及续写提示词工程与上下文管理,需独立 spec
- **真正并行工具执行**:知识库场景工具多为读操作,串行够用;写操作串行反而更安全

---

## Consequences(后果)

**正面**:

- 用户不再遇到"跑到一半静默停止"——步数耗尽和 token 截断都有明确提示
- MAX_STEPS 可配置,高级用户可根据 vault 规模调整
- 支持并行工具调用,不再丢失一轮内的多个 toolCall

**负面**:

- MAX_STEPS=50 比 10 更宽容,极端情况下单次对话 API 消耗增加
- 可配置意味着用户可能设过高(如 200),需靠滑块上限(200)兜底
- 截断时仍需用户手动发"继续",未实现自动续传(长期目标)

**影响面**:

- `src/settings.ts`:`RatelVaultSettings` 新增 `agentMaxSteps`,设置面板新增滑块
- `src/core/agent-loop.ts`:`MAX_STEPS` 常量改为 `maxSteps` 参数,默认 50
- `src/main.ts`:调用 `agentLoop` 时传入 `this.settings.agentMaxSteps`
- `src/ports/llm.ts`:`ChatDelta` 新增 `finishReason` 字段
- `src/adapters/llm-deepseek.ts`:解析 `finish_reason` 并传递
- `tests/core/agent-loop.test.ts`:MAX_STEPS 测试用例更新,新增自定义 maxSteps 测试

---

## 参考

- [LangChain AgentExecutor: max_iterations=15, early_stopping_method](https://juejin.cn/post/7524909129576759342)
- [Trae Agent 参数调优: max_steps 默认 20](https://blog.csdn.net/gitblog_00182/article/details/151377743)
- [AutoGPT: --max-iterations 50 作为 continuous 模式安全阀](https://blog.csdn.net/weixin_31459297/article/details/155957535)
- [Claude Code Agent Loop 全解析:状态机、终止原因、截断恢复阶梯](https://toutiao.com/group/7638853071221342771/)
- [从 Chat Completions 到 Responses:OpenAI max_output_tokens + max_tool_calls](https://juejin.cn/post/7540285101152763950)
- `src/core/agent-loop.ts`(Agent Loop 实现)
- `src/settings.ts`(配置项定义)
- `src/adapters/llm-deepseek.ts`(finish_reason 解析)
