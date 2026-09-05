/**
 * @file src/ui/mascot/face-motion.test.ts
 * @description 等待慢转眼与说话开合量
 * @module ui/mascot/face-motion.test
 */
import { describe, it, expect } from 'vitest';
import { waitingWander, speakingTalkAmount, listeningGlance, idleGlance, shouldDoubleBlink, nextBlinkDelayMs, idleSwayRotate, waitingBodyRotate, speakingNod, thinkingWink, errorShakeRotate } from './face-motion';

describe('waitingWander', () => {
	it('不同时刻 - 视线水平分量会变 - 不是死盯', () => {
		const a = waitingWander(0);
		const b = waitingWander(800);
		expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y)).toBeGreaterThan(0.05);
	});
	it('任意时刻 - 分量限幅 - 不超过 waiting 摆幅', () => {
		for (const t of [0, 250, 1000, 3333]) {
			const g = waitingWander(t);
			expect(Math.abs(g.x)).toBeLessThanOrEqual(0.55);
			expect(Math.abs(g.y)).toBeLessThanOrEqual(0.4);
		}
	});
});

describe('speakingTalkAmount', () => {
	it('开合量 - 一周期内有高低差 - 不是定值', () => {
		const samples = [0, 40, 80, 120, 160, 200].map(speakingTalkAmount);
		expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(0.2);
	});
	it('开合量 - 任意时刻 - 落在 0-1', () => {
		for (const t of [0, 37, 90, 180, 4000]) {
			const a = speakingTalkAmount(t);
			expect(a).toBeGreaterThanOrEqual(0);
			expect(a).toBeLessThanOrEqual(1);
		}
	});
});

describe('listeningGlance', () => {
	it('看向输入框 - 垂直分量为正 - 朝下', () => {
		expect(listeningGlance(0).y).toBeGreaterThan(0.1);
		expect(listeningGlance(400).y).toBeGreaterThan(0.1);
	});
	it('不同时刻 - 水平分量会变 - 像跟着字走', () => {
		expect(listeningGlance(0).x).not.toBeCloseTo(listeningGlance(600).x, 2);
	});
});

describe('idleGlance', () => {
	it('空闲微瞥 - 两时刻水平分量不同', () => {
		expect(idleGlance(0).x).not.toBeCloseTo(idleGlance(1800).x, 2);
	});
});

describe('shouldDoubleBlink / nextBlinkDelayMs', () => {
	it('连眨判定 - rand 小于 0.25 - 为 true', () => {
		expect(shouldDoubleBlink(0)).toBe(true);
		expect(shouldDoubleBlink(0.24)).toBe(true);
		expect(shouldDoubleBlink(0.25)).toBe(false);
	});
	it('下次间隔 - 连眨 - 落在 120-220ms', () => {
		const d = nextBlinkDelayMs({ blinkMin: 6000, blinkMax: 12000 }, 0.5, true);
		expect(d).toBeGreaterThanOrEqual(120);
		expect(d).toBeLessThanOrEqual(220);
	});
	it('下次间隔 - 普通眨 - 落在 blinkMin-Max', () => {
		const d = nextBlinkDelayMs({ blinkMin: 6000, blinkMax: 12000 }, 0, false);
		expect(d).toBe(6000);
	});
});

describe('idleSwayRotate', () => {
	it('闲着轻晃 - 两时刻角度不同 - 且不超过约 4 度', () => {
		expect(idleSwayRotate(0)).not.toBeCloseTo(idleSwayRotate(2200), 5);
		for (const t of [0, 400, 1200, 5000]) {
			expect(Math.abs(idleSwayRotate(t))).toBeLessThanOrEqual(4.05);
		}
	});
});

describe('waitingBodyRotate', () => {
	it('等待摆身 - 两时刻角度不同', () => {
		expect(waitingBodyRotate(0)).not.toBeCloseTo(waitingBodyRotate(900), 5);
	});
});

describe('speakingNod', () => {
	it('说话点头 - 两时刻 offset 不同', () => {
		expect(speakingNod(0)).not.toBeCloseTo(speakingNod(400), 5);
	});
});

describe('thinkingWink', () => {
	it('思考单眼 - 一个周期内出现明显闭合', () => {
		const samples = Array.from({ length: 30 }, (_, i) => thinkingWink(i * 100));
		expect(Math.max(...samples)).toBeGreaterThan(0.4);
		expect(Math.min(...samples)).toBeGreaterThanOrEqual(0);
	});
});

describe('errorShakeRotate', () => {
	it('报错短震 - 前 220ms 有摆 - 之后为 0', () => {
		expect(Math.abs(errorShakeRotate(40))).toBeGreaterThan(2);
		expect(errorShakeRotate(300)).toBe(0);
	});
});
