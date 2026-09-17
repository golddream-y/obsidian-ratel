# S-CHAT-TIME — 跨日续聊的时间锚点

> 日期: 2026-09-17
> 状态: Active
> Spec ID: **S-CHAT-TIME**
> 关联: [P-BASIC-ENV](../archive/S-BASIC-ENV/)（每次 ask 注入当前本地时间）、[S-COMPACT-V2](../archive/S-COMPACT-V2/)（压缩不删聊天，时间戳跟 raw 消息走）

---

## 1. 背景

知识库对话是低频的：同一场可能隔天甚至隔周再打开。人翻记录时不知道哪一段是哪一天；模型每轮能看到「现在几点」，但历史只有正文，不知道上一轮是哪天。旧回复里的「今天」也不会改写。

现网：

- 每次 `ask` 注入 `当前本地时间: YYYY-MM-DD HH:mm (时区, 星期)`，不入库。模型知道**这一轮的现在**。
- `ChatMessage` 无发送时刻。气泡无日期。会话列表只有相对时间（`3h` / `2d`）。
- 一线 Agent（ChatGPT / Claude Code）同样没把「历史哪一天」做成默认能力；IM（微信 / iMessage / Slack）用**跨日分割线**解决人看的问题。

本 spec 做人看得见的日历日，并给模型补「距上一轮」；不给每条消息贴钟点。

---

## 2. 目标

1. 打开一场跨了自然日的对话，消息流里能看出每一段是哪一天（今天 / 昨天 / 具体日历日）。
2. 会话列表超过当天时，能看出是哪一天，不只是 `2d`。
3. 模型在跨日或空闲过久后再发时，除现有「当前本地时间」外，能看到上一轮用户消息的本地时刻和间隔；同日连续对答不额外塞间隔。
4. 旧会话没有时间戳也能打开，不崩、不编造日期。

---

## 3. 非目标

- 气泡旁 `HH:mm`、悬停时钟、Telegram 式滚动吸顶日期条（侧栏窄 + 虚拟列表，另开）
- 给历史上送的每一条消息加日期前缀（费 token，压缩后更脏）
- 改写 transcript 里旧的「今天 / 明天」字面
- 改 `get_datetime` 语义、时区设置项、日记格式
- 新增 `AgentEvent` 成员、新 injection source id（间隔写进现有 `env` 段）
- 设置里开关「显示日期」
- 改 compact 策略、上送预算、架构子系统目录

---

## 4. 详细设计

### 4.1 落盘：`ChatMessage.createdAt`

`src/ports/llm.ts` 的 `ChatMessage` 增加可选：

```ts
/** 写入会话时的本地墙钟 epoch ms；旧数据缺省 */
createdAt?: number;
```

- **谁写：** `ContextManager` 在 `push` user / assistant / tool 时，若调用方未带则填 `Date.now()`。system 注入段、检索块不写（它们不入库或本来就不是用户轮次）。
- **谁读：** UI hydrate、会话列表不读单条（列表仍用 `Session.updatedAt`）、模型间隔行读**最近一条 user** 的 `createdAt`。
- **旧数据：** 字段缺省。不回填猜测值。
- **压缩：** 投影仍保留带 `createdAt` 的 raw 消息；compact 摘要本身是新 assistant/system 内容，写入时带当时的 `createdAt`。不把摘要的时刻冒充被压掉的旧轮次。
- **出站：** `toMessages` / 适配器构造 API payload 时**剥掉** `createdAt`（模型 API 不认识该字段）。间隔只走 `env` 文本。

UI `Message` 增加可选 `createdAt?: number`：user 气泡 = 该 raw user 的时刻；折叠后的 assistant 气泡 = 该组**第一条** assistant raw 的时刻。缺省则该气泡不参与分割线比较。

不改 `AgentEvent` 判别联合。流式过程中气泡可以先无时刻，`message.end` / 落盘后补上；分割线按当前列表里已有的 `createdAt` 算。

### 4.2 人：消息流日分割线

纯函数（可单测）：

```ts
shouldShowDayDivider(prev: number | undefined, curr: number | undefined, now: Date): boolean
formatDayDividerLabel(ts: number, now: Date): StringKey + params
```

规则（**本地日历日**，与 `formatLocalDateTime` 同一套年月日，不用 UTC 日）：

- `curr` 缺省 → 不插线
- `prev` 缺省且 `curr` 有值 → **插**（一场的第一条有时刻的气泡上方也要有日期，否则打开旧对话仍不知道是哪天）
- 两者都有、本地年月日不同 → 插
- 同一本地日 → 不插
- compact 分隔行不是聊天气泡，不参与比较、不长分割线

文案（i18n，禁止硬编码）：

| 条件 | 中文 |
|---|---|
| 与 `now` 同一本地日 | 今天 |
| 昨天 | 昨天 |
| 同一年、更早 | {month}月{day}日 |
| 跨年 | {year}年{month}日 |

插在该日第一气泡**上方**，居中一条细线 + 标签，不进 StatusStrip，不进空态。虚拟列表把分割线当成独立短行（或气泡上边距里的一条），高度固定可测，避免把日线算进气泡测量抖动。

v1 **不做**吸顶。同一日多条气泡只在该日第一条上方出现一次。

### 4.3 人：会话列表

现网 `formatWhen`：`<1m` 点、`<1h` 分钟、`<1d` 小时、否则 `Nd`。隔两天只看到 `2d`，对不上日历。

改为：

- 与现在同一本地日：保持相对（`·` / `Nm` / `Nh`）
- 昨天：`昨天`（i18n）
- 更早同年：`M月D日`
- 跨年：`YYYY年M月D日`

用 `SessionIndexEntry.updatedAt`（最后活动），不是 `createdAt`。tooltip 仍是标题全文，不另挂 ISO。

### 4.4 模型：`env` 段两行

保持每次 `ask` 刷新当前时间行。同一 `env` 注入源，内容变成 1 或 2 行：

```
当前本地时间: 2026-09-17 09:30 (Asia/Shanghai, 星期四)
距上一轮用户消息: 26 小时（上次 2026-09-16 21:04）
```

第二行**仅当**最近一条入库 user 有 `createdAt`，且满足任一：

- 与现在不是同一本地日历日
- 或间隔 ≥ **4 小时**

否则只保留第一行（同日连聊不刷「距上一轮 3 分钟」）。

间隔展示：满小时向下取整（26 小时 50 分 → `26 小时`）；不足 1 小时但因跨日仍要出第二行时写 `不足 1 小时`。时刻用本地 `YYYY-MM-DD HH:mm`，与第一行同一时区函数。

没有上一轮 user 时间戳（新会话、全是旧数据）：只有第一行。

提示词在现有「先看系统注入的当前本地时间」后加一句：**历史正文里的「今天」以说话当时为准；当前日只看环境时间行；是否隔天看「距上一轮」行。** 不改 tool schema。

分类器 / 标题 / compact / 诊断测模型：继续可以不带 `env` 间隔；它们走短任务，不读这场聊天的跨日。主对话 `ask` 必带刷新后的 `env`。

### 4.5 测试

- `shouldShowDayDivider`：缺 curr 不插；缺 prev 有 curr 插；同日不插；跨日本地日插；UTC 已过零点但本地未过不插（用固定 `now`）
- `formatDayDividerLabel`：今天 / 昨天 / 同年 / 跨年
- 会话列表 `formatWhen`：当天相对、昨天、跨年
- `formatEnvGapLine`：无时间戳 → 无第二行；同日 3 小时 → 无；同日 5 小时 → 有；跨日 30 分钟 → 有且「不足 1 小时」
- hydrate：user/assistant 带上 `createdAt`；缺省不抛
- `toMessages` 出站消息无 `createdAt` 字段（或适配器 JSON 不含该 key）

不要求 Svelte 测分割线动画。不打真网。

---

## 5. 影响面

| 区域 | 变化 |
|---|---|
| `ports/llm.ts` `ChatMessage` | 可选 `createdAt` |
| `ContextManager` push 路径 | 默认打戳；`toMessages` 出站剥离 |
| `env` 注入 | 条件第二行；提示词一句 |
| UI `Message` + hydrate + MessageList | 日分割线 |
| SessionMenu `formatWhen` | 跨日改日历 |
| i18n zh/en/types | 分割线 + 列表 + 间隔行（间隔行若只进模型、用户不可见，可放 prompt 默认中文，不进 i18n；**用户可见**的分割线/列表必须 i18n） |
| 设置 / AgentEvent / compact 算法 / 架构目录 | 无 |
| `docs/architecture/host/persistence.md` | 实施时补一句「会话消息可带 createdAt」；不新开页 |

模型可见的间隔行是系统注入，不是 UI 文案：用 `formatEnvContextLine` 同文件的中文模板即可（与现网时间行一致，prompt 默认中文）。分割线与列表必须 `t()`。

---

## 6. 分期

- **一期（本 spec 唯一 plan）：** 落盘 `createdAt` + 日分割线 + 列表日历 + `env` 间隔行。
- **二期（另开 spec）：** 气泡钟点、吸顶日条、给压缩摘要标明「覆盖哪段日期」。

---

## 7. 参考

- 现网时间注入：`src/utils/local-datetime.ts`、`src/main.ts` `setEnvContext`、`INJECTION_SOURCE_IDS` 的 `env`
- 会话列表：`src/ui/chat/session/SessionMenu.svelte` `formatWhen`
- hydrate：`src/ui/chat/message-stream/hydrate-session-messages.ts`
- 行业：IM 日分割线；Claude Code 社区 hook（每轮当前时间 + idle）；ChatGPT 多年不展示气泡时间
