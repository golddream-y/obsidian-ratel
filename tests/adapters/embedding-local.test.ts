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
		// 关键路径:第二参未传时也显式传 undefined,与端口签名(embed(texts, options?))一致。
		expect(inner.embed).toHaveBeenCalledWith(['hello'], undefined);
	});
});

describe('EmbeddingLocal — T5 options 透传', () => {
	it('embed - 传入 options - 同一对象(含 signal 与 onBatchComplete)原样转发给内层实现', async () => {
		// 关键路径:options 被静默吞掉时,取消与批次活动在这条通道上消失且不报错;
		// 这里按引用断言"原样转发",而不是只断言某个回调最终被调用。
		const inner = createMockEmbedding();
		const e = new EmbeddingLocal();
		e.setEmbedding(inner);
		const controller = new AbortController();
		const onBatchComplete = vi.fn();
		const options = { signal: controller.signal, onBatchComplete };

		await e.embed(['hello'], options);

		expect(inner.embed).toHaveBeenCalledTimes(1);
		const [, forwarded] = (inner.embed as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
		expect(forwarded).toBe(options);
		expect((forwarded as { signal?: AbortSignal }).signal).toBe(controller.signal);
		expect((forwarded as { onBatchComplete?: unknown }).onBatchComplete).toBe(onBatchComplete);
	});

	it('embed - 内层实现按 signal 中止 - 错误原样冒泡且不被吞成成功', async () => {
		// 关键路径:内层只有在真的收到已中止的 signal 时才按取消失败结束;
		// 若 options 被吞掉,这里会以「未收到 signal」失败,而不是碰巧通过。
		const abortError = new Error('嵌入调用已取消');
		abortError.name = 'AbortError';
		const inner: import('../../src/ports/embedding').EmbeddingPort = {
			modelId: 'local:bge-small-zh-v1.5',
			dimensions: 512,
			embed: async (_texts, forwarded) => {
				if (forwarded?.signal?.aborted !== true) {
					throw new Error('内层未收到已中止的 signal');
				}
				throw abortError;
			},
		};
		const e = new EmbeddingLocal();
		e.setEmbedding(inner);
		const controller = new AbortController();
		controller.abort();

		await expect(e.embed(['hello'], { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
	});

	it('embed - 未就绪 - 即使传入 options 仍抛 IndexNotReadyError 且不触发批次活动', async () => {
		const e = new EmbeddingLocal();
		const onBatchComplete = vi.fn();
		await expect(e.embed(['hello'], { onBatchComplete })).rejects.toBeInstanceOf(IndexNotReadyError);
		expect(onBatchComplete).not.toHaveBeenCalled();
	});
});
