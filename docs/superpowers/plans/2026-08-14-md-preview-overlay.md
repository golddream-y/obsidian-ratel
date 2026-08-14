# P-MD-PREVIEW-2 — Markdown 预览 overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在聊天叶子内打开共用 overlay：放大 mermaid（快照 + 复制源码 + +/- / 拖移 / 重置）、点附件图与 Markdown `img` 看大图；Esc / 遮罩关闭；不抢消息列表滚轮。

**Architecture:** `createMdPreviewOverlay(host)` 单例挂在 `workspace-leaf-content[data-type=ratel-chat]`。入口用冒泡自定义事件 `ratel-md-preview`（enhance / 附件图派发），ChatView 监听后 `open` 快照。流式 `innerHTML` 重建底下 DOM 时 overlay 不跟刷。

**Tech Stack:** TypeScript / Svelte 5（仅接线）/ CSS transform / Vitest / i18n

**Spec:** [S-MD-PREVIEW](../specs/2026-08-14-markdown-preview-chrome-design.md)  
**前置:** [P-MD-PREVIEW-1](../archive/S-MD-PREVIEW/2026-08-14-md-preview-blocks.md) 必须已合入（`.ratel-md-block`、`data-ratel-src`、`enhanceMdBlocks` 的 `onExpand`）

## Global Constraints

- 用户可见字符串走 i18n；测试 `it(...)` 中文 `行为 - 条件 - 期望结果`
- **禁止**新增 pan-zoom / lightbox npm；**禁止** Obsidian `Modal`
- **禁止**在 `.ratel-md` 气泡上绑滚轮缩放（只 overlay 节点）
- **禁止** overlay 打开时暂停 `MarkdownView` rAF / `content` 刷新
- overlay 内容用打开当下的 SVG **clone** 或 img `src`，不持有会被 innerHTML 拆掉的活节点
- 只 link Sandbox 预览

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/i18n/*` | `chat.md.expand` `close` `zoomIn` `zoomOut` `zoomReset` `imageFailed` |
| `src/ui/chat/md-preview-overlay.ts` | 开/关/缩放/拖移/复制 |
| `tests/ui/chat/md-preview-overlay.test.ts` | Esc、复制、scale |
| `src/ui/chat/md-block-enhance.ts` | MarkdownView 传入 onExpand |
| `src/ui/components/MarkdownView.svelte` | 传 onExpand + 点 md img |
| `src/ui/chat/ChatView.svelte` | mount overlay、听事件 |
| `src/ui/chat/message-stream/MessageBubble.svelte` | 附件图点击 |
| `src/ui/chat/message-stream/MessageList.svelte` | 如需透传则透传（优先事件，避免钻 prop） |
| `styles.css` | `.ratel-md-overlay*` |

---

### Task 1: i18n overlay 文案

**Files:**
- Modify: `src/i18n/types.ts` `zh.ts` `en.ts`

**Interfaces:**
- Produces:

```typescript
  'chat.md.expand': string;
  'chat.md.close': string;
  'chat.md.zoomIn': string;
  'chat.md.zoomOut': string;
  'chat.md.zoomReset': string;
  'chat.md.imageFailed': string;
```

- [ ] **Step 1: 写入三表**

zh: `放大` / `关闭` / `放大`（zoomIn 用「放大一级」）/ `缩小` / `重置` / `图片无法加载`  
en: `Expand` / `Close` / `Zoom in` / `Zoom out` / `Reset` / `Image failed to load`

zoomIn 中文不要和 expand 撞成同一个「放大」：expand=`放大`，zoomIn=`放大一级`。

- [ ] **Step 2: Commit**

```bash
git add src/i18n/types.ts src/i18n/zh.ts src/i18n/en.ts
git commit -m "$(cat <<'EOF'
feat(i18n): Markdown 预览层放大/缩放文案

EOF
)"
```

---

### Task 2: overlay 模块（纯 DOM）

**Files:**
- Create: `src/ui/chat/md-preview-overlay.ts`
- Create: `tests/ui/chat/md-preview-overlay.test.ts`

**Interfaces:**

```typescript
export const RATEL_MD_PREVIEW_EVENT = 'ratel-md-preview';

export type MdPreviewDetail =
	| { kind: 'diagram'; svgHtml: string; source: string }
	| { kind: 'image'; src: string; alt: string };

export interface MdPreviewOverlayLabels {
	copy: string;
	copied: string;
	close: string;
	zoomIn: string;
	zoomOut: string;
	zoomReset: string;
	imageFailed: string;
}

export function createMdPreviewOverlay(
	host: HTMLElement,
	labels: MdPreviewOverlayLabels,
): {
	open(detail: MdPreviewDetail): void;
	close(): void;
	destroy(): void;
	el: HTMLElement;
};

export function dispatchMdPreview(from: EventTarget, detail: MdPreviewDetail): void;
```

`dispatchMdPreview`：`from.dispatchEvent(new CustomEvent(RATEL_MD_PREVIEW_EVENT, { bubbles: true, detail }))`。

行为：
- `open` 时 `el` 从 `hidden` 去掉，`role="dialog"` `aria-modal="true"`
- diagram：顶栏复制/+/−/重置/关闭；舞台内放入 **parse 后的 SVG 克隆**（`svgHtml` 字符串，避免活节点）
- image：`<img>`，`error` 时文案 `imageFailed`
- 滚轮在 `.ratel-md-overlay-stage` 上 `preventDefault` 改 scale（0.4–8）；pointer drag 改 translate
- Esc 关闭；点 `.ratel-md-overlay-backdrop` 关闭；关闭后焦点回 `document.activeElement` 记录的触发钮
- `destroy` 卸监听并从 host 移除

- [ ] **Step 1: 写失败测试**

```typescript
/**
 * @file tests/ui/chat/md-preview-overlay.test.ts
 * @description 聊天叶子 Markdown 预览层
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	createMdPreviewOverlay,
	dispatchMdPreview,
	RATEL_MD_PREVIEW_EVENT,
} from '../../../src/ui/chat/md-preview-overlay';

const LABELS = {
	copy: '复制', copied: '已复制', close: '关闭',
	zoomIn: '放大一级', zoomOut: '缩小', zoomReset: '重置', imageFailed: '图片无法加载',
};

describe('createMdPreviewOverlay', () => {
	beforeEach(() => {
		document.body.replaceChildren();
	});

	it('open diagram - 显示层且 Esc 关闭', () => {
		const host = document.createElement('div');
		document.body.appendChild(host);
		const api = createMdPreviewOverlay(host, LABELS);
		expect(api.el.hasAttribute('hidden')).toBe(true);
		api.open({ kind: 'diagram', svgHtml: '<svg xmlns="http://www.w3.org/2000/svg"></svg>', source: 'graph TD; A-->B' });
		expect(api.el.hasAttribute('hidden')).toBe(false);
		expect(api.el.getAttribute('role')).toBe('dialog');
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		expect(api.el.hasAttribute('hidden')).toBe(true);
		api.destroy();
	});

	it('open diagram - 复制源码不是 SVG', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.assign(navigator, { clipboard: { writeText } });
		const host = document.createElement('div');
		document.body.appendChild(host);
		const api = createMdPreviewOverlay(host, LABELS);
		api.open({ kind: 'diagram', svgHtml: '<svg xmlns="http://www.w3.org/2000/svg"></svg>', source: 'graph TD; A-->B' });
		api.el.querySelector<HTMLButtonElement>('.ratel-md-copy')!.click();
		await vi.waitFor(() => {
			expect(writeText).toHaveBeenCalledWith('graph TD; A-->B');
		});
		api.destroy();
	});

	it('dispatchMdPreview - 冒泡 CustomEvent', () => {
		const root = document.createElement('div');
		document.body.appendChild(root);
		const seen: unknown[] = [];
		root.addEventListener(RATEL_MD_PREVIEW_EVENT, (e) => {
			seen.push((e as CustomEvent).detail);
		});
		const child = document.createElement('button');
		root.appendChild(child);
		dispatchMdPreview(child, { kind: 'image', src: 'data:image/png;base64,xx', alt: 'a' });
		expect(seen).toEqual([{ kind: 'image', src: 'data:image/png;base64,xx', alt: 'a' }]);
	});
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run tests/ui/chat/md-preview-overlay.test.ts
```

Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `md-preview-overlay.ts`**

要点：
- 结构：`div.ratel-md-overlay[hidden]` > `div.ratel-md-overlay-backdrop` + `div.ratel-md-overlay-panel`（bar + stage）
- 用 `activeDocument.body.createDiv` / `createEl` 满足 prefer-create-el
- scale/translate 存在闭包变量，写在 stage 内包装 `div.ratel-md-overlay-scene` 的 `style.transform`
- 滚轮：`stage.addEventListener('wheel', onWheel, { passive: false })`
- 复制复用与 md-block 相同的 clipboard 逻辑（可小函数内联，不要反向依赖 enhance）
- `open` 时 `preventDefault` 不传到消息列表：overlay `pointer-events: auto` 铺满叶子

缩放步进：按钮 ±0.25；滚轮 `deltaY` 符号缩放 `exp(-deltaY * 0.0015)`。双击 scene 重置。

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run tests/ui/chat/md-preview-overlay.test.ts
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/ui/chat/md-preview-overlay.ts tests/ui/chat/md-preview-overlay.test.ts
git commit -m "$(cat <<'EOF'
feat(md): 聊天叶子预览层开闭与复制源码

EOF
)"
```

---

### Task 3: ChatView 挂层 + 样式

**Files:**
- Modify: `src/ui/chat/ChatView.svelte`
- Modify: `styles.css`

**Interfaces:**
- Consumes: `createMdPreviewOverlay`、`RATEL_MD_PREVIEW_EVENT`
- host = `chatRoot.closest('.workspace-leaf-content')`，与空态 class 同一叶子

- [ ] **Step 1: ChatView 生命周期**

在已有 `chatRoot` 与空态 `$effect` 旁增加：

```typescript
import { createMdPreviewOverlay, RATEL_MD_PREVIEW_EVENT, type MdPreviewDetail } from './md-preview-overlay';
import { tNow } from '../../i18n';

let mdOverlay: ReturnType<typeof createMdPreviewOverlay> | null = null;

$effect(() => {
	const leaf = chatRoot?.closest('.workspace-leaf-content') as HTMLElement | null;
	if (!leaf) return;
	mdOverlay?.destroy();
	mdOverlay = createMdPreviewOverlay(leaf, {
		copy: tNow('chat.md.copy'),
		copied: tNow('chat.md.copied'),
		close: tNow('chat.md.close'),
		zoomIn: tNow('chat.md.zoomIn'),
		zoomOut: tNow('chat.md.zoomOut'),
		zoomReset: tNow('chat.md.zoomReset'),
		imageFailed: tNow('chat.md.imageFailed'),
	});
	const onPreview = (e: Event) => {
		const ce = e as CustomEvent<MdPreviewDetail>;
		if (ce.detail) mdOverlay?.open(ce.detail);
	};
	leaf.addEventListener(RATEL_MD_PREVIEW_EVENT, onPreview);
	return () => {
		leaf.removeEventListener(RATEL_MD_PREVIEW_EVENT, onPreview);
		mdOverlay?.destroy();
		mdOverlay = null;
	};
});
```

确认 `onDestroy` 已有路径不会漏；`$effect` cleanup 即可。

- [ ] **Step 2: overlay CSS 写入 `styles.css`**

```css
.workspace-leaf-content[data-type="ratel-chat"] .ratel-md-overlay {
	position: absolute;
	inset: 0;
	z-index: 40;
	display: flex;
	flex-direction: column;
}
.workspace-leaf-content[data-type="ratel-chat"] .ratel-md-overlay[hidden] {
	display: none;
}
.workspace-leaf-content[data-type="ratel-chat"] .ratel-md-overlay-backdrop {
	position: absolute;
	inset: 0;
	background: color-mix(in srgb, var(--background-primary) 55%, #000);
}
.workspace-leaf-content[data-type="ratel-chat"] .ratel-md-overlay-panel {
	position: relative;
	z-index: 1;
	display: flex;
	flex-direction: column;
	flex: 1;
	min-height: 0;
	margin: 12px;
	border: 1px solid var(--background-modifier-border);
	border-radius: 10px;
	background: var(--background-secondary);
	overflow: hidden;
}
.workspace-leaf-content[data-type="ratel-chat"] .ratel-md-overlay-bar {
	display: flex;
	align-items: center;
	justify-content: flex-end;
	gap: 4px;
	min-height: 36px;
	padding: 0 8px;
	border-bottom: 1px solid var(--background-modifier-border);
}
.workspace-leaf-content[data-type="ratel-chat"] .ratel-md-overlay-stage {
	flex: 1;
	min-height: 0;
	overflow: hidden;
	cursor: grab;
	touch-action: none;
}
.workspace-leaf-content[data-type="ratel-chat"] .ratel-md-overlay-scene {
	transform-origin: 0 0;
	will-change: transform;
}
.workspace-leaf-content[data-type="ratel-chat"] .ratel-md-overlay-stage img,
.workspace-leaf-content[data-type="ratel-chat"] .ratel-md-overlay-stage svg {
	max-width: none;
	display: block;
}
@media (prefers-reduced-motion: reduce) {
	.workspace-leaf-content[data-type="ratel-chat"] .ratel-md-overlay {
		transition: none;
	}
}
```

叶子需 `position: relative`（若 `.workspace-leaf-content[data-type="ratel-chat"]` 还没有，补上）。overlay 按钮复用 `button.ratel-md-copy` 规则，关闭钮 class `ratel-md-overlay-close` 同样重置 Obsidian button。

- [ ] **Step 3: Commit**

```bash
git add src/ui/chat/ChatView.svelte styles.css
git commit -m "$(cat <<'EOF'
feat(md): 在聊天叶子挂载预览 overlay

EOF
)"
```

---

### Task 4: 放大钮 + 图片入口

**Files:**
- Modify: `src/ui/components/MarkdownView.svelte`
- Modify: `src/ui/chat/md-block-enhance.ts`（若还需点 `.ratel-md img`）
- Modify: `tests/ui/chat/md-block-enhance.test.ts`
- Modify: `src/ui/chat/message-stream/MessageBubble.svelte`

**Interfaces:**
- Consumes: `dispatchMdPreview`、`enhanceMdBlocks` 的 `onExpand`
- mermaid expand：`svgHtml = body.querySelector('svg')?.outerHTML ?? ''`，`source = block.dataset.ratelSrc ?? ''`

- [ ] **Step 1: 测试 onExpand 派发（可补在 md-block-enhance 或 overlay 测试）**

已有「有 onExpand 且有 svg - 画放大钮」。再补 Markdown 图：

```typescript
	it('enhanceMdBlocks - 点 md 内 img - dispatch image', () => {
		const root = document.createElement('div');
		root.innerHTML = `<p><img src="data:image/png;base64,aa" alt="图"></p>`;
		document.body.appendChild(root);
		const seen: unknown[] = [];
		root.addEventListener('ratel-md-preview', (e) => {
			seen.push((e as CustomEvent).detail);
		});
		enhanceMdBlocks(root, { labels: LABELS, onExpand: () => {} });
		root.querySelector('img')!.click();
		expect(seen[0]).toMatchObject({ kind: 'image', alt: '图' });
	});
```

（`onExpand` 传空函数只为打开「增强模式」里绑 img；更干净：img 绑定不依赖 onExpand，**始终**给 `.ratel-md img` 绑点击。选后者：无 onExpand 也能点图。）

**决定：img 点击始终绑定；onExpand 只控制放大钮。**

- [ ] **Step 2: 跑测试确认失败后实现**

`enhanceMdBlocks`：对 `root.querySelectorAll('img')`（排除 overlay）click → `dispatchMdPreview(img, { kind: 'image', src: img.currentSrc || img.src, alt: img.alt })`。

MarkdownView `bindCodeBlocks`：

```typescript
cleanupCodeBlocks = enhanceMdBlocks(containerEl, {
	labels: {
		copy: tNow('chat.md.copy'),
		copied: tNow('chat.md.copied'),
		expand: tNow('chat.md.expand'),
	},
	onExpand: (block) => {
		const svg = block.querySelector('.ratel-md-block-body svg');
		if (!svg) return;
		dispatchMdPreview(block, {
			kind: 'diagram',
			svgHtml: svg.outerHTML,
			source: block.getAttribute('data-ratel-src') ?? '',
		});
	},
});
```

仍 **禁止** await mermaid 再 innerHTML。

- [ ] **Step 3: MessageBubble 附件**

```svelte
<img
	class="ratel-msg-img"
	src="data:{att.mimeType};base64,{att.base64}"
	alt={att.fileName}
	title={att.fileName}
	role="button"
	tabindex="0"
	onclick={(e) => {
		dispatchMdPreview(e.currentTarget, {
			kind: 'image',
			src: (e.currentTarget as HTMLImageElement).src,
			alt: att.fileName,
		});
	}}
	onkeydown={(e) => {
		if (e.key !== 'Enter' && e.key !== ' ') return;
		e.preventDefault();
		(e.currentTarget as HTMLImageElement).click();
	}}
/>
```

cursor: pointer（若尚无）。

- [ ] **Step 4: 测试 + build**

```bash
npx vitest run tests/ui/chat/md-block-enhance.test.ts tests/ui/chat/md-preview-overlay.test.ts tests/utils/markdown-renderer.test.ts tests/utils/mermaid-renderer.test.ts
npm run build
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/MarkdownView.svelte src/ui/chat/md-block-enhance.ts tests/ui/chat/md-block-enhance.test.ts src/ui/chat/message-stream/MessageBubble.svelte
git commit -m "$(cat <<'EOF'
feat(md): mermaid 放大与图片灯箱走同一 overlay

EOF
)"
```

**本 plan 验收：** Sandbox Reload 后点 mermaid「放大」能看清、能缩放/拖移、Esc 关；列表滚动 overlay 外正常；流式时底下字继续长、层内图不每帧闪掉；点附件图同样进层。
