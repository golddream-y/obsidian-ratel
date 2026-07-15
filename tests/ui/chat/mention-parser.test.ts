/**
 * @file tests/ui/chat/mention-parser.test.ts
 * @description @mention 路径解析纯函数
 * @module tests/ui/chat/mention-parser
 */

import { describe, it, expect } from 'vitest';
import {
	extractMentions,
	formatMentionToken,
	isSafeVaultMentionPath,
	parseActiveMentionQuery,
} from '../../../src/ui/chat/input/mention-parser';

describe('extractMentions / formatMentionToken', () => {
	it('extractMentions - 含 @path - 抽出相对路径', () => {
		expect(extractMentions('看 @Work/a.md 和 @b.md')).toEqual(['Work/a.md', 'b.md']);
	});

	it('extractMentions - 重复 path - 去重保序', () => {
		expect(extractMentions('@a.md @a.md')).toEqual(['a.md']);
	});

	it('formatMentionToken - 追加尾随空格', () => {
		expect(formatMentionToken('Work/a.md')).toBe('@Work/a.md ');
	});
});

describe('isSafeVaultMentionPath', () => {
	it('isSafeVaultMentionPath - 正常相对路径 - true', () => {
		expect(isSafeVaultMentionPath('Template/Diary/x.md')).toBe(true);
	});

	it('isSafeVaultMentionPath - POSIX 绝对路径 - false', () => {
		expect(isSafeVaultMentionPath('/Users/x/Vault/a.md')).toBe(false);
	});

	it('isSafeVaultMentionPath - 剥 / 后的假相对 Users/ - false', () => {
		expect(isSafeVaultMentionPath('Users/golddream/ObsidianVault/a.md')).toBe(false);
	});

	it('isSafeVaultMentionPath - 含 .. - false', () => {
		expect(isSafeVaultMentionPath('../secret.md')).toBe(false);
	});
});

describe('parseActiveMentionQuery', () => {
	it('parseActiveMentionQuery - 光标在 @foo - 返回 foo', () => {
		expect(parseActiveMentionQuery('请看 @foo')).toBe('foo');
	});

	it('parseActiveMentionQuery - @ 后已有空格 - null', () => {
		expect(parseActiveMentionQuery('@foo bar')).toBeNull();
	});

	it('parseActiveMentionQuery - 邮箱中的 @ - null', () => {
		expect(parseActiveMentionQuery('a@b')).toBeNull();
	});
});
