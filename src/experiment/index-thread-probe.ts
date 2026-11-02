/**
 * @file src/experiment/index-thread-probe.ts
 * @description T0 实验 v2 — 真实 Obsidian 中验证 Node 子线程不可用，并测 Web Worker 承担 CPU、主线程异步写是否阻塞
 * @module src/experiment
 *
 * 关键路径:
 * - v1 已证明 Obsidian 渲染进程**不能**创建 Node `worker_threads`（V8 platform 不支持）；本版保留该负结果并继续测替代路径。
 * - Web Worker 是宿主支持的独立线程形态（插件既有嵌入 Worker 即 Blob URL 模式）；它没有 Node 文件能力，因此 CPU 与 IO 必须分开验证。
 * - 阻塞量仍用主线程心跳迟到量表示；只有探针能检出 300 ms 长任务，读数才有效。
 * - 实验只写系统临时目录，不读也不写索引。
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Platform, apiVersion } from 'obsidian';
import { createInlineIndexRuntimeHost, createInlineRuntimeWorker } from '../worker/index-runtime-browser';
import { IndexRuntimeClient } from '../worker/index-runtime-client';
import { createEmbeddingBridge } from '../worker/index-runtime-embedding-bridge';

/** 心跳间隔。 */
const HEARTBEAT_MS = 10;

/** Web Worker 源码：纯 CPU，无 Node 能力。 */
const WEB_WORKER_SOURCE = String.raw`
self.onmessage = function (event) {
	var task = event.data;
	if (task.kind !== 'stringify') return;
	var items = [];
	for (var i = 0; i < task.docs; i += 1) {
		var vector = new Array(task.dims);
		for (var j = 0; j < task.dims; j += 1) vector[j] = ((i * 31 + j * 17) % 1000) / 1000;
		items.push({ path: 'note-' + i + '.md', vector: vector });
	}
	var text = JSON.stringify({ version: 1, items: items });
	var fsOk = false;
	var fsError = '';
	try {
		var fs = require('node:fs');
		var p = require('node:path');
		var probe = p.join(task.dir, 'worker-fs-probe.txt');
		fs.writeFileSync(probe, 'probe');
		fsOk = fs.readFileSync(probe, 'utf8') === 'probe';
	} catch (error) {
		fsError = String((error && error.message) || error);
	}
	self.postMessage({
		bytes: text.length,
		hasRequire: typeof require !== 'undefined',
		hasProcess: typeof process !== 'undefined',
		fsOk: fsOk,
		fsError: fsError,
	});
};
`;

/** 读数。 */
export interface WebWorkerResult {
	bytes: number;
	hasRequire: boolean;
	hasProcess: boolean;
	fsOk: boolean;
	fsError: string;
}

export interface StallReading {
	maxGapMs: number;
	p95GapMs: number;
	samples: number;
}

/** 实验报告。 */
export interface ExperimentReport {
	startedAt: string;
	environment: string;
	nodeWorker: { supported: boolean; error?: string };
	webWorker: WebWorkerResult & { stall: StallReading };
	mainThread: { bytes: number; stall: StallReading };
	asyncWholeWrite: StallReading;
	shardedWrite: { shards: number; stall: StallReading };
	selfCheck: StallReading;
	/** 真实常驻 Worker 链路:init → ping → 写 → 读。 */
	channel: { ping: string; written: boolean; readBack: string | null; stall: StallReading; error?: string };
	/** 索引线程会话链路:索引两篇 → 查询 → 状态。 */
	runtime: { indexed: number; hits: number; totalDocs: number; stall: StallReading; error?: string };
}

/** 采样迟到量。 */
function summarize(gaps: number[]): StallReading {
	const sorted = [...gaps].sort((a, b) => a - b);
	const p95 = sorted.length > 0 ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]! : 0;
	return { maxGapMs: sorted.length > 0 ? sorted[sorted.length - 1]! : 0, p95GapMs: p95, samples: sorted.length };
}

/** 在 `run` 执行期间测主线程心跳迟到。 */
async function measure(run: () => unknown): Promise<StallReading> {
	const gaps: number[] = [];
	let deadline = performance.now() + HEARTBEAT_MS;
	const timer = window.setInterval(() => {
		const now = performance.now();
		gaps.push(now - deadline);
		deadline = now + HEARTBEAT_MS;
	}, HEARTBEAT_MS);
	try {
		await run();
		// 关键路径:Chromium 里 0ms 超时可能先于已到期心跳执行,导致同步长任务漏采;
		// 等两个心跳周期,确保至少一次心跳在停表前落地。
		await new Promise<void>((resolve) => window.setTimeout(resolve, HEARTBEAT_MS * 2));
		return summarize(gaps);
	} finally {
		window.clearInterval(timer);
	}
}

/** 主线程构造并序列化（阻塞基线）。 */
function stringifyOnMainThread(docs: number, dims: number): { bytes: number; text: string } {
	const items: Array<{ path: string; vector: number[] }> = [];
	for (let i = 0; i < docs; i += 1) {
		const vector = new Array<number>(dims);
		for (let j = 0; j < dims; j += 1) vector[j] = ((i * 31 + j * 17) % 1000) / 1000;
		items.push({ path: `note-${i}.md`, vector });
	}
	const text = JSON.stringify({ version: 1, items });
	return { bytes: text.length, text };
}

/** 在 Web Worker 里做同一份序列化。 */
function stringifyInWebWorker(dir: string, docs: number, dims: number): Promise<WebWorkerResult> {
	const url = URL.createObjectURL(new Blob([WEB_WORKER_SOURCE], { type: 'text/javascript' }));
	const worker = new Worker(url);
	const finish = (): void => {
		worker.terminate();
		URL.revokeObjectURL(url);
	};
	return new Promise((resolve, reject) => {
		worker.onmessage = (event: MessageEvent<WebWorkerResult>) => {
			finish();
			resolve(event.data);
		};
		worker.onerror = (event) => {
			finish();
			reject(new Error(event.message || 'Web Worker 执行失败'));
		};
		worker.postMessage({ kind: 'stringify', docs, dims, dir });
	});
}

/** 主线程异步整文件写入。 */
async function writeWhole(dir: string, text: string): Promise<void> {
	const file = path.join(dir, 'whole.json');
	const handle = await fsp.open(file, 'w');
	try {
		await handle.write(text);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/** 主线程异步分片写入：模拟按文件/桶分片，避免整库一次序列化。 */
async function writeSharded(dir: string, shards: number, dims: number): Promise<void> {
	const bucket = path.join(dir, 'shards');
	await fsp.mkdir(bucket, { recursive: true });
	for (let i = 0; i < shards; i += 1) {
		const vector = new Array<number>(dims);
		for (let j = 0; j < dims; j += 1) vector[j] = ((i * 31 + j * 17) % 1000) / 1000;
		await fsp.writeFile(path.join(bucket, `shard-${i}.json`), JSON.stringify({ path: `note-${i}.md`, vector }), 'utf8');
	}
}

/**
 * 运行实验 v2 并写报告。
 * @param docs 笔记条数
 * @param dims 向量维度
 */
export async function runIndexThreadExperiment(
	docs = 4000,
	dims = 512,
): Promise<{ report: ExperimentReport; reportPath: string }> {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ratel-index-thread-'));
	const osName = Platform.isMacOS ? 'macOS' : Platform.isWin ? 'Windows' : Platform.isLinux ? 'Linux' : 'unknown';
	const environment = `${osName} / Obsidian ${apiVersion}`;

	// 1) Node worker_threads：保留 v1 负结果，供证据链闭合。
	let nodeWorker: { supported: boolean; error?: string } = { supported: true };
	try {
		const { Worker } = await import('node:worker_threads');
		const probe = new Worker('void 0;', { eval: true });
		await probe.terminate();
	} catch (error) {
		nodeWorker = { supported: false, error: String((error as Error)?.message ?? error) };
	}

	// 2) 探针自检。
	const selfCheck = await measure(() => {
		const until = performance.now() + 300;
		while (performance.now() < until) {
			// 故意占用主线程。
		}
	});

	// 3) 主线程序列化基线。
	let mainBytes = 0;
	let mainText = '';
	const mainThread = await measure(() => {
		const result = stringifyOnMainThread(docs, dims);
		mainBytes = result.bytes;
		mainText = result.text;
	});

	// 4) Web Worker 承担同一份序列化。
	let webResult: WebWorkerResult = { bytes: 0, hasRequire: false, hasProcess: false, fsOk: false, fsError: '' };
	const webStall = await measure(async () => {
		webResult = await stringifyInWebWorker(dir, docs, dims);
	});
	if (!webResult.bytes) throw new Error('Web Worker 未返回结果');

	// 5) 主线程异步整文件写入。
	const asyncWholeWrite = await measure(() => writeWhole(dir, mainText));

	// 6) 主线程异步分片写入。
	const shardCount = 120;
	const shardedStall = await measure(() => writeSharded(dir, shardCount, dims));

	// 7) 真实链路:常驻 Blob Worker + init 授权 + 受限文件读写。
	let channel: ExperimentReport['channel'] = { ping: '', written: false, readBack: null, stall: { maxGapMs: 0, p95GapMs: 0, samples: 0 } };
	try {
		const host = createInlineIndexRuntimeHost({ runtimeId: 'experiment', requestTimeoutMs: 15_000 });
		host.start();
		host.send({ kind: 'init', runtimeId: 'experiment', epoch: host.epoch, root: dir, access: 'read-write' });
		const pong = await host.request<string>('ping');
		channel.ping = pong;
		channel.stall = await measure(async () => {
			await host.request('fs.write', { path: 'probe.txt', data: 'hello-worker' });
			channel.written = true;
		});
		const read = await host.request<{ data: string | null }>('fs.read', { path: 'probe.txt' });
		channel.readBack = read.data;
		await host.stop('experiment done');
	} catch (error) {
		channel.error = String((error as Error)?.message ?? error);
	}

	// 8) 会话链路:真实常驻 Worker 内跑分块 + Vectra + 日志,嵌入用确定性替身。
	let runtime: ExperimentReport['runtime'] = { indexed: 0, hits: 0, totalDocs: 0, stall: { maxGapMs: 0, p95GapMs: 0, samples: 0 } };
	try {
		const sessionRoot = path.join(dir, 'session');
		await fsp.mkdir(sessionRoot, { recursive: true });
		const dims = 8;
		const embedBridge = createEmbeddingBridge({
			dimensions: dims,
			modelId: 'experiment:stub',
			async embed(texts) { return texts.map(() => Array.from({ length: dims }, () => 0.1)); },
		});
		const client = new IndexRuntimeClient({
			// 复用与生产同一个内联 Worker 装配。
			createWorker: () => createInlineRuntimeWorker(),
			embed: embedBridge,
			requestTimeoutMs: 20_000,
		});
		runtime.stall = await measure(async () => {
			await client.start({
				root: sessionRoot,
				generationId: 'experiment-gen',
				configFingerprint: 'a'.repeat(64),
				expectedDimension: dims,
				chunkOptions: { maxTokens: 500, overlapTokens: 100 },
			});
			await client.indexFile('note-a.md', '第一段关于索引的正文\n第二段正文');
			await client.indexFile('note-b.md', '另一篇笔记的正文');
			runtime.indexed = 2;
			const hits = await client.search('索引', 5);
			runtime.hits = hits.length;
			runtime.totalDocs = (await client.status()).totalDocs;
			await client.close('experiment done');
		});
	} catch (error) {
		runtime.error = String((error as Error)?.message ?? error);
	}

	const report: ExperimentReport = {
		startedAt: new Date().toISOString(),
		environment,
		nodeWorker,
		webWorker: { ...webResult, stall: webStall },
		mainThread: { bytes: mainBytes, stall: mainThread },
		asyncWholeWrite,
		shardedWrite: { shards: shardCount, stall: shardedStall },
		selfCheck,
		channel,
		runtime,
	};
	const reportPath = path.join(os.tmpdir(), `ratel-index-thread-experiment-${Date.now()}.json`);
	await fsp.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
	await fsp.rm(dir, { recursive: true, force: true });
	return { report, reportPath };
}
