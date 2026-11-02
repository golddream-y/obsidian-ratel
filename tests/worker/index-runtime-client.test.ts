/**
 * @file tests/worker/index-runtime-client.test.ts
 * @description 宿主客户端 ↔ 运行时服务端到端 — 启动、写入、查询、恢复与关闭
 * @module tests/worker/index-runtime-client
 *
 * 关键路径:
 * - 这是真正的协议闭环测试:宿主客户端发出的每一帧都由服务循环解析并应答,
 *   不 mock 协议、不伪造响应。
 * - 嵌入通道记录工作类型,验证查询走 `query` 优先级而不是混进索引批次。
 * - 使用真实临时目录与真实 Vectra/日志,只替换线程边界与模型。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IndexRuntimeClient } from '../../src/worker/index-runtime-client';
import { serveRuntime, type RuntimeHandlers, type RuntimeServerPort } from '../../src/worker/index-runtime-worker';
import { createIndexSessionHandlers } from '../../src/worker/index-runtime-session';
import type { RuntimeWorkerLike } from '../../src/worker/index-runtime-host';
import type { EmbedWorkload } from '../../src/core/index-embedding-arbiter';

const DIMENSIONS = 8;
const FINGERPRINT = 'a'.repeat(64);

let root = '';

beforeEach(async () => {
	root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ratel-client-'));
});

afterEach(async () => {
	if (root) await fsp.rm(root, { recursive: true, force: true });
});

/** 把宿主客户端与服务循环直接对接的假线程。 */
function makeBridge(handlers: RuntimeHandlers, runtimeId: string, epoch = 1): RuntimeWorkerLike {
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
	serveRuntime({ port: serverPort, grant: { runtimeId, epoch }, handlers });
	return worker;
}

describe('索引线程客户端', () => {
	it('启动 - 写入 - 查询 - 关闭 - 全链路可用', async () => {
		const workloads: EmbedWorkload[] = [];
		const handlers: RuntimeHandlers = {
			ping: () => 'pong',
			...createIndexSessionHandlers({ root, chunkOptions: { maxTokens: 500, overlapTokens: 100, count: (t) => t.length }, epoch: 1 }),
		};
		let bridge: RuntimeWorkerLike | null = null;
		const client = new IndexRuntimeClient({
			createWorker: () => bridge!,
			embed: async (texts, workload) => {
				workloads.push(workload);
				return texts.map(() => Array.from({ length: DIMENSIONS }, () => 0.1));
			},
		});
		// runtimeId 必须与宿主分配的 id 一致,否则帧会被服务端丢弃。
		bridge = makeBridge(handlers, client.runtimeId);

		await client.start({ root, generationId: 'gen-client', configFingerprint: FINGERPRINT, expectedDimension: DIMENSIONS });
		const written = await client.indexFile('a.md', '关于索引的正文');
		expect(written.chunkCount).toBeGreaterThan(0);

		const hits = await client.search('索引', 5);
		expect(hits.map((hit) => hit.path)).toContain('a.md');

		const status = await client.status();
		expect(status.written).toBe(1);

		await client.close();
		await expect(client.indexFile('b.md', 'x')).rejects.toThrow('尚未打开');
		// 索引写入走 index,查询走 query。
		expect(workloads).toContain('index');
		expect(workloads).toContain('query');
	});
});

describe('崩溃与重启', () => {
	it('线程退出 - 在途请求以 worker-exit 失败 - 不伪装成功', async () => {
		const handlers: RuntimeHandlers = {
			ping: () => 'pong',
			...createIndexSessionHandlers({ root, chunkOptions: { maxTokens: 500, overlapTokens: 100, count: (t) => t.length }, epoch: 1 }),
		};
		let bridge: RuntimeWorkerLike = makeBridge(handlers, '');
		const client = new IndexRuntimeClient({
			createWorker: () => bridge,
			embed: async (texts) => texts.map(() => Array.from({ length: DIMENSIONS }, () => 0.1)),
			requestTimeoutMs: 2000,
		});
		bridge = makeBridge(handlers, client.runtimeId);
		await client.start({ root, generationId: 'gen-crash', configFingerprint: FINGERPRINT, expectedDimension: DIMENSIONS });
		// 模拟线程崩溃:触发宿主登记的退出回调。
		bridge.onerror?.({ message: 'worker crashed' });
		await expect(client.indexFile('a.md', '正文')).rejects.toThrow();
	});

	it('重启后 - 沿用同一代际 - 写入恢复可用', async () => {
		const handlers: RuntimeHandlers = {
			ping: () => 'pong',
			...createIndexSessionHandlers({ root, chunkOptions: { maxTokens: 500, overlapTokens: 100, count: (t) => t.length }, epoch: 1 }),
		};
		// 关键路径:每次 start 都是新 epoch,桥接必须按同样 epoch 授权,否则帧会被静默丢弃。
		let started = 0;
		let client!: IndexRuntimeClient;
		const clientRef = () => client;
		client = new IndexRuntimeClient({
			createWorker: () => makeBridge(handlers, clientRef().runtimeId, ++started),
			embed: async (texts) => texts.map(() => Array.from({ length: DIMENSIONS }, () => 0.1)),
			requestTimeoutMs: 5000,
		});
		await client.start({ root, generationId: 'gen-restart', configFingerprint: FINGERPRINT, expectedDimension: DIMENSIONS });
		await client.restart();
		await expect(client.indexFile('a.md', '正文')).resolves.toMatchObject({ chunkCount: expect.any(Number) });
	});
});

describe('查询与索引的模型公平性', () => {
	it('索引批次在途时到达的查询 - 插到剩余索引批次之前', async () => {
		const handlers: RuntimeHandlers = {
			ping: () => 'pong',
			...createIndexSessionHandlers({ root, chunkOptions: { maxTokens: 8, overlapTokens: 0, count: (t) => t.length }, epoch: 1 }),
		};
		let client!: IndexRuntimeClient;
		const order: string[] = [];
		let releaseGate!: () => void;
		const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
		let gatedFirstIndex = false;
		client = new IndexRuntimeClient({
			createWorker: () => makeBridge(handlers, client.runtimeId),
			maxBatchSize: 1,
			embed: async (texts, workload) => {
				order.push(workload);
				if (workload === 'index' && !gatedFirstIndex) {
					gatedFirstIndex = true;
					await gate;
				}
				return texts.map(() => Array.from({ length: DIMENSIONS }, () => 0.1));
			},
		});
		await client.start({ root, generationId: 'gen-fair', configFingerprint: FINGERPRINT, expectedDimension: DIMENSIONS });
		// 多块正文 → 多个索引批次,才能看出查询是否插队。
		const longText = Array.from({ length: 8 }, (_, i) => `第${i}段需要被切开的正文内容`).join('\n');
		const indexing = client.indexFile('a.md', longText);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const searching = client.search('查询', 3);
		await new Promise((resolve) => setTimeout(resolve, 20));
		releaseGate();
		await Promise.all([indexing, searching]);
		// 首个索引批次在途 → 查询插入 → 剩余索引批次。
		expect(order[0]).toBe('index');
		expect(order[1]).toBe('query');
		expect(order.filter((item) => item === 'index').length).toBeGreaterThan(1);
	});
});
