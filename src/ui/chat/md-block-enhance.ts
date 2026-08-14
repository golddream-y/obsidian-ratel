/**
 * @file src/ui/chat/md-block-enhance.ts
 * @description 给 Markdown 富块挂复制 / 放大按钮；未包外壳的围栏再包一层
 * @module ui/chat/md-block-enhance
 * @depends utils/markdown-renderer
 */

import { decodeFenceSrcAttr } from '../../utils/markdown-renderer';

const LANG_RE = /\blanguage-([a-z0-9_+-]+)/i;
const COPIED_MS = 1600;

export interface MdBlockLabels {
	copy: string;
	copied: string;
	expand?: string;
}

export interface EnhanceMdBlocksOptions {
	labels: MdBlockLabels;
	onExpand?: (block: HTMLElement) => void;
}

/**
 * 在已渲染的 Markdown 容器内，保证围栏块是统一外壳并带复制钮。
 *
 * 设计要点:
 * - 渲染层已输出 `.ratel-md-block` 时只补按钮，不叠外壳
 * - mermaid 复制取 `data-ratel-src`（经 decodeFenceSrcAttr 解码）
 * - 仅当传入 onExpand 且 body 内已有 svg 时才挂放大钮
 *
 * @param root - Markdown 根节点
 * @param opts - 文案与可选放大回调
 * @returns 清理函数（清 timer 与点击监听）
 */
export function enhanceMdBlocks(root: HTMLElement, opts: EnhanceMdBlocksOptions): () => void {
	const cleanups: Array<() => void> = [];
	const { labels, onExpand } = opts;

	const pres = Array.from(root.querySelectorAll('pre'));
	for (const pre of pres) {
		if (pre.closest('.ratel-md-block')) continue;
		if (pre.closest('.ratel-mermaid')) continue;
		const code = pre.querySelector('code');
		if (code?.className.includes('language-mermaid')) continue;
		cleanups.push(wrapBarePre(pre, code, labels, onExpand));
	}

	for (const block of Array.from(root.querySelectorAll<HTMLElement>('.ratel-md-block'))) {
		if (block.querySelector('.ratel-md-copy')) continue;
		cleanups.push(attachButtons(block, labels, onExpand));
	}

	return () => {
		for (const c of cleanups) c();
	};
}

/**
 * 把单个裸 `<pre>` 换成带顶栏的富块外壳。
 *
 * @param pre - 围栏 pre
 * @param code - 内部 code，可能为空
 * @param labels - 文案
 * @param onExpand - 可选放大回调
 * @returns 该块的清理函数
 */
function wrapBarePre(
	pre: HTMLElement,
	code: HTMLElement | null,
	labels: MdBlockLabels,
	onExpand?: (block: HTMLElement) => void,
): () => void {
	const parent = pre.parentElement;
	if (!parent) return () => {};

	const wrap = activeDocument.body.createDiv({
		cls: 'ratel-md-block',
		attr: { 'data-ratel-fence': 'code' },
	});
	wrap.remove();
	parent.insertBefore(wrap, pre);

	const bar = wrap.createDiv({ cls: 'ratel-md-block-bar' });
	const lang = langFromClass(code?.className ?? '');
	bar.createSpan({ cls: 'ratel-md-block-label', text: lang });
	bar.createDiv({ cls: 'ratel-md-block-actions' });

	const body = wrap.createDiv({ cls: 'ratel-md-block-body' });
	body.appendChild(pre);

	return attachButtons(wrap, labels, onExpand);
}

/**
 * 给已有外壳补复制钮（及可选放大钮）。
 *
 * @param block - `.ratel-md-block`
 * @param labels - 文案
 * @param onExpand - 可选放大回调
 * @returns 清理函数
 */
function attachButtons(
	block: HTMLElement,
	labels: MdBlockLabels,
	onExpand?: (block: HTMLElement) => void,
): () => void {
	let actions = block.querySelector<HTMLElement>('.ratel-md-block-actions');
	if (!actions) {
		let bar = block.querySelector<HTMLElement>('.ratel-md-block-bar');
		if (!bar) {
			bar = block.createDiv({ cls: 'ratel-md-block-bar' });
			bar.createSpan({ cls: 'ratel-md-block-label' });
			const first = block.firstChild;
			if (first) block.insertBefore(bar, first);
		}
		actions = bar.createDiv({ cls: 'ratel-md-block-actions' });
	}

	const cleanups: Array<() => void> = [];
	cleanups.push(attachCopyButton(block, actions, labels));

	if (onExpand) {
		const body = block.querySelector('.ratel-md-block-body') ?? block;
		if (body.querySelector('svg')) {
			cleanups.push(attachExpandButton(block, actions, labels, onExpand));
		}
	}

	return () => {
		for (const c of cleanups) c();
	};
}

/**
 * 在操作区挂复制钮并绑定点击。
 *
 * @param block - 富块根
 * @param actions - 操作区容器
 * @param labels - 文案
 * @returns 清理函数
 */
function attachCopyButton(
	block: HTMLElement,
	actions: HTMLElement,
	labels: MdBlockLabels,
): () => void {
	const btn = actions.createEl('button', {
		cls: 'ratel-md-copy',
		text: labels.copy,
		attr: { type: 'button', 'aria-label': labels.copy },
	});

	let copiedTimer: ReturnType<typeof window.setTimeout> | null = null;
	const onClick = () => {
		const text = copyTextForBlock(block);
		void copyText(text).then((ok) => {
			if (!ok) return;
			btn.classList.add('is-copied');
			btn.setText(labels.copied);
			if (copiedTimer) window.clearTimeout(copiedTimer);
			copiedTimer = window.setTimeout(() => {
				btn.classList.remove('is-copied');
				btn.setText(labels.copy);
				copiedTimer = null;
			}, COPIED_MS);
		});
	};
	btn.addEventListener('click', onClick);

	return () => {
		if (copiedTimer) window.clearTimeout(copiedTimer);
		btn.removeEventListener('click', onClick);
	};
}

/**
 * 在操作区挂放大钮并绑定点击。
 *
 * @param block - 富块根
 * @param actions - 操作区容器
 * @param labels - 文案（取 expand）
 * @param onExpand - 放大回调
 * @returns 清理函数
 */
function attachExpandButton(
	block: HTMLElement,
	actions: HTMLElement,
	labels: MdBlockLabels,
	onExpand: (block: HTMLElement) => void,
): () => void {
	const expandLabel = labels.expand ?? '';
	const btn = actions.createEl('button', {
		cls: 'ratel-md-expand',
		text: expandLabel,
		attr: { type: 'button', 'aria-label': expandLabel },
	});

	const onClick = () => onExpand(block);
	btn.addEventListener('click', onClick);

	return () => {
		btn.removeEventListener('click', onClick);
	};
}

/**
 * 按围栏类型取出应复制的源码。
 *
 * @param block - `.ratel-md-block`
 * @returns 纯文本源码
 */
function copyTextForBlock(block: HTMLElement): string {
	if (block.getAttribute('data-ratel-fence') === 'mermaid') {
		return decodeFenceSrcAttr(block.getAttribute('data-ratel-src') ?? '');
	}
	const code = block.querySelector('code');
	const pre = block.querySelector('pre');
	return code?.textContent ?? pre?.textContent ?? '';
}

/**
 * 从 hljs class 抽出语言名；没有则显示空串。
 *
 * @param className - code 元素 class
 * @returns 小写语言 id，或空串
 */
function langFromClass(className: string): string {
	const m = LANG_RE.exec(className);
	const raw = m?.[1]?.toLowerCase() ?? '';
	if (!raw || raw === 'plaintext' || raw === 'text') return '';
	return raw;
}

/**
 * 写入剪贴板。优先 Clipboard API。
 *
 * @param text - 要复制的源码
 * @returns 是否成功
 */
async function copyText(text: string): Promise<boolean> {
	try {
		if (!navigator.clipboard?.writeText) return false;
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}
