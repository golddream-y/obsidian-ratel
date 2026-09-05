/**
 * @file src/ui/mascot/gesture.ts
 * @description 捣蛋鬼单击 vs 拖动：按下到抬起的位移阈值
 * @module ui/mascot/gesture
 */

/** 小于该像素距离视为单击，不写新坐标 */
export const MASCOT_TAP_SLOP = 6;

/**
 * 位移是否仍算单击。
 *
 * @param dx - 相对 pointerdown 的水平像素
 * @param dy - 相对 pointerdown 的垂直像素
 * @param slop - 阈值，默认 MASCOT_TAP_SLOP
 */
export function isMascotTap(dx: number, dy: number, slop: number = MASCOT_TAP_SLOP): boolean {
	return dx * dx + dy * dy < slop * slop;
}
