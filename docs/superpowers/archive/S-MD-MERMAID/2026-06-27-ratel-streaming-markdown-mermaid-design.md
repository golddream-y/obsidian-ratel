# Spec:流式 Markdown + Mermaid 渲染

- **Spec ID**:S-MD-MERMAID
- **创建日期**:2026-06-27
- **状态**:Active
- **关联**:S-CHAT-UI(Chat UI 重设计的后续增强)

---

## 背景

当前 ChatView.svelte 的消息内容渲染为纯文本插值 `{msg.content}` + `white-space: pre-wrap`,**无 markdown 解析**。模型回复中的标题、列表、代码块、表格等 markdown 语法原样显示为 `#`、`*`、`` ``` `` 符号,可读性差。同时,模型生成的 mermaid 流程图代码块无法渲染为可视化图表。

项目此前从未引入任何 markdown 渲染库或 mermaid 依赖,Obsidian 的 `MarkdownRenderer.renderMarkdown` API 也未被使用。这是一个完全空白的功能领域。

### 流式约束

打字机效果刚修复(详见 `docs/bug-report/2026-06-27-chat-ui-and-streaming-regression.md`),核心机制是 `am.content += delta` 依赖 Svelte 5 `$state` Proxy 细粒度 DOM 更新。引入 markdown 渲染后,渲染管线从"文本节点追加"变为"HTML 字符串替换",必须保证打字机效果不退化。

---

## 目标

1. **助手消息 markdown 渲染**:标题(h1-h6)、列表(有序/无序)、代码块(带语法高亮)、表格、引用块、链接、粗体/斜体、行内代码、分隔线、任务列表
2. **mermaid 流程图渲染**:支持流程图(`graph`/`flowchart`)、时序图(`sequenceDiagram`)、类图(`classDiagram`)、甘特图(`gantt`)等 mermaid 语法,渲染为 SVG
3. **流式友好**:模型回复过程中(delta 不断追加),markdown 实时渲染,打字机效果保留,无明显闪烁
4. **XSS 防护**:模型输出经 DOMPurify 白名单过滤后再注入 DOM
5. **主题适配**:渲染输出的 HTML 通过 Obsidian CSS 变量适配亮/暗主题

## 非目标

- 用户消息不做 markdown 渲染(保持纯文本,避免用户输入的 markdown 语法被意外渲染)
- 不支持 Obsidian 扩展语法(`[[wiki links]]`、`![[embed]]`、`$$math$$`、callout 等)
- 不做 Token 级增量 diff 渲染(过度工程,全量重解析 + rAF 节流足够)
- 不做 markdown 编辑功能(只渲染不编辑)

---

## 详细设计

### 1. 技术选型

| 组件 | 选型 | 版本 | 体积(min) | 理由 |
|---|---|---|---|---|
| Markdown 解析 | marked | ^15 | ~40KB | 同步解析快,单条消息 < 1ms,流式友好 |
| XSS 防护 | DOMPurify | ^3 | ~20KB | 社区标准方案,白名单模式 |
| 代码高亮 | highlight.js(core + 按需语言) | ^11 | ~30KB | marked 内置 highlight 选项集成,按需加载控制体积 |
| 图表渲染 | mermaid | ^11 | ~1.2MB | 功能最全,ESM 支持 |

总包体积增量 ~1.3MB,`dist/main.js` 从 ~500KB → ~1.8MB。桌面端 Obsidian 插件(`isDesktopOnly: true`)可接受。

### 2. 架构:独立 MarkdownView.svelte 组件

```
ChatView.svelte
  └─ 消息渲染区:
     {#if msg.role === 'assistant'}
       <MarkdownView content={msg.content} streaming={isLast && isRunning} />
     {:else}
       <div class="ratel-content">{msg.content}</div>  ← 用户消息保持纯文本
     {/if}
```

**新建文件:**

| 文件 | 职责 |
|---|---|
| `src/ui/MarkdownView.svelte` | 渲染组件 — 接收 content + streaming prop,管理 rAF 节流 + DOM 更新 + mermaid 异步渲染生命周期 |
| `src/utils/markdown-renderer.ts` | 纯函数层 — marked 配置 + DOMPurify sanitize + highlight.js 集成,导出 `renderMarkdownToHtml(text): string` |
| `src/utils/mermaid-renderer.ts` | mermaid 初始化 + 异步渲染 — 导出 `renderMermaidBlocks(container: HTMLElement): Promise<void>` |

**不采用 Svelte action 方案的理由**:action 内管理 mermaid 异步渲染 + rAF 节流的生命周期较复杂,Svelte 5 action 的 update 时机和 `$effect` 不完全一致,容易出时序 bug。独立组件的 `$effect` + `onDestroy` 生命周期管理更自然。

### 3. 渲染管线

```
content 变化(delta 到达,Svelte 5 Proxy 触发 $effect)
  │
  ├─ rAF 节流:同一帧内多次 content 变化只执行最后一次
  │   (cancelAnimationFrame + requestAnimationFrame)
  │
  ├─ renderMarkdownToHtml(content)    [src/utils/markdown-renderer.ts]
  │   ├─ marked.parse(content, { highlight: hljsHighlight })
  │   │    ├─ 代码块:hljs.highlight(code, { language }).value
  │   │    └─ 输出 HTML 字符串(含 <pre><code class="hljs language-xxx">)
  │   └─ DOMPurify.sanitize(html, MERMAID_SANITIZE_CONFIG)
  │        └─ 白名单允许 mermaid SVG 标签和属性
  │
  ├─ Svelte {@html sanitizedHtml} 注入 DOM
  │
  └─ renderMermaidBlocks(container)   [src/utils/mermaid-renderer.ts]
       ├─ querySelectorAll('code.language-mermaid')
       ├─ 对每个 mermaid 代码块:
       │    ├─ 检测代码块是否闭合(``` 数量为偶数)
       │    ├─ 未闭合(streaming 中)→ 跳过,保留原始文本
       │    └─ 已闭合 → mermaid.render(id, code) → 替换为 SVG
       └─ 异步:await Promise.allSettled(renderPromises)
```

### 4. 关键设计决策

#### 4.1 rAF 节流

```typescript
let rafId = 0;
$effect(() => {
  const text = content;  // 追踪依赖
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(() => {
    renderToDom(text);
  });
});
onDestroy(() => cancelAnimationFrame(rafId));
```

同一帧内多个 delta(模型快速输出)只渲染最后一次,避免 60fps 被打满。

#### 4.2 mermaid 渲染时机

- **流式中**(`streaming=true`):检测内容中 ` ``` ` 数量,奇数 = 有未闭合代码块,mermaid 块不渲染(显示原始文本),避免半截 mermaid 代码触发渲染错误
- **完成时**(`streaming=false`):所有代码块已闭合,强制渲染所有 mermaid 块
- mermaid `render()` 是异步的,返回 `Promise<string>`,需 await 后替换 DOM

#### 4.3 mermaid 初始化

```typescript
import mermaid from 'mermaid';
mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',  // 后续可读 Obsidian 主题自适应
  securityLevel: 'strict',  // 防 XSS
});
```

`securityLevel: 'strict'` 禁止 mermaid 代码中的 HTML 标签和事件处理器。

#### 4.4 highlight.js 按需加载

```typescript
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import markdown from 'highlight.js/lib/languages/markdown';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
// ... 按需注册 7 种常用语言
```

只加载 core + 7 种常用语言,控制体积在 ~30KB。未注册语言回退为纯文本(不高亮)。

#### 4.5 DOMPurify 白名单

```typescript
const MERMAID_SANITIZE_CONFIG = {
  ADD_TAGS: ['svg', 'path', 'g', 'rect', 'circle', 'line', 'text',
             'polyline', 'polygon', 'defs', 'marker', 'foreignObject', 'span'],
  ADD_ATTR: ['viewBox', 'd', 'fill', 'stroke', 'stroke-width', 'x', 'y',
             'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
             'width', 'height', 'transform', 'class', 'id',
             'marker-end', 'marker-start', 'href', 'target'],
};
```

白名单允许 mermaid 生成的 SVG 标签和属性,过滤 `<script>`、`onerror`、`javascript:` 等 XSS 向量。

#### 4.6 主题适配

marked 输出裸 HTML(`<h1>`/`<table>`/`<pre><code>`)。MarkdownView.svelte 的 `<style>` 里用 Obsidian CSS 变量映射:

```css
:global(.ratel-md h1) { color: var(--h1-color, var(--text-normal)); font-size: 1.5em; }
:global(.ratel-md h2) { color: var(--h2-color, var(--text-normal)); font-size: 1.3em; }
:global(.ratel-md table) { border-collapse: collapse; }
:global(.ratel-md th), :global(.ratel-md td) { border: 1px solid var(--background-modifier-border); padding: 4px 8px; }
:global(.ratel-md code) { background: var(--code-background); border-radius: 3px; padding: 1px 4px; }
:global(.ratel-md pre) { background: var(--code-background); border-radius: 6px; padding: 10px; overflow-x: auto; }
:global(.ratel-md blockquote) { border-left: 3px solid var(--background-modifier-border); padding-left: 10px; color: var(--text-muted); }
```

mermaid 主题:初始化时设 `theme: 'dark'`,后续可通过检测 Obsidian 主题(`document.body.classList.contains('theme-dark')`)自适应切换 `'dark'` / `'default'`。

### 5. 用户消息 vs 助手消息

- **用户消息**:保持纯文本 `{msg.content}`(用户输入不需要 markdown 渲染,且避免用户输入的 markdown 语法被意外渲染)
- **助手消息**:用 `<MarkdownView>` 渲染(模型输出需要 markdown 格式)

### 6. 错误处理

- **marked 解析异常**:try/catch,异常时回退为纯文本显示(转义 HTML 后 `<pre>` 包裹)
- **DOMPurify 异常**:同上,回退纯文本
- **mermaid 渲染异常**:单个 mermaid 块渲染失败不影响其他内容,显示原始代码 + 错误提示(`Parse failed: <error>`)
- **highlight.js 异常**:语言未注册时回退为纯文本(不高亮),不报错

### 7. 文件结构

```
src/
  ui/
    MarkdownView.svelte       # 新建 — 渲染组件
    ChatView.svelte           # 修改 — 助手消息改用 <MarkdownView>
  utils/
    markdown-renderer.ts      # 新建 — marked + DOMPurify + highlight.js
    mermaid-renderer.ts       # 新建 — mermaid 初始化 + 渲染
```

### 8. 依赖变更

`package.json` dependencies 新增:
- `marked`: ^15.0.0
- `dompurify`: ^3.2.0
- `highlight.js`: ^11.10.0
- `mermaid`: ^11.15.0

---

## 影响面

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `package.json` | 修改 | 新增 4 个 dependencies |
| `src/ui/MarkdownView.svelte` | **新建** | 渲染组件:rAF 节流 + {@html} 注入 + mermaid 生命周期 |
| `src/utils/markdown-renderer.ts` | **新建** | marked 配置 + DOMPurify + highlight.js 集成 |
| `src/utils/mermaid-renderer.ts` | **新建** | mermaid 初始化 + 异步渲染 |
| `src/ui/ChatView.svelte` | 修改 | 助手消息 `<div class="ratel-content">` 改为 `<MarkdownView>`,用户消息不变 |
| `esbuild.config.mjs` | 可能修改 | 确认 mermaid 能被 esbuild 正确打包(可能需 `--banner` 处理) |
| `tests/utils/markdown-renderer.test.ts` | **新建** | 单测:marked 输出、DOMPurify 过滤、mermaid 检测 |
| `tests/utils/mermaid-renderer.test.ts` | **新建** | 单测:mermaid 块检测、闭合判断 |

---

## 参考

- marked 文档:https://marked.js.org/
- DOMPurify:https://github.com/cure53/DOMPurify
- highlight.js:https://highlightjs.org/
- mermaid:https://mermaid.js.org/
- Obsidian MarkdownRenderer API:`node_modules/obsidian/obsidian.d.ts` L4137
- 流式回归 bug 报告:`docs/bug-report/2026-06-27-chat-ui-and-streaming-regression.md`
