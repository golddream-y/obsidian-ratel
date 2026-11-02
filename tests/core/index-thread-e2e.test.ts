/**
 * @file tests/core/index-thread-e2e.test.ts
 * @description 线程索引 + 宿主检索编排的端到端组合
 * @module tests/core/index-thread-e2e
 *
 * 关键路径:
 * - 组合的是真实组件:线程服务循环 → 客户端 → 线程协调器(写入) → 候选来源(读取)
 *   → MultiQuerySearcher(融合/可见性/精排)。只替换线程边界、模型与 Vault。
 * - 证明「写入在线程、编排在宿主」这条切分自洽:写进去的文件能被编排层检索到。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IndexRuntimeClient } from '../../src/worker/index-runtime-client';
import { serveRuntime, type RuntimeHandlers, type RuntimeServerPort } from '../../src/worker/index-runtime-worker';
import { createIndexSessionHandlers } from '../../src/worker/index-runtime-session';
import type { RuntimeWorkerLike } from '../../src/worker/index-runtime-host';
import { IndexThreadCoordinator } from '../../src/core/index-thread-coordinator';
import { createThreadCandidateSource } from '../../src/core/index-thread-candidate-source';
import { MultiQuerySearcher } from '../../src/core/multi-query-searcher';
import type { EmbeddingPort } from '../../src/ports/embedding';
import type { WorkerManager } from '../../src/worker/manager';
import type { ObsidianVault } from '../../src/adapters/obsidian-vault';

const DIMENSIONS = 8;
const FINGERPRINT = 'a'.repeat(64);
let root = '';

beforeEach(async () => {
	root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ratel-thread-e2e-'));
});

afterEach(async () => {
	if (root) await fsp.rm(root, { recursive: true, force: true });
});

/** 把客户端与服务循环直接对接的假线程。 */
function makeBridge(handlers: RuntimeHandlers, runtimeId: string): RuntimeWorkerLike {
	const serverPort: RuntimeServerPort = {
		postMessage: (message) => { worker.onmessage?.({ data: message }); },
		onmessage: null,
	};
	const worker: RuntimeWorkerLike = {
		onmessage: null,
		onerror: null,
		postMessage: (message) => { serverPort.onmessage?.({ data: message }); },
		terminate: async () => {},
	};
	serveRuntime({ port: serverPort, grant: { runtimeId, epoch: 1 }, handlers });
	return worker;
}

describe('线程索引 + 宿主检索编排', () => {
	it('线程写入的两篇 - 经候选来源与编排层可检索', async () => {
		const embedding: EmbeddingPort = {
			dimensions: DIMENSIONS,
			modelId: 'test:e2e',
			async embed(texts) {
				return texts.map(() => Array.from({ length: DIMENSIONS }, () => 0.1));
			},
		};
		const handlers: RuntimeHandlers = {
			ping: () => 'pong',
			...createIndexSessionHandlers({
				root,
				chunkOptions: { maxTokens: 500, overlapTokens: 100, count: (text: string) => text.length },
				epoch: 1,
			}),
		};
		let bridge: RuntimeWorkerLike | null = null;
		const client = new IndexRuntimeClient({
			createWorker: () => bridge!,
			embed: async (texts) => embedding.embed([...texts]),
		});
		bridge = makeBridge(handlers, client.runtimeId);

		const files: Record<string, string> = {
			'a.md': '关于索引与检索的正文',
			'b.md': '另一篇不相关的内容',
		};
		const coordinator = new IndexThreadCoordinator({
			client,
			vault: {
				listMarkdownFiles: () => Object.keys(files),
				readFile: async (filePath: string) => files[filePath] ?? '',
			},
			start: { root, generationId: 'gen-e2e', configFingerprint: FINGERPRINT, expectedDimension: DIMENSIONS },
		});
		const counters = await coordinator.start();
		expect(counters).toMatchObject({ total: 2, committed: 2, failures: 0 });

		const searcher = new MultiQuerySearcher({
			embedding,
			// 关键路径:检索候选来自线程,Worker 不应再被用于召回。
			workerManager: { request: async () => { throw new Error('不应调用 Worker 召回'); } } as unknown as WorkerManager,
			vault: { readFile: async (filePath: string) => files[filePath] ?? '' } as unknown as ObsidianVault,
			candidateSource: createThreadCandidateSource({
				searchByVector: (vector, topK) => client.searchByVector(vector, topK),
			}),
		});
		const results = await searcher.search('索引', 5);
		expect(results.length).toBeGreaterThan(0);
		expect(results.map((result) => result.metadata.path)).toContain('a.md');

		coordinator.destroy();
		await client.close('e2e done');
	});
});
