/**
 * @file tests/ui/tokens/token-estimator.test.ts
 * @description token-estimator 单元测试 — 中英混合权重估算
 */
import { describe, it, expect } from 'vitest';
import { estimateTokens } from '../../../src/ui/tokens/token-estimator';

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
