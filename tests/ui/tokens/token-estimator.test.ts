/**
 * @file tests/ui/tokens/token-estimator.test.ts
 * @description token-estimator 单元测试 — 中英混合权重估算 + 消息列表估算
 */
import { describe, it, expect } from 'vitest';
import { estimateMessagesTokens, estimateTokens } from '../../../src/ui/tokens/token-estimator';

describe('estimateTokens', () => {
	it('estimateTokens - 空字符串 - 返回 0', () => {
		expect(estimateTokens('')).toBe(0);
	});

	it('estimateTokens - 纯英文 - 约 4 字符/token', () => {
		// "hello world" = 11 字符 ASCII,11/4 = 2.75 → ceil = 3
		expect(estimateTokens('hello world')).toBe(3);
	});

	it('estimateTokens - 纯中文 - 约 1.5 字符/token', () => {
		// 6 个 CJK,6/1.5 = 4
		expect(estimateTokens('你好世界测试')).toBe(4);
	});

	it('estimateTokens - 中英混合 - 分权重求和', () => {
		// "hello 你好" = 6 ASCII + 2 CJK,6/4 + 2/1.5 = 1.5 + 1.33 = 2.83 → ceil = 3
		expect(estimateTokens('hello 你好')).toBe(3);
	});

	it('estimateTokens - 纯符号 - 约 3 字符/token', () => {
		// 3 个非 ASCII 非 CJK 字符(emoji 等),3/3 = 1
		expect(estimateTokens('🎉🎊🎈')).toBe(1);
	});
});

describe('estimateMessagesTokens', () => {
	it('estimateMessagesTokens - 空数组 - 返回 0', () => {
		expect(estimateMessagesTokens([])).toBe(0);
	});

	it('estimateMessagesTokens - 仅 text/think - 累加估算', () => {
		const used = estimateMessagesTokens([
			{ segments: [{ type: 'text', text: 'hello world' }] },
			{ segments: [{ type: 'think', text: '你好世界测试' }] },
		]);
		// hello world=3 + 你好世界测试=4
		expect(used).toBe(7);
	});

	it('estimateMessagesTokens - 含 tool/image - 忽略非文本段', () => {
		const used = estimateMessagesTokens([
			{
				segments: [
					{ type: 'text', text: 'hello world' },
					{ type: 'tool' },
					{ type: 'image' },
					{ type: 'citation' },
				],
			},
		]);
		expect(used).toBe(estimateTokens('hello world'));
	});

	it('estimateMessagesTokens - 多消息多段 - 全部 text/think 求和', () => {
		const a = 'hello world';
		const b = '你好世界测试';
		const used = estimateMessagesTokens([
			{ segments: [{ type: 'text', text: a }, { type: 'think', text: b }] },
			{ segments: [{ type: 'text', text: a }] },
		]);
		expect(used).toBe(estimateTokens(a) + estimateTokens(b) + estimateTokens(a));
	});
});
