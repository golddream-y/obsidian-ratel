import { describe, it, expect } from 'vitest';
import { createTokenCounter } from '../../src/core/token-counter';

// 极简词表:[PAD] [UNK] [CLS] [SEP] 我 们 你 好
const VOCAB = '[PAD]\n[UNK]\n[CLS]\n[SEP]\n我\n们\n你\n好\n';

describe('createTokenCounter', () => {
	it('有词表 - 精确计数 - 按 tokenize 结果', () => {
		const c = createTokenCounter(VOCAB);
		expect(c.exact).toBe(true);
		expect(c.count('我们')).toBe(2);
		expect(c.count('')).toBe(0);
	});

	it('无词表 - 估算 - 按字符数取上界', () => {
		const c = createTokenCounter(null);
		expect(c.exact).toBe(false);
		expect(c.count('我们')).toBe(2);
		expect(c.count('hello')).toBe(5);
	});

	it('maxInputTokens 默认 512 且可覆盖', () => {
		expect(createTokenCounter(null).maxInputTokens).toBe(512);
		expect(createTokenCounter(null, 1024).maxInputTokens).toBe(1024);
	});

	it('空词表 - 退化为字符上界估算 - 不抛错', () => {
		const c = createTokenCounter('');
		expect(c.exact).toBe(false);
		expect(c.count('我们')).toBe(2);
	});

	it('有词表 - 未知字符 - 按 [UNK] 记一个 token', () => {
		const c = createTokenCounter(VOCAB);
		expect(c.count('X')).toBe(1);
	});

	it('有词表 - 超长文本 - 不受 encode 截断影响', () => {
		const c = createTokenCounter(VOCAB);
		// 关键路径:计数走 tokenize,不被模型输入上限截断,否则长块会被误判为可放下。
		expect(c.count('我'.repeat(600))).toBe(600);
	});
});
