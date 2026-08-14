# S-MD-PREVIEW — Markdown 预览壳（统一块 + 共用 overlay）

> **ID:** S-MD-PREVIEW  
> **状态:** Active（v1 富块 P-MD-PREVIEW-1 已落地并归档 plan；overlay 见 P-MD-PREVIEW-2）  
> **日期:** 2026-08-14  
> **前置:** S-MD-MERMAID（已归档，能渲染）、现网代码卡片 enhance  
> **动机:** 助手 Markdown 能画 mermaid / 高亮代码，但图是裸 SVG，无复制源码、无放大；代码块与图表两套皮。要对齐 Cursor / GitHub / VS Code Markdown 预览的「独立块 + 动作条」，且**不得丢掉流式打字机**。

---

## 1. 背景

现网管线（`MarkdownView`）：`content` delta → rAF 节流 → `renderMarkdownToHtml`（marked + hljs + DOMPurify）→ `innerHTML` → 闭合围栏后 `renderMermaidBlocks` 把 `<pre><code class="language-mermaid">` **整段换成** `.ratel-mermaid` SVG。代码围栏另走 `.ratel-code-block` 顶栏复制。

用户可见缺口：

- mermaid 能渲染，但无顶栏、无复制源码、无放大；宽图在窄侧栏被压扁。
- 代码块刚有卡片，图表仍是另一套皮肤。
- 表格可撑破侧栏；附件图只能看缩略，无灯箱。

调研共识（ChatGPT/Claude 弱交互；**Cursor Plan 聊天**、**GitHub**、**VS Code Markdown Mermaid Zoom**、BookStack viewer）：独立块、复制源码、大图进全屏再 pan/zoom。侧栏里滚轮必须和消息列表隔离。

已确认产品方向：

- 范围取「整页预览升级」的 **v1 切片**（统一性优先，不是只补 mermaid 专用壳）。
- **不做** callout / GitHub Alerts、`$$` 公式、`[[wiki]]`、导出 PNG/SVG、用户消息 Markdown。
- 实现走 **统一富块 + 共用 overlay**（不为代码/mermaid 各做一套皮）。

---

## 2. 目标

1. **统一富块** `.ratel-md-block`：围栏代码与 mermaid 同一套边框 / 顶栏 / 按钮语言。  
2. **复制**：代码复制高亮解码后的源码；mermaid 复制围栏源码（渲染成 SVG 后源码仍在）。  
3. **放大**：mermaid 与消息内图片进入**同一套**聊天叶子 overlay；层内才缩放/拖移。  
4. **表格**：横滚外壳，圆角边框与块一致；v1 无顶栏。  
5. **打字机不回归**：流式仍是 delta 追加 + rAF 全量 Markdown 重绘，观感为逐字/逐词往下长，不得变成「整段蹦」或卡顿闪白。  
6. **i18n**：新增按钮 / aria 走 `zh` / `en` / `types`。

成功标准（可验收）：

- 助手消息里 \`\`\`json 与 \`\`\`mermaid 顶栏视觉一致；都有「复制」；mermaid 另有「放大」。  
- 复制 mermaid 得到的是源码，不是 SVG markup。  
- 点放大后图在 overlay 内可读、可 +/- / 拖移 / 重置；**消息列表滚轮不被图抢走**。  
- Esc / 点遮罩关闭 overlay。  
- 宽表格在侧栏内横滚，不撑破聊天列。  
- 点附件缩略图或 Markdown `img` 进入同一 overlay。  
- 流式输出时正文仍随 delta 增长（见 §4）；未闭合围栏不画 mermaid、不进 overlay。  
- `npm test` / `npm run build` 通过。

---

## 3. 非目标

- Callout / GitHub Alerts、KaTeX/`$$`、wiki 链接 / embed。  
- 导出 PNG/SVG、跳转 mermaid.live、在线编辑图表。  
- 用户消息做 Markdown（保持纯文本）。  
- Token 级增量 DOM diff（S-MD-MERMAID 已否决）。  
- 新增 pan-zoom / lightbox npm 包（CSS `transform` + 自写 overlay）。  
- 改 Agent Loop、引用算法、权限。  
- mermaid 主题跟随 Obsidian 亮暗（现网写死 `dark`；本 spec 不强制改，允许实施时顺手用 CSS 变量若零风险）。

---

## 4. 打字机（硬约束，不可破）

S-MD-MERMAID / 2026-06-27 回归：一旦把「文本节点追加」改成「少次大块替换」或阻塞在 mermaid 异步上，打字机就会变成一段一段刷新。

**现网机制（必须保留）：**

| 层 | 行为 |
|---|---|
| 数据 | 助手 `content += delta`，Svelte 5 `$state` 驱动 `MarkdownView` 的 `content` |
| 节流 | `$effect` + `cancelAnimationFrame` / `requestAnimationFrame`：同一帧多次 delta 只画最后一次 |
| 绘制 | `renderMarkdownToHtml` **全量**解析 + `innerHTML` 写入 `.ratel-md`（不是 `{@html}` 分片、不是虚拟 DOM diff） |
| 选区 | 容器内有 Selection 则暂存、松手再刷（复制正文不能被流式冲掉） |
| mermaid | `areAllCodeBlocksClosed` 为假时**不**调用 `mermaid.render`；闭合后再画 |
| 收尾 | `streaming` true→false 再强制 `renderToDom(..., true)` |

**本 spec 额外禁止：**

1. 等 `mermaid.render()` **完成**才把本帧 HTML 写进 DOM（正文必须先出现，图后补）。  
2. 每帧对整页做重布局测量、或同步导出 canvas。  
3. 流式中打开 overlay 时 **暂停** `content` 刷新（列表里的字还得继续长；overlay 用已缓存的源码/SVG 快照，不跟每一帧 innerHTML 重建绑死）。  
4. 用「防闪」为名降低 rAF 频率到肉眼可辨的大步跳跃（保持一帧一刷上限，不人为 debounce 到 100ms+）。  
5. 把顶栏按钮做成每帧卸载/挂载的 Svelte 组件树替代 `innerHTML` 管线。

**允许：** innerHTML 之后对块做一次轻量 enhance（挂按钮、给 mermaid 套壳）；enhance 必须幂等、可 `cleanup`，失败不得打断下一帧。

**验收口令：** 生成一篇带短段落 + 一个已闭合小 mermaid + 后续正文的回复，肉眼仍是「字在往下长」，不是「等图好了整段出现」或「每半秒跳一块」。

---

## 5. 详细设计

### 5.1 统一块 `.ratel-md-block`

代码围栏与 mermaid **同一 class 合同**：

```
.ratel-md-block
  .ratel-md-block-bar
    .ratel-md-block-label     // 语言 / mermaid / 空
    .ratel-md-block-actions
      button.ratel-md-copy    // 始终有
      button.ratel-md-expand  // 仅 mermaid
  .ratel-md-block-body
    pre>code  或  svg / 错误条
```

现网 `.ratel-code-block` / `.ratel-code-copy` **迁到这套名字**（可短暂双 class 兼容，plan 结束前只留新名）。

HTML 层：`renderMarkdownToHtml` 在 sanitize 前把围栏 `<pre><code>` 包进块壳（mermaid **也包**，不再把 mermaid 排除在外壳之外）。块根写 `data-ratel-fence="mermaid"|code`；mermaid 源码写在 `data-ratel-src`（属性内 HTML 转义）。**复制与 overlay 只读该属性**，禁止从 SVG 反推源码。过长源码仍放属性（Obsidian 桌面侧栏可接受）；不另插 `script` 节点，以免 DOMPurify / innerHTML 再丢一层。

**关键路径：** `SANITIZE_CONFIG.ADD_ATTR` 必须包含 `data-ratel-src`、`data-ratel-fence`，否则 DOMPurify 会剥掉源码钩子，复制 mermaid 会空。

DOM 层：`enhanceMdBlocks`（由现 `enhanceCodeBlocks` 扩展或改名）只补按钮与监听；已有按钮不叠层。

样式：主规则写在 `styles.css` 的

`.workspace-leaf-content[data-type="ratel-chat"] .ratel-md .ratel-md-block`

压过 Obsidian 全局 `pre` / `button`。Svelte scoped 只留降级，不以它为唯一来源。

### 5.2 mermaid 替换时机

`renderMermaidBlocks` 改为：**在已有 `.ratel-md-block[data-ratel-fence="mermaid"]` 的 body 里**把 `pre` 换成 SVG，**不拆掉外壳和顶栏**。源码属性留在块根上。

失败：body 内 `.ratel-md-block-error` 文案（i18n `chat.md.mermaidFailed`，`{message}`）+ 仍可复制源码。不要退回成与代码块不同的裸 `pre`。硬编码「Mermaid 渲染失败」删除。

未闭合：保持 `pre>code` 在壳内当代码看（可复制当前半截），不调 mermaid。

### 5.3 共用 overlay `.ratel-md-overlay`

挂在 `.workspace-leaf-content[data-type="ratel-chat"]` 上（盖住该叶子，不盖整个 Obsidian；**不用** `Modal`）。

| 入口 | 内容 | 顶栏动作 |
|---|---|---|
| mermaid「放大」 | SVG 快照（打开当下的一份） | 复制源码、+/-、重置、关闭 |
| 附件 `img.ratel-msg-img` | 原图 | 关闭 |
| `.ratel-md img` | 该图 | 关闭 |

层内手势（仅 overlay 打开时、仅 overlay 节点上）：

- 滚轮 / pinch → 缩放（`transform: scale`，原点跟指针）  
- 拖移 → translate  
- 双击或重置钮 → scale=1, translate=0  
- Esc、点遮罩、关闭钮 → 关  

消息列表在 overlay 打开时仍可在遮罩外不可点；**不要**在 `.ratel-md` 气泡内绑定滚轮缩放。

流式：overlay 打开期间 `MarkdownView` 继续 rAF 刷新底下的消息；overlay 内容用打开时快照，避免每帧把正在看的图拆掉。关掉 overlay 后底下已是最新 DOM。

### 5.4 表格

`renderMarkdownToHtml` 把 `<table>…</table>` 包进 `.ratel-md-table-wrap`（`overflow-x: auto`，边框/圆角对齐 `.ratel-md-block`）。无顶栏、无复制。

### 5.5 图片

`MessageBubble` 附件图与 `.ratel-md img` 共用 overlay 打开函数。不新做第二套灯箱皮肤。Markdown 外链图若被 DOMPurify 放行则同样可点；加载失败 overlay 显示简短错误（i18n）。

### 5.6 模块边界

| 文件 | 职责 |
|---|---|
| `src/utils/markdown-renderer.ts` | 包 `.ratel-md-block` / `.ratel-md-table-wrap`；sanitize |
| `src/utils/mermaid-renderer.ts` | 只替换块 body 为 SVG / 错误条 |
| `src/ui/chat/md-block-enhance.ts` | 挂复制 / 放大；替代或演进 `code-block-enhance.ts` |
| `src/ui/chat/md-preview-overlay.ts`（或小 Svelte） | 叶子内 overlay：开/关、缩放、复制 |
| `src/ui/components/MarkdownView.svelte` | 仍管 rAF + innerHTML + 选区；调用 enhance；**不**把 overlay 建进每条消息 |
| `styles.css` | 块 / 表格壳 / overlay / 按钮重置 |
| `src/i18n/zh.ts` `en.ts` `types.ts` | 新 key：`chat.md.copy` / `copied` / `expand` / `close` / `zoomIn` / `zoomOut` / `zoomReset`。删除或改映射现有 `chat.code.copy` / `copied`，禁止两套「复制」文案并存 |

Overlay 单例挂在 ChatView 叶子，避免每条消息一个层。

### 5.7 错误与无障碍

- 复制失败：按钮不假装「已复制」；不弹阻塞 Modal。  
- mermaid 失败：块内错误条，复制仍可用。  
- 按钮 `type="button"`，`aria-label` 用 i18n。  
- overlay `role="dialog"`，`aria-modal="true"`，打开时焦点进层，关闭回触发按钮。  
- `prefers-reduced-motion`：overlay 淡入关掉；缩放仍可用、无弹跳动画。

---

## 6. 测试

- renderer：围栏代码与 mermaid 都输出 `.ratel-md-block`；mermaid 带源码钩子；表格有 wrap；行内 `code` 不进块。  
- enhance：复制代码 / 复制 mermaid 源码；已包不叠层；未闭合或尚未换成 SVG 的 mermaid **不显示**「放大」。  
- overlay：打开/Esc 关；不在单测里跑真实 mermaid 全量（可 stub `mermaid.render`）。  
- 打字机：保留 / 补一条「未闭合围栏时仍写入 HTML、不 await mermaid」的单元或轻量时序断言（`renderToDom` 路径不阻塞）。  
- 回归：`tests/utils/markdown-renderer.test.ts`、现有 mermaid extract 测试。

---

## 7. 影响面

- **用户：** 助手消息里代码/图/表更好用；流式观感不变。  
- **包体积：** 不新增 mermaid/marked；不新增 pan-zoom 库。  
- **架构文档：** 不改 ports / Worker；无需 ADR。  
- **文档同步：** 实施完成走 finishing 时确认 user-guide（复制代码、放大 mermaid、点图）。  

---

## 9. 实施拆分

一张 spec、两份 plan（各自可独立验收、可单独合入）：

| Plan | 交付 | 合入后用户能做什么 |
|---|---|---|
| **[P-MD-PREVIEW-1](../archive/S-MD-PREVIEW/2026-08-14-md-preview-blocks.md)**（已归档） | 统一 `.ratel-md-block`、表格横滚、复制（含 mermaid 源码）、mermaid 只换 body、打字机约束 | 代码/图同一套卡片；能复制源码；表不撑破侧栏 |
| **[P-MD-PREVIEW-2](../plans/2026-08-14-md-preview-overlay.md)** | 叶子 overlay：放大 mermaid、+/-/拖移、Esc；附件与 md 图灯箱 | 能看清大图；列表滚轮不被抢 |

1 不依赖 2。2 依赖 1 的块合同与 `data-ratel-src`。`enhanceMdBlocks` 的 `onExpand` 在 1 里可选：未传入则不渲染「放大」。

---

## 8. 参考

- 归档 [S-MD-MERMAID](../archive/S-MD-MERMAID/2026-06-27-ratel-streaming-markdown-mermaid-design.md)  
- [2026-06-27 打字机回归](../../bug-report/2026-06-27-chat-ui-and-streaming-regression.md)  
- Cursor Plan 聊天 mermaid：展开 / 缩放 / 复制源码  
- GitHub Markdown mermaid pan/zoom；VS Code「Markdown Mermaid Zoom」全屏 overlay  
- BookStack mermaid-viewer：复制源码 + 锁滚轮  
