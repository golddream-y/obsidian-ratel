/**
 * @file src/ui/chat/message-stream/virtual-window.ts
 * @description 变量高度渲染单元的前缀布局、可见窗口与测量补偿
 * @module ui/chat/message-stream/virtual-window
 */

/** 可参与虚拟布局的最小单元契约 — 只要求稳定 id */
export interface VirtualItemLike { id: string }

/** 布局后的单元几何 — top/height/bottom 基于估算或实测 */
export interface VirtualLayoutItem extends VirtualItemLike {
	index: number;
	top: number;
	height: number;
	bottom: number;
}

/** 完整虚拟布局 — 前缀位置数组、id 索引与总高度 */
export interface VirtualLayout {
	items: VirtualLayoutItem[];
	byId: Map<string, VirtualLayoutItem>;
	totalHeight: number;
}

/** 可见挂载范围与上下 spacer 高度 */
export interface VirtualRange {
	start: number;
	end: number;
	paddingTop: number;
	paddingBottom: number;
}

/**
 * 构建完整前缀高度布局;未测量单元使用类型估算值。
 *
 * @param items - 按展示顺序排列的渲染单元
 * @param measured - 已实测的单元高度
 * @param estimate - 未测量单元的高度估算函数
 * @returns 包含前缀位置、id 索引和总高度的布局
 * @example
 *   buildVirtualLayout(items, measured, () => 96);
 */
export function buildVirtualLayout<T extends VirtualItemLike>(
	items: T[],
	measured: ReadonlyMap<string, number>,
	estimate: (item: T) => number,
): VirtualLayout {
	let top = 0;
	const layoutItems = items.map((item, index): VirtualLayoutItem => {
		// 性能:高度下限 1px,防御零高单元导致窗口计算死区间
		const height = Math.max(1, measured.get(item.id) ?? estimate(item));
		const out = { id: item.id, index, top, height, bottom: top + height };
		top += height;
		return out;
	});
	return { items: layoutItems, byId: new Map(layoutItems.map((item) => [item.id, item])), totalHeight: top };
}

/**
 * 计算视口、overscan 与临时保留 id 的连续挂载范围。
 *
 * @param layout - 完整变量高度布局
 * @param scrollTop - 当前滚动位置
 * @param viewportHeight - 视口高度
 * @param overscanPx - 视口上下额外挂载距离
 * @param retainedIds - 因焦点或选择而必须暂留的单元 id
 * @returns 连续挂载范围及上下占位高度
 * @example
 *   computeVirtualRange(layout, 1000, 600, 600, new Set());
 */
export function computeVirtualRange(
	layout: VirtualLayout,
	scrollTop: number,
	viewportHeight: number,
	overscanPx: number,
	retainedIds: ReadonlySet<string>,
): VirtualRange {
	if (layout.items.length === 0) return { start: 0, end: 0, paddingTop: 0, paddingBottom: 0 };
	const minY = Math.max(0, scrollTop - overscanPx);
	const maxY = scrollTop + Math.max(1, viewportHeight) + overscanPx;
	let start = layout.items.findIndex((item) => item.bottom > minY);
	if (start < 0) start = layout.items.length - 1;
	let end = start;
	while (end < layout.items.length && layout.items[end]!.top < maxY) end++;
	// 关键路径:retained 单元可能是选择文本的远端端点,扩展为连续范围防止中间内容被卸载
	for (const id of retainedIds) {
		const item = layout.byId.get(id);
		if (!item) continue;
		start = Math.min(start, item.index);
		end = Math.max(end, item.index + 1);
	}
	const paddingTop = layout.items[start]?.top ?? 0;
	const visibleBottom = end > 0 ? layout.items[end - 1]!.bottom : 0;
	return { start, end, paddingTop, paddingBottom: Math.max(0, layout.totalHeight - visibleBottom) };
}

/**
 * 实测高度变化发生在视口上方时补偿 scrollTop,保持阅读锚点。
 *
 * @param layout - 测量前的完整布局
 * @param id - 高度发生变化的单元 id
 * @param newHeight - 新实测高度
 * @param scrollTop - 测量前滚动位置
 * @returns 应用阅读锚点补偿后的滚动位置
 * @example
 *   compensateMeasuredHeight(layout, 'unit-1', 140, 1000);
 */
export function compensateMeasuredHeight(
	layout: VirtualLayout,
	id: string,
	newHeight: number,
	scrollTop: number,
): number {
	const item = layout.byId.get(id);
	// 关键路径:只在变化单元完全位于视口上方时补偿 — 视口内变化不该移动滚动
	if (!item || item.bottom > scrollTop) return scrollTop;
	return scrollTop + (Math.max(1, newHeight) - item.height);
}

/**
 * 返回未挂载单元在完整虚拟布局中的顶部位置。
 *
 * @param layout - 完整变量高度布局
 * @param id - 目标渲染单元 id
 * @returns 单元顶部偏移;不存在时返回 null
 * @example
 *   offsetForUnit(layout, 'unit-1');
 */
export function offsetForUnit(layout: VirtualLayout, id: string): number | null {
	return layout.byId.get(id)?.top ?? null;
}
