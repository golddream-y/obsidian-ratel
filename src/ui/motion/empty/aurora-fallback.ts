/**
 * @file src/ui/motion/empty/aurora-fallback.ts
 * @description Aurora 背景降级判定（无 WebGL / 闸门关闭 → CSS 呼吸）
 * @module ui/motion/empty/aurora-fallback
 */

/**
 * 是否应使用 CSS 呼吸降级而非 WebGL 环。
 *
 * @param enabled - 调用方闸门（通常来自 isChatMotionEnabled）
 * @param webgl2Supported - 当前环境是否可创建 WebGL2 上下文
 * @returns 为 true 时不启动 rAF / canvas
 */
export function shouldUseAuroraFallback(enabled: boolean, webgl2Supported: boolean): boolean {
	return !enabled || !webgl2Supported;
}

/**
 * 探测 WebGL2 是否可用（jsdom 等环境常返回 false）。
 *
 * @returns 能否取得 webgl2 上下文
 */
export function probeWebGL2Support(): boolean {
	if (typeof document === 'undefined') return false;
	try {
		const canvas = document.body.createEl('canvas');
		const getContext = (canvas as { getContext?: HTMLCanvasElement['getContext'] }).getContext;
		const ok = typeof getContext === 'function' && !!getContext.call(canvas, 'webgl2', { alpha: true });
		canvas.remove();
		return ok;
	} catch {
		return false;
	}
}

/**
 * 将 `#rrggbb` 转为 0–1 RGB 三元组（供 uniform 上传）。
 *
 * @param hex - 六位十六进制色
 * @returns 线性 RGB
 */
export function hexToRgb01(hex: string): [number, number, number] {
	const h = hex.replace('#', '');
	return [
		parseInt(h.slice(0, 2), 16) / 255,
		parseInt(h.slice(2, 4), 16) / 255,
		parseInt(h.slice(4, 6), 16) / 255,
	];
}
