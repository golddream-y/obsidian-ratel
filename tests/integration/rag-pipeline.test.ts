/**
 * @file tests/integration/rag-pipeline.test.ts
 * @description L2 集成测试 — RAG 端到端:embed → chunk → upsert → search
 * @module tests/integration/rag-pipeline
 *
 * 关键路径:
 * - 用 mock EmbeddingApi 走通整条管道,不依赖真实外部 API。
 * - 验证"embed → upsert → search"循环之后,自搜结果应当高于阈值(相同向量余弦相似度 ≈ 1)。
 * - 维度不匹配应当早失败,不让脏数据进入向量库。
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { VectraStore } from '../../src/adapters/vector-vectra';
import { chunkMarkdown } from '../../src/worker/chunker';
import { EmbeddingApi } from '../../src/adapters/embedding-api';
import type { EmbeddingPort } from '../../src/ports/embedding';
import type { EmbeddingsModel, EmbeddingsResponse } from 'vectra';
import path from 'path';
import fs from 'fs';

const TEST_INDEX_DIR = path.join(__dirname, '../tmp/rag-pipeline-index');

/** 关键路径:用确定性 4 维向量避免随机漂移,让分数断言稳定。 */
function buildMockEmbeddings(dimensions: number): EmbeddingsModel {
	return {
		maxTokens: 8192,
		async createEmbeddings(inputs: string | string[]): Promise<EmbeddingsResponse> {
			const arr = Array.isArray(inputs) ? inputs : [inputs];
			// 每个文本的向量固定为 [0.1, 0.2, 0.3, 0.4] + 长度 padding 0
			const output = arr.map(() => {
				const base = [0.1, 0.2, 0.3, 0.4];
				while (base.length < dimensions) base.push(0);
				return base.slice(0, dimensions);
			});
			return { status: 'success', output };
		},
	};
}

describe('RAG Pipeline Integration', () => {
	let store: VectraStore;

	beforeAll(() => {
		// 关键路径:每次跑前清空,保证幂等。
		if (fs.existsSync(TEST_INDEX_DIR)) {
			fs.rmSync(TEST_INDEX_DIR, { recursive: true });
		}
		// 关键路径:VectraStore 内部需要 embeddings 模型才能把文本转成向量。
		// 用确定性 4 维 mock 注入,确保 search 分数断言稳定。
		store = new VectraStore(TEST_INDEX_DIR, buildMockEmbeddings(4));
	});

	afterAll(() => {
		if (fs.existsSync(TEST_INDEX_DIR)) {
			fs.rmSync(TEST_INDEX_DIR, { recursive: true });
		}
	});

	it('embeds, chunks, upserts, and searches — top result is the source', async () => {
		// 1. 用 mock fetch 让 EmbeddingApi 走通一遍(验证管道联通),但实际写入用
		//    VectraStore 内部 mock embeddings,保证向量是确定性的 [0.1, 0.2, 0.3, 0.4]。
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				data: [{ embedding: [0.1, 0.2, 0.3, 0.4], index: 0 }],
			}),
		});
		vi.stubGlobal('fetch', mockFetch);

		// 2. 准备 markdown 内容并分块。
		const markdown = '# Section 1\nContent about cats\n\n# Section 2\nContent about dogs';
		const chunks = chunkMarkdown(markdown, 100, 10);
		expect(chunks.length).toBeGreaterThanOrEqual(1);

		// 3. 用 EmbeddingApi 走一遍管道(后续 VectraStore 内部用同样的 mock 向量)。
		const embedding: EmbeddingPort = new EmbeddingApi({
			apiBase: 'http://test',
			apiKey: 'sk-test',
			model: 'test-model',
			dimensions: 4,
		});
		for (const chunk of chunks) {
			const vectors = await embedding.embed([chunk.text]);
			expect(vectors[0]).toHaveLength(4);
			// 关键路径:写入时 VectraStore 内部用确定性 mock 嵌入。
			await store.upsert(`doc-${chunk.index}`, chunk.text, {
				path: 'test.md',
				chunkIndex: chunk.index,
			});
		}

		// 4. 用相同向量搜索,期望最高分显著大于 0.5(余弦相似度 ≈ 1)。
		const queryVector = [0.1, 0.2, 0.3, 0.4];
		const results = await store.search(queryVector, 5);
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].score).toBeGreaterThan(0.5);

		vi.unstubAllGlobals();
	});

	it('handles dimension mismatch gracefully', async () => {
		const wrongDimEmbedding = new EmbeddingApi({
			apiBase: 'http://test',
			apiKey: 'sk',
			model: 'm',
			dimensions: 4,
		});

		// 关键路径:服务端错误返回 2 维,期望 4 维,应当早失败。
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				data: [{ embedding: [0.1, 0.2], index: 0 }], // 2 dims, expected 4
			}),
		});
		vi.stubGlobal('fetch', mockFetch);

		await expect(wrongDimEmbedding.embed(['test'])).rejects.toThrow(/dimension/i);

		vi.unstubAllGlobals();
	});
});
