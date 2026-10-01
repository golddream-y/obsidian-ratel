/**
 * @file tests/core/usage-calibration.test.ts
 * @description usageCalibrationRatio / recordUsageCalibration — 接口用量校准
 * @module tests/core/usage-calibration
 * @depends core/usage-calibration
 */

import { describe, it, expect } from 'vitest';
import {
	recordUsageCalibration,
	usageCalibrationRatio,
} from '../../src/core/usage-calibration';

describe('usageCalibration', () => {
	it('recordUsageCalibration - 无记录 - 比值为 1', () => {
		expect(usageCalibrationRatio('session-never-recorded')).toBe(1);
	});

	it('recordUsageCalibration - 真值是估算的 1.5 倍 - 记下 1.5', () => {
		const id = 'session-ratio-15';
		recordUsageCalibration(id, 100, 150);
		expect(usageCalibrationRatio(id)).toBe(1.5);
	});

	it('recordUsageCalibration - 比值超出 0.5 到 2 - 夹到边界', () => {
		const low = 'session-clamp-low';
		recordUsageCalibration(low, 100, 25);
		expect(usageCalibrationRatio(low)).toBe(0.5);

		const high = 'session-clamp-high';
		recordUsageCalibration(high, 100, 350);
		expect(usageCalibrationRatio(high)).toBe(2);
	});

	it('recordUsageCalibration - 估算或真值为 0 - 不覆盖已有比值', () => {
		const id = 'session-skip-zero';
		recordUsageCalibration(id, 100, 150);
		expect(usageCalibrationRatio(id)).toBe(1.5);
		recordUsageCalibration(id, 0, 200);
		expect(usageCalibrationRatio(id)).toBe(1.5);
		recordUsageCalibration(id, 50, 0);
		expect(usageCalibrationRatio(id)).toBe(1.5);
	});
});
