/**
 * @file src/adapters/vector-vectra-sharded.ts
 * @description 分片向量存储适配器 — 按路径哈希路由到 N 个独立本地索引。
 * @module adapters/vector-vectra-sharded
 * @depends node:fs、node:path、core/index-shard-routing、adapters/vector-vectra、adapters/atomic-index-storage
 *
 * 设计要点:
 * - 写入只碰目标分片,单次提交体积约为全库 1/N;跨片只影响查询。
 * - 批量写入按片合并:`beginWriteBatch` 后每片各自延迟提交,`endWriteBatch` 每片只落盘一次。
 * - 任一单片失败都必须上抛,不把该片当成空结果静默降级。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { FileStorage } from 'vectra';
import { shardCountForBlocks, shardDirectoryName, shardIdForPath } from '../core/index-shard-routing';
import { AtomicIndexStorage } from './atomic-index-storage';
import {
	VectraStore,
	type FileReplacement,
	type PreparedBlock,
} from './vector-vectra';
import type { IndexStatus, SearchFilter, VectorSearchResult } from '../ports/vector';

/** 分片存储装配选项。 */
export interface ShardedStoreOptions {
	/** 分片根目录;实际索引落在 `<root>/shards/<hh>/`。 */
	root: string;
	/** 显式片数;缺省按总块数自适应。 */
	shardCount?: number;
	/** 总块数;仅在未显式指定片数时参与计算。 */
	totalBlocks?: number;
	/** 分片存储工厂;缺省使用原子索引存储。 */
	createStorage?: (shardRoot: string) => FileStorage;
	/**
	 * 单片 VectraStore 工厂;缺省在分片目录内直接构造。
	 *
	 * 关键路径:会话/装配侧可借它注入可观测或故障注入的单片实现,但片数、路由与
	 * 跨片归并语义仍由本适配器决定,注入方不能改变「同一路径只落一片」的契约。
	 */
	createStore?: (shardRoot: string, storage: FileStorage) => VectraStore;
}

/**
 * 装配侧可见的向量存储类型 — 单份与分片实现对上层保持同一方法语义。
 *
 * 关键路径:布局选择只发生在装配层;上层(日志、处理器、后端)拿到的是同一组方法,
 * 不按布局分支。需要一个具体实现时再按能力收窄(如 `getDocumentText` 仅单份布局提供)。
 */
export type IndexVectorStore = VectraStore | ShardedVectorStore;

/**
 * 分片向量存储 — 对上层保持单库语义,内部按路径哈希路由到多个分片。
 *
 * 关键路径:同一路径的所有块永远落在同一分片(路由与 journal 的 pathHash 同源),
 * 因此删除/替换无需跨片扫描;跨片查询在 {@link search} 内归并。
 */
export class ShardedVectorStore {
	private readonly stores = new Map<number, VectraStore>();
	private readonly batchShards = new Set<number>();
	private readonly count: number;
	private batchOpen = false;
	private readonly createStorage: (shardRoot: string) => FileStorage;
	private readonly createStore: (shardRoot: string, storage: FileStorage) => VectraStore;

	constructor(private readonly options: ShardedStoreOptions) {
		this.count = options.shardCount ?? shardCountForBlocks(options.totalBlocks ?? 0);
		this.createStorage = options.createStorage ?? ((shardRoot) => new AtomicIndexStorage({ generationRoot: shardRoot }));
		this.createStore = options.createStore ?? ((shardRoot, storage) => new VectraStore(shardRoot, { autoInit: false, storage: storage }));
	}

	/** 生效片数 — 显式配置优先,否则按总块数自适应。 */
	get shardCount(): number {
		return this.count;
	}

	/** 路径落到哪一片。 */
	shardIdOf(relativePath: string): number {
		return shardIdForPath(relativePath, this.count);
	}

	/** 分片号的目录名(两位十六进制)。 */
	shardDirectoryOf(shardId: number): string {
		return shardDirectoryName(shardId);
	}

	/** `shards/<hh>/` 绝对路径。 */
	shardRoot(shardId: number): string {
		return path.join(this.options.root, 'shards', shardDirectoryName(shardId));
	}

	/** 取(必要时创建)某片存储实例。 */
	private async storeOf(shardId: number): Promise<VectraStore> {
		const existing = this.stores.get(shardId);
		if (existing !== undefined) return existing;
		const root = this.shardRoot(shardId);
		const store = this.createStore(root, this.createStorage(root));
		await store.init();
		this.stores.set(shardId, store);
		return store;
	}

	/** 批内首次写入某片时补开该片事务,否则该片的写入会绕过批量合并。 */
	private async openBatchIfNeeded(shardId: number, store: VectraStore): Promise<void> {
		if (!this.batchOpen || this.batchShards.has(shardId)) return;
		await store.beginWriteBatch();
		this.batchShards.add(shardId);
	}

	/** 预热全部片 — 查询需要遍历所有片,提前建好实例避免首个请求抖动。 */
	async init(): Promise<void> {
		for (let shardId = 0; shardId < this.count; shardId += 1) await this.storeOf(shardId);
	}

	/** 用完整新块集合替换某路径 — 只触碰该路径所在分片。 */
	async replaceFile(input: FileReplacement): Promise<void> {
		const shardId = this.shardIdOf(input.path);
		const store = await this.storeOf(shardId);
		await this.openBatchIfNeeded(shardId, store);
		await store.replaceFile(input);
	}

	/** 删除某路径的全部块 — 只触碰该路径所在分片。 */
	async deleteByPath(relativePath: string): Promise<number> {
		const shardId = this.shardIdOf(relativePath);
		const store = await this.storeOf(shardId);
		await this.openBatchIfNeeded(shardId, store);
		return store.deleteByPath(relativePath);
	}

	/** 枚举某路径的当前块集合。 */
	async inspectFile(relativePath: string): Promise<PreparedBlock[]> {
		const store = await this.storeOf(this.shardIdOf(relativePath));
		return store.inspectFile(relativePath);
	}

	/** 批量枚举 — 按片分组,每片只做一次全量枚举。 */
	async inspectFiles(paths: string[]): Promise<Map<string, PreparedBlock[]>> {
		const grouped = new Map<number, string[]>();
		for (const relativePath of paths) {
			const shardId = this.shardIdOf(relativePath);
			const bucket = grouped.get(shardId);
			if (bucket === undefined) grouped.set(shardId, [relativePath]);
			else bucket.push(relativePath);
		}
		const merged = new Map<string, PreparedBlock[]>();
		for (const [shardId, group] of grouped) {
			const store = await this.storeOf(shardId);
			const partial = await store.inspectFiles(group);
			for (const [key, value] of partial) merged.set(key, value);
		}
		return merged;
	}

	/** 开始批量写入 — 之后的替换按片延迟提交。 */
	async beginWriteBatch(): Promise<void> {
		this.batchOpen = true;
		this.batchShards.clear();
	}

	/** 结束批量写入 — 每片只提交一次。 */
	async endWriteBatch(): Promise<void> {
		if (!this.batchOpen) return;
		this.batchOpen = false;
		const shards = [...this.batchShards].sort((left, right) => left - right);
		this.batchShards.clear();
		for (const shardId of shards) await this.stores.get(shardId)?.endWriteBatch();
	}

	/** 放弃批量写入 — 丢弃批内所有内存改动,磁盘保持批前状态。 */
	abortWriteBatch(): void {
		if (!this.batchOpen) return;
		this.batchOpen = false;
		for (const shardId of this.batchShards) this.stores.get(shardId)?.abortWriteBatch();
		this.batchShards.clear();
	}

	/** 当前是否处于批量写入。 */
	get inWriteBatch(): boolean {
		return this.batchOpen;
	}

	/** 跨片查询:每片取 topK 后按分数归并,返回单一有序 topK。 */
	async search(queryVector: number[], topK: number, filter?: SearchFilter): Promise<VectorSearchResult[]> {
		const lists = await Promise.all(
			[...this.stores.keys()]
				.sort((left, right) => left - right)
				.map(async (shardId) => this.stores.get(shardId)!.search(queryVector, topK, filter)),
		);
		// 关键路径:单片失败已经由 search 上抛,不会走到这里被当成空结果。
		const merged = lists.flat();
		merged.sort((left, right) => right.score - left.score);
		return merged.slice(0, topK);
	}

	/** 汇总全部片的状态。 */
	async status(): Promise<IndexStatus> {
		let totalDocs = 0;
		let lastIndexTime = 0;
		let isIndexing = false;
		for (const store of this.stores.values()) {
			const snapshot = await store.status();
			totalDocs += snapshot.totalDocs;
			lastIndexTime = Math.max(lastIndexTime, snapshot.lastIndexTime);
			isIndexing ||= snapshot.isIndexing;
		}
		return { totalDocs, lastIndexTime, isIndexing };
	}

	/** 重载全部片 — 提交失败后核对磁盘真值。 */
	async reload(): Promise<void> {
		for (const store of this.stores.values()) await store.reload();
	}

	/** 任一片需要重载即为真 — 上层据此拒绝用可能过期的内存视图继续查询。 */
	isReloadRequired(): boolean {
		for (const store of this.stores.values()) {
			if (store.isReloadRequired()) return true;
		}
		return false;
	}

	/**
	 * 分片布局是否已落盘 — 与 `VectraStore.isIndexCreated` 同语义的布局级判定。
	 *
	 * 关键路径:只看 `shards/layout.json`。空库只要 layout 存在就是「已建布局」,
	 * 不能按某片是否有块判定,否则热启动会被误判成首次建库而触发全量重建。
	 */
	async isIndexCreated(): Promise<boolean> {
		return fs.existsSync(path.join(this.options.root, 'shards', 'layout.json'));
	}

	/**
	 * 清空全部片的数据 — 与 `VectraStore.dropIndex` 对齐的清库入口。
	 *
	 * 关键路径:逐片走各自守卫后的删除,不直接递归删 `shards/` 根;layout 是布局标记,
	 * 清数据不改变片数,保留它才能让下一轮写入仍落在同一组片目录。
	 */
	async dropIndex(): Promise<void> {
		const shardIds = [...this.stores.keys()].sort((left, right) => left - right);
		for (const shardId of shardIds) {
			const store = this.stores.get(shardId);
			if (store !== undefined) await store.dropIndex();
		}
		this.stores.clear();
		this.batchShards.clear();
		this.batchOpen = false;
	}

	/** 仅测试使用 — 取指定分片的底层存储以注入故障。 */
	storeForTest(shardId: number): VectraStore {
		const store = this.stores.get(shardId);
		if (store === undefined) throw new Error(`分片 ${shardId} 尚未加载`);
		return store;
	}
}

/** 创建分片存储。 */
export function createShardedStore(options: ShardedStoreOptions): ShardedVectorStore {
	return new ShardedVectorStore(options);
}
