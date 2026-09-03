/**
 * @file src/ui/mascot/layout.ts
 * @description 吉祥物窗体比例坐标与视线限幅
 * @module ui/mascot/layout
 */

export const MASCOT_SIZE = 48;
export const MASCOT_INSET = 12;
export const DEFAULT_MASCOT_RATIO = { x: 1, y: 1 };
export const GAZE_CLAMP_X = 0.55;
export const GAZE_CLAMP_Y = 0.4;

/**
 * 将比例坐标 clamp 到 0–1。
 *
 * @param x - 水平比例
 * @param y - 垂直比例
 * @returns clamp 后的 { x, y }
 */
export function clampMascotRatio(x: number, y: number): { x: number; y: number } {
	return {
		x: Math.min(1, Math.max(0, x)),
		y: Math.min(1, Math.max(0, y)),
	};
}

/**
 * 比例坐标 → 绝对 left/top。可动盒为 pane 减去吉祥物尺寸与双侧 inset。
 *
 * @param x - 水平比例 0–1
 * @param y - 垂直比例 0–1
 * @param paneW - 聊天窗宽度
 * @param paneH - 聊天窗高度
 * @returns 吉祥物左上角 left/top
 */
export function ratioToOffset(x: number, y: number, paneW: number, paneH: number): { left: number; top: number } {
	const { x: cx, y: cy } = clampMascotRatio(x, y);
	const boxW = paneW - MASCOT_SIZE - 2 * MASCOT_INSET;
	const boxH = paneH - MASCOT_SIZE - 2 * MASCOT_INSET;
	return {
		left: MASCOT_INSET + cx * Math.max(0, boxW),
		top: MASCOT_INSET + cy * Math.max(0, boxH),
	};
}

/**
 * 绝对 left/top → 比例坐标，结果 clamp 到 0–1。
 *
 * @param left - 吉祥物左上角水平偏移
 * @param top - 吉祥物左上角垂直偏移
 * @param paneW - 聊天窗宽度
 * @param paneH - 聊天窗高度
 * @returns clamp 后的比例 { x, y }
 */
export function offsetToRatio(left: number, top: number, paneW: number, paneH: number): { x: number; y: number } {
	const boxW = paneW - MASCOT_SIZE - 2 * MASCOT_INSET;
	const boxH = paneH - MASCOT_SIZE - 2 * MASCOT_INSET;
	const rawX = boxW > 0 ? (left - MASCOT_INSET) / boxW : 0;
	const rawY = boxH > 0 ? (top - MASCOT_INSET) / boxH : 0;
	return clampMascotRatio(rawX, rawY);
}

/**
 * 由指针相对吉祥物中心计算归一化视线，水平 ±GAZE_CLAMP_X、垂直 ±GAZE_CLAMP_Y 限幅。
 *
 * @param pointerX - 指针 X；null/undefined 视为无指针
 * @param pointerY - 指针 Y；null/undefined 视为无指针
 * @param mascotCenterX - 吉祥物中心 X
 * @param mascotCenterY - 吉祥物中心 Y
 * @param frozen - 拖动冻结时为 true，视线归零
 * @returns 限幅后的 gaze { x, y }
 */
export function computeGaze(
	pointerX: number | null | undefined,
	pointerY: number | null | undefined,
	mascotCenterX: number,
	mascotCenterY: number,
	frozen: boolean,
): { x: number; y: number } {
	if (frozen || pointerX == null || pointerY == null) {
		return { x: 0, y: 0 };
	}
	const dx = pointerX - mascotCenterX;
	const dy = pointerY - mascotCenterY;
	return {
		x: Math.min(GAZE_CLAMP_X, Math.max(-GAZE_CLAMP_X, dx / MASCOT_SIZE)),
		y: Math.min(GAZE_CLAMP_Y, Math.max(-GAZE_CLAMP_Y, dy / MASCOT_SIZE)),
	};
}
