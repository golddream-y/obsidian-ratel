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
