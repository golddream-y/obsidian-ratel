# P-MD-PREVIEW-1 — 统一 Markdown 富块 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 助手消息里代码围栏与 mermaid 共用 `.ratel-md-block` 卡片与复制钮；mermaid 只替换 body、源码可复制；表格横滚；流式仍先 `innerHTML` 再异步画图。

**Architecture:** `renderMarkdownToHtml` 输出统一壳（含 mermaid + `data-ratel-src`）；`renderMermaidBlocks` 只换 `.ratel-md-block-body` 内的 `pre`；`enhanceMdBlocks` 挂复制（无 `onExpand` 则不画「放大」）。不改 rAF / 选区 / 不等 mermaid。

**Tech Stack:** TypeScript / Svelte 5 / marked / DOMPurify / mermaid / Vitest / i18n

**Spec:** [S-MD-PREVIEW](../../specs/2026-08-14-markdown-preview-chrome-design.md)  
**后续:** [P-MD-PREVIEW-2](../../plans/2026-08-14-md-preview-overlay.md)（overlay / 灯箱）

## Global Constraints

- 用户可见字符串走 i18n（`zh.ts` + `en.ts` + `types.ts`），禁止硬编码
- 测试 `it(...)` 中文：`行为 - 条件 - 期望结果`
- 文件头 `@file` / `@description` / `@module`；注释中文
- **禁止**新增 pan-zoom / lightbox / mermaid 以外的 npm 依赖
- **禁止** `await mermaid.render` 之后才写本帧 `innerHTML`
- **禁止**人为 debounce rAF 到 100ms+
- 不引入 Obsidian `Modal` 做预览
- 不实现 overlay（本 plan 无「放大」按钮，因不传 `onExpand`）
- SANITIZE `ADD_ATTR` 必须含 `data-ratel-src`、`data-ratel-fence`
- 删除 `chat.code.copy` / `chat.code.copied`，改用 `chat.md.*`
- 只 link Obsidian Sandbox 预览，禁止动日常主库

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/i18n/types.ts` `zh.ts` `en.ts` | `chat.md.copy` / `copied` / `mermaidFailed` |
| `src/utils/markdown-renderer.ts` | 统一壳 + 表格 wrap + data 属性 |
| `src/utils/mermaid-renderer.ts` | 只换 body；错误 i18n class |
| `src/ui/chat/md-block-enhance.ts` | 复制；可选 `onExpand` |
| `src/ui/chat/code-block-enhance.ts` | 删除；调用点改 enhanceMdBlocks |
| `src/ui/components/MarkdownView.svelte` | 接线；class 改名 |
| `styles.css` | `.ratel-md-block` / `.ratel-md-table-wrap` |
| `tests/utils/markdown-renderer.test.ts` | 壳 / mermaid src / 表格 |
| `tests/utils/mermaid-renderer.test.ts` | body 替换、外壳保留 |
| `tests/ui/chat/md-block-enhance.test.ts` | 复制；无 onExpand 无放大钮 |
| `tests/ui/chat/code-block-enhance.test.ts` | 删除 |

---

### Task 1: i18n `chat.md.*` 替换 `chat.code.*`

**Files:**
- Modify: `src/i18n/types.ts`
- Modify: `src/i18n/zh.ts`
- Modify: `src/i18n/en.ts`

**Interfaces:**
- Produces keys: `chat.md.copy` `chat.md.copied` `chat.md.mermaidFailed`（`{message}`）
- Removes: `chat.code.copy` `chat.code.copied`

- [x] **Step 1: 改 types / zh / en**

在 `types.ts` 把 `'chat.code.copy'` / `'chat.code.copied'` 换成：

```typescript
  'chat.md.copy': string;
  'chat.md.copied': string;
  'chat.md.mermaidFailed': string;
```

`zh.ts`：

```typescript
  'chat.md.copy': '复制',
  'chat.md.copied': '已复制',
  'chat.md.mermaidFailed': 'Mermaid 渲染失败: {message}',
```

`en.ts`：

```typescript
  'chat.md.copy': 'Copy',
  'chat.md.copied': 'Copied',
  'chat.md.mermaidFailed': 'Mermaid failed: {message}',
```

- [x] **Step 2: 暂时让 MarkdownView 编译过**

`MarkdownView.svelte` 里 `tNow('chat.code.copy')` 改为 `tNow('chat.md.copy')`（copied 同理）。后续 Task 4 再换成 `enhanceMdBlocks`。

- [x] **Step 3: Commit**

```bash
git add src/i18n/types.ts src/i18n/zh.ts src/i18n/en.ts src/ui/components/MarkdownView.svelte
git commit -m "$(cat <<'EOF'
feat(i18n): 代码块文案收口到 chat.md.*

EOF
)"
```

---

### Task 2: renderer 统一壳 + 表格 wrap

**Files:**
- Modify: `src/utils/markdown-renderer.ts`
- Modify: `tests/utils/markdown-renderer.test.ts`

**Interfaces:**
- Consumes: 现有 `renderMarkdownToHtml`
- Produces HTML 合同：
  - `.ratel-md-block[data-ratel-fence="code"|"mermaid"]`
  - mermaid 另有 `data-ratel-src`（解码后的源码再属性转义）
  - `.ratel-md-block-bar` > `.ratel-md-block-label` + 空 `.ratel-md-block-actions`
  - `.ratel-md-block-body` > 原 `<pre><code>`
  - `<table>` 外包 `.ratel-md-table-wrap`

- [x] **Step 1: 写失败测试（改现有用例）**

`tests/utils/markdown-renderer.test.ts` 把「围栏代码 - 包成独立卡片」改成新 class；mermaid **要包**：

```typescript
	it('围栏代码 - 包成 ratel-md-block 并带语言标签', () => {
		const html = renderMarkdownToHtml('```json\n{"a":1}\n```');
		expect(html).toContain('class="ratel-md-block"');
		expect(html).toContain('data-ratel-fence="code"');
		expect(html).toContain('class="ratel-md-block-label">json<');
		expect(html).toContain('class="ratel-md-block-body"');
		expect(html).not.toContain('ratel-code-block');
	});

	it('mermaid 围栏 - 同样包壳并带 data-ratel-src', () => {
		const html = renderMarkdownToHtml('```mermaid\ngraph TD; A-->B\n```');
		expect(html).toContain('data-ratel-fence="mermaid"');
		expect(html).toContain('data-ratel-src="');
		expect(html).toContain('graph TD');
		expect(html).toContain('language-mermaid');
		expect(html).toContain('class="ratel-md-block-label">mermaid<');
	});

	it('行内代码 - 不包成代码卡片', () => {
		const html = renderMarkdownToHtml('这是 `inline` 文本');
		expect(html).not.toContain('ratel-md-block');
		expect(html).toContain('<code>inline</code>');
	});

	it('表格 - 外包横滚壳', () => {
		const md = '| A | B |\n|---|---|\n| 1 | 2 |';
		const html = renderMarkdownToHtml(md);
		expect(html).toContain('class="ratel-md-table-wrap"');
		expect(html).toContain('<table>');
	});
```

删掉旧的「mermaid 围栏 - 不包成代码卡片」。

- [x] **Step 2: 跑测试确认失败**

```bash
npx vitest run tests/utils/markdown-renderer.test.ts
```

Expected: 新用例 FAIL（仍是 `ratel-code-block` 或 mermaid 无壳）。

- [x] **Step 3: 实现 wrap**

`SANITIZE_CONFIG.ADD_ATTR` 增加 `'data-ratel-src', 'data-ratel-fence'`。

替换 `wrapFencedCodeHtml` + 增加 `wrapTablesHtml`：

```typescript
function unescapeHtmlText(text: string): string {
	return text
		.replace(/&quot;/g, '"')
		.replace(/&gt;/g, '>')
		.replace(/&lt;/g, '<')
		.replace(/&amp;/g, '&');
}

function fenceSourceFromCodeHtml(body: string): string {
	return unescapeHtmlText(body.replace(/<[^>]+>/g, ''));
}

function wrapFencedCodeHtml(html: string): string {
	const fencedPreRe = /<pre>\s*<code([^>]*)>([\s\S]*?)<\/code>\s*<\/pre>/gi;
	return html.replace(fencedPreRe, (_full, attrs: string, body: string) => {
		const cls = CODE_CLASS_RE.exec(attrs)?.[1] ?? '';
		const isMermaid = /\blanguage-mermaid\b/i.test(cls);
		const lang = isMermaid ? 'mermaid' : fencedLangFromClass(cls);
		const fence = isMermaid ? 'mermaid' : 'code';
		const srcAttr = isMermaid
			? ` data-ratel-src="${escapeHtmlText(fenceSourceFromCodeHtml(body))}"`
			: '';
		const langHtml = lang
			? `<span class="ratel-md-block-label">${escapeHtmlText(lang)}</span>`
			: '<span class="ratel-md-block-label"></span>';
		return `<div class="ratel-md-block" data-ratel-fence="${fence}"${srcAttr}><div class="ratel-md-block-bar">${langHtml}<div class="ratel-md-block-actions"></div></div><div class="ratel-md-block-body"><pre><code${attrs}>${body}</code></pre></div></div>`;
	});
}

function wrapTablesHtml(html: string): string {
	return html.replace(/<table\b[\s\S]*?<\/table>/gi, (table) => {
		if (table.includes('ratel-md-table-wrap')) return table;
		return `<div class="ratel-md-table-wrap">${table}</div>`;
	});
}
```

`renderMarkdownToHtml`：

```typescript
return DOMPurify.sanitize(wrapTablesHtml(wrapFencedCodeHtml(rawHtml)), SANITIZE_CONFIG);
```

- [x] **Step 4: 跑测试确认通过**

```bash
npx vitest run tests/utils/markdown-renderer.test.ts
```

Expected: PASS。若 `data-ratel-src` 丢失，检查 ADD_ATTR。

- [x] **Step 5: Commit**

```bash
git add src/utils/markdown-renderer.ts tests/utils/markdown-renderer.test.ts
git commit -m "$(cat <<'EOF'
feat(md): 围栏与 mermaid 统一成 ratel-md-block

EOF
)"
```

---

### Task 3: mermaid 只替换 body

**Files:**
- Modify: `src/utils/mermaid-renderer.ts`
- Modify: `tests/utils/mermaid-renderer.test.ts`

**Interfaces:**
- Consumes: `.ratel-md-block[data-ratel-fence="mermaid"] .ratel-md-block-body pre code.language-mermaid`
- Produces: body 内 `.ratel-mermaid` SVG 或 `.ratel-md-block-error`；块根与 `data-ratel-src` 保留
- `renderMermaidBlocks(container, labels?: { failed: (detail: string) => string })`

- [x] **Step 1: 写失败测试**

在 `tests/utils/mermaid-renderer.test.ts` 增加（jsdom + mock mermaid）：

```typescript
import { vi } from 'vitest';

vi.mock('mermaid', () => ({
	default: {
		initialize: vi.fn(),
		render: vi.fn(async (id: string) => ({
			svg: `<svg xmlns="http://www.w3.org/2000/svg" data-id="${id}"></svg>`,
		})),
	},
}));

import { renderMermaidBlocks } from '../../src/utils/mermaid-renderer';

it('renderMermaidBlocks - 已有 md-block 壳 - 只换 body 保留 data-ratel-src', async () => {
	const root = document.createElement('div');
	root.innerHTML = `<div class="ratel-md-block" data-ratel-fence="mermaid" data-ratel-src="graph TD; A-->B"><div class="ratel-md-block-bar"><span class="ratel-md-block-label">mermaid</span><div class="ratel-md-block-actions"></div></div><div class="ratel-md-block-body"><pre><code class="hljs language-mermaid">graph TD; A--&gt;B</code></pre></div></div>`;
	document.body.appendChild(root);
	await renderMermaidBlocks(root);
	const block = root.querySelector('.ratel-md-block')!;
	expect(block.getAttribute('data-ratel-src')).toBe('graph TD; A-->B');
	expect(block.querySelector('.ratel-md-block-bar')).toBeTruthy();
	expect(block.querySelector('.ratel-mermaid svg')).toBeTruthy();
	expect(block.querySelector('pre')).toBeNull();
});

it('renderMermaidBlocks - render 抛错 - body 错误条且外壳仍在', async () => {
	const mermaid = await import('mermaid');
	vi.mocked(mermaid.default.render).mockRejectedValueOnce(new Error('bad'));
	const root = document.createElement('div');
	root.innerHTML = `<div class="ratel-md-block" data-ratel-fence="mermaid" data-ratel-src="x"><div class="ratel-md-block-body"><pre><code class="language-mermaid">x</code></pre></div></div>`;
	await renderMermaidBlocks(root, { failed: (d) => `失败:${d}` });
	expect(root.querySelector('.ratel-md-block')).toBeTruthy();
	expect(root.querySelector('.ratel-md-block-error')?.textContent).toContain('失败:');
});
```

- [x] **Step 2: 跑测试确认失败**

```bash
npx vitest run tests/utils/mermaid-renderer.test.ts
```

Expected: FAIL（现网 `pre.replaceWith` 拆掉壳）。

- [x] **Step 3: 改 `renderSingleMermaidBlock`**

```typescript
export async function renderMermaidBlocks(
	container: HTMLElement,
	labels?: { failed: (detail: string) => string },
): Promise<void> {
	const mermaidCodeEls = container.querySelectorAll<HTMLElement>('code.language-mermaid');
	if (mermaidCodeEls.length === 0) return;
	await Promise.allSettled(
		Array.from(mermaidCodeEls).map((el) => renderSingleMermaidBlock(el, labels)),
	);
}

function replaceInBlockBody(codeEl: HTMLElement, node: HTMLElement): void {
	const block = codeEl.closest('.ratel-md-block');
	const body = block?.querySelector('.ratel-md-block-body');
	const pre = codeEl.parentElement;
	if (body) {
		body.replaceChildren(node);
		return;
	}
	if (pre && pre.tagName === 'PRE') {
		pre.replaceWith(node);
		return;
	}
	codeEl.replaceWith(node);
}

async function renderSingleMermaidBlock(
	codeEl: HTMLElement,
	labels?: { failed: (detail: string) => string },
): Promise<void> {
	const code = codeEl.textContent ?? '';
	if (!code.trim()) return;
	const id = `ratel-mermaid-${++renderCounter}`;
	try {
		const { svg } = await mermaid.render(id, code);
		const wrapper = activeDocument.body.createDiv({ cls: 'ratel-mermaid' });
		wrapper.remove();
		const sanitized = DOMPurify.sanitize(svg, MERMAID_SANITIZE_CONFIG);
		const parsed = new DOMParser().parseFromString(sanitized, 'image/svg+xml');
		wrapper.replaceChildren(parsed.documentElement);
		replaceInBlockBody(codeEl, wrapper);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		const text = labels?.failed(detail) ?? detail;
		const errorDiv = activeDocument.body.createDiv({
			cls: 'ratel-md-block-error',
			text,
		});
		errorDiv.remove();
		replaceInBlockBody(codeEl, errorDiv);
	}
}
```

删除 `.ratel-mermaid-error` 创建路径（CSS 可暂留，MarkdownView 改为 `.ratel-md-block-error`）。

- [x] **Step 4: 跑测试确认通过**

```bash
npx vitest run tests/utils/mermaid-renderer.test.ts tests/utils/markdown-renderer.test.ts
```

Expected: PASS。

- [x] **Step 5: Commit**

```bash
git add src/utils/mermaid-renderer.ts tests/utils/mermaid-renderer.test.ts
git commit -m "$(cat <<'EOF'
fix(md): mermaid 只替换块 body，保留外壳与源码

EOF
)"
```

---

### Task 4: `enhanceMdBlocks` 复制

**Files:**
- Create: `src/ui/chat/md-block-enhance.ts`
- Create: `tests/ui/chat/md-block-enhance.test.ts`
- Delete: `src/ui/chat/code-block-enhance.ts`
- Delete: `tests/ui/chat/code-block-enhance.test.ts`
- Modify: `src/ui/components/MarkdownView.svelte`

**Interfaces:**
- Produces:

```typescript
export interface MdBlockLabels {
	copy: string;
	copied: string;
	expand?: string;
}

export interface EnhanceMdBlocksOptions {
	labels: MdBlockLabels;
	onExpand?: (block: HTMLElement) => void;
}

export function enhanceMdBlocks(root: HTMLElement, opts: EnhanceMdBlocksOptions): () => void;
```

复制：`data-ratel-fence="mermaid"` 用 `data-ratel-src`；否则 `code`/`pre` 的 `textContent`。  
`onExpand` 缺省：**不创建** `.ratel-md-expand`。  
仅当 `onExpand` 存在 **且** body 内已有 `svg` 时才画放大钮（本 plan MarkdownView 不传 onExpand）。

- [x] **Step 1: 写失败测试**

```typescript
/**
 * @file tests/ui/chat/md-block-enhance.test.ts
 * @description 统一富块复制按钮
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enhanceMdBlocks } from '../../../src/ui/chat/md-block-enhance';

const LABELS = { copy: '复制', copied: '已复制', expand: '放大' };

function mountBlock(html: string): HTMLDivElement {
	const root = document.createElement('div');
	root.innerHTML = html;
	document.body.appendChild(root);
	return root;
}

describe('enhanceMdBlocks', () => {
	beforeEach(() => {
		document.body.replaceChildren();
	});

	it('enhanceMdBlocks - 代码块 - 复制 textContent 且无放大钮', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.assign(navigator, { clipboard: { writeText } });
		const root = mountBlock(
			`<div class="ratel-md-block" data-ratel-fence="code"><div class="ratel-md-block-bar"><span class="ratel-md-block-label">json</span><div class="ratel-md-block-actions"></div></div><div class="ratel-md-block-body"><pre><code>{ "a": 1 }</code></pre></div></div>`,
		);
		enhanceMdBlocks(root, { labels: LABELS });
		expect(root.querySelector('.ratel-md-expand')).toBeNull();
		root.querySelector<HTMLButtonElement>('.ratel-md-copy')!.click();
		await vi.waitFor(() => {
			expect(writeText).toHaveBeenCalledWith('{ "a": 1 }');
		});
	});

	it('enhanceMdBlocks - mermaid - 复制 data-ratel-src 不是 SVG', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.assign(navigator, { clipboard: { writeText } });
		const root = mountBlock(
			`<div class="ratel-md-block" data-ratel-fence="mermaid" data-ratel-src="graph TD; A-->B"><div class="ratel-md-block-bar"><span class="ratel-md-block-label">mermaid</span><div class="ratel-md-block-actions"></div></div><div class="ratel-md-block-body"><div class="ratel-mermaid"><svg></svg></div></div></div>`,
		);
		enhanceMdBlocks(root, { labels: LABELS });
		root.querySelector<HTMLButtonElement>('.ratel-md-copy')!.click();
		await vi.waitFor(() => {
			expect(writeText).toHaveBeenCalledWith('graph TD; A-->B');
		});
	});

	it('enhanceMdBlocks - 无 onExpand - 即使有 svg 也不画放大', () => {
		const root = mountBlock(
			`<div class="ratel-md-block" data-ratel-fence="mermaid" data-ratel-src="x"><div class="ratel-md-block-bar"><div class="ratel-md-block-actions"></div></div><div class="ratel-md-block-body"><svg></svg></div></div>`,
		);
		enhanceMdBlocks(root, { labels: LABELS });
		expect(root.querySelector('.ratel-md-expand')).toBeNull();
	});

	it('enhanceMdBlocks - 有 onExpand 且有 svg - 画放大钮', () => {
		const onExpand = vi.fn();
		const root = mountBlock(
			`<div class="ratel-md-block" data-ratel-fence="mermaid" data-ratel-src="x"><div class="ratel-md-block-bar"><div class="ratel-md-block-actions"></div></div><div class="ratel-md-block-body"><svg></svg></div></div>`,
		);
		enhanceMdBlocks(root, { labels: LABELS, onExpand });
		root.querySelector<HTMLButtonElement>('.ratel-md-expand')!.click();
		expect(onExpand).toHaveBeenCalledTimes(1);
	});
});
```

- [x] **Step 2: 跑测试确认失败**

```bash
npx vitest run tests/ui/chat/md-block-enhance.test.ts
```

Expected: FAIL（模块不存在）。

- [x] **Step 3: 实现 `md-block-enhance.ts`**

从 `code-block-enhance.ts` 改写：查询 `.ratel-md-block`；按钮进 `.ratel-md-block-actions`；class `ratel-md-copy` / `ratel-md-expand`；复制逻辑按 Interfaces。未包壳的裸 `pre` 仍可包一层 `.ratel-md-block` 作为降级（与现 wrapFence 同类）。

- [x] **Step 4: MarkdownView 接线**

- import `enhanceMdBlocks`
- `bindCodeBlocks`：`enhanceMdBlocks(containerEl, { labels: { copy: tNow('chat.md.copy'), copied: tNow('chat.md.copied') } })`（不传 onExpand）
- `renderMermaidBlocks(containerEl, { failed: (message) => tNow('chat.md.mermaidFailed', { message }) })`
- **顺序不变：** 先 `innerHTML`，闭合则 `renderMermaidBlocks.finally(bindCodeBlocks)`，否则直接 bind。禁止把 innerHTML 挪到 mermaid await 之后。

删除 `code-block-enhance.ts` 与其测试。Grep `enhanceCodeBlocks` / `ratel-code-block` 清掉。

- [x] **Step 5: 跑测试确认通过**

```bash
npx vitest run tests/ui/chat/md-block-enhance.test.ts tests/utils/markdown-renderer.test.ts tests/utils/mermaid-renderer.test.ts
```

Expected: PASS。

- [x] **Step 6: Commit**

```bash
git add src/ui/chat/md-block-enhance.ts tests/ui/chat/md-block-enhance.test.ts src/ui/components/MarkdownView.svelte
git rm src/ui/chat/code-block-enhance.ts tests/ui/chat/code-block-enhance.test.ts
git commit -m "$(cat <<'EOF'
feat(md): 统一块挂复制，mermaid 复制源码

EOF
)"
```

---

### Task 5: 全局样式 + 打字机自检

**Files:**
- Modify: `styles.css`
- Modify: `src/ui/components/MarkdownView.svelte`（scoped 选择器改新 class；`.ratel-md-block-error`）

**Interfaces:**
- Consumes: `.ratel-md-block` 合同
- 叶子选择器压过 Obsidian `pre`/`button`

- [x] **Step 1: `styles.css` 用新 class 替换现有 `.ratel-code-block*` 段**

```css
.workspace-leaf-content[data-type="ratel-chat"] .ratel-md .ratel-md-block {
	margin: 0.9em 0;
	border: 1px solid var(--background-modifier-border);
	border-radius: 10px;
	overflow: hidden;
	background: var(--background-secondary);
}
.workspace-leaf-content[data-type="ratel-chat"] .ratel-md .ratel-md-block-bar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	min-height: 32px;
	padding: 0 8px 0 12px;
	border-bottom: 1px solid var(--background-modifier-border);
	background: color-mix(in srgb, var(--background-primary) 55%, var(--background-secondary));
}
.workspace-leaf-content[data-type="ratel-chat"] .ratel-md .ratel-md-block-label {
	font-size: 11px;
	font-weight: 500;
	letter-spacing: 0.04em;
	text-transform: lowercase;
	color: var(--text-faint, var(--text-muted));
	user-select: none;
}
.workspace-leaf-content[data-type="ratel-chat"] .ratel-md .ratel-md-block-actions {
	display: flex;
	align-items: center;
	gap: 4px;
}
.workspace-leaf-content[data-type="ratel-chat"] .ratel-md .ratel-md-block-body pre {
	margin: 0;
	padding: 12px 14px;
	border-radius: 0;
	background: transparent;
	overflow-x: auto;
}
.workspace-leaf-content[data-type="ratel-chat"] .ratel-md .ratel-md-block-body svg {
	max-width: 100%;
	height: auto;
	display: block;
	margin: 12px auto;
}
.workspace-leaf-content[data-type="ratel-chat"] button.ratel-md-copy,
.workspace-leaf-content[data-type="ratel-chat"] button.ratel-md-expand {
	appearance: none;
	-webkit-appearance: none;
	margin: 0;
	padding: 3px 8px;
	min-height: unset;
	height: auto;
	min-width: unset;
	border: 1px solid transparent;
	border-radius: 6px;
	box-shadow: none;
	background: transparent;
	color: var(--text-muted);
	font-family: inherit;
	font-size: 11px;
	line-height: 1.3;
	cursor: pointer;
}
.workspace-leaf-content[data-type="ratel-chat"] button.ratel-md-copy:hover,
.workspace-leaf-content[data-type="ratel-chat"] button.ratel-md-expand:hover {
	background: var(--background-modifier-hover);
	color: var(--text-normal);
	box-shadow: none;
}
.workspace-leaf-content[data-type="ratel-chat"] button.ratel-md-copy.is-copied {
	color: var(--text-success, var(--interactive-accent));
}
.workspace-leaf-content[data-type="ratel-chat"] .ratel-md .ratel-md-table-wrap {
	margin: 0.9em 0;
	overflow-x: auto;
	border: 1px solid var(--background-modifier-border);
	border-radius: 10px;
}
.workspace-leaf-content[data-type="ratel-chat"] .ratel-md .ratel-md-table-wrap table {
	margin: 0;
	width: max-content;
	min-width: 100%;
}
.workspace-leaf-content[data-type="ratel-chat"] .ratel-md .ratel-md-block-error {
	padding: 8px 10px;
	color: var(--text-error);
	font-size: 11.5px;
}
```

MarkdownView scoped：把 `.ratel-code-*` 改成 `.ratel-md-block*` 对应选择器；`.ratel-mermaid-error` → `.ratel-md-block-error`。

- [x] **Step 2: 打字机路径自检**

读 `MarkdownView.svelte` 的 `renderToDom`：必须仍是 (1) `innerHTML = html` (2) 再 `void renderMermaidBlocks(...).finally(bind)`。若有人改成 `await renderMermaidBlocks` 再 innerHTML，**改回去**。

- [x] **Step 3: 全量相关测试 + build**

```bash
npx vitest run tests/utils/markdown-renderer.test.ts tests/utils/mermaid-renderer.test.ts tests/ui/chat/md-block-enhance.test.ts
npm run build
```

Expected: 测试 PASS；build 成功（允许既有 svelte a11y warning）。

- [x] **Step 4: Commit**

```bash
git add styles.css src/ui/components/MarkdownView.svelte
git commit -m "$(cat <<'EOF'
style(md): 统一富块与表格横滚压过 Obsidian pre

EOF
)"
```

**本 plan 验收：** Sandbox Reload 后，\`\`\`json 与 \`\`\`mermaid 顶栏一致、都能复制（mermaid 为源码）；宽表横滚；流式时字仍往下长。无放大钮是预期（P-MD-PREVIEW-2）。
