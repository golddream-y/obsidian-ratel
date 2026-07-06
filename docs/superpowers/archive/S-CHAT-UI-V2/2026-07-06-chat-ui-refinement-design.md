# Chat UI 打磨与交互体验优化 — Spec

- **Spec ID**: S-CHAT-UI-V2
- **创建日期**: 2026-07-06
- **状态**: Active
- **作者**: AI + 用户对话驱动
- **参考原型**: [`docs/prototype/chat-ui-mockup.html`](../../prototype/chat-ui-mockup.html)

---

## 1. 背景

### 1.1 现状

Chat UI 当前由 5 层组成(`src/ui/chat/ChatView.svelte`):Header → MessageList → StatusLine → StatusDrawer → Input。原型 [`docs/prototype/chat-ui-mockup.html`](../../prototype/chat-ui-mockup.html) 与代码结构基本一致,但存在 4 处与项目 memory 中已确认设计原则的矛盾,以及多处样式硬约束违规。

### 1.2 问题清单

| # | 问题 | 位置 |
|---|---|---|
| 1 | Header model-badge 固定绿色,不随模型状态变色 | `ChatView.svelte` L508-520 |
| 2 | 上下文百分比在 StatusLine 内部,违反"应在 StatusLine 外部显示"原则 | `StatusLine.svelte` L99-116 |
| 3 | 无独立 work 条,违反"prefers placing a work条 at the bottom"原则 | `ChatView.svelte` L416-465 |
| 4 | StatusDrawer 上下文区与向量化区混合,违反"抽屉内放置向量化项相关变动"原则 | `StatusDrawer.svelte` L143-176 |
| 5 | 圆角违规 2 处(12px / 10px,约束 ≤8px) | `ChatView.svelte` L512、`StatusDrawer.svelte` L271 |
| 6 | box-shadow 违规 17+ 处(约束禁止) | 多个 Svelte 组件 |
| 7 | `styles.css` 诊断面板 `diag-` 前缀(约束 `ratel-` 前缀) | `styles.css` L77-134 |
| 8 | `ChatView.svelte` L468-475 注释"用户明确要求阴影"已过时(约束已变更) | `ChatView.svelte` L468-475 |

### 1.3 触发本 spec 的对话

用户在前序会话中选择"UI 设计打磨 + Chat 交互体验"双方向,基于原型直接沟通修改方案。本 spec 是 brainstorming 阶段的产物,待用户审查后转入 writing-plans。

---

## 2. 目标

1. **Header 承载品牌 + 模型状态 + 上下文使用率** — model-badge 随 tone 变色,新增百分比胶囊。
2. **StatusLine 简化** — 只留状态点 + 文字 + 展开箭头,百分比外移。
3. **Input 下方新增 work 条** — 显示"正在做的事",gate 提示条移入。
4. **StatusDrawer 上下文区精简** — 抽屉聚焦向量化,上下文区只留 used/max + 压缩按钮。
5. **样式合规化** — 圆角 ≤8px、删 box-shadow、`ratel-` 前缀、修订过时注释。
6. **i18n 全覆盖** — 新增字符串全部走 `t()` / `tNow()`,补 `zh.ts` + `en.ts`。
7. **保持现有测试通过** — 不破坏 652 个测试。

---

## 3. 非目标

- 不改 MessageList / MessageBubble / ThinkSegment / ToolSegment / SearchResults 的渲染逻辑(它们已稳定)。
- 不改斜杠命令的触发逻辑(已按 "/" 触发,满足用户要求)。
- 不改 StatusLine 5 种 tone 的判定逻辑(已实现,只改视觉呈现位置)。
- 不改 UserStatusSnapshot 数据模型。
- 不引入新的 CSS 变量系统或 spacing token(留作未来技术债)。
- 不改设置面板 / 诊断面板的功能逻辑(只改 `diag-` 前缀)。
- 不改原型 HTML 文件(原型是设计参考,不是生产代码)。

---

## 4. 详细设计

### 4.1 Section 1:Header 重构

**目标**:Header 承载品牌 + 模型状态 + 上下文使用率三件事。

**布局**(自左向右):

```
[R logo] [Ratel 标题]              [6% 胶囊] [deepseek-reasoner badge]
```

#### 4.1.1 R logo(新增)

- 22×22 px,圆角 6px
- 半透明绿底 `rgba(126, 231, 135, 0.2)` + 绿边 `rgba(126, 231, 135, 0.3)`
- "R" 字,mono 字体,12px,绿色 `var(--accent)` ,font-weight 700
- class:`ratel-header-logo`

#### 4.1.2 Ratel 标题

- 保留现有 i18n key `chat.header.title`
- class:`ratel-header-title`(保留)

#### 4.1.3 百分比胶囊(新增)

- 只显示数字,如 `6%`
- 按使用率阈值变色(与现有 StatusLine 进度条阈值一致):
  - 0-79%:`var(--accent)` 绿
  - 80-94%:`var(--text-warning)` 黄
  - 95-100%:`var(--text-error)` 红
- 背景:对应色 + `rgba(..., 0.12)` 半透明
- 边框:对应色 + `rgba(..., 0.2)`
- 圆角 8px,padding `2px 9px`,font-size 11px,mono 字体
- class:`ratel-header-ctx`
- 数据来源:复用 `contextStore`(与 StatusLine 同源)

#### 4.1.4 model badge(改造)

- 保留显示模型名
- **新增**:随 tone 变色(与 StatusLine.dot 同源 tone):
  - `ready`:绿底 + 绿字(现有默认)
  - `thinking`:黄底 + 黄字 + 1.2s 脉冲动画
  - `error`:红底 + 红字
  - `unconfigured`:灰底虚边 + muted 字
  - `indexing`:黄底 + 黄字 + 1.2s 脉冲动画
- 圆角从 12px 改 8px
- class:`ratel-header-badge`(保留)+ tone 修饰 class(`ratel-header-badge--ready` / `--thinking` / `--error` / `--unconfigured` / `--indexing`)
- tone 计算逻辑:从 `StatusLine.svelte` L29-47 提取为共享函数 `deriveTone(snapshot)` 放到 `src/ui/status/tone.ts`,Header 与 StatusLine 共用。`index` 字段的 `processing` / `scanning` / `queueing` / `diffing` 四种状态都归为 `indexing` tone(diffing 是 smartRehash 的 hash 比对阶段,用户感知也是"索引中")

**涉及文件**:
- [src/ui/chat/ChatView.svelte](../../../src/ui/chat/ChatView.svelte) L388-392(template)+ L488-521(style)
- [src/ui/status/tone.ts](../../../src/ui/status/tone.ts)(新建)
- [src/ui/status/StatusLine.svelte](../../../src/ui/status/StatusLine.svelte) L29-47(改为 import)

---

### 4.2 Section 2:StatusLine 简化

**目标**:StatusLine 只留"状态点 + 状态文字 + 展开箭头"。

**布局**:

```
[●点] [思考中…]                                              [▲]
```

#### 4.2.1 保留

- 状态点 `.ratel-sl-dot`:5 种 tone 颜色(ready/thinking/error/unconfigured/indexing)
- 状态文字 `.ratel-sl-text`:i18n label
- ▲ 展开箭头 `.ratel-sl-arrow`:点击切换 Drawer

#### 4.2.2 删除

- `.ratel-sl-ctx` 整块(L99-116):进度条 + 百分比 + source-pill 全部移除
- 相关 CSS(L99-116 进度条样式、L217-310 ctx / source-pill 样式)
- 相关 i18n key:`status.line.ctxTooltip`(不再需要,百分比已外移)
- 相关 source-pill 逻辑:整行点击展开 Drawer 保留,但 source-pill 的 click 事件不再需要

#### 4.2.3 box-shadow 清理

- 删除 `.ratel-sl-dot-ready` / `.ratel-sl-dot-error` 的 `box-shadow` 光晕
- 删除 `.ratel-sl-ctx-bar` / `.ratel-sl-ctx-fill` 的 `box-shadow`(随整块删除)
- 删除 source-dot 的 `box-shadow`(随 source-pill 删除)

**涉及文件**:
- [src/ui/status/StatusLine.svelte](../../../src/ui/status/StatusLine.svelte) L99-116 + L217-310

---

### 4.3 Section 3:Input 下方新增 work 条

**目标**:Input 底部(send 按钮下方)新增 work 条,显示"正在做的事",并把现有 gate 提示条移到这里。

#### 4.3.1 布局

```
[textarea]
[Send] [Stop]
─────────────────────────────────
[⚡ 索引中 12/30 文件]   [⚠ 主线程内联模式]
```

#### 4.3.2 显示规则

- **空闲时隐藏**:不占位,不显示
- **显示条件**(任一满足即显示;优先级从上到下,同时满足时只显示第一个):
  - 索引中(`status.index` 为 `processing` / `scanning` / `queueing` / `diffing`)→ 显示"索引中..."(黄字 + 脉冲点;不解析 `indexDetail` 进度数字,进度数字由 StatusDrawer 进度条承担)
  - 模型下载中(`status.model` 为 `downloading`)→ 显示"下载模型中..."(黄字 + 脉冲点)
  - 模型初始化中(`status.model` 为 `checking` / `initializing`)→ 显示"准备模型中..."(黄字 + 脉冲点)
  - 搜索中(现有 `isRunning` 为 true 且尚未收到首个 text delta)→ 显示"搜索中..."(黄字 + 脉冲点)
  - 压缩中(现有 `isCompacting` 为 true)→ 显示"压缩中..."(黄字 + 脉冲点)
  - `gate.hardBlockReason` 非空 → 红字阻塞提示(从 input 顶部 L418-422 移来;与上面互斥,阻塞时其他不显示)
  - `gate.softHint` 非空 → 灰字提示(从 input 顶部 L418-422 移来;可与"正在做的事"并排)
- **多内容并存**:横向排列,左边"正在做的事",右边 `softHint` 提示;`hardBlockReason` 单独全宽显示

#### 4.3.3 样式

- 单行,padding `6px 14px`,font-size 11.5px
- 背景:`rgba(37, 37, 38, 0.5)` + 毛玻璃 `blur(6px)`
- 圆角 6px(从 input 区底部边框向下延伸,视觉上属于 input 区)
- 无 box-shadow
- class:`ratel-work-bar`
- 子元素 class:`ratel-work-item`(单项)、`ratel-work-dot`(脉冲点)、`ratel-work-hint`(gate 提示)

#### 4.3.4 删除旧 gate 提示条

- 删除 `ChatView.svelte` L418-422 的 `.ratel-gate` / `.ratel-gate-hard` 块
- 删除相关 CSS(L537-547 附近)
- 删除 `isCompacting` loading hint(L424-426)的独立块,合并到 work 条(显示"压缩中...")

#### 4.3.5 i18n

新增 i18n key:
- `chat.workbar.indexing`:"索引中..."(en: "Indexing...")
- `chat.workbar.downloading`:"下载模型中..."(en: "Downloading model...")
- `chat.workbar.preparing`:"准备模型中..."(en: "Preparing model...")
- `chat.workbar.searching`:"搜索中..."(en: "Searching...")
- `chat.workbar.compacting`:"压缩中..."(en: "Compacting...")

**涉及文件**:
- [src/ui/chat/ChatView.svelte](../../../src/ui/chat/ChatView.svelte) L416-465(template 改造)+ L548-560 附近(style)+ 新增 work-bar style 块
- [src/i18n/types.ts](../../../src/i18n/types.ts) 新增 5 个 key
- [src/i18n/zh.ts](../../../src/i18n/zh.ts) + [src/i18n/en.ts](../../../src/i18n/en.ts) 新增翻译

---

### 4.4 Section 4:StatusDrawer 上下文区精简

**目标**:抽屉聚焦"向量化/索引",上下文区只留 used/max tokens + 压缩按钮。

#### 4.4.1 "向量化 / 索引" section(完整保留)

- 索引状态 + 文档数 / 进度数字
- 进度条 `.ratel-drawer-progress`(仅 scanning/processing/queueing 时显示)
- 当前文件名
- embedding 状态
- worker mode pill
- 降级提示 `.ratel-drawer-degraded`

#### 4.4.2 "上下文" section(精简)

**保留**:
- 已用 / 上限 tokens 文字(`status.drawer.label.usedMax`)
- 压缩上下文按钮(`status.drawer.compactButton`)

**删除**:
- token-meter 进度条(L149-157)— 已外移到 Header
- 数据来源 source-pill(L158-166)— source 指示器从抽屉移除
- 附件 token 统计(L167-172)— 附件统计移到 AttachmentStrip 自身(若未来需要)

#### 4.4.3 圆角修正

- `.ratel-drawer-pill` L271:`border-radius: 10px` → `8px`

#### 4.4.4 box-shadow 清理

- 删除 `.ratel-drawer-meter-track` L337 的 `box-shadow`(随整块删除)
- 删除 `.ratel-drawer-src-api .ratel-drawer-src-dot` L397 的 `box-shadow`(随 source-pill 删除)

#### 4.4.5 i18n key 清理

删除以下 key(因 source-pill / token-meter / 附件统计从抽屉移除):
- `status.drawer.label.dataSource`
- `status.drawer.attachmentsCount`
- `status.drawer.sourceApi`
- `status.drawer.sourceStreaming`
- `status.drawer.sourceEstimate`

**注意**:`status.tokenSource.*` 系列共享 key 在 StatusLine 和 StatusDrawer 的 source-pill 都删除后变为死代码,一并删除。共 6 个 key:`api` / `streaming` / `estimate` / `apiTitle` / `streamingTitle` / `estimateTitle`(后三个是 tooltip 文案,与主 key 一同删除)。plan 阶段需 grep 确认无其他引用点再删。

**涉及文件**:
- [src/ui/status/StatusDrawer.svelte](../../../src/ui/status/StatusDrawer.svelte) L143-176(template)+ L271 / L337 / L397(style)
- [src/i18n/types.ts](../../../src/i18n/types.ts) + zh.ts + en.ts(删除 11 个 key:5 drawer 专属 + 6 tokenSource 共享含 Title 变体)

---

### 4.5 Section 5:样式合规化

#### 4.5.1 圆角违规修正(2 处)

| 文件 | 行 | 选择器 | 旧值 | 新值 |
|---|---|---|---|---|
| `ChatView.svelte` | L512 | `.ratel-header-badge` | 12px | 8px |
| `StatusDrawer.svelte` | L271 | `.ratel-drawer-pill` | 10px | 8px |

#### 4.5.2 box-shadow 违规删除(17+ 处)

**ChatView.svelte**:
- L596 `.ratel-plus-btn` 按钮微阴影
- L629 textarea 内嵌微阴影
- L634 textarea:focus 焦点光晕(改用 `outline: 2px solid var(--accent)` 替代,或 `border-color` 增强)
- L660 / L668 `.ratel-send` / `:hover` 按钮投影
- L684 / L689 `.ratel-stop` / `:hover` Stop 按钮投影

**StatusLine.svelte**(随 Section 2 一并处理):
- L157 `.ratel-sl-dot-ready` 光晕
- L167 `.ratel-sl-dot-error` 光晕
- L217 / L224 ctx-bar / ctx-fill(随整块删除)
- L286 source-dot(随 source-pill 删除)

**StatusDrawer.svelte**(随 Section 4 一并处理):
- L337 meter-track(随整块删除)
- L397 source-dot(随 source-pill 删除)

**其他组件**(本次 spec 范围内一并清理):
- `MessageBubble.svelte` L113 / L121 / L137 消息气泡投影
- `SearchResults.svelte` L68 搜索结果投影
- `ToolSegment.svelte` L139 工具调用点光晕
- `MessageList.svelte` L100 思考中点光晕

**替换策略**:
- 按钮投影 → 改用 `border` + `background` 对比度增强视觉层次
- 焦点光晕 → 改用 `outline` 或 `border-color` 增强
- 状态点光晕 → 删除(靠颜色 + 脉冲动画已足够区分)
- 消息气泡投影 → 改用 `border` + `background` 对比度

#### 4.5.3 class 前缀违规修正

- [styles.css](../../../styles.css) L77-134:`.diag-*` → `.ratel-diag-*`
- 同步修改诊断面板 TS 文件中引用这些 class 的位置(需 grep 确认引用点)

#### 4.5.4 注释修订

- [ChatView.svelte](../../../src/ui/chat/ChatView.svelte) L468-475:删除"用户明确要求阴影"注释块,改写为:

```css
/* 设计 token:Chat 输入区视觉层次靠 border + background 对比度,
   不使用 box-shadow(项目硬约束禁止)。圆角统一 ≤8px。 */
```

---

## 5. 影响面

### 5.1 代码影响

| 文件 | 改动类型 | 改动量 |
|---|---|---|
| `src/ui/chat/ChatView.svelte` | 改造 Header + 新增 work 条 + 删 gate + style 清理 | 大 |
| `src/ui/status/StatusLine.svelte` | 删 ctx 块 + style 清理 | 中 |
| `src/ui/status/StatusDrawer.svelte` | 精简上下文区 + style 清理 | 中 |
| `src/ui/status/tone.ts` | 新建(提取 tone 计算函数) | 小 |
| `src/i18n/types.ts` | 新增 5 key + 删除 11 key | 小 |
| `src/i18n/zh.ts` | 新增 5 翻译 + 删除 11 key | 小 |
| `src/i18n/en.ts` | 新增 5 翻译 + 删除 11 key | 小 |
| `src/ui/MessageBubble.svelte` | 删 box-shadow | 小 |
| `src/ui/SearchResults.svelte` | 删 box-shadow | 小 |
| `src/ui/ToolSegment.svelte` | 删 box-shadow | 小 |
| `src/ui/MessageList.svelte` | 删 box-shadow | 小 |
| `styles.css` | `diag-` → `ratel-diag-` | 小 |
| 诊断面板 TS 文件 | class 引用同步 | 小 |

### 5.2 测试影响

- **现有 652 个测试应全部通过**(本 spec 不改业务逻辑,只改 UI 呈现)。
- **新增测试**(可选,留作 plan 决定):
  - `tone.ts` 的 `deriveTone(snapshot)` 单元测试
  - Header 百分比胶囊阈值变色测试(0-79/80-94/95-100)
- **UI 快照测试**:项目当前无 Svelte 组件快照测试,本 spec 不引入。

### 5.3 用户可见行为变化

- Header 新增 R logo + 百分比胶囊 + badge 随状态变色
- StatusLine 变短(只留点 + 文字 + 箭头)
- Input 下方新增 work 条(空闲时不显示)
- 抽屉上下文区变短(只留 used/max + 压缩按钮)
- 全局:圆角统一 ≤8px,无阴影,视觉更扁平

### 5.4 文档同步

按 AGENTS.md「文档同步规则」,本 spec 涉及 `feat` / `fix`,需评估:

- [ ] **README**:不触发(不改功能清单 / 安装步骤 / 隐私说明)
- [ ] **user-guide**:不触发(无新斜杠命令 / secret ID;状态条 / 抽屉的用户可见行为变化属于 UI 微调,不涉及操作指引)
- [ ] **CHANGELOG**:标记待办(下次发版覆盖)
- [ ] **ARCHITECTURE.md / adr/**:不触发(不改模块边界 / 端口契约 / 数据模型;`tone.ts` 是纯内部重构,不改变架构契约)

**结论**:本 spec 实施后只需在 CHANGELOG `[Unreleased]` 块补一行,无需动其他文档。具体在 `finishing-a-development-branch` Step 0 确认。

---

## 6. 实施建议

### 6.1 Plan 拆分建议

按"可独立验证 + 依赖顺序"原则,建议拆 2 个 plan:

- **P-CHAT-UI-1-layout**(主 plan):Section 1 Header + Section 2 StatusLine + Section 3 work 条 + Section 4 抽屉精简。这 4 个 Section 有强依赖(百分比从 StatusLine 外移到 Header,tone 共享函数要先抽),不适合再拆。
- **P-CHAT-UI-2-style**(独立 plan):Section 5 样式合规化(圆角 + box-shadow + class 前缀 + 注释)。与其他 Section 无依赖,可独立提交,也可合并到 P-CHAT-UI-1。

**推荐**:合并为单 plan `P-CHAT-UI-1`,按 Task 分组提交(feature-based commit),避免过度碎片化。

### 6.2 验证策略

- 每个 Task 完成后跑 `npm test` 确保 652 测试不退化
- 每个 Task 完成后跑 `npm run build` 确保打包成功
- 最终 `npm run dev` 在 Obsidian 中人工验证:
  - Header badge 5 种 tone 颜色正确
  - 百分比胶囊阈值变色正确
  - StatusLine 简化后不显示百分比
  - work 条在索引中 / 搜索中 / 思考中正确显示
  - 抽屉上下文区只剩 used/max + 压缩按钮
  - 全局无 box-shadow,圆角 ≤8px

---

## 7. 参考

- 原型:[`docs/prototype/chat-ui-mockup.html`](../../prototype/chat-ui-mockup.html)
- AGENTS.md「文档同步规则」
- AGENTS.md「i18n 强制规则」
- memory 记录的设计原则(user_profile.md / project_memory.md)
- 相关 spec:
  - S-CHAT-UI(已归档)— Chat 消息流重构的基础
  - S-MSG-STREAM(已归档)— 消息段流式渲染
  - S-I18N-V2(已归档)— i18n V2 全量实现
