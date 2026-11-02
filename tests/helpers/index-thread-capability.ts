/**
 * @file tests/helpers/index-thread-capability.ts
 * @description T0 线程能力实验 — 真实 Node 子线程执行 JSON 提交，并在主线程用心跳探针测量阻塞
 * @module tests/helpers/index-thread-capability
 *
 * 关键路径:
 * - 实验用**真实 worker_threads 子线程**，不是 InlineWorker，也不是在主线程 await 一个 Promise 冒充隔离。
 * - 子线程脚本必须在运行时落到磁盘再启动，这与生产「bundle 内联、运行时落地」的形态一致，避免只验证测试环境特例。
 * - 主线程心跳探针只记录定时器实际迟到量：同步长任务期间定时器排不上队，迟到量就是可观测的阻塞量级。
 * - 探针必须先能检出人为注入的 300 ms 长任务，否则它给出的「不阻塞」读数没有意义。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

/** 心跳间隔；迟到量按这个间隔的到期时间计算，不在迟到回调里重设起点。 */
export const HEARTBEAT_INTERVAL_MS = 10;

/** 子线程任务。 */
export type ThreadTask =
	| { kind: 'identity' }
	| { kind: 'json-commit'; docs: number; dims: number };

/** 主线程阻塞样本。 */
export interface StallSample {
	/** 最长一次心跳迟到量（毫秒）。 */
	maxGapMs: number;
	/** 迟到量的 95 分位（毫秒）。 */
	p95GapMs: number;
	/** 采样次数。 */
	samples: number;
}

/** 子线程执行结果。 */
export interface ThreadRunResult {
	threadId: number;
	isMainThread: boolean;
	bytes?: number;
	docs?: number;
}

/**
 * 子线程脚本源码 —— CommonJS，避免依赖包的 `"type": "module"` 与扩展名推断。
 * 生产侧同理：bundle 内联成字符串，运行时写入插件目录再启动。
 */
const WORKER_SOURCE = String.raw`
const { parentPort, workerData, threadId, isMainThread } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');

/** 确定性向量替身：不访问模型，只占体积。 */
function buildDocuments(count, dims) {
	const documents = [];
	for (let i = 0; i < count; i += 1) {
		const vector = new Array(dims);
		for (let j = 0; j < dims; j += 1) vector[j] = ((i * 31 + j * 17) % 1000) / 1000;
		documents.push({ path: 'note-' + i + '.md', vector });
	}
	return documents;
}

/** 与生产同形态的整库 JSON 提交：序列化后一次写入并 fsync。 */
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

async function run() {
	const task = workerData.task;
	if (task.kind === 'identity') return { threadId, isMainThread };
	if (task.kind === 'json-commit') {
		const committed = commitJson(workerData.dir, task.docs, task.dims);
		return { threadId, isMainThread, ...committed };
	}
	throw new Error('unknown task: ' + task.kind);
}

run().then(
	(result) => parentPort.postMessage({ ok: true, result }),
	(error) => parentPort.postMessage({ ok: false, error: String((error && error.message) || error) }),
);
`;

/** 在真实子线程执行任务；用完即终止，避免悬挂线程。 */
export async function runInChildThread(task: ThreadTask): Promise<ThreadRunResult> {
	const dir = await mkdtemp(join(tmpdir(), 'ratel-index-thread-'));
	const script = join(dir, 'worker.cjs');
	await writeFile(script, WORKER_SOURCE, 'utf8');
	const worker = new Worker(script, { workerData: { task, dir } });
	try {
		return await new Promise<ThreadRunResult>((resolve, reject) => {
			worker.once('message', (message: { ok: boolean; result?: ThreadRunResult; error?: string }) => {
				if (message.ok && message.result) resolve(message.result);
				else reject(new Error(message.error ?? '子线程执行失败'));
			});
			worker.once('error', reject);
			worker.once('exit', (code) => {
				if (code !== 0) reject(new Error(`子线程退出码 ${code}`));
			});
		});
	} finally {
		await worker.terminate();
		await rm(dir, { recursive: true, force: true });
	}
}

/** 主线程对照：同样的整库 JSON 提交直接在界面线程执行。 */
export function commitJsonOnMainThread(docs: number, dims: number): { bytes: number; docs: number } {
	const documents: Array<{ path: string; vector: number[] }> = [];
	for (let i = 0; i < docs; i += 1) {
		const vector = new Array<number>(dims);
		for (let j = 0; j < dims; j += 1) vector[j] = ((i * 31 + j * 17) % 1000) / 1000;
		documents.push({ path: `note-${i}.md`, vector });
	}
	// 只保留序列化成本：写盘由子线程对照覆盖，避免主线程对照组依赖磁盘速度。
	const text = JSON.stringify({ version: 1, items: documents });
	return { bytes: Buffer.byteLength(text), docs: documents.length };
}

/** 统计迟到量。 */
function summarize(gaps: number[]): StallSample {
	const sorted = [...gaps].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
	return {
		maxGapMs: sorted.length > 0 ? sorted[sorted.length - 1]! : 0,
		p95GapMs: sorted.length > 0 ? sorted[index]! : 0,
		samples: sorted.length,
	};
}

/**
 * 测量 `run` 执行期间主线程的心跳迟到量。
 * 定时器按固定间隔重复；迟到量 = 本次实际触发时刻 − 上次预定到期时刻。
 */
export async function measureMainThreadStall(
	run: () => Promise<unknown> | unknown,
	intervalMs: number = HEARTBEAT_INTERVAL_MS,
): Promise<{ stall: StallSample; value: unknown }> {
	const gaps: number[] = [];
	let deadline = performance.now() + intervalMs;
	const timer = setInterval(() => {
		const now = performance.now();
		gaps.push(now - deadline);
		deadline = now + intervalMs;
	}, intervalMs);
	try {
		const value = await run();
		// 关键路径:同步长任务期间心跳只能排队;若结束时立刻清除,那一次迟到永远记不到。
		// 让出一个宏任务,使已到期的心跳先执行并记录迟到量,再停表。
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		return { stall: summarize(gaps), value };
	} finally {
		clearInterval(timer);
	}
}

/** 探针自检：人为注入一段同步忙等，必须被如实记录。 */
export async function probeSelfCheck(busyMs: number): Promise<StallSample> {
	const { stall } = await measureMainThreadStall(() => {
		const until = performance.now() + busyMs;
		while (performance.now() < until) {
			// 故意占用主线程。
		}
	});
	return stall;
}
