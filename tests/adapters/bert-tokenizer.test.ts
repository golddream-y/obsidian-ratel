/**
 * @file tests/adapters/bert-tokenizer.test.ts
 * @description BertTokenizer 单元测试,与 HuggingFace Transformers 分词结果对齐
 * @module tests/adapters/bert-tokenizer
 * @depends src/adapters/bert-tokenizer
 */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVocab, createTokenizer, type BertTokenizer } from '../../src/adapters/bert-tokenizer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VOCAB_PATH = path.join(__dirname, '../fixtures/bge-small-zh-v1.5/vocab.txt');

describe('BertTokenizer', () => {
	let tokenizer: BertTokenizer;

	beforeAll(async () => {
		const vocab = await loadVocab(VOCAB_PATH);
		tokenizer = createTokenizer(vocab);
	});

	it('loadVocab - 正确加载词表 - 大小为 21128', async () => {
		const vocab = await loadVocab(VOCAB_PATH);
		expect(vocab.size).toBe(21128);
		expect(vocab.get('[PAD]')).toBe(0);
		expect(vocab.get('[CLS]')).toBe(101);
		expect(vocab.get('[SEP]')).toBe(102);
		expect(vocab.get('[UNK]')).toBe(100);
	});

	it('tokenize - 简单英文 - 与 transformers 对齐', () => {
		const ids = tokenizer.tokenize('Hello world');
		// transformers BertTokenizer 输出: Hello 不在词表 -> [UNK], world -> 8572
		expect(ids).toEqual([100, 8572]);
	});

	it('tokenize - 中文字符按字切分 - 与 transformers 对齐', () => {
		const ids = tokenizer.tokenize('你好世界');
		// 每个汉字独立: 你 好 世 界
		expect(ids.length).toBe(4);
	});

	it('tokenize - 小写英文 - 与 transformers 对齐', () => {
		const ids = tokenizer.tokenize('hello world');
		expect(ids).toEqual([8701, 8572]);
	});

	it('tokenize - 中英文混合 - 与 transformers 对齐', () => {
		const ids = tokenizer.tokenize('Hello 世界');
		expect(ids).toEqual([100, 686, 4518]);
	});

	it('encode - 简单文本 - 包含 [CLS] 与 [SEP]', () => {
		const out = tokenizer.encode('Hello world');
		expect(out.inputIds.length).toBe(512);
		expect(out.inputIds[0]).toBe(101);
		expect(out.inputIds[1]).toBe(100);
		expect(out.inputIds[2]).toBe(8572);
		expect(out.inputIds[3]).toBe(102);
		expect(out.inputIds[4]).toBe(0);
		expect(out.attentionMask[0]).toBe(1);
		expect(out.attentionMask[1]).toBe(1);
		expect(out.attentionMask[2]).toBe(1);
		expect(out.attentionMask[3]).toBe(1);
		expect(out.attentionMask[4]).toBe(0);
	});

	it('encode - 空字符串 - 只有 [CLS] [SEP]', () => {
		const out = tokenizer.encode('');
		expect(out.inputIds[0]).toBe(101);
		expect(out.inputIds[1]).toBe(102);
		expect(out.attentionMask[0]).toBe(1);
		expect(out.attentionMask[1]).toBe(1);
		expect(out.attentionMask[2]).toBe(0);
	});

	it('encode - 超长文本 - 截断到 maxLength', () => {
		const text = '哈'.repeat(600);
		const out = tokenizer.encode(text, 128);
		expect(out.inputIds.length).toBe(128);
		expect(out.inputIds[127]).toBe(102);
	});

	it('encode - tokenTypeIds 全 0', () => {
		const out = tokenizer.encode('你好');
		expect(out.tokenTypeIds.every((v) => v === 0)).toBe(true);
	});
});
