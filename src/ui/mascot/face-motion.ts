/**
 * @file src/ui/mascot/face-motion.ts
 * @description 等待慢转眼、说话开合、听打字朝下看 — 纯函数，供 rAF 取样
 * @module ui/mascot/face-motion
 */

/** 等待态水平摆幅，不超过视线限幅 */
const WAIT_AMP_X = 0.5;
/** 等待态垂直摆幅 */
const WAIT_AMP_Y = 0.32;
const WAIT_HZ_X = 0.72;
const WAIT_HZ_Y = 0.5;

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
 * 空闲微瞥：鼠标停住时眼睛仍轻轻扫，避免木呆。
 */
export function idleGlance(nowMs: number): { x: number; y: number } {
	const t = nowMs / 1000;
	return {
		x: Math.sin(t * 0.55) * 0.22,
		y: Math.cos(t * 0.38) * 0.1,
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

/** 听用户打字：朝下看输入框，水平小幅跟着走 */
const LISTEN_DOWN = 0.16;
const LISTEN_AMP_X = 0.22;
const LISTEN_HZ_X = 1.4;

/**
 * 用户在输入框打字：眼睛朝下看 composer，并沿水平轻扫。
 *
 * @param nowMs - 单调毫秒
 * @returns 叠加到 gaze 的归一化偏移
 */
export function listeningGlance(nowMs: number): { x: number; y: number } {
	const t = nowMs / 1000;
	return {
		x: Math.sin(t * LISTEN_HZ_X) * LISTEN_AMP_X,
		y: LISTEN_DOWN,
	};
}

/**
 * 是否安排连眨（约四分之一）。
 *
 * @param rand - [0,1) 随机数
 */
export function shouldDoubleBlink(rand: number): boolean {
	return rand < 0.25;
}

/**
 * 下一眨距离当前的毫秒数。
 *
 * @param kin - 该脸的眨间隔范围
 * @param rand - [0,1)
 * @param doubleBlink - 是否短间隔连眨
 */
export function nextBlinkDelayMs(
	kin: { blinkMin: number; blinkMax: number },
	rand: number,
	doubleBlink: boolean,
): number {
	if (doubleBlink) return 120 + rand * 100;
	return kin.blinkMin + rand * (kin.blinkMax - kin.blinkMin);
}

/**
 * 闲着身体慢倾，约 ±4°。
 */
export function idleSwayRotate(nowMs: number): number {
	return 4 * Math.sin((nowMs / 1000) * 0.7);
}

/**
 * 等待时身体左右轻摆。
 */
export function waitingBodyRotate(nowMs: number): number {
	return 5 * Math.sin((nowMs / 1000) * 0.8);
}

/**
 * 说话时轻微点头（像素量级的 offsetY）。
 */
export function speakingNod(nowMs: number): number {
	return 1.05 * Math.sin((nowMs / 1000) * 3.1);
}

/**
 * 思考时左眼额外闭合量 0–1，约每 3s 眨一下单眼。
 */
export function thinkingWink(nowMs: number): number {
	const cycle = ((nowMs % 3000) + 3000) % 3000;
	if (cycle >= 180) return 0;
	return 0.85 * Math.sin((cycle / 180) * Math.PI);
}

/**
 * 切入报错后的短震角度；220ms 后为 0。
 *
 * @param elapsedMs - 自切入 error 起的毫秒
 */
export function errorShakeRotate(elapsedMs: number): number {
	if (elapsedMs < 0 || elapsedMs >= 220) return 0;
	const env = 1 - elapsedMs / 220;
	return 8 * Math.sin((elapsedMs / 70) * Math.PI * 2) * env;
}
