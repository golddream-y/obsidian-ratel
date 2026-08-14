/**
 * @file src/ui/chat/cite-path-tooltip.ts
 * @description 引用 [n] 悬停显示笔记路径 — 自绘 tip(不依赖 Obsidian setTooltip)
 * @module ui/chat/cite-path-tooltip
 */

const TIP_CLS = 'ratel-cite-tip';

/**
 * 给 cite 按钮绑定悬停路径提示。
 *
 * 安全路径:tip 挂在 document.body,避免被 .ratel-messages overflow 裁切;
 * Obsidian 侧栏里原生 title / setTooltip 经常不弹出。
 *
 * @param btn - 引用按钮
 * @param path - vault 相对路径
 * @returns 卸载监听与 tip
 */
export function bindCitePathTooltip(btn: HTMLElement, path: string): () => void {
	let tip: HTMLDivElement | null = null;

	const hide = () => {
		tip?.remove();
		tip = null;
	};

	const show = () => {
		hide();
		tip = document.body.createDiv({ cls: TIP_CLS, attr: { role: 'tooltip' } });
		tip.setText(path);

		const br = btn.getBoundingClientRect();
		const tr = tip.getBoundingClientRect();
		const left = Math.max(8, Math.min(br.left, window.innerWidth - tr.width - 8));
		// 优先按钮上方;空间不够则落到下方
		let top = br.top - tr.height - 6;
		if (top < 8) top = br.bottom + 6;
		tip.setCssProps({ left: `${left}px`, top: `${top}px` });
	};

	btn.addEventListener('pointerenter', show);
	btn.addEventListener('pointerleave', hide);
	btn.addEventListener('pointerdown', hide);
	window.addEventListener('scroll', hide, true);

	return () => {
		hide();
		btn.removeEventListener('pointerenter', show);
		btn.removeEventListener('pointerleave', hide);
		btn.removeEventListener('pointerdown', hide);
		window.removeEventListener('scroll', hide, true);
	};
}
