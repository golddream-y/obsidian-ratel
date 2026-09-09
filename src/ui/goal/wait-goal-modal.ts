/**
 * @file src/ui/goal/wait-goal-modal.ts
 * @description 连续 Goal Modal 让出当前指针事件,避免关一张立刻开下一张时点击穿透
 * @module ui/goal/wait-goal-modal
 */

/**
 * 等一拍再开下一张 Modal。
 * 同一 click 里 close+open 会让 mouseup 打到新弹窗按钮,放弃确认与归档来回弹。
 *
 * @param ms - 间隔毫秒,默认 50
 */
export function waitGoalModalGap(ms = 50): Promise<void> {
	return new Promise((resolve) => {
		window.setTimeout(resolve, ms);
	});
}
