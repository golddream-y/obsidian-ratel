/**
 * @file tests/core/index-thread-efficiency.test.ts
 * @description 效率组对照 — 同一负载走线程会话的每篇成本（默认跳过）
 * @module tests/core/index-thread-efficiency
 *
 * 关键路径:
 * - 这里用同线程桥接跑会话链路,测的是「线程实现自身」的每篇成本,
 *   不含线程隔离带来的主线程收益 —— 那必须在宿主内测,不能用本文件数字代替。
 * - 与 `index-efficiency-baseline` 同规模、同分块参数、同日志与完成记录,才可横向比较。
 * - 打开方式 `RATEL_EFFICIENCY=1`。
 */

import { afterAll, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IndexRuntimeClient } from '../../src/worker/index-runtime-client';
import { serveRuntime, type RuntimeHandlers, type RuntimeServerPort } from '../../src/worker/index-runtime-worker';
import { createIndexSessionHandlers } from '../../src/worker/index-runtime-session';
import type { RuntimeWorkerLike } from '../../src/worker/index-runtime-host';
import { AtomicIndexStorage } from '../../src/adapters/atomic-index-storage';
import { IndexThreadCoordinator } from '../../src/core/index-thread-coordinator';

const ENABLED = process.env.RATEL_EFFICIENCY === '1';
const FILE_COUNT = Number.parseInt(process.env.RATEL_EFFICIENCY_FILES ?? '100', 10);
const DIMENSIONS = 64;
const CHUNK = { maxTokens: 500, overlapTokens: 100, count: (text: string) => text.length };

const roots: string[] = [];

afterAll(async () => {
	for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

/** 造一篇约 2KB 的正文(与主线程基准同规模)。 */
function makeContent(index: number): string {
	return Array.from({ length: 12 }, (_, line) => `第 ${index} 篇第 ${line} 段正文，用于让分块数量稳定。`).join('\n');
}

/** 同线程桥接:客户端与服务循环直接对接。 */
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

describe.skipIf(!ENABLED)('线程会话效率对照', () => {
	it(`索引 ${FILE_COUNT} 篇 - 记录每篇成本`, { timeout: 600_000 }, async () => {
		const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ratel-thread-efficiency-'));
		roots.push(root);
		let writtenBytes = 0;
		let indexWrites = 0;
		const countingFs = {
			async openFile(absolutePath: string) {
				if (absolutePath.includes('index.json')) indexWrites += 1;
				const handle = await fsp.open(absolutePath, 'wx');
				return {
					async write(buffer: Uint8Array, offset: number, length: number) {
						const result = await handle.write(buffer, offset, length);
						writtenBytes += result.bytesWritten;
						return result.bytesWritten;
					},
					sync: () => handle.sync(),
					close: () => handle.close(),
				};
			},
			async openDirectory(absolutePath: string) {
				const handle = await fsp.open(absolutePath, 'r');
				return { sync: () => handle.sync(), close: () => handle.close() };
			},
			rename: (from: string, to: string) => fsp.rename(from, to),
			removeFile: async (absolutePath: string) => { await fsp.rm(absolutePath, { force: true }); },
		};
		const handlers: RuntimeHandlers = {
			ping: () => 'pong',
			...createIndexSessionHandlers({
				root,
				chunkOptions: CHUNK,
				epoch: 1,
				createStorage: (storageRoot) => new AtomicIndexStorage({ generationRoot: storageRoot, fileSystem: countingFs }),
			}),
		};
		let client!: IndexRuntimeClient;
		client = new IndexRuntimeClient({
			createWorker: () => makeBridge(handlers, client.runtimeId),
			embed: async (texts) => texts.map(() => Array.from({ length: DIMENSIONS }, () => 0.1)),
		});
		const start = { root, generationId: 'gen-eff', configFingerprint: 'a'.repeat(64), expectedDimension: DIMENSIONS, chunkOptions: CHUNK };
		await client.start(start);
		const baselineIndexWrites = indexWrites;
		const indexFiles = client.indexFiles.bind(client);
		let batchCalls = 0;
		client.indexFiles = async (files) => {
			batchCalls += 1;
			return indexFiles(files);
		};
		const files = Array.from({ length: FILE_COUNT }, (_, index) => ({ path: `note-${index}.md`, content: makeContent(index) }));
		const contents = new Map(files.map((file) => [file.path, file.content]));
		const coordinator = new IndexThreadCoordinator({
			client,
			vault: {
				listMarkdownFiles: () => files.map((file) => file.path),
				readFile: async (filePath) => contents.get(filePath)!,
			},
			start,
		});

		let peakHeap = 0;
		const sampler = setInterval(() => { peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed); }, 50);
		const startedAt = performance.now();
		const counters = await coordinator.start();
		const elapsedMs = performance.now() - startedAt;
		clearInterval(sampler);
		coordinator.destroy();
		await client.close('efficiency done');

		console.info(`[线程效率] 文件=${FILE_COUNT} 总耗时=${elapsedMs.toFixed(0)}ms 每篇=${(elapsedMs / FILE_COUNT).toFixed(1)}ms 峰值堆=${(peakHeap / 1024 / 1024).toFixed(1)}MB 写入字节=${(writtenBytes / 1024).toFixed(0)}KB index.json=${indexWrites - baselineIndexWrites}次 批量调用=${batchCalls}次`);
		expect(elapsedMs).toBeGreaterThan(0);
		expect(writtenBytes).toBeGreaterThan(0);
		expect(batchCalls).toBe(1);
		expect(indexWrites - baselineIndexWrites).toBe(1);
		expect(counters).toMatchObject({ committed: FILE_COUNT, failures: 0, phase: 'ready' });
	});
});
