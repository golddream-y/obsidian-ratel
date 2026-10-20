# S-RUN-STATUS-PHASES — 忙态状态行三阶段诗意文案

> 日期：2026-10-15 ｜ 状态：Active ｜ 分支：`feat/run-status-phases`（worktree `.worktrees/feat-run-status-phases`）

## 背景

聊天界面底部的「忙态行」（思考球 + 一行文字）在模型工作时持续显示。现状（1.1.0）把「点发送后到第一个字之前」整段时间压成一个模糊阶段，只轮换三句功能性等待文案：

- `orb.run.wait.1` 正在想下一步
- `orb.run.wait.2` 还在看刚才的结果
- `orb.run.wait.3` 马上继续

而真实的请求生命周期里，这一段时间包含两个性质完全不同的阶段：

1. **本地准备（出站前）**：意图分类（一次小 LLM 调用）、上下文组装、RAG 时的 embedding 与向量检索。此时请求还没发出。
2. **在途（出站 → 首个 token）**：`llm.chat()` 已发出，等网络往返、模型排队与首字（TTFB）。

代码里没有任何事件标记「请求已发出」这个时刻（`agent-loop.ts` 只有一个内部诊断 breadcrumb `llm.request`，不进 UI），UI 无法区分两阶段。同时在意图分类阶段，忙态行因「最后一条消息必须是 assistant」的显示门槛完全不出现，用户点发送后有 1～2 秒（RAG 时更久）没有任何反馈。

撰写阶段（首字之后）已有成熟的 30 句诗意随机句（`orb.run.flavor.01..30`，星月雨雪主题），本次不动。

## 目标

1. 忙态行细分为三个阶段，各自有独立文案池：
   - **① 本地准备 preparing**：请求发出前的本地工作。6 句，书斋准备意象。
   - **② 在途 awaiting**：请求已发出、等第一个 token。8 句（含 3 句古诗），远方等待意象。
   - **③ 撰写 composing**：首字之后。沿用现有「撰写中 · flavor」30 句，不改。
2. 点发送后（含意图分类阶段）忙态行立即出现，消除无反馈空窗。
3. 新增一个 AgentEvent 标记「请求出站」时刻，作为 ①/② 的分界。
4. 全部新增用户可见字符串走 i18n（zh/en/types 三同步），每句中英文案在本 spec 登记其**意境、对应内部动作、情绪基调**，作为后续改文案的依据。
5. 阶段内文案随机轮换、相邻不重复；不同轮次看到的开门句不同。

## 非目标

- 不改撰写阶段 ③ 的任何文案与轮换行为。
- 不改重试态（`chat.retry.*`）、工具调用态（工具友好名）、步数后缀（`orb.run.step`）的优先级与文案。
- 不调整「think（推理）段是否算已出字」的现有判定——推理内容出现时仍进入 ③。这是独立的语义问题，本次不碰。
- 不改角落捣蛋鬼（mascot）的 aria 文案体系（`chat.mascot.aria.*`）。
- 不做文案的用户自定义/设置开关；装饰动画开关 `chatMotionEnabled` 的现有语义不变（忙态球不受开关影响，本次新增的文字轮换也不受影响）。

## 详细设计

### 1. 事件协议：新增 `message.request`

在 `AgentEvent` 判别联合（`src/types.ts`）新增：

```ts
| { type: 'message.request'; payload: { step: number } }
```

- **发出点**：`src/core/agent-loop.ts` 每个 step 内、`llm.chat()` 调用（当前 L216）**之前**、消息数组组装完成之后 `yield`。`payload.step` 为当前 step（从 0 计，与现有 `onBreadcrumb?.('llm.request', step)` 一致）。
- **语义**：主 LLM 请求此刻出站。意图分类器那次小 LLM 调用**不发**此事件——它语义上属于本地准备。
- **频率**：多步循环每步一次（工具往返后的后续请求也算新一轮在途）。
- 消费方：`ChatView.svelte` 的事件 switch 加一个 case（见 §3）。`goal-runner.ts`、`main.ts` 等不按事件类型穷举的消费方无需改动；新增判别联合成员后由 tsc 兜底确认无遗漏 switch。

### 2. 阶段状态机

UI 侧推导顺序（从高到低，命中即停）：

| 优先级 | 条件 | 阶段 | 忙态行内容 |
|---|---|---|---|
| 1 | `retryWait != null` | retry | 重试文案（不变） |
| 2 | 末条 assistant 消息有 `calling` 工具段 | tool / search | 工具友好名（不变，检索类另算） |
| 3 | 末条 assistant 消息 text/think 段已有内容 | composing ③ | `撰写中 · <flavor>` |
| 4 | 已收到 `message.request` 且未到 3 | awaiting ② | await 池随机句 |
| 5 | `isRunning` 且以上都不满足（含最后一条还是 user 消息的意图分类期） | preparing ① | prepare 池随机句 |

关键变更：

- **忙态行显示门槛放宽**：`showBusyOrb` 由「运行中且末条是 assistant」改为「`isRunning` 且存在消息」。发送即显示；run 结束（`isRunning=false`）即隐藏。
- ChatView 新增 `$state` 布尔 `llmRequestInFlight`：
  - 收到 `message.request` → `true`；
  - 收到 `message.delta`、`tool.call`（请求以工具调用返回也算首字）、`message.end`、`error` → `false`；
  - 每次发送新消息（`isRunning = true` 处）重置为 `false`。
  - 该布尔作为 prop 传入 `MessageList.svelte`（与现有 `runStep`、`retryWait` 同路径）。

### 3. 思考球动画映射

`src/ui/orbs/map-orb-state.ts` 的忙态种类扩展：

- 新增 `'preparing'` → OrbState `'shaping'`（塑形：问题正在成形）
- 新增 `'awaiting'` → OrbState `'listening'`（聆听：听远方回音）
- 原 `'thinking' → 'composing'` 仅保留给 ③；`idle → breathing` 不变；search/tool/index/retry/compact 映射不变。

### 4. 状态行拼装（`src/ui/chat/run-status-line.ts`）

- `RunStatusInput`：移除 `streaming: boolean`，改为 `phase: 'preparing' | 'awaiting' | 'composing'`（retry/tool 仍由独立字段表达，优先级最高）。
- `RunStatusPhrases`：移除 `wait`，新增 `prepare: readonly string[]` 与 `await: readonly string[]`；`composing`、`flavor`、`step` 不变。
- `composeRunStatusLine`：retryText → toolText → 按 phase 取句；③ 仍拼成 `撰写中 · <flavor>`，①② 直接输出池中句。步数后缀规则不变（第 2 步起追加，retry 不加）。
- i18n key 常量：移除 `WAIT_LINE_KEYS`，新增 `PREPARE_PHRASE_KEYS`（6）与 `AWAIT_PHRASE_KEYS`（8），`COMPOSING_FLAVOR_KEYS` 不动。

### 5. 轮换节奏与随机起点

- 轮换间隔按阶段：**① 4 秒**（该阶段通常 1～3 秒，RAG 慢时可见 1～2 次切换）；**② 8 秒**；③ 维持 8 秒（`RUN_STATUS_ROTATE_MS` 保留给 ②③）。
- 新增 `PREPARE_ROTATE_MS = 4000`。
- **阶段切入时 tick 重置为 0，并随机一个起点下标**（现在 `pickRotatingIndex(0)` 恒定落同一下标，开门句永远相同）：每次进入新阶段生成一次随机 seed，取句下标 = `(seed + tick 步进) mod 池大小`，相邻两拍强制不相等（沿用现有防重复思路）。seed 逻辑放在纯函数里（如 `pickRotatingIndex(tick, size, seed)`，seed 缺省 0 以兼容旧测试语义），可单测。
- 阶段频繁来回（工具多步）时每次进入都重新随机，不做跨轮去重记忆（YAGNI）。

### 6. 文案池（定稿，含意境字典）

#### ① 本地准备池 `orb.run.prepare.01..06`

统一意境：**动笔前的书斋**。情绪基调：从容、专注、有仪式感，没有等待的焦灼。暗合开工序列（磨墨→翻册→清桌→听风→温茶→焚香），但单轮通常只看到 1～2 句，不要求用户感知顺序。

| key | 中文 | English | 对应内部动作 | 画面 / 情绪 |
|---|---|---|---|---|
| prepare.01 | 新墨研开了… | Fresh ink is ground… | 意图分类（小 LLM 判断要做什么） | 墨色渐浓；凝神、酝酿开始 |
| prepare.02 | 翻几页旧册… | Leafing through old pages… | RAG 检索 / 翻记忆（embedding + 向量库） | 温故、搜寻相关内容 |
| prepare.03 | 拂净案头尘… | Dusting off the desk… | 历史上下文整理 / 压缩 | 腾出干净工作面；整理、清空 |
| prepare.04 | 听听风从哪来… | Listening for where the wind comes from… | 意图方向判断（要不要 RAG、往哪走） | 侧耳辨风；辨别方向、不急于动作 |
| prepare.05 | 温壶烫盏… | Warming the pot and cups… | 本地预热 / 耗时准备（embedding 等） | 客未到先备着；预热、体贴 |
| prepare.06 | 炉香初燃… | Incense begins to curl… | 请求即将发出的临界点 | 烟刚升起；静心、仪式起点 |

#### ② 在途池 `orb.run.await.01..08`

统一意境：**话已出门，等远方回应**。情绪基调：**把等待写成闲适，不是焦虑**。分自然意象（5 句）与古诗（3 句）两组。

| key | 中文 | English | 对应等待 | 画面 / 情绪 |
|---|---|---|---|---|
| await.01 | 目送归雁过山… | Watching the geese cross the hills… | 请求刚发出 | 空间远去；开阔、不追 |
| await.02 | 等云酿成雨… | Waiting for clouds to turn to rain… | 远端正在生成 | 云聚成雨；生成中的隐喻，从容 |
| await.03 | 等第一声远钟… | Waiting for the first distant bell… | 等第一个 token（TTFB） | 「第一声」双关首个回复信号；安静期待 |
| await.04 | 檐雨数到第几行… | Counting the eaves-drip, line by line… | 纯时间流逝 | 数檐滴，「行」双关诗行（英文 line by line 同保双关）；独处的闲 |
| await.05 | 月在云后梳洗… | The moon is dressing behind the clouds… | 结果在远端成形、未露面 | 梳妆好了才出来；结果准备登场 |
| await.06 | 过尽千帆皆不是… | A thousand sails pass by, none of them mine… | 慢响应中的一次次辨认 | 温庭筠《望江南》；船一条条过都不是我的回复 |
| await.07 | 闲敲棋子落灯花… | Idly tapping chess pieces as the wick-flower falls… | 长等待 | 赵师秀《约客》；**全池情绪锚点**：等待中的闲适小动作 |
| await.08 | 月明人倚楼，盼人归… | Leaning on the moonlit tower, waiting for one's return… | 最直白的「盼回复」 | 化白居易《长相思》；月夜倚楼远望，池收尾位 |

古诗英译原则：只保画面不译典故、不加文化注释；`灯花` 译 `wick-flower`（与现有英文池 `window paper` 同类可感异域意象）。

### 7. 文案护栏（写进这里，防后续改坏）

1. **不同义换装**：新增句必须是不同意象/新动作；禁止「候信中 / 等回音 / 静候答复」式同一语义换皮。
2. **情绪不焦虑**：禁止催促感、进度焦虑、「卡住了」式措辞。
3. **跨池不撞物**：同一物件不在两池重复（灯花归属在途池，准备池不得写灯）。
4. **古诗只截从容片段**：不得接原诗后半的凄苦意象（白苹洲、肠断等一律禁用）。
5. **池间风格统一**：① 只用书斋人文意象，② 以自然意象为主、古诗点缀；③ 现有池不变，新增句向其星月雨雪风格看齐。

## 影响面

- **数据模型 / 跨线程协议**：`AgentEvent` 新增 `message.request`（主线程内 async iterator，不涉 Worker 消息）。按 AGENTS 规则属架构文档触发项，但仅是判别联合追加成员、无既有字段变更，实现完成后在 finishing 阶段确认是否补 architecture 文档（本 spec 即协议说明）。
- **代码文件**：
  - `src/types.ts`（事件类型）
  - `src/core/agent-loop.ts`（yield 事件）
  - `src/ui/chat/ChatView.svelte`（事件消费 + `llmRequestInFlight` + 传 prop）
  - `src/ui/chat/message-stream/MessageList.svelte`（显示门槛、阶段推导、轮换定时器分档、随机起点）
  - `src/ui/chat/run-status-line.ts`（入参/短语池/纯函数）
  - `src/ui/orbs/map-orb-state.ts`（两个新忙态映射）
  - `src/i18n/{zh.ts,en.ts,types.ts}`（删 3 wait key，加 14 个新 key）
- **测试**：
  - `tests/ui/chat/run-status-line.test.ts`：改 wait 用例为 prepare/await 两池用例；新增随机起点、相邻不重复、三阶段优先级、步数后缀。
  - agent-loop 事件序列测试：`message.request` 在每步 `llm.chat` 前、首个 delta 前恰好一次；意图分类不发此事件。
  - i18n key 完整性：既有 zh/en 对齐测试自动覆盖新 key。
- **文档**：纯 UI 文案与交互增强，不触发 README / user-guide（无新命令、无隐私通道变化）；CHANGELOG 留待发版（「点发送后立刻有状态反馈 + 等待文案分两阶段」）。

## 参考

- 现有实现：`src/ui/chat/run-status-line.ts`、`src/ui/orbs/map-orb-state.ts`、`src/ui/chat/message-stream/MessageList.svelte`（L85-149 忙态推导、L394-403 忙态行）、`src/core/agent-loop.ts`（L149 意图分类、L185 message.start、L216 llm.chat）。
- 文案出处：温庭筠《望江南·梳洗罢》、赵师秀《约客》、白居易《长相思·汴水流》。
- 既有风格基准：`orb.run.flavor.01..30`（zh/en）。
