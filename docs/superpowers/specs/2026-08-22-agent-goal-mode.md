# S-GOAL — Agent 目标模式(Goal Mode)

> 日期: 2026-08-22
> 状态: Active
> Spec ID: **S-GOAL**
> 取代: [S-TASK](../archive/S-TASK/2026-08-19-agent-task-store.md)(未实施即被取代,继承其合理内核)
> 关联: [PRD §2.2 产品能力栈](../../PRD.md)(支柱 A「主动智能」的前置叙事)、S-EVOLUTION Phase C(子代理模板化改为消费 goal)、写侧三件套(成果沉淀通道,轻量 spec 待立项)

---

## 1. 背景

S-TASK 的设计前提是「计划先行」:先列步骤清单,再逐步执行勾选。但动态工作流的现实是 LLM 每一轮都在根据最新观察重新规划——预声明的 `{text, done}` 列表既不是模型真正的决策依据(它靠上下文),也不是可靠的恢复载体(task JSON 不存游标与中间产物,恢复的是计划骨架而非工作现场)。

笔记插件有一个代码仓库同构、但比 task 模式更本质的优势:**库本身就是持久状态**。「哪些笔记还没补 frontmatter」是随时可查询的事实,不需要 checklist 记账。Goal 模式据此只存意图、完成标准、进度游标;每个续跑回合由模型从库里重新推导剩余工作。

行业调研(国内外 goal 模式实现)收敛出六条共性,直接支撑本设计:

1. **Goal 三件套高度一致:意图 + 完成标准 + 预算**(AutoGPT 无界循环翻车后,所有严肃实现都有界)
2. **步骤是透明层,不是状态层**(Claude Code TodoWrite 仅会话内;Copilot coding agent 把状态外置到 issue/repo)
3. **防漂移靠上下文锚定**(Manus 的 recitation:目标复述进上下文尾部)
4. **防空转靠无进展检测 + blocked 语义**(连续无进展停下来问人,不继续烧)
5. **人在场才推进,历史只增不删**(Devin/TRAE 中途干预;Copilot/Devin 保留全部历史)
6. **定时/后台触发是后期独立能力**(Coze 定时任务等),v1 均为手动继续

最直接参照:DeepSeek Harness 自身的 goal 工具(`objective` 不可变 + `max_goal_rounds` 回合上限 + `blocked` 需具体原因 + 中断后 `resume` 重武装)。

## 2. 目标

1. 用户用自然语言立一个跨会话的持久目标;Agent 每个续跑回合从库的真实状态重新推导剩余工作并连续推进
2. 完成标准在创建时协商清楚:能结构化的用代码谓词验证,不能的由 LLM 对照证据自检
3. 长任务写入有目标级授权(创建时授予、随时可撤),避免逐笔确认毁掉体验
4. 成本透明:目标级用量统计,goal 卡可见该目标花了多少
5. 防漂移防空转:复述锚定 + 无进展守卫 + 三层预算

## 3. 非目标

- 不做定时/后台自动续跑——Heartbeat 触发器留给支柱 A(行业共识:v1 手动继续)
- 不做多目标并行执行(active 全局唯一,严格串行)
- 不做目标依赖图(DAG)
- 不做跨设备同步
- 不静默删除任何目标记录——归档必须用户确认
- 不做目标模板/周期性目标(归支柱 A)

---

## 4. 详细设计

### 4.1 数据模型与落盘

```typescript
interface AgentGoal {
	version: 1;
	id: string;               // 短 id,文件名即 <id>.json
	objective: string;        // 与用户协商确认后的意图陈述
	completionCriteria: {
		text: string;          // 可检验的标准陈述(创建时谈清,含糊不许建)
		predicate?: GoalPredicate; // 能结构化时的代码谓词(可选)
	};
	progressNote: string;     // 上一轮进度游标(如「已处理 A–K」),模型维护
	status: 'pending' | 'active' | 'paused' | 'blocked' | 'completed' | 'cancelled';
	blockedReason?: string;
	roundsDone: number;
	maxRounds: number;        // 默认 10,创建时可改
	usage: { inputTokens: number; outputTokens: number }; // 目标级累计(接 usage-stats)
	grant: string[] | null;   // 目标级授权的 vault 内路径 glob;撤销即置 null
	birthSessionId: string;   // 仅溯源,session 删除不删 goal
	createdAt: string;
	updatedAt: string;
}
```

- 落盘 `.obsidian/plugins/ratel-vault/goals/<id>.json`,原子写,损坏即弃不崩溃(与索引清单同思路)
- 归档目录 `goals/archive/`(用户确认后移入,退出队列与扫描范围)

### 4.2 状态机与单活约束

| 状态 | 含义 |
|---|---|
| `pending` | 排队中,等待激活 |
| `active` | 正在推进,**全局至多一个**,store 层激活前检查、拒绝双活 |
| `paused` | 用户主动挂起(grant 同时失效) |
| `blocked` | 受阻,附原因等用户处理;不占 active 坑 |
| `completed` / `cancelled` | 终态,永不自动删除 |

### 4.3 创建协商流程

两个入口殊途同归:Agent 从对话识别批量意图主动提议,或用户显式说「立个目标」。

```
→ 协商卡:目标陈述 / 范围 / 完成标准 / 回合预算 / 授权范围,全部可改
→ 完成标准含糊(如「整理干净点」)Agent 必须追问细化,不许带糊创建
→ 若评估超出预算(如「整理整个 vault」)必须建议拆成多个 pending goals 入队
→ 已有 active 时明示「将排队执行」,用户可选「先挂起当前的再激活新的」
→ 确认落盘(pending 或 active)
```

`GoalPredicate` v0 收敛两类,其余降级 LLM 自检:

- frontmatter 断言:`{ kind: 'frontmatter-all', pathGlob, property }` — glob 匹配文件全部含指定属性
- 存在性断言:`{ kind: 'path-covered', pathGlob }` — 匹配集合达到目标(配合 progressNote 游标)

### 4.4 续跑协议(核心循环)

```
触发:onload 状态条提示「N 个进行中目标」/ 对话里说「继续」
排队仲裁:无 active 但有 pending → 模型按意图建议先做哪个,用户点头才激活(模型建议,用户落锤)
回合开始:
  注入 objective + completionCriteria + progressNote 到上下文末尾(复述锚定)
  → 扫库重推导剩余工作 → work-bar 渲染本轮动态步骤(transient,不入库)
  → 连续执行(命中 grant 的写入免逐笔确认)
回合结束:
  更新 progressNote + roundsDone + usage → 跑完成校验
  → completed(附证据)/ blocked(附原因)/ 预算尽(问加轮还是收尾)/ 用户打断
```

- 回合之间不弹确认——授权创建时已给,状态条常驻可见、随时可停
- onload 提示保留 S-TASK 遗产:「昨天的目标还差一点,继续吗?」

### 4.5 防御机制

| # | 机制 | 设计 |
|---|---|---|
| 1 | 复述锚定(抄 Manus recitation) | 回合开始把 goal 三要素注入上下文末尾;回合内每 N 次工具调用追加一行轻量提醒,防长回合漂移 |
| 2 | 无进展守卫 | 连续两个回合 progressNote 无实质变化(文本相似度判断)→ 强制 blocked,附两轮进度对比请用户裁决。对 AutoGPT 空转翻车的直接防御 |
| 3 | 三层预算 | `maxRounds`(默认 10)+ 单回合 LLM 用量软上限 + 目标级累计统计(goal 卡展示)。用量接入现有 usage-stats |

### 4.6 权限模型

- 目标级授权 = 协商卡的一部分:`grant` 记 vault 内路径 glob;回合内命中 grant 的写入跳过逐笔 ToolPermission
- 越出 grant 的写入照走现有权限流;`ratel-vault` 自身目录与 configDir 维持禁区不变(物理校验不动摇)
- 状态条一键暂停/撤权:`paused` + grant 失效,后续写入恢复逐笔确认

### 4.7 打断与干预

执行中用户发消息 → 当前批次在最近的原子写入完成后停下(已完成单步不回滚),落盘 progressNote 后再停(关键路径:先存进度再停),goal 保持 `active`,work-bar 显示「已暂停,等待你的输入」。对齐 Devin/TRAE 的中途干预体验。

### 4.8 完成验证与成果沉淀

- `predicate` 存在 → 代码校验,结果可信度最高;否则 LLM 对照当前库状态自检,完成汇报必须列证据清单
- blocked 只用于「无法推进」(缺密钥、重复失败);校验未通过但还能推进不算 blocked,继续下一轮
- 完成时可衔接写侧 `append_to_daily`(同版本交付):「要把成果总结写进今日日记吗?」——兑现 S-TASK D3「成果与载体分离」的初衷

### 4.9 GC 与归档

- 终态目标永不自动删除;超 7 天(阈值可调)进入「待归档」提示(状态条轻提示或设置页列出)
- 用户确认后才移入 `goals/archive/`;取消原 S-TASK「总数上限 50 兜底淘汰」的设计
- 待归档堆积时提高提示显著度,不偷跑删除

### 4.10 工具面(单工具多 action)

`manage_goal`,降低模型选择成本:

| action | 默认权限 | 说明 |
|---|---|---|
| create | ask | 协商卡即确认流 |
| update(progress) | allow | 进度游标/用量回写 |
| list | allow | 队列查询 |
| pause | allow | 安全方向,随时可停 |
| resume | ask | 激活 = 开跑授权,「人在场落锤」点(含 pending→active、blocked→重启) |
| cancel | ask | 终态变更需确认 |
| complete | 条件 | predicate 校验通过 allow;LLM 自检通过 ask |

### 4.11 UI 与 i18n

- 四处 UI:chat 协商卡与进度卡、状态条 chip(active 数量 + 执行指示 + 停止按钮)、work-bar 本轮动态步骤、goal 用量显示
- 全部字符串走 `src/i18n/zh.ts` / `en.ts`,新增 goal namespace;工具显示名友好化(如「推进目标:补全 frontmatter」)

---

## 5. 影响面

| 区域 | 变更 |
|---|---|
| `src/core/goal-store.ts`(新) | CRUD、原子落盘、单活仲裁、队列扫描、归档移动 |
| `src/core/goal-runner.ts`(新) | 续跑回合编排:注入构建、复述锚定提醒、无进展守卫、预算检查 |
| `src/tools/manage-goal.ts`(新) | 单工具多 action |
| `src/core/tool-permissions.ts` | grant 评估钩子(命中免确认) |
| `src/core/agent-loop.ts` | 打断语义接入、提醒行注入点 |
| `src/ui/status/` `src/ui/chat/` | chip、卡片、work-bar 复用 |
| `src/core/usage-stats.ts` | 按 goal 维度聚合 |
| `onload` | 扫描 goals/ → 状态条提示 |
| `src/i18n/` | 新 namespace |
| 测试 | vitest:单活仲裁 / 无进展守卫 / predicate 校验 / manage_goal 权限矩阵 / 打断落盘顺序 |
| 文档 | user-guide / CHANGELOG / README 在 finishing-a-development-branch 阶段按规则评估 |

下游:Phase C 子代理模板化改为领 goal + 回合预算;Heartbeat(支柱 A)未来成为续跑触发器之一。

## 6. 设计决策记录

| # | 决策 | 理由 |
|---|---|---|
| D1 | 全局单活 + pending 队列 | 消息/写入归属永远清晰(S-TASK D1 的防混理由);模型建议、用户落锤 |
| D2 | 步骤不持久化 | 行业共识:步骤是透明层;库本身是持久状态,每轮重定向 |
| D3 | 续跑需人在场 | Obsidian 插件无后台生命周期;每次激活都是显式确认点,安全优势 |
| D4 | 归档需确认,永不静默删 | 「改了就能查」的一贯姿态;Copilot/Devin 均保留历史 |
| D5 | 无进展守卫强制 blocked | AutoGPT 教训:空转烧钱是 goal 模式第一死因 |
| D6 | 复述锚定注入上下文尾部 | Manus recitation:最近位置对抗长回合漂移 |

## 7. 参考

- DeepSeek Harness goal 工具(`objective` / `max_goal_rounds` / `blocked` / `resume`)——生产级最小面参照
- Manus《Context Engineering for AI Agents》——recitation 与 todo.md 上下文锚
- GitHub Copilot coding agent——issue 即 goal、repo 即状态的外置范式
- Devin / TRAE SOLO / Qoder Quest——中途干预、里程碑放行、先协商规格再动手
- Claude Code TodoWrite——会话内透明层的价值边界
- AutoGPT / BabyAGI——无界循环的反面教材
- [S-TASK(归档)](../archive/S-TASK/2026-08-19-agent-task-store.md)——被取代的原设计与继承说明
- ⚠️ 待核验(不影响决策):Qoder Quest checkpoint 细节、扣子空间定时任务耦合度、Manus recitation 准确表述
