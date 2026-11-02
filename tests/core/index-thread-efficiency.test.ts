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
		const handlers: RuntimeHandlers = {
			ping: () => 'pong',
			...createIndexSessionHandlers({ root, chunkOptions: CHUNK, epoch: 1 }),
		};
		let client!: IndexRuntimeClient;
		client = new IndexRuntimeClient({
			createWorker: () => makeBridge(handlers, client.runtimeId),
			embed: async (texts) => texts.map(() => Array.from({ length: DIMENSIONS }, () => 0.1)),
		});
		await client.start({ root, generationId: 'gen-eff', configFingerprint: 'a'.repeat(64), expectedDimension: DIMENSIONS, chunkOptions: CHUNK });

		let peakHeap = 0;
		const sampler = setInterval(() => { peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed); }, 50);
		const startedAt = performance.now();
		for (let index = 0; index < FILE_COUNT; index += 1) {
			await client.indexFile(`note-${index}.md`, makeContent(index));
		}
		const elapsedMs = performance.now() - startedAt;
		clearInterval(sampler);
		await client.close('efficiency done');

		console.info(`[线程效率] 文件=${FILE_COUNT} 总耗时=${elapsedMs.toFixed(0)}ms 每篇=${(elapsedMs / FILE_COUNT).toFixed(1)}ms 峰值堆=${(peakHeap / 1024 / 1024).toFixed(1)}MB`);
		expect(elapsedMs).toBeGreaterThan(0);
	});
});
