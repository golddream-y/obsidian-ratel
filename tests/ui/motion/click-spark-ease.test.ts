/**
 * @file tests/ui/motion/click-spark-ease.test.ts
 * @description ClickSpark ease-out 单测
 * @module tests/ui/motion/click-spark-ease
 */

import { describe, expect, it } from 'vitest';
import { sparkEaseOut } from '../../../src/ui/motion/brand/spark-ease';

describe('sparkEaseOut', () => {
	it('sparkEaseOut - 0 与 1 - 端点', () => {
		expect(sparkEaseOut(0)).toBe(0);
		expect(sparkEaseOut(1)).toBe(1);
	});
});
