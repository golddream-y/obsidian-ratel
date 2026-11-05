/**
 * @file tests/helpers/index-reliability-scale.ts
 * @description 规模与性能验收夹具 — 计数原子存储、流式合成大库、负载读数、目录快照
 * @module tests/helpers/index-reliability-scale
 * @depends src/core/index-runtime-assembly, src/core/persistent-index-backend, src/core/index-manager,
 *   src/core/index-manifest, src/adapters/atomic-index-storage, src/adapters/vector-vectra,
 *   src/worker/chunker, tests/helpers/index-reliability-fixture
 *
 * 关键路径(T8 checkbox 2、4、5):
 * - 管线装配与 T8a 的崩溃夹具走**同一个生产入口** `setupWritableIndexRuntime`;
 *   本文件只在 `createStorage` 这一个 T1 接缝上换成计数实现,不复制生产接线。
 *   之所以另起一份而不是扩展 `index-crash-child.ts`:那边按崩溃阶段硬编码了
 *   `createStorage`,给它加参数会改动 T8a 已交付并被其证据文档引用的文件。
 * - 大库合成**流式落盘**:`generateAndWriteNotes` 逐个生成并直接写盘,只返回路径列表,
 *   不为全库构造正文数组(计划 checkbox 2 的显式约束)。
 * - 计数存储只累加**聚合计数**,不保存逐次写入事件数组 —— 3000 篇会产生上万次写入,
 *   保存事件数组本身就会把「内存有界」的断言变成被测对象的一部分。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { AtomicIndexStorage } from '../../src/adapters/atomic-index-storage';
import type { IndexVectorStore } from '../../src/adapters/vector-vectra-sharded';
import { PersistentIndexBackend } from '../../src/core/persistent-index-backend';
import { IndexManager } from '../../src/core/index-manager';
import { IndexManifest, resolveIndexManifestPath, CURRENT_CHUNKER_VERSION } from '../../src/core/index-manifest';
import { computeConfigFingerprint } from '../../src/core/index-persistence-types';
import type { IndexConfigDescriptor } from '../../src/core/index-persistence-types';
import type { IndexFileJournal } from '../../src/core/index-file-journal';
import type { IndexGenerations } from '../../src/core/index-generations';
import type { IndexTaskCoordinator, CoordinatorJournalPort, CoordinatorPrepareInput, CoordinatorCommitResult } from '../../src/core/index-task-coordinator';
import type { IndexWriteOwner } from '../../src/core/index-write-owner';
import { setupWritableIndexRuntime } from '../../src/core/index-runtime-assembly';
import type { EmbeddingPort, EmbedOptions } from '../../src/ports/embedding';
import { chunkMarkdown } from '../../src/worker/chunker';
import {
	FakeEmbeddingPort,
	T0_CHUNK_OPTIONS,
	deterministicVector,
} from './index-reliability-fixture';

// ---------------------------------------------------------------------------
// 负载读数
// ---------------------------------------------------------------------------

/** 一次负载采样 — 与性能读数一并记录,避免把带载数字当作门槛依据。 */
export interface LoadReading {
	/** 1 分钟平均负载。 */
	load1: number;
	/** 5 分钟平均负载。 */
	load5: number;
	/** 15 分钟平均负载。 */
	load15: number;
	/** 逻辑核数。 */
	cores: number;
	/** 采样时刻(ISO 8601)。 */
	at: string;
}

/**
 * 读取当前系统负载。
 *
 * 关键路径:负载必须与每个性能读数一起落表 —— 本机负载波动可达 8~100,
 * 不带负载的耗时数字无法判断是否满足「同一口径」。
 *
 * @returns 负载读数。
 */
export function readLoad(): LoadReading {
	const [load1 = 0, load5 = 0, load15 = 0] = os.loadavg();
	return {
		load1,
		load5,
		load15,
		cores: os.cpus().length,
		at: new Date().toISOString(),
	};
}

/** 把负载读数格式化成一行文本(用于日志与证据文档)。 */
export function formatLoad(load: LoadReading): string {
	return `load=${load.load1.toFixed(2)}/${load.load5.toFixed(2)}/${load.load15.toFixed(2)} cores=${load.cores}`;
}

/** 从一个 `hrtime.bigint()` 起点到现在的毫秒数。 */
export function elapsedMsSince(started: bigint): number {
	return Number(process.hrtime.bigint() - started) / 1e6;
}

// ---------------------------------------------------------------------------
// 计数原子存储
// ---------------------------------------------------------------------------

/** 写入分类 — 按代际根内的相对路径判定,不参与任何持久化决策。 */
export const SCALE_WRITE_KINDS = ['index', 'catalog', 'metadata', 'receipt', 'prepared', 'shard', 'other'] as const;

/** 写入分类。 */
export type ScaleWriteKind = (typeof SCALE_WRITE_KINDS)[number];

/** 单类写入的聚合计数。 */
export interface ScaleWriteTally {
	/** 写入次数(含失败)。 */
	count: number;
	/** 累计写入字节数(含失败)。 */
	bytes: number;
	/**
	 * 累计写入耗时(毫秒,含失败)。
	 *
	 * 关键路径:计划 checkbox 5 要求「逐文件重写大 JSON 的**累计字节数与耗时**」两项齐备。
	 * 只报总耗时与所有类别的平均单价无法把 `index.json` 的全量重写成本单列出来,
	 * 因此按类别(至少 `index` 一类)分别累计耗时。
	 */
	ms: number;
}

/** 写入计数快照。 */
export interface ScaleWriteCounters {
	/** 按分类的计数。 */
	byKind: Record<ScaleWriteKind, ScaleWriteTally>;
	/** 全部写入次数。 */
	totalCount: number;
	/** 全部写入字节数。 */
	totalBytes: number;
}

/**
 * 计数型原子存储 — `AtomicIndexStorage` 的子类,只增加观测与一次性故障注入。
 *
 * 关键路径:
 * - 生产装配注入的就是本类,因此「写入次数/字节数」来自**生产链路本身**,不是等价事务循环
 *   (T0 的写入量来自 `LocalDocumentIndex` + 等价循环,两者不得混为同一口径);
 * - 只累加聚合计数,不保存逐次事件 —— 上万次写入下保存事件数组会让「内存有界」失真;
 * - 故障注入是**一次性**的:匹配一次后自动失效,避免把所有后续写入都变成失败。
 */
export class ScaleCountingStorage extends AtomicIndexStorage {
	private readonly storageRoot: string;
	private readonly byKind: Record<ScaleWriteKind, ScaleWriteTally> = {
		index: { count: 0, bytes: 0, ms: 0 },
		catalog: { count: 0, bytes: 0, ms: 0 },
		metadata: { count: 0, bytes: 0, ms: 0 },
		receipt: { count: 0, bytes: 0, ms: 0 },
		prepared: { count: 0, bytes: 0, ms: 0 },
		shard: { count: 0, bytes: 0, ms: 0 },
		other: { count: 0, bytes: 0, ms: 0 },
	};
	private totalCount = 0;
	private totalBytes = 0;
	private upsertFailure: ((filePath: string) => boolean) | null = null;
	private upsertFailureCount = 0;
	/** 命中故障注入的路径(诊断用,数量有界)。 */
	readonly injectedFailures: string[] = [];

	constructor(generationRoot: string) {
		super({ generationRoot });
		this.storageRoot = path.resolve(generationRoot);
	}

	/** 写入计数快照(深拷贝,调用方改动不影响内部累计)。 */
	counters(): ScaleWriteCounters {
		const byKind = {} as Record<ScaleWriteKind, ScaleWriteTally>;
		for (const kind of SCALE_WRITE_KINDS) {
			byKind[kind] = { ...this.byKind[kind] };
		}
		return { byKind, totalCount: this.totalCount, totalBytes: this.totalBytes };
	}

	/** 清空计数(用于把「一次启动」的写入量与之前分离)。 */
	resetCounters(): void {
		for (const kind of SCALE_WRITE_KINDS) {
			this.byKind[kind].count = 0;
			this.byKind[kind].bytes = 0;
			this.byKind[kind].ms = 0;
		}
		this.totalCount = 0;
		this.totalBytes = 0;
	}

	/** 索引文件的写入次数 — 「每文件一次全量重写」的直接计量。 */
	indexWriteCount(): number {
		return this.byKind.index.count;
	}

	/** 索引文件的累计写入字节数。 */
	indexWriteBytes(): number {
		return this.byKind.index.bytes;
	}

	/** 索引文件(`index.json`)的累计写入耗时(毫秒)。 */
	indexWriteMs(): number {
		return this.byKind.index.ms;
	}

	/**
	 * 注入一次性写入失败:第一个匹配 `predicate` 的 `upsertFile` 抛错,之后失效。
	 *
	 * 关键路径:用于复现「向量已替换、完成记录未落盘」的中间态(完成记录写失败),
	 * 这是 T3 隔离区保留上一个版本事务的入口条件。
	 *
	 * @param predicate - 按绝对路径判定是否命中。
	 */
	failNextUpsert(predicate: (filePath: string) => boolean): void {
		this.upsertFailure = predicate;
	}

	/** 写入失败的注入次数。 */
	failureInjections(): number {
		return this.upsertFailureCount;
	}

	/** 把绝对路径归类为代际根内的相对路径。 */
	relative(filePath: string): string {
		return path.relative(this.storageRoot, path.resolve(filePath)).split(path.sep).join('/');
	}

	override async upsertFile(filePath: string, content: Buffer | string): Promise<void> {
		const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
		const kind = this.classify(filePath);
		const started = process.hrtime.bigint();
		this.byKind[kind].count += 1;
		this.byKind[kind].bytes += buffer.byteLength;
		this.totalCount += 1;
		this.totalBytes += buffer.byteLength;
		const failure = this.upsertFailure;
		if (failure !== null && failure(path.resolve(filePath))) {
			this.upsertFailure = null;
			this.upsertFailureCount += 1;
			if (this.injectedFailures.length < 16) this.injectedFailures.push(this.relative(filePath));
			this.byKind[kind].ms += elapsedMsSince(started);
			throw new Error(`注入故障:原子写入失败(${this.relative(filePath)})`);
		}
		try {
			await super.upsertFile(filePath, buffer);
		} finally {
			// 关键路径:耗时按「这一笔写入的等待时间」累计,失败的注入也照实计入(与 count/bytes 同口径)。
			this.byKind[kind].ms += elapsedMsSince(started);
		}
	}

	/** 按相对路径把写入归类 — 只用于观测统计。 */
	private classify(filePath: string): ScaleWriteKind {
		const relative = this.relative(filePath);
		const name = path.posix.basename(relative);
		if (relative === 'index.json') return 'index';
		if (relative === 'catalog.json') return 'catalog';
		if (/^[0-9a-f-]{36}\.json$/i.test(name)) return 'metadata';
		if (relative.startsWith('files/')) return 'receipt';
		if (relative.startsWith('pending/')) {
			return name === 'prepared.json' ? 'prepared' : 'shard';
		}
		return 'other';
	}
}

// ---------------------------------------------------------------------------
// 事务与并发边界(确定性计数)
// ---------------------------------------------------------------------------

/** 事务边界观测 — 在日志的状态转移点计数,不依赖任何定时采样。 */
export interface TransactionBoundaryObservations {
	/** 同时处于「已 prepare、未 commit/cleanup」状态的事务数最大值。 */
	maxInFlight: number;
	/** 同时处于 `prepare` 等待中的调用数最大值(确定性并界:`prepare` 本身不允许并发)。 */
	maxConcurrentPrepares: number;
	/** `prepare` 调用次数。 */
	prepareCount: number;
	/** `commit` 调用次数。 */
	commitCount: number;
	/** `cleanup` 调用次数。 */
	cleanupCount: number;
	/** 在转移点读磁盘核对 `pending/` 目录项的次数。 */
	pendingDirChecks: number;
	/** 转移点读到的 `pending/` 目录项最大值。 */
	maxPendingDirs: number;
	/**
	 * 「转移点磁盘 `pending/` 目录项数 ≠ 在途事务数」的次数。
	 *
	 * 关键路径:这是「未结算事务只保留活动文件」的**确定性**核对 ——
	 * 每个 prepare/commit/cleanup 边界都读一次磁盘真值,而不是 20ms 采样一次近似值。
	 */
	pendingDirMismatches: number;
}

/**
 * 边界计数日志 — 装饰生产日志,在每个事务状态转移点计数并读一次磁盘真值。
 *
 * 关键路径:
 * - 只观测、不改变语义:全部方法转发给底层日志,返回值原样透出;
 * - 计数点就是状态转移点(`prepare` 进入/返回、`commit` 返回或抛错、`cleanup` 同)——
 *   `maxInFlight` / `maxConcurrentPrepares` / `maxPendingDirs` 因此是**确定性**上界,
 *   不像定时采样那样依赖间隔与调度;
 * - 可选方法只在底层确实提供时才转发:在协调器口径里「缺失」表示不做该项核对,
 *   补一个空实现会把语义从「不核对」改成「核对通过」。
 */
export class BoundaryCountingJournal implements CoordinatorJournalPort {
	private readonly inner: CoordinatorJournalPort;
	/** 磁盘 `pending/` 目录项读取器;不提供时跳过磁盘核对(纯内存日志替身的场景)。 */
	private readonly pendingDirCount: (() => number) | null;
	private readonly inFlight = new Set<string>();
	private concurrentPrepares = 0;
	private readonly observation: TransactionBoundaryObservations = {
		maxInFlight: 0,
		maxConcurrentPrepares: 0,
		prepareCount: 0,
		commitCount: 0,
		cleanupCount: 0,
		pendingDirChecks: 0,
		maxPendingDirs: 0,
		pendingDirMismatches: 0,
	};
	/** 转发给底层日志(底层提供时才有值)。 */
	listReceipts?: CoordinatorJournalPort['listReceipts'];
	listPathStates?: CoordinatorJournalPort['listPathStates'];
	isGenerationQuarantined?: CoordinatorJournalPort['isGenerationQuarantined'];
	listTombstones?: CoordinatorJournalPort['listTombstones'];

	/**
	 * @param inner - 被装饰的日志端口(生产装配传入的是 `IndexFileJournal`)。
	 * @param pendingDirCount - 读磁盘 `pending/` 目录项数的函数(代际根由装配方绑定);
	 *   省略时不做磁盘核对(纯内存日志替身不落盘,读磁盘只会得到恒 0 的假结果)。
	 */
	constructor(inner: CoordinatorJournalPort, pendingDirCount?: () => number) {
		this.inner = inner;
		this.pendingDirCount = pendingDirCount ?? null;
		const listReceipts = inner.listReceipts;
		if (typeof listReceipts === 'function') this.listReceipts = () => listReceipts.call(inner);
		const listPathStates = inner.listPathStates;
		if (typeof listPathStates === 'function') this.listPathStates = () => listPathStates.call(inner);
		const isGenerationQuarantined = inner.isGenerationQuarantined;
		if (typeof isGenerationQuarantined === 'function') {
			this.isGenerationQuarantined = () => isGenerationQuarantined.call(inner);
		}
		const listTombstones = inner.listTombstones;
		if (typeof listTombstones === 'function') this.listTombstones = () => listTombstones.call(inner);
	}

	/** 观测快照(深拷贝)。 */
	observations(): TransactionBoundaryObservations {
		return { ...this.observation };
	}

	async prepare(input: CoordinatorPrepareInput): Promise<{ transactionId: string }> {
		this.concurrentPrepares += 1;
		this.observation.maxConcurrentPrepares = Math.max(
			this.observation.maxConcurrentPrepares,
			this.concurrentPrepares,
		);
		try {
			const prepared = await this.inner.prepare(input);
			this.observation.prepareCount += 1;
			this.inFlight.add(prepared.transactionId);
			this.observation.maxInFlight = Math.max(this.observation.maxInFlight, this.inFlight.size);
			this.checkPendingDirs();
			return prepared;
		} finally {
			this.concurrentPrepares -= 1;
		}
	}

	async commit(transactionId: string): Promise<CoordinatorCommitResult> {
		try {
			return await this.inner.commit(transactionId);
		} finally {
			this.observation.commitCount += 1;
			this.inFlight.delete(transactionId);
			this.checkPendingDirs();
		}
	}

	async cleanup(transactionId: string): Promise<void> {
		try {
			await this.inner.cleanup(transactionId);
		} finally {
			this.observation.cleanupCount += 1;
			this.inFlight.delete(transactionId);
			this.checkPendingDirs();
		}
	}

	readReceipt(path: string): ReturnType<CoordinatorJournalPort['readReceipt']> {
		return this.inner.readReceipt(path);
	}

	/** 在转移点读磁盘真值,核对「未结算事务数 == `pending/` 目录项数」。 */
	private checkPendingDirs(): void {
		const read = this.pendingDirCount;
		if (read === null) return;
		const onDisk = read();
		this.observation.pendingDirChecks += 1;
		this.observation.maxPendingDirs = Math.max(this.observation.maxPendingDirs, onDisk);
		if (onDisk !== this.inFlight.size) this.observation.pendingDirMismatches += 1;
	}
}

/**
 * 并发边界计数嵌入端口 — 在 `embed` 的进入/退出点计数,给出确定性并发上界。
 *
 * 关键路径:「同一时刻只有一个文件在准备/提交」这一条以前靠 20ms 采样 `counters().active`,
 * 采样永远只能给出下界;这里改在嵌入调用的进出点计数,`maxConcurrentEmbeds <= 1`
 * 是确定性结论。端口本身不改变嵌入行为与返回值。
 */
export class BoundaryCountingEmbedding implements EmbeddingPort {
	private readonly inner: EmbeddingPort;
	readonly modelId: string;
	readonly dimensions: number;
	private concurrent = 0;
	private maxConcurrent = 0;
	private calls = 0;

	constructor(inner: EmbeddingPort) {
		this.inner = inner;
		this.modelId = inner.modelId;
		this.dimensions = inner.dimensions;
	}

	async embed(texts: string[], options?: EmbedOptions): Promise<number[][]> {
		this.concurrent += 1;
		this.calls += 1;
		this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
		try {
			return await this.inner.embed(texts, options);
		} finally {
			this.concurrent -= 1;
		}
	}

	/** 观测快照:并发峰值与调用次数。 */
	observations(): { maxConcurrentEmbeds: number; embedCalls: number } {
		return { maxConcurrentEmbeds: this.maxConcurrent, embedCalls: this.calls };
	}
}

// ---------------------------------------------------------------------------
// 流式合成大库
// ---------------------------------------------------------------------------

/** 大库合成选项。 */
export interface ScaleNoteOptions {
	/** 每篇正文的目标字符数,默认 320(配合 T0 分块约 4~6 块)。 */
	bodyChars?: number;
	/** 内容种子,默认 `t8`。 */
	seed?: string;
}

/**
 * 逐个生成合成笔记并直接写盘,返回**只含路径**的列表。
 *
 * 关键路径:本函数不返回、也不累积正文数组 —— 计划 checkbox 2 明确要求
 * 「不得为全库预先构造正文数组」,规模用例的内存证据建立在「只有路径进内存」之上。
 * 正文按 `bodyChars` 确定性生成(`seed` + 序号),跨运行逐字节一致。
 *
 * @param vaultDir - 合成 Vault 根目录(绝对路径)。
 * @param count - 笔记数量。
 * @param options - 正文规模与种子。
 * @returns 相对路径列表(生成顺序,非字典序)。
 */
export function generateAndWriteNotes(vaultDir: string, count: number, options: ScaleNoteOptions = {}): string[] {
	const bodyChars = options.bodyChars ?? 320;
	const seed = options.seed ?? 't8';
	const paths: string[] = [];
	for (let i = 0; i < count; i++) {
		const relative = `notes/note-${i}.md`;
		writeNoteFile(vaultDir, relative, syntheticNoteContent(i, bodyChars, seed));
		paths.push(relative);
	}
	return paths;
}

/**
 * 构造一篇确定性合成笔记的正文。
 *
 * @param index - 笔记序号。
 * @param bodyChars - 目标正文长度(字符)。
 * @param seed - 内容种子。
 * @returns Markdown 正文。
 */
export function syntheticNoteContent(index: number, bodyChars: number, seed: string): string {
	const lines: string[] = [`# 合成笔记 ${index}`, ''];
	let written = 0;
	let paragraph = 0;
	while (written < bodyChars) {
		const line = `这是第 ${index} 篇合成笔记的第 ${paragraph} 段,种子 ${seed}-${index}-${paragraph},用于索引规模与写入行为验收。`;
		lines.push(line, '');
		written += line.length;
		paragraph += 1;
	}
	return lines.join('\n');
}

/**
 * 写单篇笔记到磁盘。
 *
 * @param vaultDir - Vault 根目录。
 * @param relative - 相对路径。
 * @param content - 正文。
 */
export function writeNoteFile(vaultDir: string, relative: string, content: string): void {
	const full = path.join(vaultDir, relative);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, 'utf8');
}

/**
 * 写一篇**超过 `chunkTarget` 块**的笔记,返回其相对路径。
 *
 * 关键路径:计划 checkbox 2 要求覆盖「一个超过 200 块的文件」;这里按给定分块器
 * 反复加长正文直到实测块数达标,而不是按字符数猜 —— 分块器是 Markdown 结构感知的,
 * 猜字符数会让「200 块」这个前提不成立。
 *
 * @param vaultDir - Vault 根目录。
 * @param relative - 相对路径。
 * @param chunkTarget - 目标块数下界(不含)。
 * @param options - 种子与单段长度。
 * @returns 实测块数。
 */
export function writeBigChunkNote(
	vaultDir: string,
	relative: string,
	chunkTarget: number,
	options: { seed?: string; paragraphChars?: number } = {},
): number {
	const seed = options.seed ?? 't8-big';
	const paragraphChars = options.paragraphChars ?? 96;
	let paragraphs = Math.ceil((chunkTarget * (T0_CHUNK_OPTIONS.maxTokens + 8)) / paragraphChars) + 8;
	for (let attempt = 0; attempt < 6; attempt++) {
		const paragraphsTotal = paragraphs + attempt * 16;
		const lines: string[] = ['# 超长合成笔记', ''];
		for (let p = 0; p < paragraphsTotal; p++) {
			lines.push(`## 段落 ${p}`);
			lines.push(`${seed}-${p}-`.padEnd(paragraphChars, '字形填充内容用于把这一节推到分块预算之上。'));
			lines.push('');
		}
		const content = lines.join('\n');
		const chunks = chunkMarkdown(content, T0_CHUNK_OPTIONS);
		if (chunks.length > chunkTarget) {
			writeNoteFile(vaultDir, relative, content);
			return chunks.length;
		}
	}
	throw new Error(`未能合成超过 ${chunkTarget} 块的笔记`);
}

// ---------------------------------------------------------------------------
// 目录快照
// ---------------------------------------------------------------------------

/** 单个文件的内容快照:字节数 + 内容摘要。 */
export interface FileContentSnapshot {
	/** 文件字节数。 */
	size: number;
	/** 文件内容的 sha256(十六进制)。 */
	digest: string;
}

/** 目录内容快照:相对路径 → 字节数与内容摘要。 */
export type DirectorySnapshot = Map<string, FileContentSnapshot>;

/**
 * 计数代际目录下 `pending/` 的子目录数(磁盘真值)。
 *
 * 关键路径:供事务边界观测在**每个状态转移点**核对「未结算事务数 == 磁盘目录项数」,
 * 不依赖定时采样。
 *
 * @param indexDir - 代际目录绝对路径。
 * @returns 子目录数;目录不存在时按 0。
 */
export function countPendingDirectories(indexDir: string): number {
	try {
		return fs
			.readdirSync(path.join(indexDir, 'pending'), { withFileTypes: true })
			.filter((entry) => entry.isDirectory()).length;
	} catch {
		return 0;
	}
}

/**
 * 递归快照目录内所有文件的内容(相对路径 → 字节数 + sha256)。
 *
 * 关键路径:本函数此前只记录**字节数**,却被表述成「逐字节比较」—— 字节数相同而内容不同
 * 会被漏判。这里对每个文件的完整内容算 sha256,`diffSnapshotContents` 因此是**按内容**的比对
 * (摘要碰撞在实际语料上不可达);字节数同时保留,便于区分「大小变化」与「等长内容变化」。
 * 快照只留摘要、不留正文,避免把被观测对象本身塞进内存。
 *
 * @param root - 目录绝对路径。
 * @returns 相对路径 → 字节数与内容摘要。
 */
export function snapshotDirectoryContents(root: string): DirectorySnapshot {
	const snapshot: DirectorySnapshot = new Map();
	const walk = (dir: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile()) {
				const content = fs.readFileSync(full);
				snapshot.set(path.relative(root, full).split(path.sep).join('/'), {
					size: content.byteLength,
					digest: createHash('sha256').update(content).digest('hex'),
				});
			}
		}
	};
	walk(root);
	return snapshot;
}

/** 两个目录内容快照的差异。 */
export interface DirectorySnapshotDiff {
	/** 新增的相对路径。 */
	added: string[];
	/** 删除的相对路径。 */
	removed: string[];
	/** 字节数相同但内容摘要不同的相对路径。 */
	changed: string[];
	/** 字节数不同的相对路径。 */
	resized: string[];
}

/**
 * 比较两个目录内容快照。
 *
 * @param before - 变更前快照。
 * @param after - 变更后快照。
 * @returns 新增/删除/等长内容变化/大小变化的相对路径。
 */
export function diffSnapshotContents(before: DirectorySnapshot, after: DirectorySnapshot): DirectorySnapshotDiff {
	const added: string[] = [];
	const removed: string[] = [];
	const changed: string[] = [];
	const resized: string[] = [];
	for (const [key, entry] of after) {
		const previous = before.get(key);
		if (previous === undefined) added.push(key);
		else if (previous.size !== entry.size) resized.push(key);
		else if (previous.digest !== entry.digest) changed.push(key);
	}
	for (const key of before.keys()) {
		if (!after.has(key)) removed.push(key);
	}
	return {
		added: added.sort(),
		removed: removed.sort(),
		changed: changed.sort(),
		resized: resized.sort(),
	};
}

// ---------------------------------------------------------------------------
// 生产管线装配(可注入计数存储)
// ---------------------------------------------------------------------------

/** 规模夹具的合成 Vault 端口。 */
export interface ScaleVaultPort {
	listMarkdownFiles(): string[];
	readFile(filePath: string): Promise<string>;
	stat(filePath: string): { mtime: number; size?: number } | null;
}

/** 读取计数 Vault 端口 — 在只读端口外加 `readFile` 调用计数(内存证据)。 */
export interface CountingVaultPort extends ScaleVaultPort {
	/** `readFile` 被调用次数(全部路径)。 */
	readCount(): number;
	/** 被读取过的不同路径数。 */
	distinctReadPaths(): number;
	/** 单个路径被读取的次数 — 用于断言「连续编辑不逐次重读」。 */
	readsFor(filePath: string): number;
}

/**
 * 构造带读取计数的只读合成 Vault 端口。
 *
 * 关键路径:端口只暴露**路径列表**与按需 `readFile`,不暴露任何正文集合 ——
 * 「不为全库预构造正文数组」在此处是结构性的,读取计数让「每篇只读一次」可核对。
 *
 * @param vaultDir - Vault 根目录绝对路径。
 * @param notePaths - 参与枚举的相对路径(可为动态函数,以支持运行期新增)。
 * @param onAccess - 每次 `readFile` / `stat` 的观测回调(确定性采样点,不是定时器)。
 * @returns 计数 Vault 端口。
 */
export function createCountingVault(
	vaultDir: string,
	notePaths: readonly string[] | (() => readonly string[]),
	onAccess?: (filePath: string) => void,
): CountingVaultPort {
	const paths = typeof notePaths === 'function' ? notePaths : () => notePaths;
	let reads = 0;
	const perPath = new Map<string, number>();
	return {
		listMarkdownFiles: () => [...paths()],
		readFile: (filePath: string) => {
			reads += 1;
			perPath.set(filePath, (perPath.get(filePath) ?? 0) + 1);
			onAccess?.(filePath);
			return fsp.readFile(path.join(vaultDir, filePath), 'utf8');
		},
		stat: (filePath: string) => {
			onAccess?.(filePath);
			try {
				const stat = fs.statSync(path.join(vaultDir, filePath));
				return { mtime: stat.mtimeMs, size: stat.size };
			} catch {
				return null;
			}
		},
		readCount: () => reads,
		distinctReadPaths: () => perPath.size,
		readsFor: (filePath: string) => perPath.get(filePath) ?? 0,
	};
}

/** 规模管线装配选项。 */
export interface ScaleHarnessOptions {
	/** 索引根 `.index/`(临时目录内的绝对路径)。 */
	indexRoot: string;
	/** 合成 Vault 根目录。 */
	vaultDir: string;
	/** 参与枚举的相对路径。 */
	notePaths: readonly string[] | (() => readonly string[]);
	/** 向量维度。 */
	dimensions: number;
	/** 嵌入端口;缺省用确定性假嵌入。 */
	embedding?: EmbeddingPort;
	/**
	 * 协调器步进观测回调 — 每次 vault `readFile` / `stat`(即处理流程里的固定位置)调用一次。
	 *
	 * 关键路径:观察点落在**控制流的固定位置**上,不是 20ms 定时器;同一份代码路径每次运行的
	 * 观测点序列一致,得到的计数因此可复现(定时采样只能给出下界)。
	 */
	onCoordinatorStep?: (filePath: string) => void;
}

/** 已装配的规模管线句柄。 */
export interface ScaleHarness {
	/** 代际目录(真实索引落盘处)。 */
	readonly indexDir: string;
	/** 代际标识。 */
	readonly generationId: string;
	readonly store: IndexVectorStore;
	readonly journal: IndexFileJournal;
	readonly coordinator: IndexTaskCoordinator;
	readonly generations: IndexGenerations;
	readonly lease: IndexWriteOwner;
	readonly manager: IndexManager;
	/** 计数原子存储(生产注入点)。 */
	readonly storage: ScaleCountingStorage;
	/** 事务边界计数日志(生产日志的装饰器;确定性计数点)。 */
	readonly journalBoundary: BoundaryCountingJournal;
	/** 嵌入并发边界计数端口(装饰调用方传入的嵌入端口)。 */
	readonly embeddingBoundary: BoundaryCountingEmbedding;
	/** 计数 Vault 端口。 */
	readonly vault: CountingVaultPort;
	/** 假嵌入端口的实时计数(自定义端口时不可用)。 */
	readonly embedding: EmbeddingPort;
	/** 跑一轮启动索引(与生产 `IndexController.onLayoutReady(true)` 同一路径)。 */
	run(): Promise<{ indexed: number; errors: number } | null>;
	/** 停止看护、销毁协调器并释放写所有权。 */
	dispose(): Promise<void>;
}

/** 夹具固定配置 — 与 `FakeEmbeddingPort` 的身份一致。 */
export function scaleConfig(dimensions: number): IndexConfigDescriptor {
	return {
		embeddingModelId: 'test:deterministic',
		embeddingModelRevision: null,
		embeddingDimension: dimensions,
		chunkerVersion: CURRENT_CHUNKER_VERSION,
		chunkSize: T0_CHUNK_OPTIONS.maxTokens,
		chunkOverlap: T0_CHUNK_OPTIONS.overlapTokens,
		embeddingTextVersion: null,
	};
}

/**
 * 装配规模管线 — 走生产入口 `setupWritableIndexRuntime`,只替换存储实现。
 *
 * 关键路径:
 * - 与 T8a 崩溃夹具同一入口,父/子与崩溃用例看到的是同一份生产装配;
 * - `createStorage` 注入计数实现,使写入次数/字节来自生产链路;
 * - 协调器模式不走 Worker 请求,给出最小替身避免依赖真实 `WorkerManager`;
 * - `fileRecords` / `getRoundCounters` 等端口与生产装配一致,保证单文件 durable 提交。
 *
 * @param options - 装配选项。
 * @returns 管线句柄。
 */
export async function assembleScaleHarness(options: ScaleHarnessOptions): Promise<ScaleHarness> {
	const config = scaleConfig(options.dimensions);
	const configFingerprint = await computeConfigFingerprint(config);
	const vault = createCountingVault(options.vaultDir, options.notePaths, options.onCoordinatorStep);
	const embedding = options.embedding ?? new FakeEmbeddingPort(options.dimensions);
	const embeddingBoundary = new BoundaryCountingEmbedding(embedding);
	// 关键路径:代际根要等装配完成才知道(生产装配把它落在 `indexRoot/generations/<id>/`)。
	// 事务边界观测用可变闭包延迟绑定真实代际目录;装配期的日志恢复不经过本装饰器
	// (`recoverIndexJournal` 用的是日志本体),因此不会在根绑定之前读错路径。
	let generationRootForBoundary: string | null = null;
	let journalBoundary: BoundaryCountingJournal | null = null;
	const storages: ScaleCountingStorage[] = [];
	const runtime = await setupWritableIndexRuntime({
		indexRoot: options.indexRoot,
		config,
		configFingerprint,
		vault,
		embedding: embeddingBoundary,
		getChunkOptions: () => T0_CHUNK_OPTIONS,
		chunkLimits: {
			chunkSize: T0_CHUNK_OPTIONS.maxTokens,
			chunkOverlap: T0_CHUNK_OPTIONS.overlapTokens,
		},
		expectedDimension: options.dimensions,
		// 关键路径:用装配层公开的 `wrapJournal` 接缝装饰生产日志 ——
		// 边界计数因此来自**生产链路本身**的调用序列,不需要在测试里重放事务。
		wrapJournal: (journal) => {
			const boundary = new BoundaryCountingJournal(journal, () =>
				generationRootForBoundary === null ? 0 : countPendingDirectories(generationRootForBoundary),
			);
			journalBoundary = boundary;
			return boundary;
		},
		createStorage: (root: string) => {
			const storage = new ScaleCountingStorage(root);
			storages.push(storage);
			return storage;
		},
	});
	generationRootForBoundary = runtime.indexDir;
	const boundary = journalBoundary;
	if (boundary === null) throw new Error('规模夹具:装配未经过日志包装接缝');
	const storage = storages[0];
	if (storage === undefined) throw new Error('规模夹具:未创建计数存储');
	const store = runtime.pipeline.store;
	// 关键路径:先把建库时的 index.json 落盘,使「文件事务的向量提交」与建库写入可区分。
	await store.init();
	const manifest = new IndexManifest(resolveIndexManifestPath(runtime.indexDir));
	const backend = new PersistentIndexBackend({
		indexDir: runtime.indexDir,
		manifest,
		worker: workerStub(),
		getStore: () => store,
		vault,
		getBuildStamp: () => ({
			chunkerVersion: CURRENT_CHUNKER_VERSION,
			chunkSize: T0_CHUNK_OPTIONS.maxTokens,
			chunkOverlap: T0_CHUNK_OPTIONS.overlapTokens,
			embedModelId: config.embeddingModelId,
		}),
		getChunkOptions: () => ({
			maxTokens: T0_CHUNK_OPTIONS.maxTokens,
			overlapTokens: T0_CHUNK_OPTIONS.overlapTokens,
		}),
		fileRecords: runtime.pipeline.journal,
		getRoundCounters: () => runtime.pipeline.coordinator.counters(),
		getEpoch: () => runtime.lease.epoch,
		getTaskId: () => String(runtime.pipeline.coordinator.counters().taskId ?? 0),
	});
	const manager = new IndexManager(backend, runtime.pipeline.coordinator);
	let disposed = false;
	return {
		indexDir: runtime.indexDir,
		generationId: runtime.generationId,
		store,
		journal: runtime.pipeline.journal,
		coordinator: runtime.pipeline.coordinator,
		generations: runtime.generations,
		lease: runtime.lease,
		manager,
		storage,
		journalBoundary: boundary,
		embeddingBoundary,
		vault,
		embedding,
		run: () => manager.onLayoutReady(),
		dispose: async () => {
			if (disposed) return;
			disposed = true;
			runtime.pipeline.stallWatchdog.stop();
			runtime.pipeline.coordinator.destroy();
			await runtime.lease.release();
			// 关键路径:给 vectra 内部未结算的落盘一次收敛窗口,避免临时目录删除与在途写竞争。
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
		},
	};
}

/** 协调器模式下不会走 Worker 请求;给出最小替身,避免夹具依赖真实 `WorkerManager`。 */
function workerStub(): import('../../src/worker/manager').WorkerManager {
	const notUsed = (): never => {
		throw new Error('规模夹具:协调器模式不应发出 Worker 请求');
	};
	return {
		runExclusive: <T>(operation: () => Promise<T>): Promise<T> => operation(),
		request: notUsed,
		clearProgressCallback: () => undefined,
		setProgressCallback: () => undefined,
		cancelIndex: () => false,
	} as unknown as import('../../src/worker/manager').WorkerManager;
}

// ---------------------------------------------------------------------------
// 块集合期望值
// ---------------------------------------------------------------------------

/**
 * 计算一份正文经同一分块器产出的块 ID 序列。
 *
 * 关键路径:块 ID 与 T2/T3 的生产约定一致(`<path>#chunk-<i>`);只比数量时
 * 「旧块残留 + 新块写入」会互相抵消,断言必须落到 ID 序列。
 *
 * @param filePath - 相对路径。
 * @param content - 正文。
 * @returns 块 ID 列表。
 */
export function expectedChunkIds(filePath: string, content: string): string[] {
	return chunkMarkdown(content, T0_CHUNK_OPTIONS).map((_chunk, index) => `${filePath}#chunk-${index}`);
}

/**
 * 用确定性假嵌入把正文转成可写入日志的块集合。
 *
 * @param filePath - 相对路径。
 * @param content - 正文。
 * @param dimensions - 向量维度。
 * @returns 块集合(不含 commitId,由日志统一补写)。
 */
export function blocksForContent(
	filePath: string,
	content: string,
	dimensions: number,
): Array<{ id: string; vector: number[]; metadata: Record<string, unknown> }> {
	return chunkMarkdown(content, T0_CHUNK_OPTIONS).map((chunk, index) => ({
		id: `${filePath}#chunk-${index}`,
		vector: deterministicVector(chunk.embedText, dimensions),
		metadata: { startOffset: chunk.startOffset },
	}));
}