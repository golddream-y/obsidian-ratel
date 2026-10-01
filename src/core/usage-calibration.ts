/**
 * @file src/core/usage-calibration.ts
 * @description 进程内会话级 token 估算校准 — 用 API promptTokens 与本地 measureOutbound 比值修正占用显示
 * @module core/usage-calibration
 */

/** sessionId → 校准比值(promptTokens / measured),已夹在 [0.5, 2] */
const calibrationBySession = new Map<string, number>();

const RATIO_MIN = 0.5;
const RATIO_MAX = 2;

/**
 * 将 API 真值与本地估算写入会话校准表。
 *
 * measured 或 promptTokens ≤ 0 时不记录、不覆盖已有比值。
 *
 * @param sessionId - 会话 ID
 * @param measured - measureOutbound(...).total
 * @param promptTokens - 接口返回的 prompt token 数
 */
export function recordUsageCalibration(
	sessionId: string,
	measured: number,
	promptTokens: number,
): void {
	if (measured <= 0 || promptTokens <= 0) return;
	const raw = promptTokens / measured;
	const clamped = Math.min(RATIO_MAX, Math.max(RATIO_MIN, raw));
	calibrationBySession.set(sessionId, clamped);
}

/**
 * 读取会话校准比值;无记录时返回 1(不缩放)。
 *
 * @param sessionId - 会话 ID
 * @returns 夹在 [0.5, 2] 的比值,或 1
 */
export function usageCalibrationRatio(sessionId: string): number {
	return calibrationBySession.get(sessionId) ?? 1;
}
