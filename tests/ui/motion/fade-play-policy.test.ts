/**
 * @file tests/ui/motion/fade-play-policy.test.ts
 * @description 消息 FadeIn 播放策略单测
 */
import { describe, it, expect } from 'vitest';
import {
	computeFadePlay,
	reseedEnteredIds,
} from '../../../src/ui/motion/enter/fade-play-policy';

describe('fade-play-policy', () => {
	const entered = reseedEnteredIds(['a', 'b']);

	it('computeFadePlay - 动效关 - 不播', () => {
		expect(computeFadePlay('c', entered, false)).toBe(false);
	});

	it('computeFadePlay - 已入场 - 不播', () => {
		expect(computeFadePlay('a', entered, true)).toBe(false);
	});

	it('computeFadePlay - 新消息且动效开 - 播', () => {
		expect(computeFadePlay('c', entered, true)).toBe(true);
	});

	it('reseedEnteredIds - hydrate 种子含全部 id', () => {
		const seeded = reseedEnteredIds(['x', 'y']);
		expect(seeded.has('x')).toBe(true);
		expect(seeded.has('z')).toBe(false);
		expect(computeFadePlay('x', seeded, true)).toBe(false);
	});
});
