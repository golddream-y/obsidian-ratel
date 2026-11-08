/**
 * @file tests/worker/chunk-options-parity.test.ts
 * @description 分块计数一致性 — 线程模式与主线程模式必须用同一套 token 计数
 * @module tests/worker/chunk-options-parity
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveChunkOptions } from '../../src/worker/index-runtime-entry';
import { createTokenCounter } from '../../src/core/token-counter';
import { chunkMarkdown } from '../../src/worker/chunker';

const VOCAB = readFileSync(
	path.resolve(__dirname, '../fixtures/bge-small-zh-v1.5/vocab.txt'),
	'utf-8',
);

describe('分块计数一致性', () => {
	it('带词表时 - 线程模式与主线程的 count 完全一致', () => {
		const worker = resolveChunkOptions(undefined, VOCAB);
		const main = createTokenCounter(VOCAB);
		for (const text of ['工程化', '# 标题\n正文内容', 'a'.repeat(200), '中文与 English 混排']) {
			expect(worker.count(text)).toBe(main.count(text));
		}
	});

	it('同一条 chunkSize - 两种模式切出的块完全相同', () => {
		// 关键路径:块不同会让完成记录的内容哈希失配,切换索引模式后表现为整库重索引。
		const content = Array.from({ length: 12 }, (_, i) =>
			`## 小节 ${i}\n\n索引写入线程的可靠性取决于提交顺序与恢复判定的严格程度,任何一步放宽都会在重启后表现为重复索引。`,
		).join('\n\n');
		const worker = resolveChunkOptions({ maxTokens: 200, overlapTokens: 50 }, VOCAB);
		const mainCounter = createTokenCounter(VOCAB);
		const main = { maxTokens: 200, overlapTokens: 50, count: (t: string) => mainCounter.count(t) };
		const workerChunks = chunkMarkdown(content, worker);
		const mainChunks = chunkMarkdown(content, main);
		expect(workerChunks.length).toBe(mainChunks.length);
		expect(workerChunks.map((c) => c.startOffset)).toEqual(mainChunks.map((c) => c.startOffset));
		expect(workerChunks.map((c) => c.text)).toEqual(mainChunks.map((c) => c.text));
	});

	it('缺词表时退化为字符计数 - 这是降级而不是等价', () => {
		// 记录降级语义:没有词表时按字符数估算,与真实 token 数并不相等。
		// 用含标点、数字与英文的混合文本 —— 纯中文短句恰好一字一 token,无法体现差异。
		const fallback = resolveChunkOptions(undefined, undefined);
		const withVocab = resolveChunkOptions(undefined, VOCAB);
		const text = '## 工程化 2026-11-08: WebGPU/CPU 混排 a, b, c!';
		expect(fallback.count(text)).toBe(text.length);
		expect(withVocab.count(text)).not.toBe(text.length);
	});
});
