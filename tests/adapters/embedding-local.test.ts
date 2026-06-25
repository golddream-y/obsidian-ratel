/**
 * @file tests/adapters/embedding-local.test.ts
 * @description EmbeddingLocal 行为 — 构造默认值 / 注入 embedding / 未就绪抛 IndexNotReadyError
 * @module tests/adapters/embedding-local
 * @depends adapters/embedding-local
 *
 * 关键路径:
 * - EmbeddingLocal 是本地 Embedding 占位适配器,固定模型 bge-small-zh-v1.5。
 * - 未注入真实 EmbeddingOnnx 时 embed 抛 IndexNotReadyError。
 * - 注入后 embed 代理到真实适配器。
 */

import { describe, it, expect, vi } from 'vitest';
import { EmbeddingLocal, IndexNotReadyError } from '../../src/adapters/embedding-local';

function createMockEmbedding(): import('../../src/ports/embedding').EmbeddingPort {
	return {
		modelId: 'local:bge-small-zh-v1.5',
		dimensions: 512,
		embed: vi.fn().mockResolvedValue([Array(512).fill(0.5)]),
	};
}

describe('EmbeddingLocal - 构造', () => {
	it('默认值 - modelId / dimensions', () => {
		const adapter = new EmbeddingLocal();
		expect(adapter.modelId).toBe('local:bge-small-zh-v1.5');
		expect(adapter.dimensions).toBe(512);
	});
});

describe('EmbeddingLocal - 注入式', () => {
	it('未注入 embedding 时 embed - 抛 IndexNotReadyError(code=INDEX_NOT_READY)', async () => {
		const e = new EmbeddingLocal();
		await expect(e.embed(['hello'])).rejects.toBeInstanceOf(IndexNotReadyError);
	});

	it('注入 embedding 后 embed - 调用并返回', async () => {
		const inner = createMockEmbedding();
		const e = new EmbeddingLocal();
		e.setEmbedding(inner);
		const vectors = await e.embed(['hello']);
		expect(vectors).toHaveLength(1);
		expect(vectors[0]).toHaveLength(512);
		expect(inner.embed).toHaveBeenCalledWith(['hello']);
	});
});
