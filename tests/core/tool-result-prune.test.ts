/**
 * @file tests/core/tool-result-prune.test.ts
 * @description pruneOverlongText 单测 — 码点裁剪、代理对安全、参数防御
 * @module core/tool-result-prune.test
 */
import { describe, it, expect } from 'vitest';
import {
	pruneOverlongText,
	TOOL_RESULT_LIMIT_CODEPOINTS,
	PRUNE_HEAD_CODEPOINTS,
	PRUNE_TAIL_CODEPOINTS,
} from '../../src/core/tool-result-prune';

describe('tool-result-prune', () => {
	it('pruneOverlongText - 未超限 - 原样返回', () => {
		expect(pruneOverlongText('short')).toBe('short');
	});

	it('pruneOverlongText - 空串 - 原样返回', () => {
		expect(pruneOverlongText('')).toBe('');
	});

	it('pruneOverlongText - head+tail 不小于 limit - 抛 RangeError', () => {
		expect(() => pruneOverlongText('abcdefghij', 6, 4, 4)).toThrow(RangeError);
	});

	it('pruneOverlongText - 恰好等于上限 - 不裁', () => {
		const exact = 'a'.repeat(TOOL_RESULT_LIMIT_CODEPOINTS);
		expect(pruneOverlongText(exact)).toBe(exact);
	});

	it('pruneOverlongText - 超限 - 保留头尾并标注省略数', () => {
		const content = 'x'.repeat(TOOL_RESULT_LIMIT_CODEPOINTS + 100);
		const out = pruneOverlongText(content);
		// 省略数 = 删除的码点数 = 32100 - 24000 - 6000 = 2100(非超限数 100)
		expect(out).toContain('[truncated 2100 chars]');
		const head = out.slice(0, PRUNE_HEAD_CODEPOINTS);
		expect(head).toBe('x'.repeat(PRUNE_HEAD_CODEPOINTS));
		expect(out.endsWith('x'.repeat(PRUNE_TAIL_CODEPOINTS))).toBe(true);
	});

	it('pruneOverlongText - 自定义小参数 - 头尾与省略数正确', () => {
		// 10 码点,head=4, tail=1 → 省略 5
		expect(pruneOverlongText('abcdefghij', 6, 4, 1)).toBe('abcd\n[truncated 5 chars]\nj');
	});

	it('pruneOverlongText - 代理对不被拦腰切开 - emoji 按码点计数', () => {
		// '😀' 是代理对:1 码点 = 2 个 UTF-16 单元。
		// 3 个 😀 = 3 码点,上限 2、头 1、尾 1 → 省略 1
		const out = pruneOverlongText('😀😀😀', 2, 1, 1);
		expect(out).toBe('😀\n[truncated 1 chars]\n😀');
		// 结果不含孤立代理(拆开的 emoji 会变成乱码)
		for (const ch of Array.from(out)) {
			expect(Number.isNaN(ch.codePointAt(0))).toBe(false);
		}
	});

	it('pruneOverlongText - 多字节密集文本 - 码点数而非 UTF-16 数判定', () => {
		// 32001 个 '😀' → 64002 个 UTF-16 单元但 32001 码点 → 裁
		const content = '😀'.repeat(TOOL_RESULT_LIMIT_CODEPOINTS + 1);
		const out = pruneOverlongText(content);
		// 省略数按码点计:32001 - 24000 - 6000 = 2001(若按 UTF-16 单元误算会得 34002 且切坏代理对)
		expect(out).toContain('[truncated 2001 chars]');
		expect(Array.from(out).length).toBeLessThan(TOOL_RESULT_LIMIT_CODEPOINTS + 1);
	});
});
