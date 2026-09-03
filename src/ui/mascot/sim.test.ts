/**
 * @file src/ui/mascot/sim.test.ts
 * @description 吉祥物模拟器：关动效静脸、开动效视线会动
 * @module ui/mascot/sim.test
 */
import { describe, it, expect } from 'vitest';
import { MascotSim } from './sim';

describe('MascotSim', () => {
	it('关动效 - 指针有位移 - 视线仍为 0', () => {
		const sim = new MascotSim();
		const f = sim.tick({
			face: 'idle',
			animate: false,
			pointerGaze: { x: 0.5, y: 0.2 },
			dt: 1 / 60,
			now: 1000,
		});
		expect(f.gazeX).toBe(0);
		expect(f.gazeY).toBe(0);
	});
	it('等待态开动效 - 若干帧后视线离开原点', () => {
		const sim = new MascotSim();
		let f = sim.tick({
			face: 'waiting',
			animate: true,
			pointerGaze: { x: 0, y: 0 },
			dt: 1 / 60,
			now: 0,
		});
		for (let i = 1; i <= 20; i++) {
			f = sim.tick({
				face: 'waiting',
				animate: true,
				pointerGaze: { x: 0, y: 0 },
				dt: 1 / 60,
				now: i * 80,
			});
		}
		expect(Math.abs(f.gazeX) + Math.abs(f.gazeY)).toBeGreaterThan(0.04);
	});
	it('按下 - 若干帧后身体竖直被压扁', () => {
		const sim = new MascotSim();
		let f = sim.tick({
			face: 'idle',
			animate: true,
			pointerGaze: { x: 0, y: 0 },
			dt: 1 / 60,
			now: 0,
			pressing: true,
		});
		for (let i = 1; i <= 18; i++) {
			f = sim.tick({
				face: 'idle',
				animate: true,
				pointerGaze: { x: 0, y: 0 },
				dt: 1 / 60,
				now: i * 16,
				pressing: true,
			});
		}
		expect(f.body.scaleY).toBeLessThan(0.97);
	});
});
