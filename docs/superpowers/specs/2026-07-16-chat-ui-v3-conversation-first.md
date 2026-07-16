# Chat UI v3 — Conversation-first 设计(S-CHAT-UI-V3)

> 日期: 2026-07-16  
> 状态: Active  
> 作者: Erwin(原型 `docs/prototype/chat-ui-mockup.html` v3 获认可后落盘)  
> 关联: S-CHAT-UI / S-CHAT-UI-V2(已归档,打磨骨架)、S-EVOLUTION(图谱原生主张)、原型 [`docs/prototype/chat-ui-mockup.html`](../../prototype/chat-ui-mockup.html)

---

## 1. 背景

S-CHAT-UI-V2 已把侧栏打磨成「可用的 Agent 聊天」:Header 三件套、StatusLine/Drawer、work-bar、无 box-shadow。但观感仍偏 **IDE 运维台**:状态条夹在消息与输入之间、Header 信息过载、工具/检索像日志 dump。这与对外主张 **graph-native AI agent** 的「和知识库说话」气质冲突。

2026-07-16 原型 v3 按 **Conversation-first** 重做,用户反馈「好太多了」。本 spec 把原型与现网差异固化为可实施契约,供后续 1–N 个 plan 落地。

### 1.1 现网布局(AS-IS)

```
Header: R logo + 标题 + %胶囊 + 模型 badge(tone 变色)
Messages: MessageBubble + ToolSegment 卡片 + SearchResults 分数墙
StatusLine: 常驻 30px(点 + 文案 + ▲)      ← 夹在消息与输入之间
StatusDrawer: 索引详情 + 上下文 + 压缩
Input: 附件/@ + textarea + Send/Stop
work-bar: 条件显示(indexing/downloading/…)
```

### 1.2 原型布局(TO-BE)

```
Header: Ratel. + graph-native 副标 + 模型 chip(无 %、无 tone 脉冲)
Messages: 用户气泡 + 细线工具时间线 + 正文 + 引用芯片
Composer 壳:
  StatusStrip(薄条:点 + 就绪/忙 + 右侧 % )  ← 沉入输入区顶沿
  StatusDrawer(从 strip 展开,仅索引/上下文两块)
  Input(圆角一体框: + / textarea / ↑)
```

---

## 2. 目标

1. **对话优先**:消息区是视觉主角;运维信息不打断「读回复 → 打字」脊柱。  
2. **图谱叙事**:检索/链接结果以**可点击笔记芯片**呈现,而非分数表 + emoji 卡片。  
3. **忙态单通道**:同一时刻用户只从一处感知「正在干活」(StatusStrip 文案 ± 时间线 calling 行);Header 不再用 tone 脉冲抢戏。  
4. **可渐进落地**:视觉与布局可分 Phase 合并;不改 Agent Loop / 消息协议 / Worker。  
5. **Obsidian 主题兼容**:不引入固定「暖墨色」到生产(原型色仅作气质参考);生产用 `--background-*` / `--text-*` / 单一 accent 语义映射。

## 3. 非目标

- 不重做 Agent Loop、segment 数据模型、tool 执行协议  
- 不在本期实现完整模型切换器(Header chip 仍可打开现有 ModelInfoModal / 跳设置)  
- 不强制引入 Google Fonts 到插件包(原型字体仅设计参考;生产可用系统栈 + 可选 `--font-interface`)  
- 不重做诊断面板 / 设置页视觉  
- 不把 StatusDrawer 做成独立 View  
- Canvas / Bases UI 集成  
- 移动端布局

---

## 4. 差异对照(原型 ↔ 现网)

| 维度 | 现网 | 原型 v3 | 本 spec 决策 |
|---|---|---|---|
| Header | logo 方块 + 标题 + **%** + **tone badge** | 词标 + 副标 + 静默 model chip | **采用原型**:去掉 Header % 与 tone 脉冲;% 挪到 StatusStrip |
| Status 位置 | 消息与 Input **之间** | Composer **顶沿** | **采用原型**:StatusLine 迁入 composer 壳内,消息区直接贴 composer |
| Status 视觉 | 30px 工具条 + 展开箭头 | 更薄的 strip + 右侧 mono % | 精简高度与字重;保留点击展开 |
| Drawer | 向量化多行 + 运行模式 + 历史红字位 | 两块:索引 / 上下文 | **精简**:去掉运行模式警示叙事;索引只显示就绪/篇数/Embedding 类型;上下文 used/max + meter + 压缩 |
| 工具 UI | Collapsible 厚卡片 + ✓/✗ | 左边线 + 单行 mono 时间线 | **采用时间线**;展开仍显示 args/result |
| 思考段 | 黄字折叠卡 | 时间线一行 `◇ 思考` | 并入时间线或保持轻折叠,去掉 emoji |
| 检索结果 | 🔍 卡片 + 分数色阶表 | 正文 `[n]` + **cite-chip** 行 | **采用芯片**;分数可弱化到 chip 次要位或省略 |
| work-bar | Input 下方独立条 | 无独立条,忙态进 StatusStrip | **合并**:索引中/下载中/准备模型 → StatusStrip 文案;删除或降级为 strip 同构 |
| 输入框 | 分列 + / textarea + 底栏 Send | 一体圆角框 + 右上发送 | **采用一体框**;Send/Stop 仍在框内 |
| 色板 | Obsidian 变量 + 成功绿 | 暖墨 + copper | 生产映射:`accent`→主题 accent 或铜调 CSS 变量(可选 `ratel-accent`);禁止绑死原型 hex |

---

## 5. 详细设计

### 5.1 信息架构

```
┌─────────────────────────────────────┐
│ Header: Brand · model chip          │
├─────────────────────────────────────┤
│                                     │
│  Messages (flex:1)                  │
│  · user bubble                      │
│  · assistant: Trace → Prose → Chips │
│                                     │
├─────────────────────────────────────┤
│ StatusStrip  [● 就绪        12%] ▲  │  ← composer 壳
│ ├─ Drawer (可选展开)                │
│ └─ InputBox (+ · textarea · ↑)      │
└─────────────────────────────────────┘
```

**硬规则:**

- StatusStrip **不得**再插在 MessageList 与 Input 之间的「中间层」(现网位置废弃)。  
- Header **不得**再显示上下文百分比与 tone 脉冲徽章。  
- 对话进行中(`isRunning`):StatusStrip 显示忙态文案(如「思考中…」「检索中…」),**不再**同时点亮 Header badge 脉冲 + work-bar 黄条(三选一 → 只留 Strip)。

### 5.2 Header

| 元素 | 行为 |
|---|---|
| Brand | 文案 `Ratel` + 可选副标 i18n(`chat.header.tagline` = graph-native / 图谱原生);去掉大方块 `R` logo 或改为极简词标 |
| Model chip | 显示 `chatModel`;点击 → 现有 ModelInfoModal(只读 + 跳设置);**无** tone 修饰类 |

### 5.3 StatusStrip + Drawer

**Strip 内容(从左到右):**

1. 状态点(ready=绿语义 / busy=警告语义 / error=错误 / unconfigured=空心)  
2. 文案:`deriveTone` + `chatBusy` 合成的短句(复用现有 StatusLine 逻辑,改皮肤)  
3. spacer  
4. 上下文 `%`(原 Header 胶囊迁入;阈值色可保留,但用文字色而非大胶囊)  
5. 展开 chevron  

**Drawer 内容(精简):**

- **索引**:状态、篇数(`indexDocCount>0` 才显示篇数)、Embedding 类型(本地/API)  
- **上下文**:used/max、细 meter、压缩按钮  
- **删除**:运行模式 hint-pill、任何「可在设置启用 Worker」类文案(已在 0.1.7 去掉 degraded,Drawer 也不要回潮)

组件改造建议:保留 `StatusLine.svelte` / `StatusDrawer.svelte` 文件,改 DOM 层级挂载点与 class;或重命名为 `StatusStrip` 以免语义混淆(plan 自定)。

### 5.4 消息:Trace 时间线

**范围:** `ToolSegment`、`ThinkSegment`(及可选把多次 tool 收成同一 Trace 容器)。

**折叠态(默认 done/failed):**

```
│ ✓  search_by_tag · project/perf          4
│ ✓  search_vault · 性能优化               3
│ ●  get_links · 产品规划/MOC.md           图   ← calling 时
```

**展开态:** 现有 args / result 区块(可保留 Collapsible 内核,换外壳)。

**规则:**

- 不用 🔍💭 等 emoji 作主图标;用 `✓` / `✗` / 脉冲点 / `◇`(思考)  
- `displayName` 继续走 `format-tool-display` + i18n  
- calling 默认展开或保持时间线高亮一行(与现网 calling 可见性等价)

### 5.5 检索结果与引用机制(正文 `[n]` ↔ 芯片)

> 现网缺口:`TextSegment` 经 `MarkdownView` 渲染,`[1][2]` 只是纯文本;**无**点击跳转。`SearchResults` 是独立分数表。`types.ts` 已预留 `citation` segment 但未实现。原型同时有正文铜色散链 + 底部 cite-chip。

#### 5.5.1 数据源(不改协议)

- 仍由 `search.result` 事件写入 `Message.searchResults: { docId, score, path, index }[]`  
- `index` 从 1 起,与模型回答中的 `[n]` **同一编号空间**  
- 可选附带结构信号(`tags` / `backlinkCount`,来自 0.1.7 enrich);芯片次要位可显示反链数

#### 5.5.2 呈现(双通道,同一数据)

| 通道 | 形态 | 行为 |
|---|---|---|
| **A. 正文内联** | Markdown 中的 `[n]` / `[[n]]` 渲染为可点击 cite 链(铜调 / accent) | 点击 → 打开 `searchResults` 中 `index===n` 的 `path`;无匹配则忽略 |
| **B. 底部芯片行** | 取代现 `SearchResults` 大卡;每条 chip:`n` + 截断 path + 可选弱化 meta | 点击 → 同上打开笔记 |

**硬规则:**

1. A 与 B **共用同一打开函数**(禁止两套跳转逻辑)。  
2. 去掉 🔍 标题卡、精排大徽章、三档分数色块表;rerank 若需提示,用芯片行上方一行 11px muted(`已精排` i18n)。  
3. score **默认不展示**;若调试需要,仅以 mono 弱文案出现在 chip 末尾(非色阶墙)。  
4. 流式输出期间:芯片可在 `search.result` 到达后立刻出现;正文 `[n]` 在 Markdown 重渲染时挂上点击(streaming 结束再 bind 也可,plan 自定,但不得丢点击)。  
5. **不**在本期实现自动从正文抽取 citation segment 写入消息模型;以内联正则/渲染期增强 + `searchResults` 查找即可(YAGNI)。完整 `citation` segment 类型仍预留。

#### 5.5.3 打开笔记

- 优先:`app.workspace.openLinkText(path, '', false)` 或项目已有等价封装(经 Workspace 外观,若尚无则 ChatView 内薄封装,禁止散落 `import 'obsidian'` 到 SearchResults——可注入 `onOpenPath(path)`)。  
- 路径必须是 vault 相对路径;非法 / 不存在 → Notice + 不抛未捕获异常。  
- 与 S-EVOLUTION Phase B `open_note` 工具对齐时复用同一底层,本期不阻塞。

#### 5.5.4 无检索结果时

- 模型若写了 `[1]` 但本轮无 `searchResults`:内联保持普通文本样式(不可点),不报错。  
- 芯片行不渲染。

### 5.6 展开层 / 浮层 / Dialog(原型未全画,生产必须定)

| 表面 | 现网 | 本 spec |
|---|---|---|
| **StatusDrawer** | 消息与输入之间展开 | 仍从 StatusStrip 展开,**向上占 composer 上方空间**(max-height 动画);打开时消息区被挤短,不盖住 Header;点 Strip 再收起 |
| **Trace 行展开** | Collapsible 厚卡片 | 时间线下一行 detail 面板(原型 `.trace-detail`):等宽 args/result;边框轻、无大阴影;同一时刻允许多行展开 |
| **SlashMenu** | 输入区上方浮层 | 相对 **composer 一体框** 定位(底边贴框顶);圆角 8–12;项:`cmd` mono accent + `desc` muted;键盘上下/Enter/Esc 行为不变 |
| **MentionMenu** | 同 Slash | 与 Slash **互斥**(现网已有);皮肤与 Slash 统一;选中后 MentionStrip chip 样式对齐原型 sage 弱色(主题 accent 映射) |
| **ModelInfoModal** | Obsidian Modal | 保留;仅入口改为 Header model chip;Modal 内部不做大改(非目标) |
| **Compact 确认** | 现有 confirm | 保留逻辑;按钮视觉随 ghost/primary 规范,不新开设计 |
| **Stop / 错误块** | Send 变 Stop;bubble 内 error | 保留;Stop 在一体框内右侧;error 左边线强调,与 Drawer 错误点语义一致 |

**浮层硬规则:**

- Slash / Mention 不得再相对「旧 StatusLine 夹层」定位;统一相对 `.ratel-composer`。  
- Drawer 与 Slash **可同时存在**(少见);若冲突,优先保证输入焦点与 Slash 可见。  
- 所有展开层遵守:无 emoji 装饰标题、无多色 pill 堆、圆角 ≤12。

### 5.7 进度与 Meter 渐变

> 原型 Drawer 上下文 meter:`linear-gradient(90deg, copper → sage)`。Strip 右侧仅数字 `%`。现网 Header 胶囊按 80%/95% 换纯色。

#### 5.7.1 上下文占用(主)

| 位置 | 形态 |
|---|---|
| StatusStrip | **仅 mono 百分比文字**(如 `12%`);颜色随阈值:`<80` 正常 / `≥80` warning / `≥95` error(映射 `--text-*`) |
| Drawer meter | **3–4px 高**轨道 + 填充条;填充使用 **双色水平渐变** |

**渐变生产定义(强制写清,避免「随便渐变」):**

```css
/* 语义:从「已用」(cite/accent 侧)过渡到「余裕」(success 侧) */
background: linear-gradient(
  90deg,
  var(--ratel-meter-from, var(--interactive-accent)) 0%,
  var(--ratel-meter-to, var(--text-success)) 100%
);
```

- `--ratel-meter-from` / `--ratel-meter-to` 可在 Chat 根节点定义;浅色/深色主题下需人工目视对比度合格。  
- **禁止**紫→蓝 AI 渐变、禁止彩虹多停靠点。  
- 宽度 = `min(percentage, 100)%`;过渡 `width 0.35s ease`。  
- 阈值变色作用于 **Strip 文字**;Drawer 渐变条本身不随 80/95 改成纯红(避免条变成报警灯);≥95% 时可选将 `meter-to` 改为 `--text-warning` 单次覆盖(plan 二选一,默认不改渐变、只改文字)。

#### 5.7.2 索引进度

- Drawer 内若索引 `processing`:可用**同款细轨道**,填充色用 warning 语义纯色即可(**不要**铜绿渐变,避免与上下文 meter 混淆)。  
- 进度数字仍以文案 `12/30` 或「索引中」为主;与 StatusStrip 忙态文案一致。

#### 5.7.3 其它

- 删除 Header 彩色大胶囊后,不再有第三处进度可视化。  
- 源(estimate/streaming/api)药丸:**默认不在 Strip 展示**(减噪);若需保留,仅放 Drawer 上下文块一行 muted,非原型重点可不做(P4 可选)。

### 5.8 work-bar 合并

| 现 work-bar 态 | 新载体 |
|---|---|
| indexing / downloading / preparing / searching / compacting | StatusStrip 文案(+ busy 点) |
| hard gate 不可发送 | 保留 gate:禁用 Send + Strip/placeholder 提示(不另起黄条) |

删除 Input 下方独立 `.ratel-work-bar` DOM(或 `display:none` 过渡一期后删)。

### 5.9 Composer 输入框

- **单一圆角壳**包裹:`+` | textarea | Send/Stop(三者**同框**,禁止各自独立边框拼盘)
- focus 时壳用 accent 描边 + soft ring(`:focus-within`;生产用 accent 透明度;禁止 box-shadow)
- 附件条 / MentionStrip 仍在一体壳**上方**(composer 壳内)
- SlashMenu / MentionMenu 定位相对 `.ratel-composer` / 输入区(§5.6)

### 5.10 主题与 token(生产约束)

| 原型 | 生产 |
|---|---|
| `--ink` / `--paper` / `--copper` | `--background-primary` / `--text-normal` / `--interactive-accent` 或 `--ratel-cite` |
| meter 铜→绿渐变 | `--ratel-meter-from` → `--ratel-meter-to`(§5.7) |
| Instrument Sans | 不打包 Web font |
| 圆角 14–16 | 建议 8–12 |
| 禁止 | 多色 pill 堆、Header 脉冲、夹层 StatusLine、紫蓝渐变 |

### 5.11 i18n

新增/调整(plan 补全):

- `chat.header.tagline`  
- `chat.cite.openNote`(aria)  
- `chat.search.rerankHint`(弱文案,替代大徽章)  
- work-bar 合并后的 Strip 文案复用/迁移  
- 删除仅服务旧 Search 大卡标题的冗余展示(若有)

### 5.12 建议实施分 Phase

| Phase | 内容 | 风险 |
|---|---|---|
| **P1 布局骨架** | StatusStrip 迁入 composer;Header 去 %/tone;work-bar→Strip;Drawer 精简 + meter 渐变;**一体输入壳**(§5.9,不可再推迟) | 中 |
| **P2 Trace + 浮层皮肤** | 时间线换皮;Slash/Mention 相对 composer 定位与统一皮肤 | 低 |
| **P3 引用机制** | 芯片取代 Search 大卡;**正文 `[n]` 可点** + 共用 `onOpenPath` | 中高 — 渲染挂钩 |
| **P4 抛光** | cite 色、Drawer 动效、可选 source 行 | 低 |

P1 **必须**含一体输入壳(用户已确认:分列 + / textarea / footer Send 不算 Conversation-first)。P3 必须含正文引用联动。

---

## 6. 影响面

| 区域 | 影响 |
|---|---|
| `src/ui/chat/ChatView.svelte` | 重排 DOM:Status* 移入 composer;删 work-bar;Header 精简 |
| `src/ui/status/StatusLine.svelte` | 改 strip 布局(+ %);皮肤 |
| `src/ui/status/StatusDrawer.svelte` | 精简区块 |
| `src/ui/status/tone.ts` | 逻辑保留;Header 不再消费 tone 修饰 |
| `src/ui/chat/message-stream/ToolSegment.svelte` | 时间线样式 |
| `src/ui/chat/message-stream/ThinkSegment.svelte` | 并入时间线或轻量皮 |
| `src/ui/chat/message-stream/SearchResults.svelte` | 芯片化 |
| `src/ui/chat/message-stream/TextSegment.svelte` / `MarkdownView` | 正文 `[n]` 可点击挂钩 |
| `src/ui/chat/input/SlashMenu.svelte` / `MentionMenu.svelte` | 相对 composer 定位 + 皮肤 |
| `src/i18n/*` | tagline、cite aria、rerank 弱文案、work-bar 合并 |
| `docs/prototype/chat-ui-mockup.html` | 视觉事实源(已存在) |
| `docs/user-guide.md` | 状态条位置说明(若有截图/文案) |
| **不影响** | Agent Loop、ports、Worker、索引、权限模型 |

## 7. 成功标准

- 侧栏静态截图:消息区与输入区之间**无**常驻运维条  
- 对话中仅 StatusStrip(或等价单通道)显示忙态;Header 无脉冲  
- `search_vault` 后:底部芯片可点开笔记;**正文 `[n]` 亦可点开同一笔记**  
- Drawer 上下文 meter 为双色水平渐变(from→to CSS 变量),非纯色块、非紫蓝彩虹  
- Slash/Mention 展开时贴齐 composer 框顶,键盘导航仍可用  
- Trace 行可展开查看 args/result  
- 现有 chat 冒烟:发送、停止、/compact、抽屉压缩、索引忙态文案仍正确  
- 浅色 / 深色主题对比度可读  

## 8. 参考

- 原型:[`docs/prototype/chat-ui-mockup.html`](../../prototype/chat-ui-mockup.html)(v3)  
- 归档:S-CHAT-UI-V2 execution-log(Header/StatusLine/work-bar 来源)  
- S-EVOLUTION:图谱原生主张与 cite/open 后续能力  
- 现网:`types.ts` `citation` segment 预留;TextSegment 尚未挂钩 `[n]`  

---

## 9. 自审

- [x] 展开层(Drawer / Trace / Slash / Mention / Modal)有专节  
- [x] 引用机制含正文+芯片双通道与打开契约  
- [x] Meter 渐变有 CSS 变量级定义与索引进度区分  
- [x] 与 S-EVOLUTION / 0.1.7 Worker 文案结论不冲突  
- [x] 未要求改协议或 Worker  
- [x] 生产主题约束写明,避免把原型 hex 当硬需求  
