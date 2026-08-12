/**
 * @file tests/ui/motion/rotate-hint-policy.test.ts
 * @description 空态副句轮换索引策略
 */
import { describe, it, expect } from 'vitest';
import { nextHintIndex } from '../../../src/ui/motion/empty/rotate-hint-policy';

describe('rotate-hint-policy', () => {
	it('nextHintIndex - 末项 - 回到 0', () => {
		expect(nextHintIndex(2, 3)).toBe(0);
	});

	it('nextHintIndex - 中段 - +1', () => {
		expect(nextHintIndex(0, 3)).toBe(1);
	});

	it('nextHintIndex - len 0 - 0', () => {
		expect(nextHintIndex(0, 0)).toBe(0);
	});
});
