/**
 * @file src/ui/mascot/face-motion.ts
 * @description 等待慢转眼、说话开合 — 纯函数，供 rAF 取样
 * @module ui/mascot/face-motion
 */

/** 等待态水平摆幅，不超过视线限幅 */
const WAIT_AMP_X = 0.5;
/** 等待态垂直摆幅 */
const WAIT_AMP_Y = 0.32;
const WAIT_HZ_X = 0.9;
const WAIT_HZ_Y = 0.65;

/** 说话开合角频率：约 85ms 半拍，看起来像在讲 */
const TALK_PERIOD_MS = 170;
/** 开合峰值，1 为几乎闭眼 */
const TALK_PEAK = 0.55;

/**
 * 网络等待：眼睛在脸内慢转，避免空盯。
 *
 * @param nowMs - performance.now() 或任意单调毫秒
 * @returns 叠加到 gaze 的归一化偏移
 */
export function waitingWander(nowMs: number): { x: number; y: number } {
	const t = nowMs / 1000;
	return {
		x: Math.sin(t * WAIT_HZ_X) * WAIT_AMP_X,
		y: Math.cos(t * WAIT_HZ_Y) * WAIT_AMP_Y,
	};
}

/**
 * 流式正文：双眼周期性压扁，形成开合。
 *
 * @param nowMs - 单调毫秒
 * @returns 0 睁开 … 峰值接近闭眼
 */
export function speakingTalkAmount(nowMs: number): number {
	const phase = (nowMs / TALK_PERIOD_MS) * Math.PI * 2;
	return (Math.sin(phase) + 1) * 0.5 * TALK_PEAK;
}
