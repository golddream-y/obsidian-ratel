/**
 * @file src/ui/mascot/sim.test.ts
 * @description 捣蛋鬼模拟器：关动效静脸、开动效视线会动
 * @module ui/mascot/sim.test
 */
import { describe, it, expect } from 'vitest';
import { MascotSim, mascotKinetics } from './sim';

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
	it('kinesis - thinking 比 idle 更歪 - working 颠得比 waiting 密', () => {
		expect(mascotKinetics('thinking').rotate).toBeLessThan(mascotKinetics('idle').rotate);
		expect(mascotKinetics('working').bounceHz).toBeGreaterThan(mascotKinetics('waiting').bounceHz);
		expect(mascotKinetics('stopped').restOpen).toBeLessThan(mascotKinetics('idle').restOpen);
	});
	it('pulseTap - 开动效 - 若干帧身体被压', () => {
		const sim = new MascotSim();
		sim.tick({
			face: 'idle',
			animate: true,
			pointerGaze: { x: 0, y: 0 },
			dt: 1 / 60,
			now: 0,
		});
		sim.pulseTap(1, 16);
		let f = sim.tick({
			face: 'idle',
			animate: true,
			pointerGaze: { x: 0, y: 0 },
			dt: 1 / 60,
			now: 32,
		});
		for (let i = 3; i <= 18; i++) {
			f = sim.tick({
				face: 'idle',
				animate: true,
				pointerGaze: { x: 0, y: 0 },
				dt: 1 / 60,
				now: i * 16,
			});
		}
		expect(f.body.scaleY).toBeLessThan(0.97);
	});
	it('pulseTap - 关动效 - 身体不被压', () => {
		const sim = new MascotSim();
		sim.tick({
			face: 'idle',
			animate: false,
			pointerGaze: { x: 0, y: 0 },
			dt: 1 / 60,
			now: 0,
		});
		sim.pulseTap(1, 16);
		const f = sim.tick({
			face: 'idle',
			animate: false,
			pointerGaze: { x: 0, y: 0 },
			dt: 1 / 60,
			now: 48,
		});
		expect(f.body.scaleY).toBeGreaterThan(0.98);
	});
	it('连眨 - rng 恒 0 - 第一眨后第二次闭眼间隔短', () => {
		const sim = new MascotSim(() => 0);
		let firstShut = -1;
		let secondShut = -1;
		for (let t = 0; t <= 9000; t += 16) {
			const f = sim.tick({
				face: 'idle',
				animate: true,
				pointerGaze: { x: 0, y: 0 },
				dt: 1 / 60,
				now: t,
			});
			if (f.open < 0.35) {
				if (firstShut < 0) firstShut = t;
				else if (t > firstShut + 180 && secondShut < 0) secondShut = t;
			}
		}
		expect(firstShut).toBeGreaterThan(0);
		expect(secondShut).toBeGreaterThan(0);
		expect(secondShut - firstShut).toBeLessThan(450);
	});
	it('说话 - 两时刻开合不同', () => {
		const sim = new MascotSim();
		const a = sim.tick({
			face: 'speaking',
			animate: true,
			pointerGaze: { x: 0, y: 0 },
			dt: 1 / 60,
			now: 0,
		});
		let b = a;
		for (let i = 1; i <= 12; i++) {
			b = sim.tick({
				face: 'speaking',
				animate: true,
				pointerGaze: { x: 0, y: 0 },
				dt: 1 / 60,
				now: i * 40,
			});
		}
		expect(Math.abs(a.open - b.open) + Math.abs(a.body.offsetY - b.body.offsetY)).toBeGreaterThan(0.04);
	});
	it('切入 error - 短震 - 旋转幅度大于 idle 轻晃', () => {
		const err = new MascotSim();
		err.tick({
			face: 'idle',
			animate: true,
			pointerGaze: { x: 0, y: 0 },
			dt: 1 / 60,
			now: 0,
		});
		const f = err.tick({
			face: 'error',
			animate: true,
			pointerGaze: { x: 0, y: 0 },
			dt: 1 / 60,
			now: 40,
		});
		expect(Math.abs(f.body.rotate)).toBeGreaterThan(4);
	});
});
