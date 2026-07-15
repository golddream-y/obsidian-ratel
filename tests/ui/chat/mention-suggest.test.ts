/**
 * @file tests/ui/chat/mention-suggest.test.ts
 * @description @mention 补全建议纯函数
 * @module tests/ui/chat/mention-suggest
 */

import { describe, it, expect } from 'vitest';
import { suggestMentions, mentionBasename } from '../../../src/ui/chat/input/mention-suggest';

const PATHS = [
	'Work/Diary/2026.md',
	'Template/Diary/Daily Note Template.md',
	'notes/foo.md',
	'readme.md',
];

describe('suggestMentions', () => {
	it('suggestMentions - 空 query - 返回前 limit 条', () => {
		expect(suggestMentions('', PATHS, 2)).toEqual(PATHS.slice(0, 2));
	});

	it('suggestMentions - basename 命中优先于 path', () => {
		const r = suggestMentions('Daily', PATHS, 5);
		expect(r[0]).toBe('Template/Diary/Daily Note Template.md');
	});

	it('suggestMentions - 无命中 - 空数组', () => {
		expect(suggestMentions('zzz-not-exist', PATHS)).toEqual([]);
	});

	it('mentionBasename - 取文件名', () => {
		expect(mentionBasename('a/b/c.md')).toBe('c.md');
	});
});
