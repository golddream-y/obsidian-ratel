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
	isPastedAbsoluteFsPath,
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
		expect(isSafeVaultMentionPath('Users/alice/Notes/a.md')).toBe(false);
	});

	it('isSafeVaultMentionPath - 含 .. - false', () => {
		expect(isSafeVaultMentionPath('../secret.md')).toBe(false);
	});
});

describe('isPastedAbsoluteFsPath', () => {
	it('斜杠命令 /goal 加中文陈述 - 不是绝对路径', () => {
		expect(
			isPastedAbsoluteFsPath(
				'/goal 审查一下我这些已经写完的中篇小说的逻辑漏洞 和上下文缺失 语言表达不通顺等 用专业的小说写手严格要求',
			),
		).toBe(false);
	});

	it('/new 或 /goal 无空格 - 不是绝对路径', () => {
		expect(isPastedAbsoluteFsPath('/goal')).toBe(false);
		expect(isPastedAbsoluteFsPath('/new')).toBe(false);
	});

	it('POSIX /Users 笔记路径 - 是绝对路径', () => {
		expect(isPastedAbsoluteFsPath('/Users/alice/Notes/a.md')).toBe(true);
		expect(isPastedAbsoluteFsPath('@/Users/alice/Notes/a.md')).toBe(true);
	});

	it('剥掉盘符前缀的 Users/ - 是绝对路径', () => {
		expect(isPastedAbsoluteFsPath('Users/alice/Notes/a.md')).toBe(true);
	});

	it('Windows 盘符 - 是绝对路径', () => {
		expect(isPastedAbsoluteFsPath('C:\\Vault\\a.md')).toBe(true);
	});

	it('库内相对路径 - 不是绝对路径', () => {
		expect(isPastedAbsoluteFsPath('玄幻中篇/妖市.md')).toBe(false);
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
