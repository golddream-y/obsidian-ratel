/**
 * @file src/ui/chat/cite-enhance.ts
 * @description 助手 Markdown DOM 中把 `[n]` 提升为可点击 cite
 * @module ui/chat/cite-enhance
 */

const CITE_RE = /\[\[(\d+)\]\]|\[(\d+)\]/g;

/**
 * 在已渲染的 Markdown 容器内,将匹配编号的 `[n]`/`[[n]]` 文本替换为可点按钮。
 *
 * 关键路径:只处理非 `pre`/`code`/`a`/`button` 内的文本节点,避免破坏代码块与真链接。
 * 无匹配编号时保持原文本(spec §5.5.4)。
 *
 * @param root - Markdown 根节点
 * @param validIndexes - 本轮 searchResults 的 index 集合
 * @param onCite - 点击编号回调
 * @returns 清理函数(移除监听)
 */
export function enhanceCiteLinks(
	root: HTMLElement,
	validIndexes: Set<number>,
	onCite: (index: number) => void,
): () => void {
	if (validIndexes.size === 0) return () => {};

	const buttons: HTMLButtonElement[] = [];
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const targets: Text[] = [];
	let node: Node | null = walker.nextNode();
	while (node) {
		const parent = node.parentElement;
		if (
			parent &&
			!parent.closest('pre, code, a, button, .ratel-cite')
		) {
			const text = node.textContent ?? '';
			CITE_RE.lastIndex = 0;
			if (CITE_RE.test(text)) targets.push(node as Text);
		}
		node = walker.nextNode();
	}

	for (const textNode of targets) {
		const text = textNode.textContent ?? '';
		CITE_RE.lastIndex = 0;
		let match: RegExpExecArray | null;
		let last = 0;
		// 关键路径:用 Obsidian createFragment / createEl,避免商店 prefer-create-el。
		const frag = createFragment();
		let changed = false;
		while ((match = CITE_RE.exec(text)) !== null) {
			const n = Number(match[1] ?? match[2]);
			const start = match.index;
			if (start > last) {
				frag.appendText(text.slice(last, start));
			}
			if (validIndexes.has(n)) {
				changed = true;
				const btn = createEl('button', {
					cls: 'ratel-cite',
					text: `[${n}]`,
					attr: {
						type: 'button',
						'aria-label': String(n),
						'data-cite-index': String(n),
					},
				});
				const handler = (e: Event) => {
					e.preventDefault();
					e.stopPropagation();
					onCite(n);
				};
				btn.addEventListener('click', handler);
				buttons.push(btn);
				frag.appendChild(btn);
			} else {
				frag.appendText(match[0]);
			}
			last = start + match[0].length;
		}
		if (!changed) continue;
		if (last < text.length) {
			frag.appendText(text.slice(last));
		}
		textNode.parentNode?.replaceChild(frag, textNode);
	}

	return () => {
		for (const btn of buttons) {
			btn.replaceWith(document.createTextNode(btn.textContent ?? ''));
		}
	};
}
