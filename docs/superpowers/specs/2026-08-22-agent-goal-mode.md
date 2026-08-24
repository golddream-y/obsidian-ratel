# S-GOAL — Agent 目标模式(Goal Mode)

> 日期: 2026-08-22
> 修订: 2026-08-22 **v1.1** — 按外部评审修订:补 session 占用、grant 白名单、打断状态机(对齐现网 AbortSignal)、锚定 ephemeral 注入通道、预算闭环等 13 项
> 修订: 2026-08-22 **v1.2** — 4.11 五面 UI;计轮语义;停止≠暂停;软上限回合后检查
> 修订: 2026-08-22 **v1.3** — 指示器评审落地:面 1 用窗口底栏 StatusBarItem(不是 UserStatus store);文案去 emoji、停止≠挂起;继续 chip 唯一目标+输入中隐藏;create 用独立表单 Modal;撤权=设置页暂停或对话 pause
> 状态: Active
> Spec ID: **S-GOAL**
> 取代: [S-TASK](../archive/S-TASK/2026-08-19-agent-task-store.md)(未实施即被取代,继承其合理内核)
> 关联: [PRD §2.2 产品能力栈](../../PRD.md)(支柱 A「主动智能」的前置叙事)、S-EVOLUTION Phase C(子代理模板化改为消费 goal)、写侧三件套(独立轻量 spec 待立项,本 spec 不依赖)

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
4. 成本透明:目标级 token 用量统计,goal 卡可见该目标花了多少
5. 防漂移防空转:复述锚定 + 无进展守卫 + 三层预算

## 3. 非目标

- 不做定时/后台自动续跑——Heartbeat 触发器留给支柱 A(行业共识:v1 手动继续)
- 不做多目标并行执行(active 全局唯一,严格串行)
- 不做目标依赖图(DAG)
- 不做跨设备同步
- 不静默删除任何目标记录——归档必须用户确认,损坏记录隔离不丢弃
- 不做目标模板/周期性目标(归支柱 A)
- 不依赖未立项的 `append_to_daily`——成果沉淀 v1 用现有工具对话确认完成,不被写侧拖期

---

## 4. 详细设计

### 4.1 数据模型与落盘

```typescript
interface AgentGoal {
	version: 1;
	id: string;               // 短 id,文件名即 <id>.json
	objective: string;        // 意图陈述,创建后不可变(D7)
	completionCriteria: {
		text: string;          // 可检验的标准陈述(创建时谈清,含糊不许建)
		predicate?: GoalPredicate; // 能结构化时的代码谓词(可选,v0 仅 frontmatter-all)
	};
	progressNote: string;     // 上一轮进度游标(如「已处理 A–K」),模型维护;仅辅助,真相在库
	status: 'pending' | 'active' | 'paused' | 'blocked' | 'completed' | 'cancelled';
	blockedReason?: string;
	activeSessionId?: string; // 执行会话绑定;激活/resume 时写,转移时更新
	roundsDone: number;
	maxRounds: number;        // 默认 10,创建时可改
	usage: { inputTokens: number; outputTokens: number }; // 目标级累计,自 message.end 真值累加
	grant: string[] | null;   // 目标级授权的 vault 内路径 glob;撤销即置 null
	birthSessionId: string;   // 仅溯源,session 删除不删 goal
	createdAt: string;
	updatedAt: string;
}
```

- 落盘 `.obsidian/plugins/ratel-vault/goals/<id>.json`,原子写
- **损坏处理**:JSON 解析失败的文件**不静默丢弃**,移入 `goals/corrupt/` 隔离并 Notice 提示——跑了很久的目标静默消失不可接受(评审 Minor 采纳)
- 归档目录 `goals/archive/`(用户确认后移入,退出队列与扫描范围)

### 4.2 状态机、单活与会话占用

| 状态 | 含义 |
|---|---|
| `pending` | 排队中,等待激活 |
| `active` | 正在推进,**全局至多一个**,store 层激活前检查、拒绝双活 |
| `paused` | 用户显式挂起(grant 同时失效) |
| `blocked` | 受阻,附原因等用户处理;不占 active 坑 |
| `completed` / `cancelled` | 终态,永不自动删除 |

**会话占用(S-TASK D1 的完整答案——「这条消息属于哪个 goal」):**

- 激活 / resume 时把当前会话写入 `activeSessionId`;**续跑回合只发生在绑定会话**
- 其他会话查询或尝试推进同一 active goal → 收到「目标正在另一场对话推进」,不出现两会话同时自认在跑
- onload 点继续 = **绑定转移**到当前新会话(旧绑定视为随会话关闭失效)
- `/new` 或切走会话:进行中的回合随会话终止(abort),goal 保持 `active`,`activeSessionId` 悬空;grant 因不在场而失效(见 4.6),resume 时重新绑定并生效
- goal 授权**不进入** `ToolPermissionSessionGrants`(那是会话级「本次不再询问」,`/new` 即清,生命周期与 goal 不同);goal grant 存 goal 文件,生效条件单独判定

### 4.3 创建协商流程

两个入口殊途同归:Agent 从对话识别批量意图主动提议,或用户显式说「立个目标」。

**时序:模型调 `create` → 独立表单 Modal 弹出 → 用户改完点确认才落盘。** 不在对话里先出卡片、也不先写盘再弹窗(避免脏状态)。Modal 字段与校验见 4.11 面 4。

```
→ 模型在对话里谈清意图后调 create(带建议字段)
→ Modal:目标陈述 / 完成标准 / 回合预算 / 授权 glob(预估覆盖文件数),全部可改
→ 完成标准含糊(如「整理干净点」)由模型负责追问细化;create 本地兜底:
   criteria.text 为空、或与 objective 相同 → 拒绝创建
→ 回合预算估算 > maxRounds 默认值 → Modal 建议拆成多个 pending 入队
→ objective 创建后不可变;要改意图 = cancel + 重建新 goal(进度游标可人工带入)
→ 已有 active 时主按钮为[仅排队];用户可先在设置页暂停当前再[创建并开始]
→ 用户确认 → 落盘(pending 或 active)
```

`GoalPredicate` v0 仅一类,其余降级 LLM 自检:

- frontmatter 断言:`{ kind: 'frontmatter-all', pathGlob, property }` — glob 匹配文件全部含指定属性
- 原「path-covered」谓词删除:其目标集合依赖 progressNote 就不是代码谓词(评审 Important 7 采纳)

### 4.4 续跑协议(核心循环)

```
触发:窗口底栏 StatusBarItem(未完成/待归档)/ 输入区继续 chip / 对话里说「继续」
排队仲裁:无 active 但有 pending → 模型按意图建议先做哪个,用户点头才激活(模型建议,用户落锤)
回合开始:
  复述锚定注入(见 4.5)→ 扫库重推导剩余工作 → StatusStrip 显示目标忙态
  → 连续执行(命中 grant 的写入免逐笔确认)
回合结束:
  更新 progressNote + roundsDone + usage(来得及就写,见 4.7)→ 跑完成校验
  → completed(附证据)/ blocked(附原因)/ maxRounds 尽(问加轮还是收尾)/ 用户打断
```

- 回合之间不弹确认——授权创建时已给,状态条常驻可见、随时可停
- **计轮语义(外审修订)**:绑定会话**每一次 `ask()` 收尾都跑 finalizeRound**(累计 usage、统计 grant 范围成功写入);但仅当(显式续跑入口发起)**或**(本次 ask 发生 ≥1 次 grant 范围成功写入)才计 `roundsDone` 并触发完成校验与无进展守卫——普通插话零写入不计轮、不烧守卫;「create 后同一回合接着写完」因有 grant 写入而必然被收口

### 4.5 复述锚定的注入通道(ephemeral,不入库)

评审 Critical 4 采纳——锚定必须躲开 compact / trim / 消息配对:

- **每轮 `toMessages()` 投影时现拼**进 system 段(`objective + completionCriteria + progressNote`),不写入 `session.messages`——85% 自动压缩把历史收进摘要也不影响,因为锚定每轮重拼,永远在场
- 回合内提醒:同一 ephemeral 通道按步数间隔重拼(如每 8 步刷新一次),**禁止**伪造 user / tool 消息入库(避免孤立消息与 microcompact 清理问题)
- 锚定段不占 transcript 槽位,与 microcompact、工具消息配对零交互

### 4.6 权限模型(grant 白名单,最小面)

评审 Critical 2 采纳——grant 与现网 allow/ask/deny + 档位 + 会话 grant 的关系写死:

- **覆盖面(白名单)**:仅 `write_note` / `edit_note` / `append_note`(将来 + `update_frontmatter`),且目标路径命中 grant glob 且通过 `validateVaultPath`
- **永不覆盖**:`delete_note` / `forget_memory` / `update_app_config`(`DESTRUCTIVE_TOOLS` 全集)、所有 `mcp__*`、`run_skill_script`(独立信任门)、`open_settings`、一切 configDir 路径
- **优先级链**:`deny` > 破坏性逐次确认 > **goal grant** > 会话 grant(「本次不再询问」)> 档位。deny 全链最高,grant 撬不开 deny
- **glob 下限**:必须含具体目录前缀(如 `projects/**` 合法;裸 `**`、vault 根、空 glob 拒绝);创建 Modal 展示预估覆盖文件数
- **生效条件**:`status === 'active'` **且** 当前会话 === `activeSessionId`——不在场(切走、`paused`)即失效,无需主动清理
- **停止 ≠ 暂停**:chat 停止钮只 abort 本回合(grant 不动、goal 保持 `active`)。**撤权两条入口**(v1.3):设置页 Goal 区块行内[暂停](直走 store,不经模型);或对话里 `manage_goal pause`。二者都把 status→`paused`、grant 失效。窗口底栏与 StatusStrip **不**做暂停按钮

### 4.7 打断状态机与预算闭环

评审 Critical 3 采纳——对齐现网 AbortSignal 语义(流中掐断、销毁 socket、不等工具写完),删除原「先写 progressNote 再停」的矛盾承诺:

| 触发 | LLM 流 | 已完成写入 | status | grant | roundsDone | progressNote |
|---|---|---|---|---|---|---|
| 状态条「停止」 | 立即断(AbortSignal) | 不回滚 | `active` | 有效(在场不变) | 有实质工作则 +1 | 未 update 则保持旧值 |
| 执行中插话 | 同上;插话按普通消息处理 | 不回滚 | `active` | 有效 | 同上 | 同上 |
| 切会话 / `/new` | 随会话终止 | 不回滚 | `active`(绑定悬空) | 随绑定失效 | 同上 | 同上 |
| 显式暂停/撤权 | 停止 + 撤权 | 不回滚 | `paused` | 失效 | — | — |

- **打断不依赖 progressNote**:下一轮从库重扫(库是真相);回合结束钩子来得及就 update,来不及就丢弃,不阻塞停止
- 打断后 status 仍是 `active`、grant 仍有效。StatusStrip 文案用「已停止,等待你的输入」,**禁止**写「挂起」(与 `paused` 撤权混淆)

**三层预算闭环(各管一段,不重叠):**

| 层 | 上限 | 触达行为 |
|---|---|---|
| 回合内步数 | `maxSteps`(沿用 Agent Loop 默认 50,ADR-004) | 硬顶,强制收尾本回合 |
| 回合内 token | 单回合软上限(设置可调,默认 0=关) | **仅回合结束后检查**(外审修订):触达则本回合收尾、不再续轮,**不算 blocked**;v1 不做 ask 中途截停——那需要把 cap 传入 agentLoop,后置评估 |
| 跨回合轮数 | `maxRounds`(默认 10) | 问用户「加轮还是收尾」 |

**无进展守卫(评审 Important 6 采纳,换主信号):**

- 有 predicate:主信号 = **剩余集合大小**(连续两轮无减少 → blocked)
- 无 predicate:主信号 = 本回合 grant 范围内**成功写入计数**(连续两轮为零 → blocked)
- progressNote 文本相似度仅作辅信号(换写法会假阳性,照抄会假阴性,不可独任)
- 触发 blocked 时附两轮对比数据,请用户裁决

### 4.8 完成验证与成果沉淀

- **predicate 型**:runner 每轮末跑代码校验,通过即由 **runner 收口自动 complete**(附证据清单);模型不可对 predicate 型目标调 `complete`——单一收口,杜绝双写(评审 Important 13 采纳)
- **LLM 自检型**:模型只能**提议**完成(附证据),用户 ask 确认后才 complete
- blocked 只用于「无法推进」(缺密钥、重复失败、无进展守卫触发);校验未过但能推进不算 blocked
- 成果沉淀 v1:完成卡对话确认「把总结写入某篇笔记」(现有 `write_note`,用户点名目标);`append_to_daily` 解绑,写侧轻量 spec 立项后再升级(评审 Important 9 采纳——不让 S-GOAL 重蹈 S-TASK 被未立项依赖拖死的覆辙)

### 4.9 GC 与归档

- 终态目标永不自动删除;超 7 天(阈值可调)进入「待归档」(底栏短文案或设置页列出)
- 用户确认后才移入 `goals/archive/`;取消原 S-TASK「总数上限 50 兜底淘汰」
- 待归档堆积时提高提示显著度,不偷跑删除

### 4.10 工具面(单工具多 action)

`manage_goal`,降低模型选择成本:

| action | 默认权限 | 说明 |
|---|---|---|
| create | ask | 独立表单 Modal 确认后才落盘;本地兜底校验(见 4.3) |
| update(progress) | allow | 进度游标/用量回写 |
| list | allow | 队列查询(含状态明细) |
| pause | allow | 安全方向,随时可停 |
| resume | ask | 激活 = 开跑授权 + 会话绑定,「人在场落锤」点(含 pending→active、blocked→重启) |
| cancel | ask | 终态变更需确认 |
| complete | ask(仅自检型) | predicate 型由 runner 收口,模型调用直接拒绝 |

### 4.11 UI 设计(状态 × 界面矩阵)

现网事实约束:

- `UserStatus` store **只喂 chat 内** `StatusLine` / `StatusDrawer`,不是窗口底栏。面 1 必须用 `Plugin.addStatusBarItem()`,不要往 UserStatus 塞 goal 字段
- `StatusLine` 整行点击 = 开诊断抽屉(goal 忙态**不改**点击语义)。目标操作走继续 chip 与设置页,不指望点 Strip
- 停止复用现有 `abortActiveGeneration`;设置页为 TS 构建函数(`diagnostics-setting-page.ts` 先例)
- 用户可见文案**不用 emoji**(Strip 已有点/orb;底栏空间紧。i18n 纯文字)

**面 1 · 窗口底栏 StatusBarItem(全局常驻,chat 关着也看得到;零目标不显示;只一条短文案)**

| 条件(按优先级取一) | 文案(宜短) | 点击 |
|---|---|---|
| blocked ≥ 1 | 目标受阻 N | 打开 chat |
| active 存在 | 目标进行中 | 打开 chat |
| 仅 paused/pending | 目标暂停 P / 排队 M(有则拼接,尽量短) | 打开 chat |
| 无未完成但待归档 ≥ 1 | 待归档 K | 打开设置页 Goal 区块 |

底栏不写 objective、不加 进行/排队/暂停三计数堆在一行(空间不够)。细节在 chat Strip 与设置页。

**面 2 · chat StatusStrip(busyOverride,仅本会话绑定且 chat 已开)**

| 时机 | busyOverride 文案 | 点色 |
|---|---|---|
| 回合执行中 | \<objective 截断\> · 回合 r/R · 步 s/S | busy(现有 orb) |
| 打断后等待输入 | 目标已停止,等待你的输入 | busy |
| blocked | 目标受阻:\<reason 截断\> | error(`busyHard`) |

停止 = 复用生成停止钮,不新增控件。整行仍开抽屉——用户要暂停/归档去设置页。

**面 3 · 输入区「继续」chip(放在 MentionStrip 一类预览条位置)**

唯一继续目标(只显示一个 chip):

1. 本会话绑定的 `active` 且当前未在跑 → 「继续推进:\<objective 截断\>」
2. `active` 绑在**其他**会话 → 「接管并继续:\<objective 截断\>」,点击先 confirm 再转移绑定
3. 无 active、恰好 **1** 条 pending → 「继续排队中的目标:\<objective 截断\>」
4. 无 active、pending ≥ 2 → 「N 个目标排队」,点击打开设置页 Goal 区块(不擅自激活哪一条)
5. 仅 paused / 仅 blocked、无上述目标 → **不显示 chip**(去设置页恢复)

隐藏:输入框非空、或 `isRunning`。避免误点继续把正在打的字冲掉。

点击(1)(2)(3) → `ask(sessionId, composeContinueMessage(), { goalRound: true })`。

**面 4 · 动作 Modal(`ToolConfirmModal` 不够用:它只有允许/本会话/拒绝,没有表单)**

- **create**:独立 `GoalCreateModal`——objective / criteriaText(textarea)、predicate glob + property(可选)、maxRounds、grant globs;底部「将授权写入约 N 个文件」;主按钮 [创建并开始] / [仅排队](已有 active 时)
- **resume / cancel / complete**:小确认 Modal(只读摘要 + 主按钮),不要套工具权限三键
- **pause**:无 Modal(设置页或工具直接执行)

**面 5 · 设置页 Goal 区块(`ui/settings/goal-setting-page.ts`)**

- 列表行:状态点色 · objective 截断 · 轮次 r/R · 用量(in/out tokens)· 更新时间;blocked 行展开 reason。v1 用量只在这里看,chat 不做进度卡
- 行内操作(**直走 store,不经模型**):active→[暂停];paused/blocked→[恢复][放弃];终态超期→[归档]
- 待归档汇总 + [全部归档]

**通知(Notice)**:corrupt 隔离必发;completed 收口一条「目标完成 · 用量 …」(无 emoji);blocked 不发 Notice(底栏 + Strip 已覆盖)。

**明确不做(v1)**:诊断抽屉内 goal 区块(后续候选)、独立 chat 进度卡、底栏多条 item、Strip 上的暂停钮。

全部字符串走 `src/i18n/zh.ts` / `en.ts`,新增 goal namespace;工具显示名友好化(如「推进目标:补全 frontmatter」)。

---

## 5. 影响面

| 区域 | 变更 |
|---|---|
| `src/core/goal-store.ts`(新) | CRUD、原子落盘、单活仲裁、会话绑定、队列扫描、归档/损坏隔离移动 |
| `src/core/goal-runner.ts`(新) | 续跑回合编排:锚定注入构建、predicate 校验、无进展守卫、预算检查、runner 收口 complete |
| `src/tools/manage-goal.ts`(新) | 单工具多 action |
| `src/core/tool-permissions.ts` | grant 评估钩子(白名单工具 × glob × 在场条件,插在 deny/破坏性检查之后) |
| `src/core/agent-loop.ts` | AbortSignal 打断钩子、`message.end` token 累加到 `AgentGoal.usage`(**不进** UsageStatsStore——它只计 skills/memoryTopics/scriptFailures,无 LLM token) |
| `src/core/context-manager.ts`(投影层) | 锚定段 ephemeral 拼接点 |
| `src/ui/chat/` `src/ui/status/` | StatusStrip busyOverride;输入区继续 chip |
| `src/ui/goal/GoalCreateModal.ts`(新) | create 表单 Modal |
| `src/ui/settings/goal-setting-page.ts`(新) | Goal 列表/暂停/归档 |
| `main.ts` | `addStatusBarItem` 面 1;onload 扫描 corrupt;ask 尾部 finalizeRound |
| `src/i18n/` | 新 namespace |
| 测试 | 单活仲裁 / 会话绑定转移 / grant × deny × 破坏性交叉矩阵 / **打断时未 update 的 progressNote 不阻塞重扫** / **锚定段不被 compact 吞** / 切会话不丢 goal / predicate 收口唯一性 / 无进展守卫主信号 |
| 文档 | user-guide / CHANGELOG / README 在 finishing-a-development-branch 阶段按规则评估 |

下游:Phase C 子代理模板化改为领 goal + 回合预算;Heartbeat(支柱 A)未来成为续跑触发器之一。

## 6. 设计决策记录

| # | 决策 | 理由 |
|---|---|---|
| D1 | 全局单活 + pending 队列 + **会话绑定** | 消息/写入归属永远清晰(S-TASK D1 的防混理由);两会话同跑一个 goal 是数据竞争 |
| D2 | 步骤不持久化 | 行业共识:步骤是透明层;库本身是持久状态,每轮重定向 |
| D3 | 续跑需人在场 + resume 显式绑定 | Obsidian 插件无后台生命周期;每次激活都是显式确认点,安全优势 |
| D4 | 归档需确认,永不静默删;损坏隔离不丢 | 「改了就能查」的一贯姿态;Copilot/Devin 均保留历史 |
| D5 | 无进展守卫,主信号取客观计数 | AutoGPT 教训:空转烧钱是 goal 模式第一死因;文本相似度会误杀漏杀 |
| D6 | 复述锚定走 ephemeral 投影通道 | Manus recitation;入 transcript 会被 compact/microcompact 吞或产生孤立消息 |
| D7 | objective 创建后不可变 | 锚定的前提是锚不动;改意图 = 取消重建,与 DeepSeek 参照一致 |
| D8 | grant 白名单最小面,deny 全链最高 | 安全边界不留给实现猜;grant 只开「可批量且可逆」的写入三件套 |
| D9 | 打断对齐现网 AbortSignal,库是真相 | 「先写进度再停」与 socket 销毁语义矛盾;progressNote 降级为辅助缓存 |
| D10 | predicate 型 runner 单一收口 | 模型与 runner 双写 complete 会竞态;自检型保留人工确认 |
| D11 | 五面分工:底栏短提醒 / Strip 本回合态 / chip 唯一继续 / 表单 Modal / 设置页撤权与用量 | UserStatus 不是窗口底栏;停止≠暂停≠挂起;confirm-modal 撑不起创建表单 |

## 7. 参考

- DeepSeek Harness goal 工具(`objective` / `max_goal_rounds` / `blocked` / `resume`)——生产级最小面参照
- Manus《Context Engineering for AI Agents》——recitation 与 todo.md 上下文锚
- GitHub Copilot coding agent——issue 即 goal、repo 即状态的外置范式
- Devin / TRAE SOLO / Qoder Quest——中途干预、里程碑放行、先协商规格再动手
- Claude Code TodoWrite——会话内透明层的价值边界
- AutoGPT / BabyAGI——无界循环的反面教材
- [S-TASK(归档)](../archive/S-TASK/2026-08-19-agent-task-store.md)——被取代的原设计与继承说明

### 附录:调研待核验项(不影响设计决策)

- Qoder Quest checkpoint 细节、扣子空间定时任务耦合度、Manus recitation 准确表述——待搜索服务可用后核验,仅影响本节措辞
