/**
 * @file tests/adapters/vectra-tokenizer.test.ts
 * @description vectra tokenizer 适配 — 构建分支与降级实现的可逆性
 * @module tests/adapters/vectra-tokenizer
 * @depends src/adapters/vectra-tokenizer
 */

import { describe, expect, it } from 'vitest';
import { createVectraTokenizer } from '../../src/adapters/vectra-tokenizer';

describe('createVectraTokenizer', () => {
	it('保留 GPT 词表 - 返回 undefined - 由 vectra 使用默认分词', () => {
		expect(createVectraTokenizer(true)).toBeUndefined();
	});

	it('缺少 GPT 词表 - 返回降级 tokenizer - 编码可逆', () => {
		const tokenizer = createVectraTokenizer(false);
		expect(tokenizer).toBeDefined();
		for (const text of ['Hello world', '中文分词测试', 'emoji 😀 与代理对 𠮷']) {
			expect(tokenizer!.decode(tokenizer!.encode(text))).toBe(text);
		}
	});

	it('降级 tokenizer - 空文本 - 编解码均为空', () => {
		const tokenizer = createVectraTokenizer(false)!;
		expect(tokenizer.encode('')).toEqual([]);
		expect(tokenizer.decode([])).toBe('');
	});
});
