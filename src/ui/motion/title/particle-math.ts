/**
 * @file src/ui/motion/title/particle-math.ts
 * @description Particle Text 散射/聚拢进度 — 对齐 react-bits Particle Text
 * @module ui/motion/title/particle-math
 * @origin https://reactbits.dev/text-animations/particle-text
 */

/** 确定性 0–1 噪声，避免 Math.random 让测试抖动 */
export function hash01(n: number): number {
	const x = Math.sin(n * 12.9898) * 43758.5453;
	return x - Math.floor(x);
}

/**
 * 粒子从远处飞向字形目标。默认绕目标点，半径落在 [scatter*minRatio, scatter]。
 *
 * @param index - 粒子序号
 * @param targetX - 字形采样点 x
 * @param targetY - 字形采样点 y
 * @param scatter - 最远散射半径 px
 * @param originX - 聚拢中心 x（字块中心）
 * @param originY - 聚拢中心 y
 * @param minRatio - 最近起点相对 scatter 的比例，避免贴着目标出生
 */
export function particleStart(
	index: number,
	targetX: number,
	targetY: number,
	scatter: number,
	originX = targetX,
	originY = targetY,
	minRatio = 0.68,
): { x: number; y: number } {
	const angle = hash01(index * 2.17) * Math.PI * 2;
	const minR = scatter * Math.min(0.95, Math.max(0, minRatio));
	const radius = minR + hash01(index * 5.91) * Math.max(0, scatter - minR);
	return {
		x: originX + Math.cos(angle) * radius,
		y: originY + Math.sin(angle) * radius,
	};
}

/**
 * 单粒聚拢进度（含 stagger 延迟）。
 *
 * @param elapsedMs - 已过毫秒
 * @param delayMs - 该粒启动延迟
 * @param durationMs - 聚拢时长
 * @returns 0–1，ease-out
 */
export function gatherProgress(elapsedMs: number, delayMs: number, durationMs: number): number {
	if (elapsedMs <= delayMs) return 0;
	const raw = Math.min(1, (elapsedMs - delayMs) / Math.max(1, durationMs));
	return 1 - (1 - raw) ** 3;
}

/**
 * 线性插值。
 */
export function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

/** Canvas / CSS 共用的字形度量（只取对齐所需字段） */
export interface GlyphMetrics {
	width: number;
	actualBoundingBoxLeft: number;
	actualBoundingBoxRight: number;
	actualBoundingBoxAscent: number;
	actualBoundingBoxDescent: number;
	fontBoundingBoxAscent?: number;
	fontBoundingBoxDescent?: number;
}

/**
 * CSS 行框内字母基线相对内容盒顶边的距离。
 * half-leading = (line-height - (ascent + descent)) / 2，可为负。
 *
 * @param lineHeight - 计算后的行高（px）
 * @param fontAscent - 字体 em 方上延（fontBoundingBoxAscent）
 * @param fontDescent - 字体 em 方下延（fontBoundingBoxDescent）
 * @returns 基线相对行框顶边的 px
 */
export function cssAlphabeticBaseline(
	lineHeight: number,
	fontAscent: number,
	fontDescent: number,
): number {
	return (lineHeight - (fontAscent + fontDescent)) / 2 + fontAscent;
}

/**
 * 离屏采样画布尺寸与 fillText 原点，使最左/最上墨水落在 (0,0) 附近。
 *
 * @param metrics - measureText 得到的 ink / 宽度字段
 * @returns origin 供 alphabetic fillText；width/height 为采样画布像素
 */
export function glyphSampleLayout(metrics: GlyphMetrics): {
	originX: number;
	originY: number;
	width: number;
	height: number;
} {
	const left = Math.max(0, Math.ceil(metrics.actualBoundingBoxLeft || 0));
	const right = Math.ceil(metrics.actualBoundingBoxRight || metrics.width);
	const ascent = Math.max(1, Math.ceil(metrics.actualBoundingBoxAscent || 0));
	const descent = Math.max(0, Math.ceil(metrics.actualBoundingBoxDescent || 0));
	return {
		originX: left,
		originY: ascent,
		width: Math.max(1, left + right),
		height: Math.max(1, ascent + descent),
	};
}

/**
 * 用 0 高探针量 CSS 字母基线相对明文顶边的距离（不用 canvas 字框去猜）。
 * 探针由调用方挂在明文内（0×0、vertical-align:baseline），避免运行时 createElement。
 *
 * @param label - 明文元素
 * @param probe - 明文内的基线探针
 * @returns 基线相对 label 顶边的 px
 */
export function measureCssAlphabeticBaseline(label: HTMLElement, probe: HTMLElement): number {
	return probe.getBoundingClientRect().top - label.getBoundingClientRect().top;
}

/**
 * 把采样画布叠到明文上：采样原点 (originX, originY) 对齐 CSS 字母基线。
 *
 * @param pad - 散射预留边
 * @param labelLeft - 明文相对宿主的 left
 * @param labelTop - 明文相对宿主的 top
 * @param cssBaseline - CSS 字母基线相对明文顶边
 * @param originX - 采样 fillText x
 * @param originY - 采样 fillText y（alphabetic）
 * @returns canvas 的 CSS left/top
 */
export function particleCanvasOffset(
	pad: number,
	labelLeft: number,
	labelTop: number,
	cssBaseline: number,
	originX: number,
	originY: number,
): { left: number; top: number } {
	return {
		left: labelLeft - originX - pad,
		top: labelTop + cssBaseline - originY - pad,
	};
}
