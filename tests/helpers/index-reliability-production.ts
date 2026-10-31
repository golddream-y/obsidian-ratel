/**
 * @file tests/helpers/index-reliability-production.ts
 * @description 合成 Vault 与生产索引链路装配 — T0 基线采集与 T8 崩溃/规模测试共用
 * @module tests/helpers/index-reliability-production
 * @depends src/adapters/vector-vectra, src/worker/inline-worker, src/worker/manager,
 *   src/core/persistent-index-backend, src/core/index-manager, src/core/index-manifest,
 *   tests/helpers/index-reliability-fixture
 *
 * 关键路径:
 * - 这里装配的是生产链路(`VectraStore` + `InlineWorker` + `PersistentIndexBackend` + `IndexManager`),
 *   与 `src/main.ts` 的启动顺序一致;不能用直接调用 `IndexProcessor` 冒充启动路径。
 * - vault 端口只读合成目录,不访问真实 Vault;所有磁盘写入落在调用方传入的临时索引目录。
 * - 清理统一放在 `dispose()` / `finally`:装配中途失败或 `onLayoutReady()` 抛错都不会残留
 *   worker 监听器与采样定时器。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { VectraStore } from '../../src/adapters/vector-vectra';
import { InlineWorker } from '../../src/worker/inline-worker';
import { WorkerManager } from '../../src/worker/manager';
import { PersistentIndexBackend } from '../../src/core/persistent-index-backend';
import { IndexManager } from '../../src/core/index-manager';
import { IndexManifest, resolveIndexManifestPath, CURRENT_CHUNKER_VERSION } from '../../src/core/index-manifest';
import type { ChunkOptions } from '../../src/worker/chunker';
import {
	FakeEmbeddingPort,
	MemorySampler,
	T0_CHUNK_OPTIONS,
	type MemoryPeaks,
} from './index-reliability-fixture';

/** 生产链路启动时需要注入的 vault 端口 — 只读合成目录。 */
export interface SyntheticVaultPort {
	listMarkdownFiles(): string[];
	readFile(filePath: string): Promise<string>;
	stat(filePath: string): { mtime: number } | null;
}

/**
 * 构造只读合成目录的 vault 端口。
 *
 * @param vaultDir - 合成笔记所在目录。
 * @param notePaths - 相对路径列表(同时作为 `listMarkdownFiles` 的返回值)。
 * @returns vault 端口。
 */
export function createSyntheticVault(vaultDir: string, notePaths: string[]): SyntheticVaultPort {
	return {
		listMarkdownFiles: () => [...notePaths],
		readFile: (filePath: string) => fsp.readFile(path.join(vaultDir, filePath), 'utf8'),
		stat: (filePath: string) => {
			try {
				return { mtime: fs.statSync(path.join(vaultDir, filePath)).mtimeMs };
			} catch {
				return null;
			}
		},
	};
}

/** 生产链路装配选项。 */
export interface ProductionIndexOptions {
	/** 合成笔记所在目录。 */
	vaultDir: string;
	/** 索引目录(临时目录内)。 */
	indexDir: string;
	/** 相对路径列表。 */
	notePaths: string[];
	/** 假嵌入维度。 */
	dimensions: number;
	/** 构建戳里的嵌入模型标识,默认 `test:deterministic`。 */
	modelId?: string;
	/** 分块参数,默认 T0 固定配置。 */
	chunkOptions?: ChunkOptions;
	/** 内存采样间隔(毫秒),默认 25。 */
	sampleIntervalMs?: number;
	/** Worker 请求超时(毫秒),默认 900000。 */
	timeoutMs?: number;
}

/** 生产链路一次启动的观测结果。 */
export interface ProductionRun {
	/** `onLayoutReady()` 的墙钟耗时(毫秒)。 */
	elapsedMs: number;
	/** 采样峰值内存。 */
	peaks: MemoryPeaks;
	/** 本次完成索引的文件数。 */
	indexed: number;
	/** 本次失败的文件数。 */
	errors: number;
	/** 嵌入端口被调用次数。 */
	embedCalls: number;
	/** 累计编码文本条数(近似块数)。 */
	embedTexts: number;
	/** 写入完成后的 `index.json` 字节数。 */
	indexBytes: number;
}

/** 已装配的生产链路 — 供需要自行控制启动/退出时机的测试复用。 */
export interface ProductionIndexStack {
	readonly store: VectraStore;
	readonly worker: WorkerManager;
	readonly backend: PersistentIndexBackend;
	readonly manager: IndexManager;
	readonly sampler: MemorySampler;
	/** 嵌入端口的实时计数。 */
	embeddingStats(): { calls: number; texts: number };
	/** 停止采样并销毁 worker;重复调用安全。 */
	dispose(): void;
}

/**
 * 装配生产索引链路(不启动索引)。
 *
 * 关键路径:构造失败时同步销毁已创建的 worker,避免监听器泄漏到后续用例。
 *
 * @param options - 装配选项。
 * @returns 已装配的链路句柄。
 */
export async function createProductionIndexStack(options: ProductionIndexOptions): Promise<ProductionIndexStack> {
	const port = new FakeEmbeddingPort(options.dimensions);
	const chunkOptions = options.chunkOptions ?? T0_CHUNK_OPTIONS;
	const modelId = options.modelId ?? 'test:deterministic';
	const store = new VectraStore(options.indexDir);
	await store.isIndexCreated();

	const inline = new InlineWorker();
	inline.initWithStore(store, port);
	const worker = new WorkerManager(inline, { timeoutMs: options.timeoutMs ?? 900_000 });
	let disposed = false;
	const sampler = new MemorySampler(options.sampleIntervalMs ?? 25);
	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		sampler.stop();
		worker.destroy();
	};

	try {
		const manifest = new IndexManifest(resolveIndexManifestPath(options.indexDir));
		const backend = new PersistentIndexBackend({
			indexDir: options.indexDir,
			manifest,
			worker,
			getStore: () => store,
			vault: createSyntheticVault(options.vaultDir, options.notePaths),
			getBuildStamp: () => ({
				chunkerVersion: CURRENT_CHUNKER_VERSION,
				chunkSize: chunkOptions.maxTokens,
				chunkOverlap: chunkOptions.overlapTokens,
				embedModelId: modelId,
			}),
			getChunkOptions: () => ({
				maxTokens: chunkOptions.maxTokens,
				overlapTokens: chunkOptions.overlapTokens,
			}),
		});
		const manager = new IndexManager(backend);
		sampler.start();
		return {
			store,
			worker,
			backend,
			manager,
			sampler,
			embeddingStats: () => ({ calls: port.callCount, texts: port.textCount }),
			dispose,
		};
	} catch (err) {
		dispose();
		throw err;
	}
}

/**
 * 用生产链路跑一次索引启动,并保证清理。
 *
 * 关键路径:`sampler.stop()` 与 `worker.destroy()` 必须在 `finally` 里 ——
 * `onLayoutReady()` 抛错时若不清理,采样定时器与 worker 监听器会跨用例残留。
 *
 * @param options - 装配选项。
 * @returns 耗时、内存峰值、完成数与写入后的索引文件大小。
 */
export async function runProductionIndex(options: ProductionIndexOptions): Promise<ProductionRun> {
	const stack = await createProductionIndexStack(options);
	try {
		const started = process.hrtime.bigint();
		const result = await stack.manager.onLayoutReady();
		const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
		// 关键路径:峰值在清理前取,否则最后一次采样发生在 worker 销毁之后。
		const peaks = stack.sampler.stop();
		if (!result) throw new Error('生产链路索引未完成:onLayoutReady 返回 null');
		const stats = stack.embeddingStats();
		return {
			elapsedMs,
			peaks,
			indexed: result.indexed,
			errors: result.errors,
			embedCalls: stats.calls,
			embedTexts: stats.texts,
			indexBytes: fs.statSync(path.join(options.indexDir, 'index.json')).size,
		};
	} finally {
		stack.dispose();
	}
}
