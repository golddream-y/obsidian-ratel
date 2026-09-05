/**
 * @file src/ui/mascot/sim.ts
 * @description 捣蛋鬼姿态模拟：弹簧换脸、视线滞后、呼吸、眨眼过冲、单击轻弹
 * @module ui/mascot/sim
 * @depends ./types, ./eyes, ./face-motion, ./spring
 *
 * 运动手法参考 MIT blob-eyes 开源（临界阻尼弹簧 + 开合度眨眼），点列与姿态为 Ratel 原创。
 */
import type { MascotFace } from './types';
import { getEyeRings, lerpRings, applyGaze, squashRing, type EyeRing } from './eyes';
import {
	waitingWander,
	listeningGlance,
	idleGlance,
	idleSwayRotate,
	waitingBodyRotate,
	speakingNod,
	speakingTalkAmount,
	thinkingWink,
	errorShakeRotate,
	shouldDoubleBlink,
	nextBlinkDelayMs,
} from './face-motion';
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

export interface FaceKinetics {
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
	idle: { breathe: 0.03, rotate: 0, bounceAmp: 0, bounceHz: 0, blinkMin: 6000, blinkMax: 12000, restOpen: 1, lookBiasX: 0, lookBiasY: 0 },
	waiting: { breathe: 0.016, rotate: 0, bounceAmp: 0.35, bounceHz: 0.55, blinkMin: 3800, blinkMax: 7200, restOpen: 0.94, lookBiasX: 0, lookBiasY: 0 },
	thinking: { breathe: 0.005, rotate: -10, bounceAmp: 0, bounceHz: 0, blinkMin: 8000, blinkMax: 14000, restOpen: 0.32, lookBiasX: 0.08, lookBiasY: 0.06 },
	working: { breathe: 0.012, rotate: 8, bounceAmp: 1.6, bounceHz: 3.2, blinkMin: 2400, blinkMax: 4200, restOpen: 1.04, lookBiasX: 0, lookBiasY: -0.04 },
	speaking: { breathe: 0.018, rotate: 0, bounceAmp: 0.9, bounceHz: 2.4, blinkMin: 1600, blinkMax: 3200, restOpen: 1.04, lookBiasX: 0, lookBiasY: -0.04 },
	listening: { breathe: 0.014, rotate: 3, bounceAmp: 0.12, bounceHz: 0.7, blinkMin: 2400, blinkMax: 4400, restOpen: 0.94, lookBiasX: 0, lookBiasY: 0 },
	error: { breathe: 0.004, rotate: -13, bounceAmp: 0, bounceHz: 0, blinkMin: 0, blinkMax: 0, restOpen: 0.68, lookBiasX: 0.12, lookBiasY: 0.08 },
	stopped: { breathe: 0.002, rotate: 3, bounceAmp: 0, bounceHz: 0, blinkMin: 0, blinkMax: 0, restOpen: 0.28, lookBiasX: 0, lookBiasY: 0.12 },
};

/**
 * 各脸运动参数（供测试断言忙态差）。
 */
export function mascotKinetics(face: MascotFace): FaceKinetics {
	return FACE_KINETICS[face];
}

function clamp(v: number, a: number, b: number): number {
	return Math.min(b, Math.max(a, v));
}

/**
 * 捣蛋鬼每帧姿态。ChatMascot 只喂信号，不在组件里堆正弦。
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
	private squashX: Spring = createSpring(1);
	private squashY: Spring = createSpring(1);
	private tapUntil = 0;
	private tapAmp = 1;
	private errorAt = -1;
	private lastAnimate = true;
	private rng: () => number;

	/**
	 * @param rng - 眨眼随机源，测试可注入恒值
	 */
	constructor(rng: () => number = Math.random) {
		this.rng = rng;
	}

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
	 * 单击轻弹：把压扁弹簧目标打出去一截。
	 *
	 * @param amp - 1 为闲着满幅，忙态约 0.5
	 * @param now - 当前毫秒
	 */
	pulseTap(amp: number, now: number): void {
		if (!this.lastAnimate) return;
		this.tapAmp = amp;
		this.tapUntil = now + 320;
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
		pressing?: boolean;
	}): MascotSimFrame {
		this.lastAnimate = args.animate;
		if (args.face === 'error' && this.toFace !== 'error') {
			this.errorAt = args.now;
		}
		this.setFace(args.face, args.animate);
		const kin = FACE_KINETICS[this.toFace];

		if (!args.animate) {
			snapSpring(this.morph, 1);
			snapSpring(this.gazeX, 0);
			snapSpring(this.gazeY, 0);
			snapSpring(this.open, kin.restOpen);
			snapSpring(this.squashX, 1);
			snapSpring(this.squashY, 1);
			this.tapUntil = 0;
			return this.compose(args.now, 0, 0, kin.rotate);
		}

		this.morph.t = 1;
		stepSpring(this.morph, 16, 0.88, args.dt);

		const tapping = args.now < this.tapUntil;
		this.squashX.t = args.pressing ? 1.1 : tapping ? 1 + 0.12 * this.tapAmp : 1;
		this.squashY.t = args.pressing ? 0.88 : tapping ? 1 - 0.2 * this.tapAmp : 1;
		stepSpring(this.squashX, 18, 0.72, args.dt);
		stepSpring(this.squashY, 18, 0.72, args.dt);

		let tx = args.pointerGaze.x + kin.lookBiasX;
		let ty = args.pointerGaze.y + kin.lookBiasY;
		const pointerQuiet = Math.abs(args.pointerGaze.x) + Math.abs(args.pointerGaze.y) < 0.08;
		if (this.toFace === 'idle' && pointerQuiet) {
			const g = idleGlance(args.now);
			tx = g.x;
			ty = g.y;
		}
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
		if (this.toFace === 'speaking' && this.blinkPhase === 'idle') {
			this.open.t = kin.restOpen - speakingTalkAmount(args.now) * 0.55;
		}
		stepSpring(this.open, 26, 1, args.dt);

		const t = args.now / 1000;
		const breathe = kin.breathe * Math.sin((Math.PI * 2 * t) / 3.6);
		const bounce = kin.bounceAmp * Math.sin(Math.PI * 2 * kin.bounceHz * t);
		return this.compose(args.now, breathe, bounce, kin.rotate);
	}

	private stepBlink(now: number, kin: FaceKinetics): void {
		if (kin.blinkMin <= 0) {
			this.open.t = kin.restOpen;
			this.blinkPhase = 'idle';
			return;
		}
		if (this.blinkAt === 0) {
			this.blinkAt = now + nextBlinkDelayMs(kin, this.rng(), false);
		}
		if (this.blinkPhase === 'idle' && now >= this.blinkAt) {
			this.blinkPhase = 'shut';
			this.open.t = 0.06;
			this.open.x = 0.08;
			this.open.v = 0;
			this.blinkUntil = now + 70;
		} else if (this.blinkPhase === 'shut' && now >= this.blinkUntil) {
			this.blinkPhase = 'open';
			this.open.t = 1.18;
			this.blinkUntil = now + 90;
		} else if (this.blinkPhase === 'open' && now >= this.blinkUntil) {
			this.blinkPhase = 'idle';
			this.open.t = kin.restOpen;
			const dbl = shouldDoubleBlink(this.rng());
			this.blinkAt = now + nextBlinkDelayMs(kin, this.rng(), dbl);
		} else if (this.blinkPhase === 'idle') {
			this.open.t = kin.restOpen;
		}
	}

	private compose(now: number, breathe = 0, bounce = 0, rotate = 0): MascotSimFrame {
		const k = clamp(this.morph.x, 0, 1);
		const from = getEyeRings(this.fromFace);
		const to = getEyeRings(this.toFace);
		let left = lerpRings(from.left, to.left, k);
		let right = lerpRings(from.right, to.right, k);
		const open = clamp(this.open.x, 0.04, 1.25);
		left = squashRing(left, 1 - open);
		right = squashRing(right, 1 - open);
		if (this.toFace === 'thinking') {
			left = squashRing(left, thinkingWink(now));
		}
		const gx = this.gazeX.x;
		const gy = this.gazeY.x;
		left = applyGaze(left, gx, gy);
		right = applyGaze(right, gx, gy);

		let extraRotate = rotate + bounce * 0.35 + gx * 8;
		let extraY = breathe * 1.8 + bounce * 0.4;
		if (this.lastAnimate && this.toFace === 'idle') {
			extraRotate += idleSwayRotate(now);
		}
		if (this.lastAnimate && this.toFace === 'waiting') {
			extraRotate += waitingBodyRotate(now);
		}
		if (this.lastAnimate && this.toFace === 'speaking') {
			extraY += speakingNod(now);
		}
		if (this.lastAnimate && this.toFace === 'error' && this.errorAt >= 0) {
			extraRotate += errorShakeRotate(now - this.errorAt);
		}

		return {
			left,
			right,
			gazeX: gx,
			gazeY: gy,
			open,
			body: {
				scaleX: (1 + breathe * 0.35) * this.squashX.x,
				scaleY: (1 + breathe + bounce * 0.01) * this.squashY.x,
				rotate: extraRotate,
				offsetY: extraY,
			},
		};
	}
}
