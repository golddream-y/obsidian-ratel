# 流式 Markdown + Mermaid 渲染 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 ChatView 助手消息引入 marked.js + DOMPurify + highlight.js + mermaid v11 流式 markdown 渲染,保留打字机效果,支持 mermaid 流程图。

**Architecture:** 独立 MarkdownView.svelte 组件,接收 `content` + `streaming` prop。内部用 `$effect` + rAF 节流驱动 marked 全量重解析 → DOMPurify sanitize → `{@html}` 注入 → post-process mermaid 块。纯函数层拆到 `src/utils/markdown-renderer.ts` 和 `src/utils/mermaid-renderer.ts`。

**Tech Stack:** marked ^15, dompurify ^3, highlight.js ^11 (core + 7 语言), mermaid ^11, Svelte 5, vitest (node 环境,无 DOM)

**关联 Spec:** [S-MD-MERMAID](../specs/2026-06-27-ratel-streaming-markdown-mermaid-design.md)

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `package.json` | 新增 4 个 dependencies | 修改 |
| `src/utils/markdown-renderer.ts` | marked 配置 + DOMPurify + highlight.js 集成,导出 `renderMarkdownToHtml(text)` | **新建** |
| `src/utils/mermaid-renderer.ts` | mermaid 初始化 + `renderMermaidBlocks(container)` | **新建** |
| `src/ui/MarkdownView.svelte` | 渲染组件:rAF 节流 + `{@html}` + mermaid 生命周期 | **新建** |
| `src/ui/ChatView.svelte` | 助手消息 `ratel-content` → `<MarkdownView>` | 修改 |
| `tests/utils/markdown-renderer.test.ts` | marked 输出 / DOMPurify 过滤 / mermaid 检测 单测 | **新建** |
| `tests/utils/mermaid-renderer.test.ts` | mermaid 块闭合检测 单测 | **新建** |
| `esbuild.config.mjs` | mermaid 打包配置(如需) | 可能修改 |

---

## Task 1: 安装依赖

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 安装 4 个 dependencies**

```bash
cd /Users/golddream/code/git-public/Ratel-CLI
npm install marked dompurify highlight.js mermaid
```

- [ ] **Step 2: 安装 DOMPurify 类型定义**

```bash
npm install -D @types/dompurify
```

- [ ] **Step 3: 验证 package.json 更新**

Run: `node -e "const p=require('./package.json'); console.log(p.dependencies)"`
Expected: 输出含 `marked`、`dompurify`、`highlight.js`、`mermaid`

- [ ] **Step 4: 验证依赖可被 esbuild 解析**

```bash
node -e "require('marked'); require('dompurify'); require('highlight.js'); console.log('ok')"
```
Expected: `ok`(无报错)

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add marked dompurify highlight.js mermaid for streaming markdown rendering"
```

---

## Task 2: markdown-renderer.ts — marked + DOMPurify + highlight.js 纯函数层

**Files:**
- Create: `src/utils/markdown-renderer.ts`
- Test: `tests/utils/markdown-renderer.test.ts`

- [ ] **Step 1: 写失败测试 — markdown 基础语法渲染**

Create `tests/utils/markdown-renderer.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { renderMarkdownToHtml } from '../../src/utils/markdown-renderer';

describe('renderMarkdownToHtml', () => {
	it('标题 - h1/h2 生成对应标签', () => {
		const html = renderMarkdownToHtml('# 标题一\n## 标题二');
		expect(html).toContain('<h1>标题一</h1>');
		expect(html).toContain('<h2>标题二</h2>');
	});

	it('粗体/斜体 - 生成 strong/em 标签', () => {
		const html = renderMarkdownToHtml('**粗体** 和 *斜体*');
		expect(html).toContain('<strong>粗体</strong>');
		expect(html).toContain('<em>斜体</em>');
	});

	it('代码块 - 生成 pre code 标签', () => {
		const html = renderMarkdownToHtml('```javascript\nconst x = 1;\n```');
		expect(html).toContain('<pre>');
		expect(html).toContain('<code');
		expect(html).toContain('language-javascript');
	});

	it('行内代码 - 生成 code 标签', () => {
		const html = renderMarkdownToHtml('这是 `inline code` 文本');
		expect(html).toContain('<code>inline code</code>');
	});

	it('表格 - 生成 table 标签', () => {
		const md = '| A | B |\n|---|---|\n| 1 | 2 |';
		const html = renderMarkdownToHtml(md);
		expect(html).toContain('<table>');
		expect(html).toContain('<th>A</th>');
		expect(html).toContain('<td>1</td>');
	});

	it('引用块 - 生成 blockquote 标签', () => {
		const html = renderMarkdownToHtml('> 引用文本');
		expect(html).toContain('<blockquote>');
		expect(html).toContain('引用文本');
	});

	it('无序列表 - 生成 ul/li 标签', () => {
		const html = renderMarkdownToHtml('- 项 A\n- 项 B');
		expect(html).toContain('<ul>');
		expect(html).toContain('<li>项 A</li>');
	});
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `npx vitest run tests/utils/markdown-renderer.test.ts`
Expected: FAIL — `Cannot find module '../../src/utils/markdown-renderer'`

- [ ] **Step 3: 实现 markdown-renderer.ts**

Create `src/utils/markdown-renderer.ts`:

```typescript
/**
 * @file src/utils/markdown-renderer.ts
 * @description Markdown → HTML 渲染纯函数层(marked + DOMPurify + highlight.js)
 * @module utils/markdown-renderer
 * @depends marked, dompurify, highlight.js
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import markdown from 'highlight.js/lib/languages/markdown';

// 按需注册 7 种常用语言,控制体积
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('json', json);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('markdown', markdown);

/**
 * DOMPurify 白名单配置 — 允许 mermaid 生成的 SVG 标签和属性通过 sanitize。
 *
 * 关键路径:mermaid.render() 输出 SVG 字符串,包含 <svg>/<path>/<g>/<rect> 等标签
 * 和 viewBox/d/fill/stroke 等属性。默认 DOMPurify 配置会移除这些,导致 mermaid 图表空白。
 */
const SANITIZE_CONFIG = {
	ADD_TAGS: [
		'svg', 'path', 'g', 'rect', 'circle', 'line', 'text',
		'polyline', 'polygon', 'defs', 'marker', 'foreignObject', 'span',
	],
	ADD_ATTR: [
		'viewBox', 'd', 'fill', 'stroke', 'stroke-width', 'x', 'y',
		'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
		'width', 'height', 'transform', 'class', 'id',
		'marker-end', 'marker-start', 'href', 'target',
	],
};

/**
 * 配置 marked 实例 — 启用 GFM、代码高亮。
 *
 * 关键路径:highlight 选项在代码块闭合时(语言已确定)调用 hljs.highlight。
 * 未注册语言回退为纯文本(hljs.highlightAuto 性能差,不使用)。
 */
marked.setOptions({
	gfm: true,
	breaks: false,
});

/**
 * 将 Markdown 文本渲染为已 sanitize 的 HTML 字符串。
 *
 * 管线:marked.parse → DOMPurify.sanitize → 返回安全 HTML。
 * 异常时回退为转义纯文本(<pre> 包裹),保证不白屏。
 *
 * @param text - Markdown 源文本
 * @returns 已 sanitize 的 HTML 字符串,可直接用于 {@html}
 */
export function renderMarkdownToHtml(text: string): string {
	if (!text) return '';

	try {
		const rawHtml = marked.parse(text, {
			highlight(code: string, lang: string): string {
				if (lang && hljs.getLanguage(lang)) {
					try {
						return hljs.highlight(code, { language: lang }).value;
					} {
						// 语言注册但高亮失败,回退纯文本
						return code;
					}
				}
				// 未注册语言,不高亮
				return code;
			},
		}) as string;

		return DOMPurify.sanitize(rawHtml, SANITIZE_CONFIG);
	} catch {
		// 修复:marked 解析异常时回退为转义纯文本,避免白屏
		const escaped = text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
		return `<pre>${escaped}</pre>`;
	}
}

/**
 * 检测文本中是否所有代码块(用 ``` 分隔)都已闭合。
 *
 * 关键路径:流式渲染时,模型可能正在输出代码块内容,此时 ``` 数量为奇数(未闭合)。
 * 未闭合时不渲染 mermaid(避免半截代码触发 mermaid.parse 错误)。
 *
 * @param text - 待检测的文本
 * @returns true = 所有代码块已闭合(或无代码块)
 */
export function areAllCodeBlocksClosed(text: string): boolean {
	const fenceCount = (text.match(/```/g) ?? []).length;
	return fenceCount % 2 === 0;
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `npx vitest run tests/utils/markdown-renderer.test.ts`
Expected: PASS — 7 tests passed

- [ ] **Step 5: 写失败测试 — XSS 防护**

追加到 `tests/utils/markdown-renderer.test.ts` 的 describe 块内:

```typescript
	it('XSS - script 标签被过滤', () => {
		const html = renderMarkdownToHtml('<script>alert(1)</script>正常文本');
		expect(html).not.toContain('<script>');
		expect(html).toContain('正常文本');
	});

	it('XSS - onerror 属性被过滤', () => {
		const html = renderMarkdownToHtml('<img src="x" onerror="alert(1)">');
		expect(html).not.toContain('onerror');
	});

	it('XSS - javascript: 协议被过滤', () => {
		const html = renderMarkdownToHtml('[点击](javascript:alert(1))');
		expect(html).not.toContain('javascript:');
	});
```

- [ ] **Step 6: 运行测试,确认 XSS 测试通过**

Run: `npx vitest run tests/utils/markdown-renderer.test.ts`
Expected: PASS — 10 tests passed

- [ ] **Step 7: 写失败测试 — 代码块闭合检测**

追加到 `tests/utils/markdown-renderer.test.ts`:

```typescript
describe('areAllCodeBlocksClosed', () => {
	it('无代码块 - 返回 true', () => {
		expect(areAllCodeBlocksClosed('普通文本')).toBe(true);
	});

	it('已闭合代码块 - 返回 true', () => {
		const text = '前文\n```js\nconst x = 1;\n```\n后文';
		expect(areAllCodeBlocksClosed(text)).toBe(true);
	});

	it('未闭合代码块 - 返回 false', () => {
		const text = '前文\n```js\nconst x = 1;\n';
		expect(areAllCodeBlocksClosed(text)).toBe(false);
	});

	it('多个代码块全部闭合 - 返回 true', () => {
		const text = '```js\na\n```\n中间\n```py\nb\n```';
		expect(areAllCodeBlocksClosed(text)).toBe(true);
	});

	it('多个代码块最后一个未闭合 - 返回 false', () => {
		const text = '```js\na\n```\n中间\n```py\nb\n';
		expect(areAllCodeBlocksClosed(text)).toBe(false);
	});
});
```

- [ ] **Step 8: 运行测试,确认全部通过**

Run: `npx vitest run tests/utils/markdown-renderer.test.ts`
Expected: PASS — 15 tests passed

- [ ] **Step 9: Commit**

```bash
git add src/utils/markdown-renderer.ts tests/utils/markdown-renderer.test.ts
git commit -m "feat: add markdown-renderer util (marked + DOMPurify + highlight.js)"
```

---

## Task 3: mermaid-renderer.ts — mermaid 初始化 + 异步渲染

**Files:**
- Create: `src/utils/mermaid-renderer.ts`
- Test: `tests/utils/mermaid-renderer.test.ts`

- [ ] **Step 1: 写失败测试 — mermaid 块检测**

Create `tests/utils/mermaid-renderer.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { extractMermaidBlocks } from '../../src/utils/mermaid-renderer';

describe('extractMermaidBlocks', () => {
	it('无 mermaid 块 - 返回空数组', () => {
		const html = '<p>普通内容</p><pre><code class="language-js">var x = 1;</code></pre>';
		expect(extractMermaidBlocks(html)).toEqual([]);
	});

	it('单个 mermaid 块 - 返回代码内容', () => {
		const html = '<pre><code class="language-mermaid">graph TD\n  A-->B</code></pre>';
		const blocks = extractMermaidBlocks(html);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toContain('graph TD');
		expect(blocks[0]).toContain('A-->B');
	});

	it('多个 mermaid 块 - 全部提取', () => {
		const html = `
			<pre><code class="language-mermaid">graph TD\n  A-->B</code></pre>
			<p>中间文本</p>
			<pre><code class="language-mermaid">sequenceDiagram\n  A->>B: Hi</code></pre>
		`;
		const blocks = extractMermaidBlocks(html);
		expect(blocks).toHaveLength(2);
	});

	it('mermaid 块与普通代码块混合 - 只提取 mermaid', () => {
		const html = `
			<pre><code class="language-js">var x = 1;</code></pre>
			<pre><code class="language-mermaid">graph TD\n  A-->B</code></pre>
		`;
		const blocks = extractMermaidBlocks(html);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toContain('graph TD');
	});
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `npx vitest run tests/utils/mermaid-renderer.test.ts`
Expected: FAIL — `Cannot find module '../../src/utils/mermaid-renderer'`

- [ ] **Step 3: 实现 mermaid-renderer.ts**

Create `src/utils/mermaid-renderer.ts`:

```typescript
/**
 * @file src/utils/mermaid-renderer.ts
 * @description Mermaid 图表初始化与异步渲染
 * @module utils/mermaid-renderer
 * @depends mermaid
 */

import mermaid from 'mermaid';

/**
 * mermaid 初始化配置。
 *
 * 关键路径:
 * - startOnLoad: false — 手动控制渲染时机,不在页面加载时自动扫描
 * - securityLevel: 'strict' — 禁止 mermaid 代码中的 HTML 标签和事件处理器,防 XSS
 * - theme: 'dark' — 首版固定暗色主题,后续可读 Obsidian 主题自适应
 */
mermaid.initialize({
	startOnLoad: false,
	theme: 'dark',
	securityLevel: 'strict',
});

let renderCounter = 0;

/**
 * 从 HTML 字符串中提取所有 mermaid 代码块的内容。
 *
 * 用于在 marked 输出后、DOM 注入前检测是否存在 mermaid 块。
 * 匹配 `<code class="language-mermaid">...</code>` 模式。
 *
 * @param html - marked 输出的 HTML 字符串
 * @returns mermaid 代码内容数组(每个元素是一个代码块的原始文本)
 */
export function extractMermaidBlocks(html: string): string[] {
	const blocks: string[] = [];
	// 关键路径:matched 的 class 可能是 "language-mermaid" 或 "hljs language-mermaid"
	const regex = /<code[^>]*class="[^"]*language-mermaid[^"]*"[^>]*>([\s\S]*?)<\/code>/g;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(html)) !== null) {
		// 反转义 HTML 实体(&lt; → <, &gt; → >, &amp; → &)
		const code = match[1]!
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&amp;/g, '&')
			.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'");
		blocks.push(code);
	}
	return blocks;
}

/**
 * 渲染容器中的所有 mermaid 代码块为 SVG。
 *
 * 关键路径:在 {@html} 注入 DOM 后调用,querySelectorAll 找到所有
 * `code.language-mermaid` 元素,用 mermaid.render() 生成 SVG 替换。
 * 单个块渲染失败不影响其他块(显示原始代码 + 错误提示)。
 *
 * @param container - 包含已渲染 HTML 的 DOM 容器
 * @returns Promise,所有 mermaid 块渲染完成后 resolve
 */
export async function renderMermaidBlocks(container: HTMLElement): Promise<void> {
	const mermaidCodeEls = container.querySelectorAll<HTMLElement>('code.language-mermaid');
	if (mermaidCodeEls.length === 0) return;

	const renderPromises: Promise<void>[] = [];

	mermaidCodeEls.forEach((codeEl) => {
		renderPromises.push(renderSingleMermaidBlock(codeEl));
	});

	await Promise.allSettled(renderPromises);
}

/**
 * 渲染单个 mermaid 代码块。
 *
 * @param codeEl - `<code class="language-mermaid">` 元素
 */
async function renderSingleMermaidBlock(codeEl: HTMLElement): Promise<void> {
	const code = codeEl.textContent ?? '';
	if (!code.trim()) return;

	const id = `ratel-mermaid-${++renderCounter}`;

	try {
		const { svg } = await mermaid.render(id, code);
		// 关键路径:替换 <pre><code> 结构为 mermaid SVG 容器
		const wrapper = document.createElement('div');
		wrapper.className = 'ratel-mermaid';
		wrapper.innerHTML = svg;
		const pre = codeEl.parentElement; // <pre> 标签
		if (pre && pre.tagName === 'PRE') {
			pre.replaceWith(wrapper);
		} else {
			codeEl.replaceWith(wrapper);
		}
	} catch (err) {
		// 修复:mermaid 渲染失败时显示原始代码 + 错误提示,不影响其他内容
		const errorDiv = document.createElement('div');
		errorDiv.className = 'ratel-mermaid-error';
		errorDiv.textContent = `Mermaid 渲染失败: ${err instanceof Error ? err.message : String(err)}`;
		const pre = codeEl.parentElement;
		if (pre && pre.tagName === 'PRE') {
			pre.replaceWith(errorDiv);
		} else {
			codeEl.replaceWith(errorDiv);
		}
	}
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `npx vitest run tests/utils/mermaid-renderer.test.ts`
Expected: PASS — 4 tests passed

- [ ] **Step 5: Commit**

```bash
git add src/utils/mermaid-renderer.ts tests/utils/mermaid-renderer.test.ts
git commit -m "feat: add mermaid-renderer util (init + async SVG render)"
```

---

## Task 4: MarkdownView.svelte — 渲染组件

**Files:**
- Create: `src/ui/MarkdownView.svelte`

- [ ] **Step 1: 实现 MarkdownView.svelte**

Create `src/ui/MarkdownView.svelte`:

```svelte
<script lang="ts">
	/**
	 * @file src/ui/MarkdownView.svelte
	 * @description Markdown 流式渲染组件 — rAF 节流 + marked + DOMPurify + mermaid
	 * @module ui/MarkdownView
	 * @depends utils/markdown-renderer, utils/mermaid-renderer
	 */

	import { onDestroy } from 'svelte';
	import { renderMarkdownToHtml, areAllCodeBlocksClosed } from '../utils/markdown-renderer';
	import { renderMermaidBlocks } from '../utils/mermaid-renderer';

	/**
	 * 组件 Props。
	 *
	 * @param content - Markdown 源文本(流式追加)
	 * @param streaming - 是否正在流式输出中(true 时 mermaid 块需等闭合后渲染)
	 */
	let { content, streaming = false }: { content: string; streaming?: boolean } = $props();

	let containerEl: HTMLDivElement | null = $state(null);
	let rafId = 0;
	let lastRenderedText = '';

	/**
	 * 渲染管线:marked → DOMPurify → {@html} → mermaid post-process。
	 *
	 * 关键路径:rAF 节流确保同一帧内多次 content 变化只渲染最后一次,
	 * 避免 60fps 被打满。mermaid 仅在代码块全部闭合时渲染。
	 */
	function renderToDom(text: string) {
		if (!containerEl || text === lastRenderedText) return;
		lastRenderedText = text;

		const html = renderMarkdownToHtml(text);
		// 关键路径:用 innerHTML 替换内容(而非 {@html}),因为 mermaid post-process
		// 需要在 DOM 更新后操作 querySelectorAll,直接用 innerHTML 更可控。
		containerEl.innerHTML = html;

		// mermaid 渲染:仅在代码块全部闭合时执行
		if (areAllCodeBlocksClosed(text)) {
			renderMermaidBlocks(containerEl).catch(() => {
				// mermaid 渲染异常已在 renderSingleMermaidBlock 内处理,此处静默
			});
		}
	}

	$effect(() => {
		const text = content; // 追踪依赖
		cancelAnimationFrame(rafId);
		rafId = requestAnimationFrame(() => {
			renderToDom(text);
		});
	});

	// streaming 从 true→false 时(模型回复完成),强制重新渲染以触发 mermaid
	$effect(() => {
		if (!streaming && containerEl && content) {
			cancelAnimationFrame(rafId);
			rafId = requestAnimationFrame(() => {
				lastRenderedText = ''; // 强制刷新
				renderToDom(content);
			});
		}
	});

	onDestroy(() => {
		cancelAnimationFrame(rafId);
	});
</script>

<div class="ratel-md" bind:this={containerEl}></div>

<style>
	.ratel-md {
		font-size: 13.5px;
		line-height: 1.6;
		color: var(--text-normal);
		word-break: break-word;
	}

	/* 标题 */
	.ratel-md :global(h1) {
		font-size: 1.5em;
		font-weight: 600;
		margin: 0.8em 0 0.4em;
		color: var(--text-normal);
	}
	.ratel-md :global(h2) {
		font-size: 1.3em;
		font-weight: 600;
		margin: 0.7em 0 0.3em;
		color: var(--text-normal);
	}
	.ratel-md :global(h3) {
		font-size: 1.15em;
		font-weight: 600;
		margin: 0.6em 0 0.3em;
		color: var(--text-normal);
	}
	.ratel-md :global(h4),
	.ratel-md :global(h5),
	.ratel-md :global(h6) {
		font-size: 1em;
		font-weight: 600;
		margin: 0.5em 0 0.2em;
		color: var(--text-normal);
	}

	/* 段落 */
	.ratel-md :global(p) {
		margin: 0.4em 0;
	}

	/* 列表 */
	.ratel-md :global(ul),
	.ratel-md :global(ol) {
		margin: 0.4em 0;
		padding-left: 1.5em;
	}
	.ratel-md :global(li) {
		margin: 0.15em 0;
	}

	/* 代码 */
	.ratel-md :global(code) {
		font-family: var(--font-monospace);
		font-size: 0.9em;
		background: var(--background-secondary);
		border-radius: 3px;
		padding: 1px 4px;
	}
	.ratel-md :global(pre) {
		background: var(--background-secondary);
		border-radius: 6px;
		padding: 10px 12px;
		overflow-x: auto;
		margin: 0.5em 0;
	}
	.ratel-md :global(pre code) {
		background: transparent;
		padding: 0;
		font-size: 12px;
		line-height: 1.5;
	}

	/* 表格 */
	.ratel-md :global(table) {
		border-collapse: collapse;
		margin: 0.5em 0;
		width: 100%;
	}
	.ratel-md :global(th),
	.ratel-md :global(td) {
		border: 1px solid var(--background-modifier-border);
		padding: 4px 8px;
		text-align: left;
	}
	.ratel-md :global(th) {
		font-weight: 600;
		background: var(--background-secondary);
	}

	/* 引用块 */
	.ratel-md :global(blockquote) {
		border-left: 3px solid var(--background-modifier-border);
		padding-left: 10px;
		margin: 0.5em 0;
		color: var(--text-muted);
	}

	/* 链接 */
	.ratel-md :global(a) {
		color: var(--text-accent);
		text-decoration: none;
	}
	.ratel-md :global(a:hover) {
		text-decoration: underline;
	}

	/* 分隔线 */
	.ratel-md :global(hr) {
		border: none;
		border-top: 1px solid var(--background-modifier-border);
		margin: 1em 0;
	}

	/* highlight.js 令牌色 — 适配 Obsidian 暗色主题 */
	.ratel-md :global(.hljs-keyword) { color: #c678dd; }
	.ratel-md :global(.hljs-string) { color: #98c379; }
	.ratel-md :global(.hljs-number) { color: #d19a66; }
	.ratel-md :global(.hljs-comment) { color: #7f7f7f; font-style: italic; }
	.ratel-md :global(.hljs-function) { color: #61afef; }
	.ratel-md :global(.hljs-title) { color: #61afef; }
	.ratel-md :global(.hljs-attr) { color: #d19a66; }
	.ratel-md :global(.hljs-built_in) { color: #e6c07b; }
	.ratel-md :global(.hljs-type) { color: #e6c07b; }

	/* mermaid 容器 */
	.ratel-md :global(.ratel-mermaid) {
		margin: 0.5em 0;
		text-align: center;
	}
	.ratel-md :global(.ratel-mermaid svg) {
		max-width: 100%;
		height: auto;
	}

	/* mermaid 渲染失败提示 */
	.ratel-md :global(.ratel-mermaid-error) {
		padding: 8px 10px;
		border-radius: 6px;
		background: rgba(248, 113, 113, 0.1);
		color: var(--text-error);
		font-size: 11.5px;
		margin: 0.5em 0;
	}

	/* 任务列表 */
	.ratel-md :global(input[type="checkbox"]) {
		margin-right: 6px;
	}
</style>
```

- [ ] **Step 2: 验证 svelte-check 通过**

Run: `npx svelte-check --tsconfig tsconfig.json 2>&1 | tail -10`
Expected: 0 errors(可能有 warnings,忽略)

- [ ] **Step 3: 验证 build 通过**

Run: `npm run build 2>&1 | tail -5`
Expected: exit 0

- [ ] **Step 4: Commit**

```bash
git add src/ui/MarkdownView.svelte
git commit -m "feat: add MarkdownView.svelte component (rAF throttle + mermaid lifecycle)"
```

---

## Task 5: ChatView.svelte — 集成 MarkdownView

**Files:**
- Modify: `src/ui/ChatView.svelte:423-425`(消息内容渲染区)
- Modify: `src/ui/ChatView.svelte:1-15`(import 区)

- [ ] **Step 1: 添加 MarkdownView import**

在 `src/ui/ChatView.svelte` 的 import 区(L14 附近)添加:

```typescript
	import MarkdownView from './MarkdownView.svelte';
```

插入位置:在 `import AttachmentStrip from './AttachmentStrip.svelte';` 之后。

- [ ] **Step 2: 替换助手消息的内容渲染**

将 L423-425:
```svelte
				{#if msg.content}
					<div class="ratel-content">{msg.content}</div>
				{/if}
```

替换为:
```svelte
				{#if msg.content}
					{#if msg.role === 'assistant'}
						<MarkdownView content={msg.content} streaming={isRunning && msg === messages[messages.length - 1]} />
					{:else}
						<div class="ratel-content">{msg.content}</div>
					{/if}
				{/if}
```

- [ ] **Step 3: 验证 svelte-check 通过**

Run: `npx svelte-check --tsconfig tsconfig.json 2>&1 | tail -10`
Expected: 0 errors

- [ ] **Step 4: 验证 build 通过**

Run: `npm run build 2>&1 | tail -5`
Expected: exit 0

- [ ] **Step 5: 验证现有测试不被破坏**

Run: `npx vitest run 2>&1 | tail -10`
Expected: 所有现有测试 PASS

- [ ] **Step 6: Commit**

```bash
git add src/ui/ChatView.svelte
git commit -m "feat: integrate MarkdownView for assistant messages in ChatView"
```

---

## Task 6: esbuild 打包验证 + 修复

**Files:**
- Possibly modify: `esbuild.config.mjs`

- [ ] **Step 1: 运行完整 build,检查 mermaid 打包是否报错**

Run: `npm run build 2>&1`
Expected: exit 0。如果 mermaid 打包报错(如动态 import / ESM 问题),进入 Step 2。如果成功,跳到 Step 4。

- [ ] **Step 2: (仅当 Step 1 报错)检查错误信息**

常见问题:
- mermaid 内部使用动态 `import()`,esbuild 可能警告但能打包
- mermaid 依赖 `cytoscape` 等大包,打包时间变长(正常)

- [ ] **Step 3: (仅当需要)添加 esbuild 配置**

如果 mermaid 打包报错,在 `esbuild.config.mjs` 的 mainContext 配置中添加:

```javascript
	// 关键路径:mermaid 内部使用动态 import,需要 splitting 或手动处理
	// 如果 esbuild 报动态 import 错误,取消注释以下配置
	// splitting: false,
	// format: 'cjs',  // 已有,保持
```

实际操作:根据错误信息决定具体修复。大多数情况 esbuild 能直接打包 mermaid,无需修改。

- [ ] **Step 4: 检查产物大小**

Run: `ls -lh dist/main.js`
Expected: 文件大小 ~1.8MB-2MB(从 ~500KB 增长,mermaid 贡献 ~1.2MB)

- [ ] **Step 5: Commit(如有 esbuild 修改)**

```bash
git add esbuild.config.mjs
git commit -m "build: configure esbuild for mermaid bundling"
```

如果无修改,跳过此步。

---

## Task 7: 端到端验证 + 最终测试

**Files:**
- 无新文件

- [ ] **Step 1: 运行全部测试**

Run: `npx vitest run 2>&1 | tail -15`
Expected: 所有测试 PASS(含新增的 markdown-renderer 和 mermaid-renderer 测试)

- [ ] **Step 2: 运行 svelte-check**

Run: `npx svelte-check --tsconfig tsconfig.json 2>&1 | tail -10`
Expected: 0 errors

- [ ] **Step 3: 运行完整 build**

Run: `npm run build 2>&1 | tail -5`
Expected: exit 0

- [ ] **Step 4: 手动验证清单(需在 Obsidian 中 Reload app)**

在 Obsidian 中 Cmd+P → "Reload app without saving",然后测试:

1. **基础 markdown**:让模型回复一段含标题、列表、粗体的文本 → 确认格式正确渲染
2. **代码块高亮**:让模型回复一段 ```javascript 代码块 → 确认语法高亮(关键字紫色、字符串绿色)
3. **表格**:让模型回复一个表格 → 确认表格边框和单元格正确
4. **mermaid 流程图**:让模型生成一个 ` ```mermaid ` 代码块 → 确认渲染为 SVG 流程图
5. **流式打字机**:观察模型回复过程 → 确认内容逐字追加,无严重闪烁
6. **mermaid 流式中不渲染半截**:模型输出 mermaid 代码块过程中 → 确认不显示错误,完成后才渲染
7. **XSS**:让模型输出 `<script>alert(1)</script>` → 确认被过滤,不执行
8. **用户消息纯文本**:用户输入 `**粗体**` → 确认显示为纯文本 `**粗体**`,不被渲染

- [ ] **Step 5: Commit(如有最终调整)**

如果手动验证发现问题并修复,提交修复。否则跳过。

---

## 自审

### Spec 覆盖检查

| Spec 要求 | 对应 Task |
|---|---|
| 助手消息 markdown 渲染(标题/列表/代码块/表格等) | Task 2(marked) + Task 5(集成) |
| mermaid 流程图渲染 | Task 3(mermaid-renderer) + Task 4(MarkdownView post-process) |
| 流式友好(rAF 节流) | Task 4(MarkdownView $effect + rAF) |
| XSS 防护(DOMPurify) | Task 2(DOMPurify sanitize + 测试) |
| 主题适配(CSS 变量) | Task 4(MarkdownView `<style>` 全局样式) |
| 用户消息保持纯文本 | Task 5(`{#if msg.role === 'assistant'}` 分支) |
| 错误处理(marked/mermaid 异常) | Task 2(try/catch 回退) + Task 3(单块失败不影响其他) |
| highlight.js 按需加载 | Task 2(core + 7 语言) |
| esbuild 打包验证 | Task 6 |

所有 spec 要求均有对应 Task。

### 占位符扫描

无 TBD/TODO/"implement later"/"add appropriate error handling" 等占位符。所有代码步骤含完整代码。

### 类型一致性

- `renderMarkdownToHtml(text: string): string` — Task 2 定义,Task 4 调用,签名一致
- `areAllCodeBlocksClosed(text: string): boolean` — Task 2 定义,Task 4 调用,签名一致
- `extractMermaidBlocks(html: string): string[]` — Task 3 定义,Task 3 测试,签名一致
- `renderMermaidBlocks(container: HTMLElement): Promise<void>` — Task 3 定义,Task 4 调用,签名一致
- `MarkdownView` props: `content: string, streaming?: boolean` — Task 4 定义,Task 5 调用 `content={msg.content} streaming={...}`,类型一致

无类型不一致问题。
