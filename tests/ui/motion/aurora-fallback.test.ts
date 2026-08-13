/**
 * @file tests/ui/motion/aurora-fallback.test.ts
 * @description Aurora 降级判定单测（jsdom 无 WebGL，测纯函数）
 * @module tests/ui/motion/aurora-fallback
 */

import { describe, expect, it } from 'vitest';
import {
	hexToRgb01,
	probeWebGL2Support,
	shouldUseAuroraFallback,
} from '../../../src/ui/motion/empty/aurora-fallback';

describe('shouldUseAuroraFallback', () => {
	it('shouldUseAuroraFallback - enabled 关 - 走 CSS 降级', () => {
		expect(shouldUseAuroraFallback(false, true)).toBe(true);
	});

	it('shouldUseAuroraFallback - 无 WebGL2 - 走 CSS 降级', () => {
		expect(shouldUseAuroraFallback(true, false)).toBe(true);
	});

	it('shouldUseAuroraFallback - 闸门开且 WebGL2 可用 - 不走降级', () => {
		expect(shouldUseAuroraFallback(true, true)).toBe(false);
	});
});

describe('hexToRgb01', () => {
	it('hexToRgb01 - 暖铜色 - 归一化到 0-1', () => {
		const [r, g, b] = hexToRgb01('#c4a574');
		expect(r).toBeCloseTo(0.769, 2);
		expect(g).toBeCloseTo(0.647, 2);
		expect(b).toBeCloseTo(0.455, 2);
	});
});

describe('probeWebGL2Support', () => {
	it('probeWebGL2Support - jsdom - 返回 false', () => {
		expect(probeWebGL2Support()).toBe(false);
	});
});
