/**
 * @file src/experiment/index-thread-probe.ts
 * @description T0 实验 — 在真实 Obsidian 中比较主线程与独立 Node 子线程执行同一份整库 JSON 提交的界面阻塞
 * @module src/experiment
 *
 * 关键路径:
 * - 只有用构建期开关 `RATEL_INDEX_EXPERIMENT=1` 构建时才注册命令，正常产物不含实验入口。
 * - 实验只读运行：写临时目录与报告文件，不读也不写索引目录，不触碰生产数据。
 * - 阻塞量用主线程心跳迟到量表示；同步长任务期间定时器排不上队，迟到量就是可观测的界面阻塞量级。
 * - 子线程脚本运行时落盘再启动，与生产「bundle 内联、运行时写出」形态一致。
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { Platform, apiVersion } from 'obsidian';

/** 心跳间隔。 */
const HEARTBEAT_MS = 10;

/** 子线程脚本：CommonJS，避免依赖宿主包的模块类型推断。 */
const WORKER_SOURCE = String.raw`
const { parentPort, workerData, threadId, isMainThread } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');

function buildDocuments(count, dims) {
	const documents = [];
	for (let i = 0; i < count; i += 1) {
		const vector = new Array(dims);
		for (let j = 0; j < dims; j += 1) vector[j] = ((i * 31 + j * 17) % 1000) / 1000;
		documents.push({ path: 'note-' + i + '.md', vector });
	}
	return documents;
}

function commitJson(dir, docs, dims) {
	const documents = buildDocuments(docs, dims);
	const text = JSON.stringify({ version: 1, items: documents });
	const file = path.join(dir, 'index.json');
	const fd = fs.openSync(file, 'w');
	try {
		fs.writeFileSync(fd, text);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	return { bytes: Buffer.byteLength(text), docs: documents.length };
}

try {
	const task = workerData.task;
	const result = task.kind === 'identity'
		? { threadId, isMainThread }
		: { threadId, isMainThread, ...commitJson(workerData.dir, task.docs, task.dims) };
	parentPort.postMessage({ ok: true, result });
} catch (error) {
	parentPort.postMessage({ ok: false, error: String((error && error.message) || error) });
}
`;

/** 一次测量的读数。 */
export interface StallReading {
	maxGapMs: number;
	p95GapMs: number;
	samples: number;
}

/** 实验报告。 */
export interface ExperimentReport {
	startedAt: string;
	environment: string;
	threadId: number;
	mainThread: { bytes: number; stall: StallReading };
	workerThread: { bytes: number; stall: StallReading };
	selfCheck: StallReading;
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
		// 让一次已到期的心跳先执行，避免同步长任务结束时被直接清除而漏记。
		await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
		return summarize(gaps);
	} finally {
		window.clearInterval(timer);
	}
}

/** 主线程直接执行同形态提交（只测序列化与构造成本）。 */
function commitOnMainThread(docs: number, dims: number): { bytes: number } {
	const items: Array<{ path: string; vector: number[] }> = [];
	for (let i = 0; i < docs; i += 1) {
		const vector = new Array<number>(dims);
		for (let j = 0; j < dims; j += 1) vector[j] = ((i * 31 + j * 17) % 1000) / 1000;
		items.push({ path: `note-${i}.md`, vector });
	}
	const text = JSON.stringify({ version: 1, items });
	return { bytes: Buffer.byteLength(text) };
}

/** 子线程执行同形态提交。 */
async function commitOnWorker(dir: string, docs: number, dims: number): Promise<{ bytes: number; threadId: number }> {
	const script = path.join(dir, 'worker.cjs');
	await fsp.writeFile(script, WORKER_SOURCE, 'utf8');
	const worker = new Worker(script, { workerData: { task: { kind: 'json-commit', docs, dims }, dir } });
	try {
		return await new Promise<{ bytes: number; threadId: number }>((resolve, reject) => {
			worker.once('message', (message: { ok: boolean; result?: { bytes: number; threadId: number }; error?: string }) => {
				if (message.ok && message.result) resolve(message.result);
				else reject(new Error(message.error ?? '子线程执行失败'));
			});
			worker.once('error', reject);
		});
	} finally {
		await worker.terminate();
	}
}

/**
 * 运行实验并把报告写到临时目录。
 * @param docs 构造的笔记条数
 * @param dims 每条向量维度
 */
export async function runIndexThreadExperiment(
	docs = 4000,
	dims = 512,
): Promise<{ report: ExperimentReport; reportPath: string }> {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ratel-index-thread-'));
	const osName = Platform.isMacOS ? 'macOS' : Platform.isWin ? 'Windows' : Platform.isLinux ? 'Linux' : 'unknown';
	const environment = `${osName} / Obsidian ${apiVersion}`;

	const selfCheck = await measure(() => {
		const until = performance.now() + 300;
		while (performance.now() < until) {
			// 故意占用主线程，验证探针能检出长任务。
		}
	});

	let mainBytes = 0;
	const mainStall = await measure(() => {
		mainBytes = commitOnMainThread(docs, dims).bytes;
	});

	let workerBytes = 0;
	let threadId = 0;
	const workerStall = await measure(async () => {
		const result = await commitOnWorker(dir, docs, dims);
		workerBytes = result.bytes;
		threadId = result.threadId;
	});

	const report: ExperimentReport = {
		startedAt: new Date().toISOString(),
		environment,
		threadId,
		mainThread: { bytes: mainBytes, stall: mainStall },
		workerThread: { bytes: workerBytes, stall: workerStall },
		selfCheck,
	};
	const reportPath = path.join(os.tmpdir(), `ratel-index-thread-experiment-${Date.now()}.json`);
	await fsp.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
	await fsp.rm(dir, { recursive: true, force: true });
	return { report, reportPath };
}
