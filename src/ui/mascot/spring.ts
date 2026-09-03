/**
 * @file src/ui/mascot/spring.ts
 * @description 临界阻尼弹簧步进（手法参考 MIT blob-eyes / grok-ball，实现自写）
 * @module ui/mascot/spring
 */

export interface Spring {
	x: number;
	v: number;
	t: number;
}

/**
 * 创建弹簧，位置与目标同为 v0。
 *
 * @param v0 - 初值
 */
export function createSpring(v0: number): Spring {
	return { x: v0, v: 0, t: v0 };
}

/**
 * 弹簧步进。子步 1/120s，避免大 dt 炸掉。
 *
 * @param s - 弹簧
 * @param omega - 角频率
 * @param zeta - 阻尼比；<1 会过冲，更弹
 * @param dt - 秒
 */
export function stepSpring(s: Spring, omega: number, zeta: number, dt: number): void {
	const cap = Math.min(dt, 0.05);
	const steps = Math.max(1, Math.ceil(cap / (1 / 120)));
	const j = cap / steps;
	for (let i = 0; i < steps; i++) {
		s.v += (-2 * zeta * omega * s.v - omega * omega * (s.x - s.t)) * j;
		s.x += s.v * j;
	}
	if (!Number.isFinite(s.x) || !Number.isFinite(s.v)) {
		s.x = s.t;
		s.v = 0;
	}
}

/**
 * 立刻贴到目标（关动效）。
 *
 * @param s - 弹簧
 * @param value - 目标
 */
export function snapSpring(s: Spring, value: number): void {
	s.x = value;
	s.v = 0;
	s.t = value;
}
