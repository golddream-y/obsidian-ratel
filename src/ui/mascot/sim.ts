/**
 * @file src/ui/mascot/sim.ts
 * @description 吉祥物姿态模拟：弹簧换脸、视线滞后、呼吸、眨眼过冲
 * @module ui/mascot/sim
 * @depends ./types, ./eyes, ./face-motion, ./spring
 *
 * 运动手法参考 MIT blob-eyes 开源（临界阻尼弹簧 + 开合度眨眼），点列与姿态为 Ratel 原创。
 */
import type { MascotFace } from './types';
import { getEyeRings, lerpRings, applyGaze, squashRing, type EyeRing } from './eyes';
import { waitingWander, listeningGlance } from './face-motion';
import { createSpring, snapSpring, stepSpring, type Spring } from './spring';

export interface MascotBodyPose {
	scaleX: number;
	scaleY: number;
	rotate: number;
	offsetY: number;
}

export interface MascotSimFrame {
	left: EyeRing;
	right: EyeRing;
	body: MascotBodyPose;
	gazeX: number;
	gazeY: number;
	open: number;
}

interface FaceKinetics {
	breathe: number;
	rotate: number;
	bounceAmp: number;
	bounceHz: number;
	blinkMin: number;
	blinkMax: number;
	restOpen: number;
	lookBiasX: number;
	lookBiasY: number;
}

const FACE_KINETICS: Record<MascotFace, FaceKinetics> = {
	idle: { breathe: 0.022, rotate: 0, bounceAmp: 0, bounceHz: 0, blinkMin: 2200, blinkMax: 4800, restOpen: 1, lookBiasX: 0, lookBiasY: 0 },
	waiting: { breathe: 0.014, rotate: 0, bounceAmp: 0, bounceHz: 0, blinkMin: 3800, blinkMax: 7200, restOpen: 0.94, lookBiasX: 0, lookBiasY: 0 },
	thinking: { breathe: 0.007, rotate: -6, bounceAmp: 0, bounceHz: 0, blinkMin: 8000, blinkMax: 14000, restOpen: 0.4, lookBiasX: 0.08, lookBiasY: 0.06 },
	working: { breathe: 0.012, rotate: 7, bounceAmp: 1.1, bounceHz: 2.4, blinkMin: 2400, blinkMax: 4200, restOpen: 1.04, lookBiasX: 0, lookBiasY: -0.04 },
	speaking: { breathe: 0.016, rotate: 0, bounceAmp: 2.4, bounceHz: 3.6, blinkMin: 1400, blinkMax: 2800, restOpen: 1.06, lookBiasX: 0, lookBiasY: -0.05 },
	listening: { breathe: 0.012, rotate: 4, bounceAmp: 0.4, bounceHz: 1.1, blinkMin: 2400, blinkMax: 4400, restOpen: 0.92, lookBiasX: 0, lookBiasY: 0.28 },
	error: { breathe: 0.004, rotate: -11, bounceAmp: 0, bounceHz: 0, blinkMin: 0, blinkMax: 0, restOpen: 0.72, lookBiasX: 0.12, lookBiasY: 0.08 },
	stopped: { breathe: 0.003, rotate: 2, bounceAmp: 0, bounceHz: 0, blinkMin: 0, blinkMax: 0, restOpen: 0.32, lookBiasX: 0, lookBiasY: 0.12 },
};

function clamp(v: number, a: number, b: number): number {
	return Math.min(b, Math.max(a, v));
}

/**
 * 吉祥物每帧姿态。ChatMascot 只喂信号，不在组件里堆正弦。
 */
export class MascotSim {
	private morph: Spring = createSpring(1);
	private gazeX: Spring = createSpring(0);
	private gazeY: Spring = createSpring(0);
	private open: Spring = createSpring(1);
	private fromFace: MascotFace = 'idle';
	private toFace: MascotFace = 'idle';
	private blinkAt = 0;
	private blinkPhase: 'idle' | 'shut' | 'open' = 'idle';
	private blinkUntil = 0;

	/**
	 * 切脸。animate=false 时立刻贴住。
	 *
	 * @param face - 目标脸档
	 * @param animate - 是否弹簧
	 */
	setFace(face: MascotFace, animate: boolean): void {
		if (face === this.toFace) return;
		if (!animate) {
			this.fromFace = face;
			this.toFace = face;
			snapSpring(this.morph, 1);
			return;
		}
		this.fromFace = this.morph.x > 0.97 ? this.toFace : this.fromFace;
		this.toFace = face;
		this.morph.t = 1;
		this.morph.x = 0;
		this.morph.v = 0;
	}

	/**
	 * 推进一帧。
	 *
	 * @param args.face - 当前脸
	 * @param args.animate - 动效闸门
	 * @param args.pointerGaze - 指针视线，已限幅
	 * @param args.dt - 秒
	 * @param args.now - 毫秒
	 */
	tick(args: {
		face: MascotFace;
		animate: boolean;
		pointerGaze: { x: number; y: number };
		dt: number;
		now: number;
	}): MascotSimFrame {
		this.setFace(args.face, args.animate);
		const kin = FACE_KINETICS[this.toFace];

		if (!args.animate) {
			snapSpring(this.morph, 1);
			snapSpring(this.gazeX, 0);
			snapSpring(this.gazeY, 0);
			snapSpring(this.open, kin.restOpen);
			return this.compose();
		}

		this.morph.t = 1;
		stepSpring(this.morph, 16, 0.88, args.dt);

		let tx = args.pointerGaze.x + kin.lookBiasX;
		let ty = args.pointerGaze.y + kin.lookBiasY;
		if (this.toFace === 'waiting') {
			const w = waitingWander(args.now);
			tx = clamp(w.x + args.pointerGaze.x * 0.28, -0.55, 0.55);
			ty = clamp(w.y + args.pointerGaze.y * 0.28, -0.4, 0.4);
		}
		if (this.toFace === 'listening') {
			const g = listeningGlance(args.now);
			tx = clamp(g.x + args.pointerGaze.x * 0.2, -0.55, 0.55);
			ty = clamp(g.y + args.pointerGaze.y * 0.15, -0.4, 0.4);
		}
		this.gazeX.t = tx;
		this.gazeY.t = ty;
		stepSpring(this.gazeX, 11, 0.78, args.dt);
		stepSpring(this.gazeY, 11, 0.78, args.dt);

		this.stepBlink(args.now, kin);
		stepSpring(this.open, 26, 1, args.dt);

		const t = args.now / 1000;
		const breathe = kin.breathe * Math.sin((Math.PI * 2 * t) / 3.6);
		const bounce = kin.bounceAmp * Math.sin(Math.PI * 2 * kin.bounceHz * t);
		return this.compose(breathe, bounce, kin.rotate);
	}

	private stepBlink(now: number, kin: FaceKinetics): void {
		if (kin.blinkMin <= 0) {
			this.open.t = kin.restOpen;
			this.blinkPhase = 'idle';
			return;
		}
		if (this.blinkAt === 0) {
			this.blinkAt = now + kin.blinkMin + Math.random() * (kin.blinkMax - kin.blinkMin);
		}
		if (this.blinkPhase === 'idle' && now >= this.blinkAt) {
			this.blinkPhase = 'shut';
			this.open.t = 0.06;
			this.blinkUntil = now + 70;
		} else if (this.blinkPhase === 'shut' && now >= this.blinkUntil) {
			this.blinkPhase = 'open';
			this.open.t = 1.18;
			this.blinkUntil = now + 90;
		} else if (this.blinkPhase === 'open' && now >= this.blinkUntil) {
			this.blinkPhase = 'idle';
			this.open.t = kin.restOpen;
			this.blinkAt = now + kin.blinkMin + Math.random() * (kin.blinkMax - kin.blinkMin);
		} else if (this.blinkPhase === 'idle') {
			this.open.t = kin.restOpen;
		}
	}

	private compose(breathe = 0, bounce = 0, rotate = 0): MascotSimFrame {
		const k = clamp(this.morph.x, 0, 1);
		const from = getEyeRings(this.fromFace);
		const to = getEyeRings(this.toFace);
		let left = lerpRings(from.left, to.left, k);
		let right = lerpRings(from.right, to.right, k);
		const open = clamp(this.open.x, 0.04, 1.25);
		left = squashRing(left, 1 - open);
		right = squashRing(right, 1 - open);
		const gx = this.gazeX.x;
		const gy = this.gazeY.x;
		left = applyGaze(left, gx, gy);
		right = applyGaze(right, gx, gy);
		return {
			left,
			right,
			gazeX: gx,
			gazeY: gy,
			open,
			body: {
				scaleX: 1 + breathe * 0.35,
				scaleY: 1 + breathe + bounce * 0.012,
				rotate: rotate + bounce * 0.4,
				offsetY: breathe * 1.6 + bounce * 0.35,
			},
		};
	}
}
