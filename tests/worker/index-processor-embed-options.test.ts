/**
 * @file tests/worker/index-processor-embed-options.test.ts
 * @description 索引入口必须把取消信号透传给嵌入端口,不能只传文本
 * @module tests/worker/index-processor-embed-options
 *
 * 关键路径:取消信号在批次边界生效;若入口丢弃 options,「停止索引」只能等整批跑完,
 * 表现为暂停无效、CPU 继续空转。此用例锁定三个入口的透传行为。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IndexProcessor } from '../../src/worker/index-processor';
import { VectraStore } from '../../src/adapters/vector-vectra';
import type { EmbedOptions, EmbeddingPort } from '../../src/ports/embedding';
import type { EmbeddingsModel, EmbeddingsResponse } from 'vectra';

const stubEmbedder: EmbeddingsModel = {
	maxTokens: 8192,
	async createEmbeddings(inputs: string | string[]): Promise<EmbeddingsResponse> {
		const arr = Array.isArray(inputs) ? inputs : [inputs];
		return { status: 'success', output: arr.map(() => Array(8).fill(0.1)) };
	},
};

const CHUNK_OPTIONS = { maxTokens: 500, overlapTokens: 100, count: (t: string) => t.length };

let dir = '';

/** 记录每次调用传入的 options。 */
function makeEmbedding(seen: Array<EmbedOptions | undefined>): EmbeddingPort {
	return {
		dimensions: 8,
		modelId: 'test:options',
		async embed(texts: string[], options?: EmbedOptions): Promise<number[][]> {
			seen.push(options);
			if (options?.signal?.aborted === true) throw new Error('aborted');
			return texts.map(() => Array(8).fill(0.1));
		},
	};
}

beforeEach(async () => {
	dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ratel-embed-options-'));
});

afterEach(async () => {
	if (dir) await fsp.rm(dir, { recursive: true, force: true });
});

describe('索引入口的嵌入选项透传', () => {
	it('增量索引 - 携带取消信号与批次回调', async () => {
		const seen: Array<EmbedOptions | undefined> = [];
		const store = new VectraStore(dir, { embeddings: stubEmbedder, autoInit: true });
		await store.init();
		const processor = new IndexProcessor(store, makeEmbedding(seen), CHUNK_OPTIONS);
		const controller = new AbortController();
		const onBatchComplete = (): void => {};
		await processor.indexIncremental({ path: 'a.md', content: '一段正文' }, undefined, {
			signal: controller.signal,
			onBatchComplete,
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]?.signal).toBe(controller.signal);
		expect(seen[0]?.onBatchComplete).toBe(onBatchComplete);
	});

	it('全量索引 - 每个文件都带上同一取消信号', async () => {
		const seen: Array<EmbedOptions | undefined> = [];
		const store = new VectraStore(dir, { embeddings: stubEmbedder, autoInit: true });
		await store.init();
		const processor = new IndexProcessor(store, makeEmbedding(seen), CHUNK_OPTIONS);
		const controller = new AbortController();
		await processor.indexFull(
			[{ path: 'a.md', content: '一' }, { path: 'b.md', content: '二' }],
			undefined,
			{ signal: controller.signal },
		);
		expect(seen).toHaveLength(2);
		expect(seen.every((options) => options?.signal === controller.signal)).toBe(true);
	});

	it('批量索引 - 同样透传 - 不因批处理路径丢失', async () => {
		const seen: Array<EmbedOptions | undefined> = [];
		const store = new VectraStore(dir, { embeddings: stubEmbedder, autoInit: true });
		await store.init();
		const processor = new IndexProcessor(store, makeEmbedding(seen), CHUNK_OPTIONS);
		const controller = new AbortController();
		await processor.indexBatch([{ path: 'a.md', content: '正文' }], undefined, {
			signal: controller.signal,
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]?.signal).toBe(controller.signal);
	});

	it('已取消信号 - 不静默写入 - 失败计入 errors', async () => {
		const seen: Array<EmbedOptions | undefined> = [];
		const store = new VectraStore(dir, { embeddings: stubEmbedder, autoInit: true });
		await store.init();
		const processor = new IndexProcessor(store, makeEmbedding(seen), CHUNK_OPTIONS);
		const controller = new AbortController();
		controller.abort();
		const result = await processor.indexIncremental({ path: 'a.md', content: '正文' }, undefined, {
			signal: controller.signal,
		});
		expect(result.indexed).toBe(0);
		expect(result.errors).toBe(1);
		// 未写入任何块:整库条目数保持 0,取消不会留下半份内容。
		expect((await store.status()).totalDocs).toBe(0);
	});
});
