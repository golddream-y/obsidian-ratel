/**
 * @file tests/ui/motion/empty-hints.test.ts
 * @description 空态副句 hint 列表组装
 */
import { describe, it, expect } from 'vitest';
import { EMPTY_HINT_KEYS, resolveEmptyHints } from '../../../src/ui/motion/empty/empty-hints';

describe('empty-hints', () => {
	it('EMPTY_HINT_KEYS - 长度 - 为 3', () => {
		expect(EMPTY_HINT_KEYS).toHaveLength(3);
	});

	it('resolveEmptyHints - 三键齐全 - 返回三句', () => {
		const map: Record<string, string> = {
			'chat.empty.hint.1': 'a',
			'chat.empty.hint.2': 'b',
			'chat.empty.hint.3': 'c',
			'chat.empty.hint': 'fallback',
		};
		expect(resolveEmptyHints((k) => map[k] ?? k)).toEqual(['a', 'b', 'c']);
	});

	it('resolveEmptyHints - 缺键 - 回退 chat.empty.hint', () => {
		const map: Record<string, string> = { 'chat.empty.hint': 'only' };
		expect(resolveEmptyHints((k) => map[k] ?? '')).toEqual(['only', 'only', 'only']);
	});
});
