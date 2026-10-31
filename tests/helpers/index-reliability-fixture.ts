/**
 * @file tests/helpers/index-reliability-fixture.ts
 * @description 索引可靠性实验夹具 — 临时工作区、确定性假嵌入、可计数可故障的原子文件存储
 * @module tests/helpers/index-reliability-fixture
 * @depends vectra, node:fs, node:os, node:path, src/ports/embedding, src/worker/chunker, src/adapters/vector-vectra
 *
 * 关键路径:
 * - 本夹具不改动 `src/` 生产路径;T1 起复用其中的临时目录、确定性嵌入与写入计数能力,
 *   T8 的崩溃/规模测试复用同一份工作区与合成数据。
 * - 所有磁盘操作都落在系统临时目录,测试结束由调用方 `dispose()` 清理,不触碰真实 Vault。
 * - 枚举一律走 vectra 公开的 `listItems()` / `listItemsByMetadata()`,不用相似度查询做删除枚举。
 */

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalDocumentIndex, LocalFileStorage } from 'vectra';
import type {
	DocumentChunkMetadata,
	EmbeddingsModel,
	FileDetails,
	FileStorage,
	ListFilesFilter,
	MetadataTypes,
} from 'vectra';
import type { EmbeddingPort } from '../../src/ports/embedding';
import type { ChunkOptions } from '../../src/worker/chunker';
import type { VectraStore } from '../../src/adapters/vector-vectra';

// ---------------------------------------------------------------------------
// 临时工作区
// ---------------------------------------------------------------------------

/** 系统临时目录下的独立工作区;`dispose()` 递归删除,测试不得留下残留。 */
export interface TempWorkspace {
	/** 工作区根目录(绝对路径)。 */
	readonly root: string;
	/** 在工作区内创建子目录并返回绝对路径。 */
	mkdir(name: string): string;
	/** 递归删除整个工作区;重复调用安全。 */
	dispose(): void;
}

/**
 * 创建系统临时目录下的工作区。
 *
 * @param prefix - 目录前缀,便于在 `/tmp` 里定位残留。
 * @returns 工作区句柄。
 */
export function createTempWorkspace(prefix = 'ratel-t0-'): TempWorkspace {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	return {
		root,
		mkdir(name: string): string {
			const dir = path.join(root, name);
			fs.mkdirSync(dir, { recursive: true });
			return dir;
		},
		dispose(): void {
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}

// ---------------------------------------------------------------------------
// 确定性假嵌入
// ---------------------------------------------------------------------------

/**
 * 由文本内容确定性地生成向量 — 同一文本永远得到同一向量,便于重复实验与跨运行比较。
 *
 * 关键路径:用 FNV-1a 哈希播种,再用线性同余生成器逐维取值,最后归一化;
 * 不依赖 `Math.random()`,不读网络、不加载模型。
 *
 * @param text - 嵌入输入文本。
 * @param dimensions - 向量维度(实验用 512 / 768 等)。
 * @returns 长度等于 `dimensions` 的确定性向量。
 */
export function deterministicVector(text: string, dimensions: number): number[] {
	let seed = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		seed ^= text.charCodeAt(i);
		seed = Math.imul(seed, 0x01000193) >>> 0;
	}
	// 关键路径:线性同余生成器(数值取自 Numerical Recipes),保证跨平台一致。
	let state = seed === 0 ? 0x9e3779b9 : seed;
	const vector: number[] = new Array<number>(dimensions);
	let sumOfSquares = 0;
	for (let i = 0; i < dimensions; i++) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		const value = (state / 0xffffffff) * 2 - 1;
		vector[i] = value;
		sumOfSquares += value * value;
	}
	const norm = Math.sqrt(sumOfSquares);
	for (let i = 0; i < dimensions; i++) {
		vector[i] = (vector[i] ?? 0) / norm;
	}
	return vector;
}

/** 假嵌入端口:可计数、可注入失败,模拟推理阶段异常。 */
export interface FakeEmbeddingPortOptions {
	/**
	 * 文本匹配该正则时抛错,用于复现「推理失败」。
	 *
	 * 关键路径:只接受无 `g` / `y` 标志的正则 —— 这两类标志让 `RegExp.test` 保留
	 * `lastIndex`,连续调用同一正则的结果会随调用顺序漂移,故障注入随之变成非确定性。
	 */
	failWhenTextMatches?: RegExp;
	/** 第 N 次 `embed` 调用(从 1 开始)抛错。 */
	failOnCall?: number;
}

/** `EmbeddingPort` 的确定性假实现。 */
export class FakeEmbeddingPort implements EmbeddingPort {
	readonly dimensions: number;
	readonly modelId = 'test:deterministic';
	/** `embed` 被调用次数。 */
	callCount = 0;
	/** 累计编码的文本条数。 */
	textCount = 0;
	private readonly options: FakeEmbeddingPortOptions;

	constructor(dimensions: number, options: FakeEmbeddingPortOptions = {}) {
		this.dimensions = dimensions;
		// 关键路径:带 g / y 标志的正则在 `test` 上保留 lastIndex,会让故障注入依赖调用顺序;
		// 这里直接拒绝,而不是在每个调用点补救。
		if (options.failWhenTextMatches?.global || options.failWhenTextMatches?.sticky) {
			throw new Error('failWhenTextMatches 不允许带 g / y 标志:RegExp.test 的 lastIndex 会让注入非确定性');
		}
		this.options = options;
	}

	async embed(texts: string[]): Promise<number[][]> {
		this.callCount++;
		if (this.options.failOnCall !== undefined && this.callCount === this.options.failOnCall) {
			throw new Error('注入故障:嵌入调用失败');
		}
		// 关键路径:先取局部变量再判空,避免在回调里用非空断言绕过类型收窄。
		const matcher = this.options.failWhenTextMatches;
		if (matcher) {
			// 防御:即使调用方之后改写了正则对象,也从干净状态开始匹配。
			matcher.lastIndex = 0;
			if (texts.some((text) => matcher.test(text))) {
				throw new Error('注入故障:嵌入文本命中失败规则');
			}
		}
		this.textCount += texts.length;
		return texts.map((text) => deterministicVector(text, this.dimensions));
	}
}

// ---------------------------------------------------------------------------
// 可计数、可注入故障的原子文件存储
// ---------------------------------------------------------------------------

/** 单次 `upsertFile` 的观测记录。 */
export interface StorageWriteEvent {
	/** 目标文件绝对路径。 */
	path: string;
	/** 写入内容字节数。 */
	bytes: number;
	/** 文件分类:索引文件 / 目录 catalog / 外置 metadata / 其他。 */
	kind: 'index' | 'catalog' | 'metadata' | 'other';
	/** 结束状态。 */
	outcome: 'renamed' | 'failed-before-rename' | 'failed-after-rename';
}

/** 故障注入模式。 */
export type AtomicStorageFailure = 'none' | 'before-write' | 'after-rename';

/** 原子存储薄封装选项。 */
export interface AtomicTestFileStorageOptions {
	/** 只对匹配的路径注入故障;默认只对索引文件注入。 */
	failOn?: (filePath: string) => boolean;
	/** 故障模式,默认不注入。 */
	failure?: AtomicStorageFailure;
	/** 每次 `upsertFile` 结束后回调,用于观测落盘时机。 */
	onWrite?: (event: StorageWriteEvent) => void;
	/**
	 * 是否在 rename 前执行文件 `fsync`,默认开启。
	 * 关键路径:仅在统计写入量/字节数的基准里关闭,以贴近生产 `writeFile` 的开销;
	 * 关闭后不再具备掉电耐久性,不能用于原子性验证。
	 */
	fsync?: boolean;
}

/**
 * `LocalFileStorage` 的薄封装 — 只覆盖 `upsertFile` 的原子替换。
 *
 * 关键路径(T0 实验范围):
 * 1. 同目录创建唯一临时文件(`wx` 排他创建,避免覆盖别人的临时文件);
 * 2. 写入 → 文件 `sync()` → 关闭;
 * 3. 同目录 `rename` 覆盖目标文件;
 * 4. 失败时清理临时文件,且不遮蔽原错误。
 *
 * 其余 `FileStorage` 方法直接委托给内层 `LocalFileStorage`,不做额外语义。
 */
export class AtomicTestFileStorage implements FileStorage {
	private readonly inner: LocalFileStorage;
	private readonly options: AtomicTestFileStorageOptions;
	/** 所有写入观测记录(含失败)。 */
	readonly writes: StorageWriteEvent[] = [];
	private sequence = 0;

	constructor(options: AtomicTestFileStorageOptions = {}) {
		// 关键路径:vectra 传给 storage 的始终是绝对路径,因此内层不能设置 rootFolder —
		// `LocalFileStorage` 会用 `path.join(root, 绝对路径)` 把绝对路径二次拼接成错误路径。
		this.inner = new LocalFileStorage();
		this.options = options;
	}

	/** 索引文件的写入次数。 */
	indexWriteCount(): number {
		return this.writes.filter((write) => write.kind === 'index').length;
	}

	/** 索引文件的累计写入字节数。 */
	indexWriteBytes(): number {
		return this.writes
			.filter((write) => write.kind === 'index')
			.reduce((sum, write) => sum + write.bytes, 0);
	}

	/** 全部写入的累计字节数。 */
	totalWriteBytes(): number {
		return this.writes.reduce((sum, write) => sum + write.bytes, 0);
	}

	createFile(filePath: string, content: Buffer | string): Promise<void> {
		return this.inner.createFile(filePath, content);
	}

	createFolder(folderPath: string): Promise<void> {
		return this.inner.createFolder(folderPath);
	}

	deleteFile(filePath: string): Promise<void> {
		return this.inner.deleteFile(filePath);
	}

	deleteFolder(folderPath: string): Promise<void> {
		return this.inner.deleteFolder(folderPath);
	}

	getDetails(fileOrFolderPath: string): Promise<FileDetails> {
		return this.inner.getDetails(fileOrFolderPath);
	}

	listFiles(folderPath: string, filter?: ListFilesFilter): Promise<FileDetails[]> {
		return this.inner.listFiles(folderPath, filter);
	}

	pathExists(fileOrFolderPath: string): Promise<boolean> {
		return this.inner.pathExists(fileOrFolderPath);
	}

	readFile(filePath: string): Promise<Buffer> {
		return this.inner.readFile(filePath);
	}

	async upsertFile(filePath: string, content: Buffer | string): Promise<void> {
		const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
		const kind = classifyStoragePath(filePath);
		const shouldFail = this.options.failOn ? this.options.failOn(filePath) : kind === 'index';
		const failure = this.options.failure ?? 'none';

		if (shouldFail && failure === 'before-write') {
			this.record({ path: filePath, bytes: buffer.byteLength, kind, outcome: 'failed-before-rename' });
			throw new Error(`注入故障:写入临时文件前失败(${path.basename(filePath)})`);
		}

		// 关键路径:临时文件与目标同目录,保证 rename 是同文件系统内的原子替换。
		const tempPath = `${filePath}.tmp-${process.pid}-${++this.sequence}-${Date.now().toString(36)}`;
		let renamed = false;
		try {
			const handle = await fsp.open(tempPath, 'wx');
			try {
				await handle.writeFile(buffer);
				if (this.options.fsync !== false) await handle.sync();
			} finally {
				await handle.close();
			}
			await fsp.rename(tempPath, filePath);
			renamed = true;
		} catch (err) {
			// 关键路径:清理临时文件失败不能遮蔽原错误。
			if (!renamed) {
				await fsp.rm(tempPath, { force: true }).catch(() => undefined);
			}
			this.record({ path: filePath, bytes: buffer.byteLength, kind, outcome: 'failed-before-rename' });
			throw err;
		}

		const afterRenameFailure = shouldFail && failure === 'after-rename';
		this.record({
			path: filePath,
			bytes: buffer.byteLength,
			kind,
			outcome: afterRenameFailure ? 'failed-after-rename' : 'renamed',
		});
		if (afterRenameFailure) {
			throw new Error(`注入故障:rename 完成后失败(${path.basename(filePath)})`);
		}
	}

	private record(event: StorageWriteEvent): void {
		this.writes.push(event);
		this.options.onWrite?.(event);
	}
}

/**
 * 按文件名给写入分类 — 只用于观测统计,不参与任何持久化决策。
 *
 * @param filePath - 写入目标路径。
 * @returns 分类标签。
 */
function classifyStoragePath(filePath: string): StorageWriteEvent['kind'] {
	const name = path.basename(filePath);
	if (name === 'index.json') return 'index';
	if (name === 'catalog.json') return 'catalog';
	// 关键路径:vectra 的外置 metadata 文件是 `<uuid>.json`,与索引同目录。
	if (/^[0-9a-f-]{36}\.json$/i.test(name)) return 'metadata';
	return 'other';
}

// ---------------------------------------------------------------------------
// 索引与块枚举
// ---------------------------------------------------------------------------

/** 创建索引时的附加选项。 */
export interface CreateDocumentIndexOptions {
	/** 索引目录(绝对路径)。 */
	folderPath: string;
	/** 嵌入模型;只做 upsertItem 时可省略。 */
	embeddings?: EmbeddingsModel;
	/** 注入的文件存储,用于验证原子替换。 */
	storage?: FileStorage;
	/** 声明为外置 metadata 的键;不传则 metadata 全部内联在 index.json。 */
	indexedMetadataKeys?: string[];
}

/**
 * 通过公开配置构造 `LocalDocumentIndex`,必要时创建索引文件。
 *
 * @param options - 索引目录、嵌入模型、存储与 metadata 配置。
 * @returns 已就绪的索引实例。
 */
export async function createDocumentIndex(options: CreateDocumentIndexOptions): Promise<LocalDocumentIndex> {
	const index = new LocalDocumentIndex({
		folderPath: options.folderPath,
		embeddings: options.embeddings,
		storage: options.storage,
	});
	if (!(await index.isIndexCreated())) {
		await index.createIndex({
			version: 1,
			metadata_config: options.indexedMetadataKeys ? { indexed: options.indexedMetadataKeys } : {},
		});
	}
	return index;
}

/** 块 metadata 的形状 — 继承 vectra 必填字段,再补生产代码写入的字段。 */
export interface BlockMetadata extends DocumentChunkMetadata {
	path: string;
	chunkIndex: number;
	startOffset: number;
}

/**
 * 构造一条块的 metadata。
 *
 * 关键路径:`DocumentChunkMetadata` 要求 `documentId` / `startPos` / `endPos`,
 * 生产代码(`VectraStore.upsertItem`)用双重断言绕过;这里显式填齐,测试保持类型安全。
 *
 * @param filePath - 业务路径,同时作为 `documentId`。
 * @param chunkIndex - 块序号。
 * @param extra - 额外 metadata(如 `commitId`)。
 * @returns 完整的块 metadata。
 */
export function blockMetadata(
	filePath: string,
	chunkIndex: number,
	extra: Record<string, MetadataTypes> = {},
): BlockMetadata {
	return {
		documentId: filePath,
		path: filePath,
		chunkIndex,
		startPos: chunkIndex * 100,
		endPos: chunkIndex * 100 + 50,
		startOffset: chunkIndex * 100,
		...extra,
	};
}

/**
 * 在单个事务里播种指定文件的若干块。
 *
 * @param index - 目标索引。
 * @param filePath - 业务路径(写入 `metadata.path`)。
 * @param count - 块数量。
 * @param dimensions - 向量维度。
 * @param options.commitId - 可选提交标识,写入 `metadata.commitId`。
 * @returns 播种的块 ID 列表。
 */
export async function seedBlocks(
	index: LocalDocumentIndex,
	filePath: string,
	count: number,
	dimensions: number,
	options: { commitId?: string } = {},
): Promise<string[]> {
	const ids: string[] = [];
	await index.beginUpdate();
	try {
		for (let i = 0; i < count; i++) {
			const id = `${filePath}#chunk-${i}`;
			await index.upsertItem({
				id,
				vector: deterministicVector(`${filePath}#${i}`, dimensions),
				metadata: blockMetadata(filePath, i, options.commitId ? { commitId: options.commitId } : {}),
			});
			ids.push(id);
		}
		await index.endUpdate();
	} catch (err) {
		index.cancelUpdate();
		throw err;
	}
	return ids;
}

/**
 * 生成某文件按生产约定命名的块 ID 序列(`<path>#chunk-<i>`)。
 *
 * 关键路径:块 ID 是判断「替换的是同一批块」的唯一依据 —— 只比数量时,
 * 旧块残留与新块写入会互相抵消,断言仍然通过。
 *
 * @param filePath - 业务路径。
 * @param count - 块数量。
 * @returns 从 `#chunk-0` 开始的 ID 列表。
 */
export function chunkIdsFor(filePath: string, count: number): string[] {
	return Array.from({ length: count }, (_unused, index) => `${filePath}#chunk-${index}`);
}

/**
 * 通过 `VectraStore` 的公开事务接口播种块(生产写入路径,不直接操作索引实例)。
 *
 * @param store - 目标存储。
 * @param filePath - 业务路径(写入 `metadata.path`)。
 * @param count - 块数量。
 * @param dimensions - 向量维度。
 * @returns 播种的块 ID 列表。
 */
export async function seedStoreBlocks(
	store: VectraStore,
	filePath: string,
	count: number,
	dimensions: number,
): Promise<string[]> {
	const ids = chunkIdsFor(filePath, count);
	await store.beginFileUpdate();
	try {
		for (const [index, id] of ids.entries()) {
			await store.upsertItem(id, deterministicVector(`${filePath}#${index}`, dimensions), {
				path: filePath,
				chunkIndex: index,
				startOffset: index * 10,
			});
		}
		await store.endFileUpdate();
	} catch (err) {
		await store.cancelFileUpdate();
		throw err;
	}
	return ids;
}

/**
 * 用完整条目枚举取出目标路径的全部块 ID。
 *
 * 关键路径:`listItems()` 返回索引全部条目,按 `metadata.path` 过滤即得该文件全部块;
 * 不依赖相似度、不受 topK 限制,也不使用任何私有字段。
 *
 * @param index - 目标索引。
 * @param filePath - 业务路径。
 * @returns 块 ID 列表。
 */
export async function listBlockIds(index: LocalDocumentIndex, filePath: string): Promise<string[]> {
	const items = await index.listItems();
	return items
		.filter((item) => (item.metadata as { path?: string }).path === filePath)
		.map((item) => item.id);
}

/**
 * 用 metadata 过滤器枚举目标路径的块 ID(`path` 必须是内联或被索引的键)。
 *
 * @param index - 目标索引。
 * @param filePath - 业务路径。
 * @returns 块 ID 列表。
 */
export async function listBlockIdsByMetadata(index: LocalDocumentIndex, filePath: string): Promise<string[]> {
	const items = await index.listItemsByMetadata({ path: filePath });
	return items.map((item) => item.id);
}

/**
 * 直接读取磁盘上的 `index.json` 并统计目标路径块数 — 独立于内存视图的磁盘真值。
 *
 * 关键路径:只解析公开的 JSON 持久化格式,不访问 vectra 私有字段;
 * 用于证明「endUpdate 是否已落盘」以及失败后的磁盘状态。
 *
 * @param folderPath - 索引目录。
 * @param filePath - 业务路径。
 * @returns 磁盘上的块 ID 列表。
 */
export async function readDiskBlockIds(folderPath: string, filePath: string): Promise<string[]> {
	const raw = await fsp.readFile(path.join(folderPath, 'index.json'), 'utf8');
	const data: unknown = JSON.parse(raw);
	if (!isIndexFileShape(data)) throw new Error('index.json 结构不符合预期');
	return data.items
		.filter((item) => item.metadata.path === filePath)
		.map((item) => item.id);
}

/** 磁盘 `index.json` 的原始字节数与内容摘要,用于证明「原文件保持」。 */
export async function readDiskIndexFile(folderPath: string): Promise<{ bytes: number; text: string }> {
	const buffer = await fsp.readFile(path.join(folderPath, 'index.json'));
	return { bytes: buffer.byteLength, text: buffer.toString('utf8') };
}

interface IndexFileShape {
	items: Array<{ id: string; metadata: { path?: string } }>;
}

/**
 * 校验磁盘 JSON 形状 — 用 `unknown` 收窄替代 `any`。
 *
 * @param value - `JSON.parse` 的结果。
 * @returns 是否为带 items 数组的索引文件。
 */
function isIndexFileShape(value: unknown): value is IndexFileShape {
	if (typeof value !== 'object' || value === null) return false;
	const items = (value as { items?: unknown }).items;
	if (!Array.isArray(items)) return false;
	return items.every((item) => {
		if (typeof item !== 'object' || item === null) return false;
		const candidate = item as { id?: unknown; metadata?: unknown };
		return typeof candidate.id === 'string' && typeof candidate.metadata === 'object' && candidate.metadata !== null;
	});
}

// ---------------------------------------------------------------------------
// 合成数据与分块配置
// ---------------------------------------------------------------------------

/** T0 固定分块配置:预算 100 字符、重叠 20 字符、字符数作为 token 上界。 */
export const T0_CHUNK_OPTIONS: ChunkOptions = {
	maxTokens: 100,
	overlapTokens: 20,
	count: (text: string) => text.length,
};

/**
 * 生成确定性的合成笔记 — 同样的 `count` 与 `seed` 永远得到同样的内容。
 *
 * @param count - 笔记数量。
 * @param options.seed - 内容种子,默认 `t0`。
 * @param options.paragraphs - 每篇段落数,默认 3(配合 T0 分块配置约 4~6 块)。
 * @returns 路径与正文列表。
 */
export function generateSyntheticNotes(
	count: number,
	options: { seed?: string; paragraphs?: number } = {},
): Array<{ path: string; content: string }> {
	const seed = options.seed ?? 't0';
	const paragraphs = options.paragraphs ?? 3;
	const notes: Array<{ path: string; content: string }> = [];
	for (let i = 0; i < count; i++) {
		const lines: string[] = [`# 合成笔记 ${i}`, ''];
		for (let p = 0; p < paragraphs; p++) {
			lines.push(`## 段落 ${p}`);
			lines.push(`这是第 ${i} 篇合成笔记的第 ${p} 段,用于索引可靠性实验。${seed}-${i}-${p}`);
			lines.push('');
		}
		notes.push({ path: `notes/note-${i}.md`, content: lines.join('\n') });
	}
	return notes;
}

/**
 * 把合成笔记写入临时磁盘,返回相对路径列表。
 *
 * @param root - 目标根目录(临时工作区内的 vault 目录)。
 * @param notes - 合成笔记。
 * @returns 相对路径列表,可直接作为 vault 端口的结果。
 */
export function writeNotesToDisk(
	root: string,
	notes: Array<{ path: string; content: string }>,
): string[] {
	const paths: string[] = [];
	for (const note of notes) {
		const fullPath = path.join(root, note.path);
		fs.mkdirSync(path.dirname(fullPath), { recursive: true });
		fs.writeFileSync(fullPath, note.content, 'utf8');
		paths.push(note.path);
	}
	return paths;
}

// ---------------------------------------------------------------------------
// 计时与内存采样
// ---------------------------------------------------------------------------

/** 内存采样结果(字节)。 */
export interface MemoryPeaks {
	peakHeapUsed: number;
	peakRss: number;
	peakExternal: number;
}

/**
 * 内存峰值采样器 — 固定间隔读取 `process.memoryUsage()`,记录峰值。
 *
 * 关键路径:采样间隔 20ms,短于该间隔的瞬时峰值可能漏采,报告中按「采样峰值」表述。
 */
export class MemorySampler {
	private readonly intervalMs: number;
	private timer: NodeJS.Timeout | null = null;
	private peaks: MemoryPeaks = { peakHeapUsed: 0, peakRss: 0, peakExternal: 0 };

	constructor(intervalMs = 20) {
		this.intervalMs = intervalMs;
	}

	/** 开始采样。 */
	start(): void {
		if (this.timer) return;
		this.sample();
		this.timer = setInterval(() => this.sample(), this.intervalMs);
		this.timer.unref();
	}

	/** 停止采样并返回峰值。 */
	stop(): MemoryPeaks {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.sample();
		return { ...this.peaks };
	}

	private sample(): void {
		const usage = process.memoryUsage();
		this.peaks.peakHeapUsed = Math.max(this.peaks.peakHeapUsed, usage.heapUsed);
		this.peaks.peakRss = Math.max(this.peaks.peakRss, usage.rss);
		this.peaks.peakExternal = Math.max(this.peaks.peakExternal, usage.external);
	}
}

/**
 * 把字节数格式化成便于阅读的文本。
 *
 * @param bytes - 字节数。
 * @returns 例如 `1.5 MiB`。
 */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KiB', 'MiB', 'GiB', 'TiB'];
	let value = bytes / 1024;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex++;
	}
	return `${value.toFixed(1)} ${units[unitIndex] ?? 'B'}`;
}

/**
 * 取数组的中位数(偶数个时取中间两数均值)。
 *
 * @param values - 数值列表。
 * @returns 中位数;空数组返回 0。
 */
export function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
	return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}
