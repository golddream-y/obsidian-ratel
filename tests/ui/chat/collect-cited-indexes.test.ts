/**
 * @file tests/ui/chat/collect-cited-indexes.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
	collectCitedIndexes,
	collectCitedIndexesFromSegments,
	shouldShowCiteChips,
} from '../../../src/ui/chat/collect-cited-indexes';

describe('collectCitedIndexes', () => {
	it('collectCitedIndexes - 正文含有效编号 - 返回交集', () => {
		const set = collectCitedIndexes('见[1]与[[2]]和[9]', new Set([1, 2, 3]));
		expect([...set].sort()).toEqual([1, 2]);
	});

	it('collectCitedIndexes - 无有效编号 - 空集', () => {
		expect(collectCitedIndexes('无引用', new Set([1])).size).toBe(0);
	});

	it('collectCitedIndexesFromSegments - 只扫 text 段', () => {
		const set = collectCitedIndexesFromSegments(
			[
				{ type: 'think', text: '[1]' },
				{ type: 'text', text: '结论[2]' },
			],
			new Set([1, 2]),
		);
		expect([...set]).toEqual([2]);
	});

	it('shouldShowCiteChips - 有结果无引用 - 显示', () => {
		expect(shouldShowCiteChips(true, 0)).toBe(true);
	});

	it('shouldShowCiteChips - 有结果且有引用 - 隐藏', () => {
		expect(shouldShowCiteChips(true, 1)).toBe(false);
	});

	it('shouldShowCiteChips - 无结果 - 隐藏', () => {
		expect(shouldShowCiteChips(false, 0)).toBe(false);
	});
});
