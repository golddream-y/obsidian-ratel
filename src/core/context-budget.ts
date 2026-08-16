/**
 * @file src/core/context-budget.ts
 * @description 上送历史上限推导 — 由模型窗口计算 Layer 1 预算,替代写死的 8000
 * @module core/context-budget
 */

/**
 * 输出余量:给模型回复留的空间。
 *
 * 关键路径:大窗按 10%、封顶 32k;窗 < 32k 时改按 15% 且下限 512,
 * 避免 custom 4k 上 reserve(8k) > 窗口。
 *
 * @param window - 模型上下文窗口上限(token)
 * @returns 输出预留 token 数,区间 [512, 32_000];窗 < 32k 时为 max(512, 15% 窗),大窗为 min(32_000, 10% 窗)
 */
export function outputReserve(window: number): number {
	// 32_000 分界:低于此按小窗比例(15%/20%),避免固定预留吃掉大半 custom 窗口
	if (window < 32_000) return Math.max(512, Math.floor(window * 0.15));
	// 修复: 大窗去掉 8,192 下限 — 旧 max(8_192, 10%) 与固定 prefixSlack 叠加,
	// 使 32k 分界处 tailBudget 从 20,801 暴跌到 1,024(95% 悬崖)
	return Math.min(32_000, Math.floor(window * 0.10));
}

/**
 * 前缀预留:系统段 + 记忆 + skill discovery + 检索块 + compact head
 * 都不经 Layer 1,预算必须先扣掉;小窗按 20% 缩放。
 *
 * @param window - 模型上下文窗口上限(token)
 * @returns 前缀预留 token 数,区间 [512, 24_000];窗 < 32k 时为 max(512, 20% 窗),大窗为 min(24_000, 20% 窗)
 */
export function prefixSlack(window: number): number {
	if (window < 32_000) return Math.max(512, Math.floor(window * 0.20));
	// 24_000:大窗前缀(系统段+记忆+discovery+检索块+compact head)实测峰值上限;
	// 同时按 20% 缩放,保证 32k 分界两侧预算单调不减(旧固定 24_000 使 [32k, 33.2k] 区间触 tailBudget 下限)
	return Math.min(24_000, Math.floor(window * 0.20));
}

/**
 * Layer 1 历史池预算(projectView tail 的 token 上限)。
 *
 * 256k → 206,400;1M → 992,576;custom 4k → 2,663;下限 1,024。
 *
 * 前置条件:window ≥ 2,048 时 reserve + slack + budget 不超 window
 * (两处 max 均触 512 下限的极端区间内,2,048 是三项之和恰好不超过窗口的最小整数窗)。
 *
 * @param window - 模型上下文窗口上限(token),来自 getEffectiveChatModelMaxTokens
 * @returns tail 预算 token 数,恒 ≥ 1,024;32k 分界两侧单调不减
 */
export function tailBudget(window: number): number {
	// 1_024 下限:极端小窗(如 custom 1024)在 reserve+slack 扣完后仍保底一份可用历史
	return Math.max(1_024, window - outputReserve(window) - prefixSlack(window));
}
