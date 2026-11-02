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

describe('重启后仍可检索', () => {
	it('关闭后重开同一代际 - 已提交内容仍可检索', async () => {
		const embedding: EmbeddingPort = {
			dimensions: DIMENSIONS,
			modelId: 'test:reopen',
			async embed(texts) {
				return texts.map(() => Array.from({ length: DIMENSIONS }, () => 0.1));
			},
		};
		/** 起一个全新的客户端 + 服务循环,模拟插件重载。 */
		const open = () => {
			const handlers: RuntimeHandlers = {
				ping: () => 'pong',
				...createIndexSessionHandlers({ root, chunkOptions: { maxTokens: 500, overlapTokens: 100, count: (t: string) => t.length }, epoch: 1 }),
			};
			let bridge: RuntimeWorkerLike | null = null;
			const client = new IndexRuntimeClient({
				createWorker: () => bridge!,
				embed: async (texts) => embedding.embed([...texts]),
			});
			bridge = makeBridge(handlers, client.runtimeId);
			return client;
		};

		const first = open();
		await first.start({ root, generationId: 'gen-reopen', configFingerprint: FINGERPRINT, expectedDimension: DIMENSIONS });
		await first.indexFile('持久.md', '重启后仍然可检索的正文');
		await first.close('第一次关闭');

		const second = open();
		await second.start({ root, generationId: 'gen-reopen', configFingerprint: FINGERPRINT, expectedDimension: DIMENSIONS });
		const hits = await second.search('检索', 5);
		expect(hits.map((hit) => hit.path)).toContain('持久.md');
		await second.close('第二次关闭');
	});
});

describe('二次核对不重复嵌入', () => {
	it('同一批文件跑两轮 - 第二轮全部跳过 - 嵌入调用不翻倍', async () => {
		const embedCalls: string[][] = [];
		const handlers: RuntimeHandlers = {
			ping: () => 'pong',
			...createIndexSessionHandlers({ root, chunkOptions: { maxTokens: 500, overlapTokens: 100, count: (text: string) => text.length }, epoch: 1 }),
		};
		let bridge: RuntimeWorkerLike | null = null;
		const client = new IndexRuntimeClient({
			createWorker: () => bridge!,
			embed: async (texts) => {
				// 关键路径:记录每次嵌入请求,用来判定第二轮是否真的跳过。
				embedCalls.push([...texts]);
				return texts.map(() => Array.from({ length: DIMENSIONS }, () => 0.1));
			},
		});
		bridge = makeBridge(handlers, client.runtimeId);
		const files = ['一.md', '二.md', '三.md'];
		const coordinator = new IndexThreadCoordinator({
			client,
			vault: {
				listMarkdownFiles: () => files,
				readFile: async (filePath: string) => `正文 ${filePath}`,
			},
			start: { root, generationId: 'gen-twice', configFingerprint: FINGERPRINT, expectedDimension: DIMENSIONS },
		});

		await coordinator.start();
		const firstRound = embedCalls.length;
		expect(firstRound).toBeGreaterThan(0);

		// 第二轮等价于「重建索引 / 插件重启后的全库核对」。
		await coordinator.start();
		expect(embedCalls.length).toBe(firstRound);
		expect(coordinator.counters()).toMatchObject({ total: files.length, committed: files.length, failures: 0 });
		coordinator.destroy();
		await client.close('two rounds done');
	});
});
