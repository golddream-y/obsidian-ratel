/**
 * @file tests/ui/motion/noise-opacity.test.ts
 * @description 空态 Noise 托盘透明度契约
 */
import { describe, it, expect } from 'vitest';
import { NOISE_OPACITY_MAX } from '../../../src/ui/motion/empty/noise-opacity';

describe('noise-opacity', () => {
	it('NOISE_OPACITY_MAX - 常量 - 不超过 0.08', () => {
		expect(NOISE_OPACITY_MAX).toBeLessThanOrEqual(0.08);
	});
});
