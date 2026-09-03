/**
 * @file src/ui/mascot/face-motion.test.ts
 * @description 等待慢转眼与说话开合量
 * @module ui/mascot/face-motion.test
 */
import { describe, it, expect } from 'vitest';
import { waitingWander, speakingTalkAmount } from './face-motion';

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
