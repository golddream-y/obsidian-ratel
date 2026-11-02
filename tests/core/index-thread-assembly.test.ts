/**
 * @file tests/core/index-thread-assembly.test.ts
 * @description 线程版装配 — 协调器与客户端接线、代际参数透传与嵌入桥接
 * @module tests/core/index-thread-assembly
 */

import { describe, expect, it, vi } from 'vitest';
import { assembleIndexThreadPipeline } from '../../src/core/index-thread-assembly';
import type { EmbeddingPort } from '../../src/ports/embedding';
import type { ThreadIndexClient } from '../../src/core/index-thread-coordinator';

const DIMENSIONS = 8;

/** 记录调用的假线程客户端。 */
function makeThreadClient(): ThreadIndexClient & Record<'start' | 'indexFile' | 'deleteFile' | 'recover' | 'close', ReturnType<typeof vi.fn>> {
	const client = {
		start: vi.fn(async () => undefined),
		indexFile: vi.fn(async () => ({ chunkCount: 1 })),
		deleteFile: vi.fn(async () => ({ removed: 1 })),
		recover: vi.fn(async () => ({ pending: 0, decisions: 0, failures: 0 })),
		close: vi.fn(async () => undefined),
	};
	return client as unknown as ThreadIndexClient & typeof client;
}

const EMBEDDING: EmbeddingPort = {
	dimensions: DIMENSIONS,
	modelId: 'test:assembly',
	async embed(texts) {
		return texts.map(() => Array.from({ length: DIMENSIONS }, () => 0.1));
	},
};

describe('线程版索引装配', () => {
	it('装配后启动 - 代际参数与分块预算透传到线程', async () => {
		const threadClient = makeThreadClient();
		const pipeline = assembleIndexThreadPipeline({
			indexRoot: '/tmp/index-root',
			generationId: 'gen-x',
			configFingerprint: 'b'.repeat(64),
			expectedDimension: DIMENSIONS,
			embedding: EMBEDDING,
			vault: { listMarkdownFiles: () => [], readFile: async () => '' },
			chunkOptions: { maxTokens: 400, overlapTokens: 50 },
			createClient: () => threadClient,
		});
		await pipeline.coordinator.start();
		expect(threadClient.start).toHaveBeenCalledWith(expect.objectContaining({
			root: '/tmp/index-root',
			generationId: 'gen-x',
			configFingerprint: 'b'.repeat(64),
			expectedDimension: DIMENSIONS,
			chunkOptions: { maxTokens: 400, overlapTokens: 50 },
		}));
	});

	it('协调器枚举文件 - 逐个交给线程 - 计数与就绪一致', async () => {
		const threadClient = makeThreadClient();
		const pipeline = assembleIndexThreadPipeline({
			indexRoot: '/tmp/index-root',
			generationId: 'gen-x',
			configFingerprint: 'b'.repeat(64),
			embedding: EMBEDDING,
			vault: { listMarkdownFiles: () => ['a.md', 'b.md'], readFile: async (p: string) => `正文 ${p}` },
			createClient: () => threadClient,
		});
		const counters = await pipeline.coordinator.start();
		expect(threadClient.indexFile).toHaveBeenCalledTimes(2);
		expect(threadClient.indexFile).toHaveBeenCalledWith('a.md', '正文 a.md');
		expect(counters).toMatchObject({ total: 2, committed: 2, failures: 0 });
		expect(pipeline.coordinator.isReady()).toBe(true);
		pipeline.coordinator.destroy();
		expect(threadClient.close).toHaveBeenCalled();
	});

	it('线程写入失败 - 该文件保留在失败集合 - 不整体中断', async () => {
		const threadClient = makeThreadClient();
		threadClient.indexFile.mockImplementation(async (filePath: string) => {
			if (filePath === 'b.md') throw new Error('提交失败');
			return { chunkCount: 1 };
		});
		const pipeline = assembleIndexThreadPipeline({
			indexRoot: '/tmp/index-root',
			generationId: 'gen-x',
			configFingerprint: 'b'.repeat(64),
			embedding: EMBEDDING,
			vault: { listMarkdownFiles: () => ['a.md', 'b.md'], readFile: async (p: string) => p },
			createClient: () => threadClient,
		});
		const counters = await pipeline.coordinator.start();
		expect(counters).toMatchObject({ committed: 1, failures: 1 });
		expect(pipeline.coordinator.isReady()).toBe(false);
		pipeline.coordinator.destroy();
	});
});
