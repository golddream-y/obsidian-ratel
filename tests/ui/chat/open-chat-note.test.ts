/**
 * @file tests/ui/chat/open-chat-note.test.ts
 * @description 引用编号 → 路径查找
 * @module tests/ui/chat/open-chat-note
 */
import { describe, it, expect } from 'vitest';
import { pathForCiteIndex } from '../../../src/ui/chat/open-chat-note';

describe('pathForCiteIndex', () => {
	const results = [
		{ index: 1, path: 'a.md' },
		{ index: 2, path: 'b/c.md' },
	];

	it('查找 - 命中编号 - 返回路径', () => {
		expect(pathForCiteIndex(results, 2)).toBe('b/c.md');
	});

	it('查找 - 无匹配 - 返回 null', () => {
		expect(pathForCiteIndex(results, 9)).toBeNull();
	});

	it('查找 - 空结果 - 返回 null', () => {
		expect(pathForCiteIndex(undefined, 1)).toBeNull();
		expect(pathForCiteIndex([], 1)).toBeNull();
	});
});
