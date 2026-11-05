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

describe('先解析代际再装配', () => {
	it('活动代际指纹一致 - 直接复用该代际 - 线程拿到代际根', async () => {
		const { computeConfigFingerprint, INDEX_RECORD_SCHEMA_VERSION } = await import('../../src/core/index-persistence-types');
		const config = {
			embeddingModelId: 'local:test', embeddingModelRevision: null, embeddingDimension: DIMENSIONS,
			chunkerVersion: 1, chunkSize: 400, chunkOverlap: 50, embeddingTextVersion: null,
		};
		const fingerprint = await computeConfigFingerprint(config);
		const record = {
			schemaVersion: INDEX_RECORD_SCHEMA_VERSION, generationId: 'gen-active', fingerprint,
			kind: 'fresh' as const, status: 'active' as const, root: '/tmp/gen-active',
			verifiedAt: 1, createdAt: 1,
		};
		const generations = {
			readControl: async () => ({
				schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
				activeGenerationId: 'gen-active',
				generations: { 'gen-active': record },
			}),
			generationRootOf: (id: string) => `/tmp/${id}`,
		} as never;
		const owner = { epoch: 1, assertWritable: () => {}, beginCommit: () => ({ settle: () => {} }) };
		const threadClient = makeThreadClient();
		const { assembleIndexThreadRuntime } = await import('../../src/core/index-thread-assembly');
		const result = await assembleIndexThreadRuntime({
			indexRoot: '/tmp/index-root',
			generations, config, owner, expectedDimension: DIMENSIONS,
			embedding: EMBEDDING,
			vault: { listMarkdownFiles: () => [], readFile: async () => '' },
			createClient: () => threadClient,
		});
		expect(result.resolved).toMatchObject({ generationId: 'gen-active', configFingerprint: fingerprint, active: true });
		await result.pipeline!.coordinator.start();
		expect(threadClient.start).toHaveBeenCalledWith(expect.objectContaining({
			root: '/tmp/gen-active', generationId: 'gen-active', configFingerprint: fingerprint,
		}));
	});
});

describe('线程模式的代际提权（2026-11-05 事故回归）', () => {
	/** 只提供提权所需的最小控制指针替身。 */
	function makeGenerations(activeGenerationId: string | null) {
		const publishActiveGeneration = vi.fn(async ({ generationId }: { generationId: string }) => ({
			activeGenerationId: generationId,
			generations: {},
		}));
		return {
			readControl: vi.fn(async () => ({ activeGenerationId, generations: {} })),
			publishActiveGeneration,
		};
	}

	const START = { root: '/tmp/index-root', generationId: 'gen-new', configFingerprint: 'c'.repeat(64), expectedDimension: DIMENSIONS };

	function build(generations: ReturnType<typeof makeGenerations>, fingerprint: string) {
		const threadClient = makeThreadClient();
		const pipeline = assembleIndexThreadPipeline({
			indexRoot: '/tmp/index-root',
			generationId: 'gen-new',
			configFingerprint: fingerprint,
			expectedDimension: DIMENSIONS,
			embedding: EMBEDDING,
			// 关键路径:必须经协调器真正走一次写入,否则验不到「提交后才登记」。
			vault: {
				listMarkdownFiles: () => ['a.md', 'b.md', 'c.md'],
				readFile: async (p: string) => `# ${p}`,
			},
			chunkOptions: { maxTokens: 400, overlapTokens: 50 },
			createClient: () => threadClient,
			generations: generations as never,
		});
		return { threadClient, pipeline };
	}

	it('尚无活动代际 - 首个写入成功后登记一次 - 后续写入不重复登记', async () => {
		const generations = makeGenerations(null);
		const { pipeline } = build(generations, 'c'.repeat(64));
		await pipeline.coordinator.start();
		expect(generations.publishActiveGeneration).toHaveBeenCalledTimes(1);
		expect(generations.publishActiveGeneration).toHaveBeenCalledWith({ generationId: 'gen-new', mode: 'upgrade' });
		pipeline.coordinator.destroy();
	});

	it('已有活动代际 - 不登记 - 也不重复读控制指针', async () => {
		const generations = makeGenerations('gen-existing');
		const { pipeline } = build(generations, 'd'.repeat(64));
		await pipeline.coordinator.start();
		expect(generations.publishActiveGeneration).not.toHaveBeenCalled();
		expect(generations.readControl).toHaveBeenCalledTimes(1);
		pipeline.coordinator.destroy();
	});

	it('登记失败 - 提交结果不受影响 - 下一次写入重试', async () => {
		const generations = makeGenerations(null);
		generations.publishActiveGeneration.mockRejectedValueOnce(new Error('控制指针写入失败'));
		const { pipeline } = build(generations, 'e'.repeat(64));
		const counters = await pipeline.coordinator.start();
		expect(counters.failures).toBe(0);
		expect(generations.publishActiveGeneration).toHaveBeenCalledTimes(2);
		pipeline.coordinator.destroy();
	});

	void START;
});
