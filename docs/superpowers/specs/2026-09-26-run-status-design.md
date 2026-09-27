# S-RUN-STATUS — 跑起来时说清正在做什么

> 日期: 2026-09-26
> 状态: Active
> Spec ID: **S-RUN-STATUS**
> 关联: [MessageList](../../../src/ui/chat/message-stream/MessageList.svelte)、[map-orb-state](../../../src/ui/orbs/map-orb-state.ts)、[S-LOOP-STABILITY](2026-09-26-loop-stability-design.md)（为什么会停，另 spec）

---

## 1. 背景

对话进行时，消息底部的球几乎一直写「撰写中」。更细的词已经有了：工作中、检索中、整理中、重试倒计时。它们很少出现，因为两步工具之间、以及等模型出第一个字时，忙态都映射成 `thinking` → 撰写中。

对话一开始，状态条上的目标进度（第几步 / 上限）会被关掉，避免和消息里的球叠两层。长任务因此只剩一个词。

工具在跑时，这一行写工具自己的名字。字已经在流、球却只写「撰写中」时，后面再跟一句随机短句，隔几秒换一条，像炉石加载时的提示：不报假进度，也不解释当前工具。

## 2. 目标

1. 等模型、还没有工具、也还没有出字时，用两三句短状态轮换，不再固定「撰写中」。
2. 字或思考已经在流时，仍以「撰写中」开头，后面随机跟一句短状态，每 8 秒换一条，换句时淡入上移一点。不立刻重复刚显示过的那句。
3. 工具正在调用时，显示这个工具的现有友好名，不显示笼统的「工作中」。
4. 从第 2 步起，同一行带上「第 n 步」。有进行中的目标时，用目标已有的回合/步文案，不另造一套。
5. 重试、压缩仍用现在的句子，不被轮换盖掉。

## 3. 非目标

- 不加第二个球，不把对话进行时的状态条黄条再开回来。
- 不做假进度百分比，不加声音。
- 不改球的动画种类，只改旁边的字。
- 不把索引、下载模型的句子挪进对话球。那些仍在空闲时的状态条。

## 4. 需求

| ID | 需求 | 验收口径 |
|---|---|---|
| RS-01 | 等待时轮换 | 本步还没有文字、思考、进行中的工具时，每 8 秒换一句，换句淡入。中英各 3 句，句子说的是「还在想 / 还在看上一步」，不是玩笑 |
| RS-02 | 撰写中加随机句 | 本步已有文字或思考流，行首是撰写中，后面是「 · 」加一句随机短状态。进入该态立刻出一句。之后每 8 秒从池里另抽一句，淡入，不与上一句相同。离开该态（改去工具名、重试、等待）就停掉这个轮换 |
| RS-03 | 工具用友好名 | 有 `status === 'calling'` 的工具时，显示 `formatToolDisplayName` 的结果。检索类不再只写「检索中」 |
| RS-04 | 步数 | 第 2 步及以后，同一行末尾是「第 n 步」。n 从 1 计，与循环步一致 |
| RS-05 | 重试优先 | `retryWait` 有值时仍是现有重试句，不轮换、不改成工具名 |
| RS-06 | 目标留在状态条 | 目标的回合和步仍在状态条上，不拼进球旁边这一行，避免长句把短状态挤掉 |

## 5. 详细设计

### 5.1 一行，五态

消息列表底部球旁边只保留一行。优先级从高到低：

1. 重试等待：现有 `retryWaitLabel`。
2. 工具调用中：该工具友好名。多个同时 calling 时，用最后一个。
3. 本步已有正文或思考：`撰写中 · {随机句}`。
4. 否则：等待句，8 秒一轮，换句淡入。等待句不使用撰写中的随机池。
5. 若当前步数 ≥ 2，在以上 2–4 的句子后加「 · 第 n 步」。重试句不加。撰写中的完整样子是：`撰写中 · ❄️ 雪还在下 · 第 3 步`。

等待句中文三句，英文三句，放 i18n，不在组件里写死：

- 正在想下一步
- 还在看刚才的结果
- 马上继续

英文对应：Thinking about the next step / Still looking at the last result / Continuing in a moment.

撰写中的随机池也放 i18n，中英各 30 句，同一下标互为译文。抽句用池的下标，不在组件里写死句子。换句时避开刚刚显示的那一条。句子只写气象和星象，不写库、不写牌、不写在做事的标点。图标只写进合适的中文句，英文不加。

星象：

1. 🌙 月还没升到中天
2. 星子一颗一颗亮起来
3. 银河还在转
4. ☄️ 有一颗星划过去了
5. 新月细得像一根线
6. 月亮把窗纸照透了
7. 北极星还在原处
8. 天边先白了一线
9. 夜还很长
10. 星图还没看完
11. 月色先铺到纸上
12. 月移过一行字
13. 疏星还挂在原处
14. 这一夜还没转完
15. 月白先落在标题上

气象：

16. ❄️ 雪还在下
17. 雪正走过屋顶
18. 霜还留在窗上
19. 雪落在未干的墨上
20. 🌧️ 雨还没停
21. 雨点敲着窗
22. 檐上的水还在滴
23. 🌫️ 雾还没散
24. 风还在翻这一页
25. 风把灯吹得一晃
26. 这一阵风还没走
27. 🍃 叶子还在往下飘
28. 潮还没有退
29. 云缝里漏下一线光
30. ⛈️ 远处还在响雷

英文按同一序号：

1. The moon has not reached the peak
2. Stars are coming on, one by one
3. The galaxy is still turning
4. A star just crossed the sky
5. The new moon is a thin line
6. Moonlight came through the window paper
7. The north star has not moved
8. A line of white showed at the edge of the sky
9. The night is still long
10. The star chart is still open
11. Moonlight reached the page first
12. The moon moved across a line
13. The sparse stars are still where they were
14. This night has not finished turning
15. Moonlight fell on the heading first
16. Snow is still falling
17. Snow is crossing the roof
18. Frost is still on the window
19. Snow fell on wet ink
20. The rain has not stopped
21. Rain is tapping the window
22. Water is still dripping from the eaves
23. The fog has not lifted
24. The wind is still turning this page
25. The wind made the lamp flicker
26. This gust has not left
27. Leaves are still coming down
28. The tide has not gone out
29. A line of light came through the clouds
30. Thunder is still sounding, far off

这些句子不表示真实进度。工具名、重试、步数仍然是真的。

### 5.2 步数从哪来

Chat 在收到 `message.start` 时把本轮步数加一，传给消息列表。不从工具条反推。目标的回合和步留在状态条，球旁边只放短状态。

对话进行时状态条继续不显示第二套忙态。目标条在 `isRunning` 时保持现在的隐藏，信息改由这一行承担。

### 5.3 和稳定性 spec 的边界

步数用尽、工具超时、空步续写的句子由 S-LOOP-STABILITY 写进消息或工具结果。本 spec 只描述跑的过程中那一行。到顶之后球消失，不继续轮换。

## 6. 影响面

| 区域 | 变化 |
|---|---|
| `src/ui/chat/message-stream/MessageList.svelte` | 一行五态；等待轮换 |
| `src/ui/chat/ChatView.svelte` | 把本轮步数传下去；目标文案留在状态条 |
| `src/i18n` | 三句等待文案、三十句撰写随机句、步数后缀 zh/en |
| 测试 | 有 calling 工具时用友好名；无流无工具时是等待句；出字后是「撰写中 · 」加池中的一句；重试盖过轮换；步数从 2 起出现；目标长句不进这一行 |

## 7. 参考

- 现有映射：`src/ui/orbs/map-orb-state.ts`（`thinking` → 撰写中）
- 对话中隐藏状态条：`ChatView.svelte` 里 `isRunning` 时 `workBar` 为 null
- 工具友好名：`formatToolDisplayName`
