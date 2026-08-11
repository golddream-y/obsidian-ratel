/**
 * @file tests/ui/chat/latest-cite-search.test.ts
 * @description 最近 searchResults 回退 — 跟进回合 cite 挂钩
 * @module tests/ui/chat/latest-cite-search
 */

import { describe, expect, it } from 'vitest';
import { latestCiteSearchResults } from '../../../src/ui/chat/latest-cite-search';

describe('latestCiteSearchResults', () => {
	it('latestCiteSearchResults - 无结果 - 返回 null', () => {
		expect(latestCiteSearchResults([])).toBeNull();
		expect(latestCiteSearchResults([{ searchResults: [] }])).toBeNull();
	});

	it('latestCiteSearchResults - 跟进消息无挂载 - 回退到较早检索', () => {
		const early = [{ docId: 'a', score: 1, path: 'a.md', index: 7 }];
		const msgs = [
			{ searchResults: early },
			{},
			{ searchResults: undefined },
		];
		expect(latestCiteSearchResults(msgs)).toBe(early);
	});

	it('latestCiteSearchResults - 较新检索覆盖 - 取最后一次', () => {
		const early = [{ docId: 'a', score: 1, path: 'a.md', index: 1 }];
		const late = [{ docId: 'b', score: 1, path: 'b.md', index: 2 }];
		expect(latestCiteSearchResults([{ searchResults: early }, { searchResults: late }])).toBe(
			late,
		);
	});
});
