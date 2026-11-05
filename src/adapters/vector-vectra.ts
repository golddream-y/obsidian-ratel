/**
 * @file src/adapters/vector-vectra.ts
 * @description vectra 包装层 — `VectorStore` 端口的具体实现(本地纯 JS 索引)
 * @module adapters/vector-vectra
 * @depends vectra, ports/vector, core/index-persistence-types
 *
 * 设计要点:
 * - 索引仅在首次调用时懒加载(参见 `ensureIndex`),允许冷启动阶段不触发磁盘 IO。
 * - 搜索按 `metadata.documentId` 聚合。当前契约下 `documentId` 是**块 ID**(`upsertItem` 与
 *   `replaceFile` 两条写入路径一致),因此返回的是 top-K 片段;文档级聚合是另行设计,不在当前契约内。
 * - 文件级替换(T2)通过完整枚举 + 单事务删除/插入实现:不再用零向量相似度查询枚举
 *   (T0 已证明它只返回索引数组前 100 项,与文件归属无关)。
 * - 提交失败后存储进入「需重载」状态,不再用旧内存缓存服务查询;调用方必须 `reload()`。
 *   失败时的磁盘状态由 T1 原子存储的 `getLastWriteOutcome` 判定,不能一律当作旧版。
 */

import path from 'node:path';
import type { VectorStore, VectorSearchResult, IndexStatus, SearchFilter } from '../ports/vector';
import { devLogger } from '../logging/dev-logger';
// 关键路径:通过 esbuild conditions 让 'vectra' 走 browser 入口,避免引入 index.js 里 re-export 的 server/grpc 依赖。
import {
	LocalDocumentIndex,
	type EmbeddingsModel,
	type DocumentChunkMetadata,
	type FileStorage,
	type MetadataTypes,
} from 'vectra';
import fs from 'fs';
import { tNow } from '../i18n';
import { assertSafeRecordPath, validateBlockSet } from '../core/index-persistence-types';
import type { AtomicWriteOutcome, AtomicWriteRecord } from './atomic-index-storage';

// ==================== 公共契约 ====================

/**
 * 一个待写入的块 — 由推理阶段准备好,持久化阶段原样替换。
 *
 * 关键路径:`metadata` 会带上 `commitId` 与 `path`;块 ID 由调用方保证在该文件内唯一。
 */
export interface PreparedBlock {
	/** 块 ID,生产约定为 `<path>#chunk-<index>`。 */
	id: string;
	/** 预计算向量;必须全部是有限数且同维度。 */
	vector: number[];
	/** 块元数据(路径、序号、偏移等)。 */
	metadata: Record<string, unknown>;
}

/** 一次文件级替换 — 目标路径、提交标识与完整新块集合。 */
export interface FileReplacement {
	/** vault 相对路径。 */
	path: string;
	/** 提交标识;写入该路径每个块的 metadata,供完成记录核对。 */
	commitId: string;
	/** 完整新块集合;空数组表示把该路径清空。 */
	blocks: PreparedBlock[];
}

/**
 * 文件级替换存储契约 — T2 的公共适配器方法,T3 起由日志/协调器调用。
 *
 * 关键路径:`replaceFile` 的删除与插入在同一个 `beginUpdate/endUpdate` 内完成,
 * 因此单文件提交只落盘一次;失败后必须 `reload()` 才能继续查询或写入。
 */
export interface FileReplaceStore {
	/** 用 `blocks` 完整替换 `path` 的全部块;`blocks` 为空时只删除。 */
	replaceFile(input: FileReplacement): Promise<void>;
	/** 完整枚举某个路径的当前块集合(不经过相似度查询)。 */
	inspectFile(path: string): Promise<PreparedBlock[]>;
	/**
	 * 可选:批量枚举多个路径的当前块集合 — 一次全量枚举后按 `metadata.path` 分组。
	 *
	 * 关键路径:`inspectFile` 逐条调用等于「路径数 × 总块数」的枚举代价;
	 * 迁移侧按清单逐文件核对时必须走批量入口。声明为可选是为了不强迫既有替身实现,
	 * 但 `VectraStore` 始终实现它 —— 调用方应对 `?` 缺省回退到逐条 `inspectFile`。
	 */
	inspectFiles?(paths: string[]): Promise<Map<string, PreparedBlock[]>>;
	/** 丢弃当前内存实例并重建,用于提交失败后核对磁盘真值。 */
	reload(): Promise<void>;
}

/**
 * 代际目录集合名 — 与 `core/index-generations` 的目录布局契约一致。
 *
 * 关键路径:这里只做只读判定,不引入代际模块的实现,避免适配器反向依赖编排层。
 */
const INDEX_GENERATIONS_DIRNAME = 'generations';
// 关键路径:分片布局的代际目录只有 shards/,没有根 index.json;形状白名单必须认它,
// 否则单份存储落在分片代际时会以 drop-refused 拒绝删除。
const INDEX_SHARDS_DIRNAME = 'shards';

/**
 * 代际目录名 — 由配置指纹派生(`gen-` + 16 位小写十六进制)。
 *
 * 关键路径:与 `core/index-generations` 的派生规则逐字一致;第 4 条守卫据此拒绝
 * `generations/` 树下的异形目录,使本适配器与后端的缺省判定条数一致。
 */
const INDEX_GENERATION_DIR_PATTERN = /^gen-[0-9a-f]{16}$/;

/** Vectra 索引文件 — 普通索引目录的标志性索引特征。 */
const INDEX_VECTRA_INDEX_FILENAME = 'index.json';

/**
 * `.index/` 根下的受保护文件 — 递归删除命中任一即拒绝。
 *
 * 关键路径:控制指针与 owner 锁是「删除凭据」与并发安全的根,任何递归删除都不得触碰。
 */
const INDEX_ROOT_PROTECTED_FILENAMES = ['control.json', 'owner.lock', 'owner.recovery.lock'] as const;

/**
 * 形状白名单判定 — 目标必须「看起来像一个索引目录」才允许递归删除。
 *
 * 关键路径:这是递归删除的**安全边界**,不是代际归属判定。要求是「含索引特征 / 为空 /
 * 不存在」三者之一:前两者没有可误删的内容,后者是真索引目录(含 `index.json` 的普通布局,
 * 今天未接线时的全量重建正是这种)的必要特征。pluginDir 形状的目录在没有索引特征时被拒。
 *
 * 与后端 `describeForeignIndexDir` 的第 5 条逐条一致:不存在或空 → 允许;非空 → 必须有特征。
 *
 * @param target - 已解析为绝对路径的候选目录。
 * @returns 拒绝原因;允许删除时为 null。
 */
function describeNonIndexDirectory(target: string): string | null {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(target, { withFileTypes: true });
	}
	catch {
		// 读不到按「不存在」处理:递归删除对不存在的目标本就是无操作,不值得升级成拒绝。
		return null;
	}
	if (entries.length === 0) return null;
	const features = [INDEX_VECTRA_INDEX_FILENAME, INDEX_GENERATIONS_DIRNAME, INDEX_SHARDS_DIRNAME, ...INDEX_ROOT_PROTECTED_FILENAMES];
	if (features.some(name => fs.existsSync(path.join(target, name)))) return null;
	return `目标不含任何索引特征(${features.join(' / ')}),拒绝递归删除非索引目录`;
}

/** 存储错误码。 */
export const VECTOR_STORE_ERROR_CODES = [
	'reload-required',
	'replace-failed',
	'delete-failed',
	'invalid-replacement',
	'drop-refused',
] as const;

/** 存储错误码。 */
export type VectorStoreErrorCode = (typeof VECTOR_STORE_ERROR_CODES)[number];

/**
 * 提交失败后的磁盘状态。
 *
 * 关键路径:
 * - `complete-previous`:rename 未执行,磁盘仍是完整旧版;
 * - `complete-next`:rename 已执行,磁盘已是完整新版(哪怕调用方收到错误);
 * - `unknown`:没有可判定的写入记录(未注入原子存储或记录不可归属),必须重载后核对。
 */
export const DISK_COMMIT_STATES = ['complete-previous', 'complete-next', 'unknown'] as const;

/** 提交失败后的磁盘状态。 */
export type DiskCommitState = (typeof DISK_COMMIT_STATES)[number];

/** 向量存储错误 — 携带稳定错误码与可判定的磁盘状态。 */
export class VectorStoreError extends Error {
	/** 稳定错误码。 */
	readonly code: VectorStoreErrorCode;
	/** 提交失败后的磁盘状态;非提交类错误为 null。 */
	readonly diskState: DiskCommitState | null;
	/** 底层原始错误。 */
	readonly cause: unknown;

	constructor(
		code: VectorStoreErrorCode,
		message: string,
		options: { diskState?: DiskCommitState; cause?: unknown } = {},
	) {
		super(message);
		this.name = 'VectorStoreError';
		this.code = code;
		this.diskState = options.diskState ?? null;
		this.cause = options.cause ?? null;
	}
}

/** 原子存储的写入结果读取接缝 — 只依赖 T1 适配器的公开方法。 */
interface AtomicWriteOutcomeReader {
	getLastWriteOutcome(filePath: string): AtomicWriteRecord | null;
}

/** 判断注入的存储是否能报告写入结果。 */
function asWriteOutcomeReader(storage: FileStorage | undefined): AtomicWriteOutcomeReader | null {
	if (storage === undefined) return null;
	const candidate = storage as unknown as AtomicWriteOutcomeReader;
	return typeof candidate.getLastWriteOutcome === 'function' ? candidate : null;
}

/**
 * VectraStore 构造选项(M-1 扩展)。
 *
 * 设计要点:
 * - `embeddings`:由主线程注入的 ONNX FeatureExtractor;Worker 启动期由调用方注入,避免重复构造。
 * - `autoInit`:默认 true,构造时调一次 `init()` 预热;Worker 启动期显式 init 后可传 false 避免双重 init。
 * - `storage`:T1 的原子 `FileStorage`;生产由装配层注入,测试用于注入故障与统计写入。
 *   不注入时沿用 vectra 默认实现,`replaceFile` 失败后只能报「磁盘状态不明」。
 */
export interface VectraStoreOptions {
	embeddings?: EmbeddingsModel;
	autoInit?: boolean;
	storage?: FileStorage;
}

/**
 * vectra 向量库适配器。
 *
 * 设计要点:
 * - 索引仅在首次调用时懒加载(参见 `ensureIndex`),允许冷启动阶段不触发磁盘 IO。
 * - 搜索时按 `topK * 10` 过度抓取,再做 chunk → document 聚合,确保返回的 topK 是文档级而非片段级。
 * - `_lastIndexTime` 简单记录最近一次写入时间戳,供 UI 展示索引新鲜度。
 * - `status()` 出错时降级返回零值,避免观测调用挂掉上游 Agent Loop。
 * - 提交失败后 `needsReload` 置位,所有查询与写入都被拒绝,直到 `reload()` 重建实例。
 */
export class VectraStore implements VectorStore, FileReplaceStore {
	private index: LocalDocumentIndex | null = null;
	/** 批量写入深度;>0 时 `replaceFile` 只改内存,落盘推迟到 `endWriteBatch`。 */
	private writeBatchDepth = 0;
	private readonly indexDir: string;
	private _lastIndexTime = 0;
	private readonly embeddings: EmbeddingsModel | undefined;
	private readonly storage: FileStorage | undefined;
	private readonly writeOutcomeReader: AtomicWriteOutcomeReader | null;
	// 关键路径:缓存 init 的 promise,避免并发首次调用的竞态。
	private _ready: Promise<void> | null = null;
	// 关键路径:提交失败后旧内存视图不可信,禁止继续用它服务查询。
	private needsReload = false;

	constructor(indexDir: string, embeddingsOrOptions?: EmbeddingsModel | VectraStoreOptions) {
		// 关键路径:统一解析为绝对路径 —— 原子存储只接受绝对路径,且写入结果按解析后的路径归属。
		this.indexDir = path.resolve(indexDir);
		// 关键路径:兼容旧的 `(dir, embeddings?)` 签名,新签名 `(dir, options?)`。
		if (
			embeddingsOrOptions &&
			typeof embeddingsOrOptions === 'object' &&
			('embeddings' in embeddingsOrOptions || 'autoInit' in embeddingsOrOptions || 'storage' in embeddingsOrOptions)
		) {
			this.embeddings = embeddingsOrOptions.embeddings;
			this.storage = embeddingsOrOptions.storage;
			if (embeddingsOrOptions.autoInit !== false) {
				this._ready = this.init();
			}
		} else {
			this.embeddings = embeddingsOrOptions as EmbeddingsModel | undefined;
			this.storage = undefined;
			this._ready = this.init();
		}
		this.writeOutcomeReader = asWriteOutcomeReader(this.storage);
	}

	/**
	 * 显式预热索引 — 构造 LocalDocumentIndex 并确保磁盘文件就绪。
	 *
	 * 关键路径:
	 * - 幂等:所有调用共享同一个 `_ready` promise,不会出现并发首次调用竞态。
	 * - 构造期 `autoInit` 已启动初始化时,这里必须 **await 同一 promise**,
	 *   不能因为 `this.index` 已赋值就提前返回(那样调用方会在索引文件尚未落地时继续)。
	 * - Worker 启动期会调一次,避免首个请求才触发 init 的延迟。
	 */
	async init(): Promise<void> {
		this._ready ??= this.createIndexOnDisk();
		return this._ready;
	}

	/** 创建 `LocalDocumentIndex` 并在磁盘上落地索引文件(仅供 `init` 复用)。 */
	private async createIndexOnDisk(): Promise<void> {
		if (!this.index) {
			this.index = new LocalDocumentIndex({
				folderPath: this.indexDir,
				embeddings: this.embeddings,
				storage: this.storage,
			});
			// 关键路径:首次运行需在磁盘上落地 index.json + 索引文件。
			if (!(await this.index.isIndexCreated())) {
				await this.index.createIndex();
			}
		}
	}

	/**
	 * 懒加载索引:首次调用时创建 `LocalDocumentIndex`,必要时初始化磁盘文件。
	 *
	 * @returns 已就绪的 `LocalDocumentIndex`。
	 * @throws 当磁盘不可写或 vectra 内部初始化失败时抛出。
	 */
	private async ensureIndex(): Promise<LocalDocumentIndex> {
		if (!this._ready) this._ready = this.init();
		await this._ready;
		if (!this.index) throw new Error(tNow('error.vector.initFailed'));
		return this.index;
	}

	/**
	 * 判断索引是否已创建(磁盘上有 index 文件)。
	 *
	 * 关键路径:smart reindex 启动期判断首次(无索引走全量)还是热启动(有索引走 hash diff)。
	 */
	async isIndexCreated(): Promise<boolean> {
		this.assertUsable('isIndexCreated');
		const index = await this.ensureIndex();
		return index.isIndexCreated();
	}

	/**
	 * 删除整个索引目录(模型切换/参数变更时全量重建用)。
	 *
	 * 关键路径:
	 * - 这是本模块**唯一**的递归删除边界(`fs.rmSync(..., { recursive: true })`),因此删除前的
	 *   归属守卫必须在这里闭合:代际布局下 `.index/` 根含控制指针、owner 锁与 `generations/`
	 *   聚合目录,误把根或聚合目录当索引目录传进来会连带删掉删除凭据与全部代际。
	 *   守卫失败时抛稳定错误码且**不删除任何文件**。
	 * - 守卫同时是**形状白名单**:非空且不含索引特征(`index.json` / `generations/` /
	 *   `control.json`)的目录一律拒绝 —— 装配错误把 pluginDir 当索引目录传进来时,不能静默
	 *   递归删掉整个插件目录(见 {@link assertDroppableIndexDir})。
	 * - vectra 没有清空 API,删目录后下次 init 会重建。自包含重置流程:先清 this.index 和
	 *   `_ready`,再删目录,最后 init 重建空索引。
	 */
	async dropIndex(): Promise<void> {
		// 关键路径(B2):守卫必须在任何删除动作之前执行,且不改动内存状态。
		this.assertDroppableIndexDir();
		// 关键路径:先清 this.index,下次 ensureIndex 会重建。
		this.index = null;
		this._ready = null;
		this.needsReload = false;
		if (fs.existsSync(this.indexDir)) {
			// 关键路径:rmSync 递归删整个目录,包括 index.json + 索引文件。
			fs.rmSync(this.indexDir, { recursive: true, force: true });
		}
		await this.init();
	}

	/**
	 * 递归删除前的归属守卫 — 拒绝删除 `.index/` 根、`generations/` 聚合目录与非索引目录。
	 *
	 * 判定按「规范化路径 + 内容探测 + 形状白名单」:
	 * 1. 目录名等于 `generations` → 聚合目录,拒绝;
	 * 2. 目录内含 `control.json` / `owner.lock` / `owner.recovery.lock` → `.index/` 根特征,拒绝;
	 * 3. 目录内含 `generations/` 子目录 → `.index/` 根特征,拒绝;
	 * 4. 父目录名为 `generations` 且自身不是 `gen-<16hex>` → 代际树里的异形目录,拒绝;
	 * 5. **形状白名单**:目录不存在、为空,或内含索引特征(`index.json` / `generations/` /
	 *    `control.json`)任一,才允许递归删除;非空且不含任何索引特征的一律拒绝 ——
	 *    pluginDir 形状(含 `main.js` / `data.json` / `attachments` 等插件产物但**没有**索引特征)
	 *    必须被拒,否则一次装配错误就会静默递归删掉整个插件目录。
	 *
	 * 为什么不做「目录名等于 `.index` 一律拒绝」:T7 之前的装配(`src/main.ts`)直接把
	 * `.index/` 根当索引目录使用,按名拒绝会让清库与重建在迁移完成前直接失效;
	 * 而内容探测已覆盖真正危险的情形(根上已有控制指针或代际聚合目录)。
	 *
	 * 严格版(要求 basename 必须是本索引根 `generations/` 下的 `gen-[0-9a-f]{16}`)不在本适配器内:
	 * **T7 必须通过后端的注入端口 `assertDropOwnership` 收紧**;这里只承担形状白名单级别的安全
	 * 边界。本方法与 `core/persistent-index-backend` 的 `describeForeignIndexDir` 必须逐条一致
	 * (第 4 条此前只在后端有,适配器缺失)。
	 *
	 * @throws {VectorStoreError} `drop-refused`;抛出前不删除任何文件。
	 */
	private assertDroppableIndexDir(): void {
		const target = path.resolve(this.indexDir);
		const reasons: string[] = [];
		if (path.basename(target) === INDEX_GENERATIONS_DIRNAME) reasons.push('目标是代际聚合目录 generations/');
		for (const name of INDEX_ROOT_PROTECTED_FILENAMES) {
			if (fs.existsSync(path.join(target, name))) reasons.push(`目标内含受保护文件 ${name}`);
		}
		const generationsPath = path.join(target, INDEX_GENERATIONS_DIRNAME);
		if (fs.existsSync(generationsPath) && fs.statSync(generationsPath).isDirectory()) {
			reasons.push('目标是 .index 根(内含 generations/ 聚合目录)');
		}
		if (path.basename(path.dirname(target)) === INDEX_GENERATIONS_DIRNAME && !INDEX_GENERATION_DIR_PATTERN.test(path.basename(target))) {
			reasons.push(`目标是 generations/ 下的非代际目录(${path.basename(target)})`);
		}
		if (reasons.length === 0) {
			const shapeReason = describeNonIndexDirectory(target);
			if (shapeReason !== null) reasons.push(shapeReason);
		}
		if (reasons.length === 0) return;
		throw new VectorStoreError(
			'drop-refused',
			`拒绝递归删除索引目录(${reasons.join(';')}):${target}`,
		);
	}

	/**
	 * 写入或更新文档向量。
	 *
	 * @param docId - 业务层文档 ID(即文件 vault 路径)。
	 * @param text - 文档文本(由调用方分块好;vectra 内部仍会再切)。
	 * @param metadata - 任意元数据,会被持久化到 chunk metadata。
	 */
	async upsert(docId: string, text: string, metadata?: Record<string, unknown>): Promise<void> {
		this.assertUsable('upsert');
		const index = await this.ensureIndex();
		await index.upsertDocument(
			docId,
			text,
			undefined,
			metadata as Record<string, MetadataTypes>,
		);
		this._lastIndexTime = Date.now();
	}

	/**
	 * 向量检索 — 返回与查询最相关的 topK 片段(当前契约)。
	 *
	 * 关键路径:
	 * 1. `queryItems` 抓 `topK * 10` 个 chunk,弥补聚合后丢弃带来的损耗。
	 * 2. 把 vectra 内部 `documentId` 映射回我们传入的 `docId`(URI)。
	 * 3. 同 `documentId` 多 chunk 取最高分,按分数降序截断到 `topK`。
	 *
	 * 注意(I1):写入侧把 `documentId` 设为块 ID,所以这里实际不做文件级聚合 ——
	 * 结果是 top-K 片段。文档级聚合需要单独设计(不能靠改写入侧悄悄切换检索粒度)。
	 *
	 * @param queryVector - 查询向量。
	 * @param topK - 返回片段上限。
	 * @param filter - 元数据过滤(当前实现未使用,留作扩展)。
	 * @returns 片段级结果,按相关性降序。
	 */
	async search(queryVector: number[], topK: number, _filter?: SearchFilter): Promise<VectorSearchResult[]> {
		void _filter; // 关键路径:filter 当前实现未启用,保留以满足端口契约。
		this.assertUsable('search');
		const index = await this.ensureIndex();
		// 过度抓取:确保聚合后 topK 文档都能拿到。
		const results = await index.queryItems(queryVector, '', topK * 10);

		// 关键路径:先收集所有命中的内部 documentId,再去批量查 URI。
		const internalIds = new Set<string>();
		for (const r of results) {
			const chunkMeta = r.item.metadata;
			if (chunkMeta.documentId) {
				internalIds.add(chunkMeta.documentId);
			}
		}

		// 内部 documentId → 业务 docId(URI) 的映射。
		const uriMap = new Map<string, string>();
		for (const internalId of internalIds) {
			const uri = await index.getDocumentUri(internalId);
			if (uri) uriMap.set(internalId, uri);
		}

		// 关键路径:chunk 级别分数聚合成 document 级别,取每个文档的最高分。
		const docMap = new Map<string, { docId: string; score: number; metadata: Record<string, unknown> }>();
		for (const r of results) {
			const chunkMeta = r.item.metadata;
			const internalDocId = chunkMeta.documentId;
			if (!internalDocId) continue;

			const docId = uriMap.get(internalDocId) ?? internalDocId;
			const existing = docMap.get(docId);
			if (!existing || r.score > existing.score) {
				docMap.set(docId, {
					docId,
					score: r.score,
					metadata: chunkMeta,
				});
			}
		}

		return Array.from(docMap.values())
			.sort((a, b) => b.score - a.score)
			.slice(0, topK);
	}

	/**
	 * 删除文档。
	 *
	 * 修复:vectra 在文档不存在时抛错,这里静默忽略以保证批量删除的幂等性。
	 *
	 * @param docIds - 待删除文档 ID 列表。
	 * @returns 实际成功删除的文档数。
	 */
	async delete(docIds: string[]): Promise<number> {
		this.assertUsable('delete');
		const index = await this.ensureIndex();
		let count = 0;
		for (const id of docIds) {
			try {
				await index.deleteDocument(id);
				count++;
			} catch {
				// 修复:文档可能已被其他流程删除,忽略。
			}
		}
		return count;
	}

	/**
	 * 删除指定文件路径下的所有 chunk。
	 *
	 * 关键路径:
	 * - 用 `listItems()` 完整枚举该路径的全部块,再在一个事务里删除;不再使用
	 *   「512 维零向量 queryItems(topK=100)」的启发式(T0 已证明它只覆盖索引数组前 100 项,
	 *   目标块排在第 100 项之后时一个都删不掉,且与向量维度无关)。
	 * - 不能复用 `this.delete(ids)`:`delete` 调 `deleteDocument(uri)` 依赖 catalog,
	 *   而 `upsertItem` 绕过 `upsertDocument` 不写 catalog,`deleteDocument` 会提前返回。
	 *   这里直接调底层 `LocalIndex.deleteItems(itemIds)`,按 item.id 删。
	 * - 目标路径本来就没有块时不提交事务,避免无意义的整库重写。
	 *
	 * @param filePath - 文件相对路径(如 "notes/foo.md")
	 * @returns 实际删除的 chunk 数
	 * @throws {VectorStoreError} 提交失败(`delete-failed`);存储随即进入需重载状态。
	 */
	async deleteByPath(filePath: string): Promise<number> {
		this.assertUsable('deleteByPath');
		const index = await this.ensureIndex();
		const before = this.readLastIndexWrite();
		await this.beginTransaction('deleteByPath');
		try {
			const ids = await this.listBlockIdsOf(index, filePath);
			if (ids.length === 0) {
				// 关键路径:没有旧块时取消事务,不产生一次全库重写。
				index.cancelUpdate();
				return 0;
			}
			await index.deleteItems(ids);
			await index.endUpdate();
			this._lastIndexTime = Date.now();
			return ids.length;
		} catch (error) {
			this.cancelTransactionQuietly(index);
			throw this.failCommit('delete-failed', `删除文件块失败:${filePath}`, before, error);
		}
	}

	/**
	 * 查询索引状态。
	 *
	 * 行为契约:出错时返回零值状态,绝不抛错(观测类调用不应阻断主流程)。
	 *
	 * 关键路径:用 `getIndexStats().items` 而非 `getCatalogStats().documents` 计数 —
	 * `upsertItem`(批量 embed 路径)绕过 `upsertDocument`,不写 catalog,
	 * `getCatalogStats().documents` 会返回 0;`getIndexStats().items` 直接读索引文件,
	 * 统计所有 item(含 `upsertDocument` 与 `upsertItem` 两条路径写入的 chunk)。
	 *
	 * @returns 索引统计信息。
	 */
	async status(): Promise<IndexStatus> {
		// 关键路径:需重载时不读旧内存视图,也不抛错 —— 观测调用按「无可用数据」降级。
		if (this.needsReload) {
			return { totalDocs: 0, lastIndexTime: 0, isIndexing: false };
		}
		try {
			const index = await this.ensureIndex();
			const stats = await index.getIndexStats();
			return {
				totalDocs: stats.items,
				lastIndexTime: this._lastIndexTime,
				isIndexing: false,
			};
		} catch {
			// 修复:观测调用降级,不让 UI 卡死。
			return {
				totalDocs: 0,
				lastIndexTime: 0,
				isIndexing: false,
			};
		}
	}

	/**
	 * 取指定 URI 文档的全文(用于诊断页 chunk 摘要展示)。
	 *
	 * 关键路径:
	 * - vectra 没有提供按 URI 直接取文本的 API,需要 `listDocuments()` 全量列举后过滤。
	 * - 诊断页只对 Top-K 命中调用,通常 1-10 次,单次 listDocuments 遍历整个 catalog。
	 * - 大库(>5000 文档)时这是性能瓶颈,但**仅诊断用**,不阻塞主流程;若成为问题,
	 *   后续可改为读磁盘 index.json(vectra 内部存储格式)。
	 *
	 * @param uri - 文档 URI(本项目即 vault 相对路径)。
	 * @returns 文档原文;URI 不存在时返回 null;底层失败返回 null(诊断场景降级,避免挂 UI)。
	 */
	async getDocumentText(uri: string): Promise<string | null> {
		if (this.needsReload) return null;
		try {
			const index = await this.ensureIndex();
			const docs = await index.listDocuments();
			for (const doc of docs) {
				if (doc.uri === uri) {
					const text = await doc.loadText();
					return text;
				}
			}
			return null;
		} catch (err) {
			// 修复:诊断调用降级,不让 UI 卡死。
			devLogger.error('vectra', 'getDocumentText failed', err);
			return null;
		}
	}

	/**
	 * 用预计算向量插入或更新文档。
	 *
	 * 关键路径:绕过 vectra 的 upsertDocument(它会调 embedding),
	 * 直接用 LocalIndex.upsertItem 写入预计算向量。
	 * 必须在 beginFileUpdate/endFileUpdate 事务内调用。
	 *
	 * @param docId - 文档唯一标识。
	 * @param vector - 预计算向量。
	 * @param metadata - 任意附加元数据。
	 */
	async upsertItem(docId: string, vector: number[], metadata?: Record<string, unknown>): Promise<void> {
		this.assertUsable('upsertItem');
		const index = await this.ensureIndex();
		await index.upsertItem({
			id: docId,
			vector,
			// 关键路径:必须设 documentId,search() 按 documentId 聚合 chunk→doc,
			// 未设 documentId 的 item 会被 search 跳过(参见 search 中 `if (!internalDocId) continue`)。
			// 绕过 upsertDocument 时不建 catalog 记录,getDocumentUri 返回 undefined,
			// search 回退用 documentId 作 docId(见 `uriMap.get(internalDocId) ?? internalDocId`)。
			// 双重断言:spread 的 Record<string, unknown> 值类型为 unknown,无法直接满足
			// DocumentChunkMetadata 的索引签名,故先转 unknown 再断言。
			metadata: { ...metadata, docId, documentId: docId } as unknown as DocumentChunkMetadata,
		});
	}

	/**
	 * 开始文件级事务 — 一个文件的多个 chunk 在同一事务内写入,避免每 chunk 一次事务。
	 */
	async beginFileUpdate(): Promise<void> {
		this.assertUsable('beginFileUpdate');
		const index = await this.ensureIndex();
		await this.beginTransaction('beginFileUpdate', index);
	}

	/**
	 * 提交文件级事务。
	 *
	 * 关键路径:在事务提交成功后更新 `_lastIndexTime`,与 `upsert()` 行为对齐 —
	 * `upsertItem` 绕过了 `upsertDocument`,不会走到 `upsert()` 里的赋值,
	 * 故在此处补上,保证 `status()` 报告的索引新鲜度准确。
	 * 提交失败时记录磁盘状态并让存储进入需重载状态。
	 */
	async endFileUpdate(): Promise<void> {
		this.assertUsable('endFileUpdate');
		const index = await this.ensureIndex();
		const before = this.readLastIndexWrite();
		try {
			await index.endUpdate();
			this._lastIndexTime = Date.now();
		} catch (error) {
			throw this.failCommit('replace-failed', '提交文件事务失败', before, error);
		}
	}

	/**
	 * 取消文件级事务(回滚)。
	 *
	 * 关键路径:这是清理路径,即使存储处于需重载状态也允许调用,避免失败后无法释放事务。
	 */
	async cancelFileUpdate(): Promise<void> {
		const index = await this.ensureIndex();
		index.cancelUpdate();
	}

	// ==================== FileReplaceStore ====================

	/**
	 * 用完整新块集合替换某个路径的全部块 — 删除与插入在同一事务内完成。
	 *
	 * 关键路径:
	 * 1. 先做输入校验(ID 唯一、向量有限、同维度),校验失败不进入事务;
	 * 2. 事务内用 `listItems()` 完整枚举旧块并删除,再写入全部新块(空数组也完成删除);
	 * 3. 每个块的 metadata 带上 `commitId` 与 `path`,供 T3 的完成记录核对;
	 * 4. 提交失败按 T1 原子存储的写入结果判定磁盘是完整旧版还是完整新版,并进入需重载状态。
	 *
	 * @param input - 目标路径、提交标识与完整新块集合。
	 * @throws {VectorStoreError} 输入非法(`invalid-replacement`)或提交失败(`replace-failed`)。
	 */
	async replaceFile(input: FileReplacement): Promise<void> {
		this.assertUsable('replaceFile');
		const replacement = await this.validateReplacement(input);
		const index = await this.ensureIndex();
		const before = this.readLastIndexWrite();
		// 关键路径:批内由外层统一开启/提交事务 —— 每篇都 begin/end 会让整份索引被重写一次,
		// 这正是大库上「每篇几十秒」的根因。
		const batched = this.writeBatchDepth > 0;
		if (!batched) await this.beginTransaction('replaceFile', index);
		try {
			const staleIds = await this.listBlockIdsOf(index, replacement.path);
			if (staleIds.length === 0 && replacement.blocks.length === 0) {
				// 关键路径:目标路径既没有旧块也没有新块,磁盘已是目标状态,不产生无意义的整库重写。
				if (!batched) index.cancelUpdate();
				return;
			}
			if (staleIds.length > 0) await index.deleteItems(staleIds);
			for (const block of replacement.blocks) {
				await index.upsertItem({
					id: block.id,
					vector: block.vector,
					// 关键路径:path 与 commitId 由存储侧统一写入,调用方无法把块写到别的路径。
					metadata: {
						...block.metadata,
						path: replacement.path,
						commitId: replacement.commitId,
						// 关键路径(I1):`documentId` 必须是块 ID,与 `upsertItem` 路径保持一致。
						// search() 按 documentId 聚合,写文件路径会让检索粒度从「top K 片段」
						// 静默变成「top K 文件」,且三条索引路径彼此分裂。
						// 文档级聚合是另行设计,不在当前契约内。
						docId: block.id,
						documentId: block.id,
					} as unknown as DocumentChunkMetadata,
				});
			}
			// 批内不在这里落盘:由 `endWriteBatch` 统一提交,把 N 次整库重写压成 1 次。
			if (!batched) await index.endUpdate();
			this._lastIndexTime = Date.now();
		} catch (error) {
			if (!batched) this.cancelTransactionQuietly(index);
			throw this.failCommit('replace-failed', `替换文件块失败:${replacement.path}`, before, error);
		}
	}

	/**
	 * 开始批量写入 — 期间多次 `replaceFile` 只改内存,落盘推迟到 {@link endWriteBatch}。
	 *
	 * 关键路径:Vectra 的存储接口是整文件读写,没有增量追加;能做的只有「合并提交」,
	 * 把 N 次整库重写压成 1 次。批量期间若有任何异常,`endWriteBatch` 会取消事务,
	 * 磁盘保持批前状态(内存改动随事务丢弃)。
	 *
	 * @throws {VectorStoreError} 存储处于需重载状态。
	 */
	async beginWriteBatch(): Promise<void> {
		this.assertUsable('beginWriteBatch');
		if (this.writeBatchDepth > 0) {
			this.writeBatchDepth += 1;
			return;
		}
		const index = await this.ensureIndex();
		await this.beginTransaction('beginWriteBatch', index);
		this.writeBatchDepth = 1;
	}

	/**
	 * 结束批量写入并落盘一次。
	 *
	 * @throws {VectorStoreError} 提交失败(存储进入需重载状态)。
	 */
	async endWriteBatch(): Promise<void> {
		if (this.writeBatchDepth === 0) return;
		this.writeBatchDepth -= 1;
		if (this.writeBatchDepth > 0) return;
		const index = await this.ensureIndex();
		const before = this.readLastIndexWrite();
		try {
			await index.endUpdate();
			this._lastIndexTime = Date.now();
		} catch (error) {
			this.cancelTransactionQuietly(index);
			throw this.failCommit('replace-failed', '批量提交索引失败', before, error);
		}
	}

	/**
	 * 放弃批量写入 — 丢弃批内所有内存改动,磁盘保持批前状态。
	 *
	 * 关键路径:批内任一事务失败时不能把半批写盘,否则磁盘会出现「部分文件已更新、
	 * 完成记录未写」的混合状态。
	 */
	abortWriteBatch(): void {
		if (this.writeBatchDepth === 0) return;
		this.writeBatchDepth = 0;
		if (this.index !== null) this.cancelTransactionQuietly(this.index);
	}

	/** 当前是否处于批量写入中。 */
	get inWriteBatch(): boolean {
		return this.writeBatchDepth > 0;
	}

	/**
	 * 完整枚举某个路径的当前块集合 — 只走 `listItems()`,不使用相似度查询。
	 *
	 * @param filePath - vault 相对路径。
	 * @returns 块集合(索引内顺序);路径不存在时为空数组。
	 * @throws {VectorStoreError} 存储处于需重载状态(`reload-required`)。
	 */
	async inspectFile(filePath: string): Promise<PreparedBlock[]> {
		this.assertUsable('inspectFile');
		const index = await this.ensureIndex();
		const items = await index.listItems();
		return items
			.filter((item) => (item.metadata as { path?: string }).path === filePath)
			.map((item) => this.toPreparedBlock(item));
	}

	/**
	 * 批量枚举多个路径的当前块集合 — **一次** `listItems()` 后按 `metadata.path` 分组。
	 *
	 * 关键路径(O(N²) 接缝):`inspectFile` 是「全量枚举 + 过滤」,逐条调用等于
	 * 文件数 × 总块数的代价(250/500/1000/2000 文件实测约 6/25/96/365ms,再叠加
	 * 每次 `slice()` 的临时垃圾);迁移侧的逐文件兼容校验必须走本入口,
	 * 把这份代价降为一次枚举加一次分组。
	 *
	 * 语义与 {@link inspectFile} 完全一致:
	 * - 只返回被请求的路径;**未命中的路径映射为空数组**(不是缺键),便于调用方直接遍历;
	 * - 每个路径的块保持索引内顺序,块形状(浅拷贝 `vector` / `metadata`)与逐条调用相同。
	 *
	 * @param paths - vault 相对路径列表;重复路径按一次处理。
	 * @returns 路径 → 块集合(含被请求但无块的路径)。
	 * @throws {VectorStoreError} 存储处于需重载状态(`reload-required`)。
	 */
	async inspectFiles(paths: string[]): Promise<Map<string, PreparedBlock[]>> {
		this.assertUsable('inspectFiles');
		const index = await this.ensureIndex();
		const wanted = new Set(paths);
		const grouped = new Map<string, PreparedBlock[]>();
		for (const filePath of wanted) grouped.set(filePath, []);
		const items = await index.listItems();
		for (const item of items) {
			const itemPath = (item.metadata as { path?: string }).path;
			if (itemPath === undefined || !wanted.has(itemPath)) continue;
			grouped.get(itemPath)?.push(this.toPreparedBlock(item));
		}
		return grouped;
	}

	/**
	 * 索引项 → 待写入块形状。
	 *
	 * 关键路径:vector 与 metadata 都做浅拷贝 —— 返回结果不得与 vectra 内存实例共享引用,
	 * 否则调用方改动会静默污染索引(逐条与批量两条路径必须给出同一形状)。
	 *
	 * @param item - `listItems()` 返回的索引项。
	 * @returns 只含 id/vector/metadata 的块。
	 */
	private toPreparedBlock(item: { id: string; vector: ArrayLike<number>; metadata: unknown }): PreparedBlock {
		return {
			id: item.id,
			// 关键路径:ArrayLike 未必可迭代(vector 可能是 Float32Array 或普通数组),统一用 Array.from。
			vector: Array.from(item.vector),
			metadata: { ...(item.metadata as Record<string, unknown>) },
		};
	}

	/**
	 * 丢弃当前内存实例并重建 — 提交失败后核对磁盘真值的唯一入口。
	 *
	 * @throws 重建失败时继续抛出,并把存储留在需重载状态。
	 */
	async reload(): Promise<void> {
		this.index = null;
		this._ready = null;
		this.needsReload = false;
		const ready = this.init();
		this._ready = ready;
		try {
			await ready;
		} catch (error) {
			this.enterReloadState();
			throw error;
		}
	}

	/**
	 * 存储是否处于需重载状态 — 供调用方在失败后决定是否 `reload()` 再继续。
	 *
	 * 关键路径(B3b):提交失败(`replace-failed` / `delete-failed`)与后续被拒的调用
	 * 都会让该状态为 true;调用方必须先重载,否则同批剩余写入全部抛 `reload-required`。
	 *
	 * @returns 已置位需重载时为 true。
	 */
	isReloadRequired(): boolean {
		return this.needsReload;
	}

	// ==================== 内部实现 ====================

	/** 索引文件绝对路径 — 判定提交结果时按它取最近一次写入记录。 */
	private indexPath(): string {
		return path.join(this.indexDir, 'index.json');
	}

	/** 读取最近一次索引文件写入记录(未注入原子存储时为 null)。 */
	private readLastIndexWrite(): AtomicWriteRecord | null {
		const reader = this.writeOutcomeReader;
		if (reader === null) return null;
		return reader.getLastWriteOutcome(this.indexPath());
	}

	/**
	 * 判定提交失败后的磁盘状态。
	 *
	 * 关键路径:rename 前失败 = 完整旧版;rename 已执行(renamed / unknown-after-rename)= 完整新版;
	 * 没有新记录或无法归属时只能报「状态不明」,不能一律当作旧版。
	 */
	private classifyDiskState(before: AtomicWriteRecord | null): DiskCommitState {
		const reader = this.writeOutcomeReader;
		if (reader === null) return 'unknown';
		const after = reader.getLastWriteOutcome(this.indexPath());
		if (after === null) return 'unknown';
		// 同一条记录说明本次提交没有产生新的写入,磁盘仍是旧版。
		if (before !== null && after === before) return 'complete-previous';
		const outcome: AtomicWriteOutcome = after.outcome;
		return outcome === 'failed-before-rename' ? 'complete-previous' : 'complete-next';
	}

	/** 进入需重载状态:旧内存视图不再可信。 */
	private enterReloadState(): void {
		this.needsReload = true;
	}

	/** 构造提交失败错误,并让存储进入需重载状态。 */
	private failCommit(
		code: VectorStoreErrorCode,
		message: string,
		before: AtomicWriteRecord | null,
		cause: unknown,
	): VectorStoreError {
		const diskState = this.classifyDiskState(before);
		this.enterReloadState();
		return new VectorStoreError(code, message, { diskState, cause });
	}

	/** 开始事务;失败同样进入需重载状态(实例可能已不可继续)。 */
	private async beginTransaction(operation: string, index?: LocalDocumentIndex): Promise<void> {
		const target = index ?? (await this.ensureIndex());
		try {
			await target.beginUpdate();
		} catch (error) {
			this.enterReloadState();
			throw new VectorStoreError('replace-failed', `无法开始 ${operation} 事务`, {
				diskState: 'complete-previous',
				cause: error,
			});
		}
	}

	/** 回滚事务;回滚失败不遮蔽原始错误。 */
	private cancelTransactionQuietly(index: LocalDocumentIndex): void {
		try {
			index.cancelUpdate();
		} catch {
			// 关键路径:事务已不可取消时忽略 —— 存储已进入需重载状态,由 reload 重建。
		}
	}

	/** 完整枚举某路径的块 ID(走 `listItems()`)。 */
	private async listBlockIdsOf(index: LocalDocumentIndex, filePath: string): Promise<string[]> {
		const items = await index.listItems();
		return items
			.filter((item) => (item.metadata as { path?: string }).path === filePath)
			.map((item) => item.id);
	}

	/**
	 * 校验并规范化替换输入。
	 *
	 * @throws {VectorStoreError} 路径越界、提交标识为空、块 ID 重复、向量非有限或维度不一致。
	 */
	private async validateReplacement(input: FileReplacement): Promise<FileReplacement> {
		const fail = (reason: string, cause?: unknown): never => {
			throw new VectorStoreError('invalid-replacement', `文件替换输入非法:${reason}`, { cause });
		};
		if (typeof input !== 'object' || input === null) return fail('输入必须是对象');
		if (typeof input.path !== 'string' || input.path.length === 0) return fail('path 必须是非空字符串');
		let recordPath: string;
		try {
			recordPath = assertSafeRecordPath(input.path);
		} catch (error) {
			return fail(`path 未通过路径校验(${input.path})`, error);
		}
		if (typeof input.commitId !== 'string' || input.commitId.length === 0) {
			return fail('commitId 必须是非空字符串');
		}
		if (!Array.isArray(input.blocks)) return fail('blocks 必须是数组');
		try {
			await validateBlockSet(input.blocks, {});
		} catch (error) {
			return fail('块集合未通过校验(ID 重复或向量含非有限值)', error);
		}
		const dimension = input.blocks[0]?.vector.length ?? 0;
		for (const block of input.blocks) {
			if (typeof block.metadata !== 'object' || block.metadata === null || Array.isArray(block.metadata)) {
				return fail(`块 ${block.id} 的 metadata 必须是对象`);
			}
			if (block.vector.length !== dimension) {
				return fail(`块 ${block.id} 的向量维度与同批其他块不一致`);
			}
		}
		return { path: recordPath, commitId: input.commitId, blocks: input.blocks };
	}

	/** 断言存储可用 — 提交失败后必须 reload 才能继续查询或写入。 */
	private assertUsable(operation: string): void {
		if (!this.needsReload) return;
		throw new VectorStoreError(
			'reload-required',
			`索引存储处于需重载状态,拒绝 ${operation};请先调用 reload() 核对磁盘`,
		);
	}
}
