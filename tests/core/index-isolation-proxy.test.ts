/**
 * @file tests/core/index-isolation-proxy.test.ts
 * @description 隔离代理 — 同一份索引工作放在独立线程后主线程迟到是否下降（默认跳过）
 * @module tests/core/index-isolation-proxy
 *
 * 关键路径:
 * - **这不是宿主读数。** Obsidian 里不能用 `worker_threads`,产品路径用的是 Blob Web Worker。
 *   本用例只是用 Node 的 worker 线程模拟「同一份工作放到另一个线程」,用来验证
 *   「工作搬走 → 主线程不再被卡」这个基本判断,给 T9 的流畅度提供方向性数字。
 * - 宿主内的正式读数必须由实验命令产出,不能拿本文件数字替代。
 * - 打开方式 `RATEL_ISOLATION=1`。
 */

import { afterAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { runIndexing } from '../../src/experiment/isolation-proxy-worker';

const ENABLED = process.env.RATEL_ISOLATION === '1';
const FILE_COUNT = Number.parseInt(process.env.RATEL_ISOLATION_FILES ?? '50', 10);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 采样事件循环迟到。 */
function startStallSampler(): { stop: () => { maxGapMs: number; p95GapMs: number; samples: number } } {
	let last = performance.now();
	const gaps: number[] = [];
	const timer = setInterval(() => {
		const now = performance.now();
		gaps.push(now - last);
		last = now;
	}, 1);
	return {
		stop: () => {
			clearInterval(timer);
			const sorted = [...gaps].sort((a, b) => a - b);
			const p95 = sorted[Math.max(0, Math.floor(sorted.length * 0.95) - 1)] ?? 0;
			return { maxGapMs: Math.max(0, ...gaps), p95GapMs: p95, samples: gaps.length };
		},
	};
}

const roots: string[] = [];
afterAll(async () => {
	for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

describe.skipIf(!ENABLED)('隔离代理对照', () => {
	it(`索引 ${FILE_COUNT} 篇 - 主线程内 vs 独立线程 - 记录主线程迟到`, { timeout: 600_000 }, async () => {
		// 1) 主线程内直接跑(对照)。
		const inlineRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'ratel-isolation-inline-'));
		roots.push(inlineRoot);
		const inlineSampler = startStallSampler();
		await runIndexing(inlineRoot, FILE_COUNT, 'inline-gen');
		const inline = inlineSampler.stop();

		// 2) 同一份工作放进 worker 线程(代理)。
		const workerRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'ratel-isolation-worker-'));
		roots.push(workerRoot);
		const outfile = path.join(workerRoot, 'isolation-proxy-worker.js');
		await build({
			entryPoints: [path.join(REPO_ROOT, 'src/experiment/isolation-proxy-worker.ts')],
			bundle: true,
			platform: 'node',
			format: 'cjs',
			target: 'es2021',
			outfile,
			logLevel: 'silent',
			external: ['node:worker_threads', 'node:fs/promises', 'node:fs', 'node:path', 'node:crypto', 'node:os'],
			// 与生产构建同一套替身:vectra 会尝试加载推理运行时,本代理不需要。
			alias: {
				'@huggingface/transformers': path.join(REPO_ROOT, 'src/adapters/empty-transformers.cjs'),
				'onnxruntime-node': path.join(REPO_ROOT, 'src/adapters/empty-module.cjs'),
				'onnxruntime-web': path.join(REPO_ROOT, 'src/adapters/empty-module.cjs'),
			},
		});
		const workerSampler = startStallSampler();
		await new Promise<void>((resolve, reject) => {
			const worker = new Worker(outfile, { workerData: { root: workerRoot, fileCount: FILE_COUNT } });
			worker.once('message', (message: { ok: boolean; error?: string }) => {
				if (message.ok) resolve();
				else reject(new Error(message.error ?? 'worker failed'));
			});
			worker.once('error', reject);
		});
		const worker = workerSampler.stop();

		console.info(
			`[隔离代理] 文件=${FILE_COUNT} 主线程内迟到 max=${inline.maxGapMs.toFixed(0)}ms p95=${inline.p95GapMs.toFixed(1)}ms | 独立线程迟到 max=${worker.maxGapMs.toFixed(0)}ms p95=${worker.p95GapMs.toFixed(1)}ms`,
		);
		// 关键路径:不做「线程一定更快」的断言 —— 实测在 50/300/800 篇三档都不稳定
		// (50 篇 10.2ms vs 13.8ms、800 篇 51ms vs 55ms),因为主线程在这条链路上主要在等异步 IO,
		// 真正的大块阻塞(整份索引序列化)要等索引规模更大才显现。这里的价值是给出方向性观察,
		// 不是证明;不能据此宣布流畅度已解决。
		expect(inline.samples).toBeGreaterThan(0);
		expect(worker.samples).toBeGreaterThan(0);
	});
});
