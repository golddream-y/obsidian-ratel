/**
 * @file src/core/persistent-index-backend.ts
 * @description 索引快照、差异更新与成功元数据提交
 * @module core/persistent-index-backend
 * @depends worker/manager, core/index-manifest, core/index-build-stamp
 *
 * 设计要点:
 * - 整批返回只汇总统计,不再承担唯一提交职责:文件级有效性由 T3 的文件完成记录决定,
 *   本模块负责启动期 hash diff、调用 Worker 与维护「清单 + 构建戳」这份派生视图。
 * - 不再有整库失效操作:任何一次写失败都不允许抹掉其他文件已提交的凭据。
 * - `isIndexComplete` 检查本轮扫描/队列/失败与持久凭据,注入文件记录端口后还要求记录覆盖清单;
 *   本轮失败计数只在扫描成功时清零(scan 级语义),单文件提交成功不得清零。
 * - 部分检索可用性读文件记录(排除 tombstone 与不可用路径),不读全量清单布尔值。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { VectraStore } from '../adapters/vector-vectra';
import type { WorkerManager } from '../worker/manager';
import type { ChunkOptionsPayload, WorkerResponse } from '../types';
import type { CommittedIndexState, IndexBackend } from './index-manager';
import { IndexManifest, type IndexManifestData } from './index-manifest';
import { resolveBuildStampPath, readBuildStamp, isBuildStampCurrent, writeBuildStamp, type IndexBuildStamp } from './index-build-stamp';
import { sha256 } from '../utils/hash';
import { tNow } from '../i18n';
interface IndexSnapshot {
	path: string;
	content: string;
	mtime: number;
	hash: string;
}
interface IndexResult {
	indexed: number;
	errors: number;
}

/**
 * 完成记录的最小结构视图 — 与 T1/T3 的 `FileCommit` 结构兼容。
 *
 * 关键路径:结构化端口避免把日志实现绑进后端,同时保证 `IndexFileJournal` 可直接注入。
 */
export interface CommittedFileRecord {
	/** vault 规范化相对路径。 */
	path: string;
	/** 版本状态。 */
	state: 'present' | 'deleted';
	/** 同路径单调递增版本号。 */
	revision: number;
	/** 输入内容 hash;删除记录为 null。 */
	inputHash: string | null;
	/** 块数量。 */
	chunkCount: number;
}

/**
 * 文件完成记录读取端口 — 由 T3 的 `IndexFileJournal` 实现。
 *
 * 关键路径:部分检索可用性与完整性判定必须读文件记录,不能只凭全量清单布尔值。
 * 端口语义与 `IndexFileJournal` 一一对应,是明确的二分,不允许互相混入:
 * - `listReceipts` 只返回 `state === 'present'` 的完成记录,删除路径一律不在其中;
 * - `listTombstones` 是删除凭据(tombstone)的唯一出口;
 * - `listSearchableReceipts` 再扣除隔离/不可用路径。
 *
 * 为什么必须二分:把 tombstone 当作「已提交」会让可见性门放过已删除路径(T7),
 * 而把删除凭据从 present 集里漏掉又会读空集,两者都会造出错误的「已完成」结论。
 */
export interface FileRecordReader {
	/** 全部可信的 present 完成记录(不含删除凭据)。 */
	listReceipts(): Promise<ReadonlyArray<CommittedFileRecord>>;
	/** 全部可信的删除凭据(tombstone);与 `listReceipts` 互斥,同一路径当前只出现在一侧。 */
	listTombstones(): Promise<ReadonlyArray<CommittedFileRecord>>;
	/** 可检索的完成记录 — 已排除 tombstone 与不可用路径。 */
	listSearchableReceipts(): Promise<ReadonlyArray<CommittedFileRecord>>;
}

/** 部分检索可用性视图。 */
export interface SearchableFileRecords {
	/** 可检索文件总数。 */
	total: number;
	/** 可检索文件记录。 */
	records: ReadonlyArray<CommittedFileRecord>;
}

/** 本轮索引运行的实时状态 — 判定「全库完成」不能只看持久凭据。 */
export interface IndexRoundState {
	/** 本轮扫描是否已结束。 */
	scanComplete: boolean;
	/** 待处理队列长度。 */
	queued: number;
	/** 在途提交数。 */
	active: number;
	/** 未决事务数。 */
	pendingTransactions: number;
	/** 本轮未清除的失败数。 */
	failures: number;
}

/** 协调器提供的队列/在途/未决事务计数。 */
export interface IndexRoundCounters {
	/** 待处理队列长度。 */
	queued: number;
	/** 在途提交数。 */
	active: number;
	/** 未决事务数。 */
	pendingTransactions: number;
}

/** 装配端口通过 getter 读取，兼容模型就绪后替换 VectraStore 的生命周期。 */
export interface PersistentIndexBackendOptions {
	indexDir: string;
	manifest: IndexManifest;
	worker: WorkerManager;
	getStore: () => VectraStore;
	vault: {
		listMarkdownFiles(): string[];
		readFile(path: string): Promise<string>;
		stat(path: string): {
			mtime: number;
		} | null;
	};
	getBuildStamp: () => IndexBuildStamp;
	getChunkOptions: () => ChunkOptionsPayload;
	/**
	 * 可选:文件完成记录端口;注入后完整性判定与部分可用性读取文件记录。
	 *
	 * 缺省风险(T7 待办):未注入时 `fileRecordsCoverManifest` 只能按「既有凭据」语义返回 true,
	 * 也就是无法核验「清单里的每个文件都真有完成记录」。这不是「已核验」,
	 * 但当前生产装配尚未注入,若改成「缺端口即不完整」会让每次启动都判不完整并触发重建,
	 * 因此这里保留既有语义,由 T7 装配时注入 `IndexFileJournal`(守卫用例登记装配点)。
	 */
	fileRecords?: FileRecordReader | null;
	/**
	 * 可选:本轮队列/在途/未决事务计数;未注入时按 0 计。
	 *
	 * 缺省风险(T7 待办):计数缺失时会得到「队列已空、无在途、无未决事务」的结论,
	 * 装配遗漏时仍可能宣告完成;装配点必须保证协调器计数器注入。
	 */
	getRoundCounters?: () => IndexRoundCounters;
}
/**
 * 统一持久化入口:输入快照决定向量与清单;整批结果只汇总统计,不再承担唯一提交职责。
 *
 * 关键路径:文件级有效性由文件完成记录决定,本模块的清单与构建戳只是可重建的派生视图;
 * 任一写失败都不得抹掉其他文件已提交的凭据(整库失效操作已移除)。
 */
export class PersistentIndexBackend implements IndexBackend {
	private tail: Promise<unknown> = Promise.resolve();
	/** 本轮扫描/失败状态 — 完整性判定必须看本轮状态,不只看持久凭据。 */
	private round = { scanComplete: false, failures: 0 };
	constructor(private deps: PersistentIndexBackendOptions) {}

	/** 启动时对已成功提交的清单做 hash diff；未知完整性的旧索引保守重建一次。 */
	smartReindex(): Promise<IndexResult & {
		skipped: number;
	}> {
		return this.serialize(() => this.runScan(async () => {
			const stamp = this.deps.getBuildStamp();
			const chunkOptions = this.deps.getChunkOptions();
			const manifest = await this.deps.manifest.load();
			const exists = await this.isIndexCreated();
			if (!exists || !manifest || this.deps.manifest.shouldFullRebuild(manifest, stamp.embedModelId, stamp.chunkSize, stamp.chunkOverlap, stamp.chunkerVersion)) {
				// 关键路径:只在缺少有效清单或参数不兼容时重建，不把运行失败当作损坏。
				if (exists)
					await this.dropStore();
				return { ...await this.full(), skipped: 0 };
			}
			const files = await this.snapshot();
			const diff = this.deps.manifest.diff(manifest, files);
			const changed = new Set([...diff.toAdd, ...diff.toUpdate].map(file => file.path));
			const toEmbed = files.filter(file => changed.has(file.path));
			if (toEmbed.length === 0 && diff.toDelete.length === 0) {
				await this.commit(manifest, stamp);
				return { indexed: 0, errors: 0, skipped: diff.unchanged.length };
			}
			// 关键路径:这里不再删除全库清单与构建戳 —— 已提交文件的凭据必须跨本次失败保留。
			let indexed = 0;
			if (toEmbed.length > 0) {
				const response = await this.deps.worker.request({
					type: 'index.batch', payload: { files: toEmbed, chunkOptions },
				});
				this.requireSuccess(response);
				if (response.type !== 'index.batch.done')
					throw this.unexpectedResponse();
				indexed = response.payload.indexed;
				for (const file of toEmbed) {
					const count = response.payload.chunkCounts[file.path];
					if (count === undefined)
						throw this.unexpectedResponse();
					this.deps.manifest.recordEntry(manifest, file.path, file.hash, file.mtime, count);
				}
			}
			for (const filePath of diff.toDelete) {
				await this.deleteVectors(filePath);
				this.deps.manifest.removeEntry(manifest, filePath);
			}
			await this.commit(manifest, stamp);
			return { indexed, errors: 0, skipped: diff.unchanged.length };
		}));
	}

	/** 手动全量入口；只有所有输入文件与元数据都写成功才返回。 */
	fullReindex(): Promise<IndexResult> {
		return this.serialize(() => this.runScan(() => this.full()));
	}

	/** 单文件更新与清单提交使用相同输入内容；失败后清单保持无效。 */
	incrementalIndex(file: {
		path: string;
		content: string;
	}): Promise<IndexResult> {
		return this.serialize(() => this.runUnit(async () => {
			const data = await this.deps.manifest.load();
			const stamp = this.deps.getBuildStamp();
			const chunkOptions = this.deps.getChunkOptions();
			const response = await this.deps.worker.request({
				type: 'index.incremental', payload: { file, chunkOptions },
			});
			this.requireSuccess(response);
			if (response.type !== 'index.done')
				throw this.unexpectedResponse();
			if (data) {
				// 关键路径:事件内容可能早于当前 stat；mtime=0 强制下次启动用 hash 核实。
				this.deps.manifest.recordEntry(data, file.path, await sha256(file.content), 0, response.payload.chunkCount ?? 0);
				await this.commit(data, stamp);
			}
			return response.payload;
		}));
	}

	/** 删除向量成功后再移除清单条目。 */
	deleteFile(filePath: string): Promise<number> {
		return this.serialize(() => this.runUnit(async () => {
			const data = await this.deps.manifest.load();
			const stamp = this.deps.getBuildStamp();
			const count = await this.deleteVectors(filePath);
			if (data) {
				this.deps.manifest.removeEntry(data, filePath);
				await this.commit(data, stamp);
			}
			return count;
		}));
	}

	/**
	 * 清库同样经过 WorkerManager 写通道，超时仍在运行的旧任务不能与之重叠。
	 *
	 * 关键路径:这里重置的是**整轮**状态(含 `scanComplete=false`),不是「提交成功」信号 ——
	 * 清库后任何文件都不再有可信凭据,`isIndexComplete` 仍会因扫描未完成而返回 false。
	 */
	dropIndex(): Promise<void> {
		return this.serialize(async () => {
			this.round.scanComplete = false;
			this.round.failures = 0;
			await this.dropStore();
		});
	}

	/** 查询当前向量目录。 */
	isIndexCreated(): Promise<boolean> {
		return this.deps.getStore().isIndexCreated();
	}

	/**
	 * 本轮索引状态 — 完整性判定与展示读取同一份状态。
	 *
	 * 关键路径:未注入协调器计数器时按 0 计(队列空、无在途、无未决事务),
	 * 这是「缺省即无待处理」的乐观语义 —— 装配遗漏不会在这里暴露,由装配守卫与 T7 装配点负责。
	 *
	 * @returns 本轮扫描/失败状态与协调器计数器(未注入计数器时按 0 计)。
	 */
	roundState(): IndexRoundState {
		const counters = this.deps.getRoundCounters?.() ?? { queued: 0, active: 0, pendingTransactions: 0 };
		return {
			scanComplete: this.round.scanComplete,
			failures: this.round.failures,
			queued: counters.queued,
			active: counters.active,
			pendingTransactions: counters.pendingTransactions,
		};
	}

	/**
	 * 检查本轮索引是否真的完成 — 本轮扫描/队列/失败与持久凭据共同决定。
	 *
	 * 关键路径:全量清单布尔值不能替代本轮状态;注入文件记录端口后还要求
	 * 清单每个条目都能在文件记录里找到同 hash 的 present 版本。
	 * 本轮失败只有「扫描重跑成功」才清除,单文件提交成功不清零(见 `runScan` 语义边界)。
	 *
	 * @returns 本轮扫描结束、队列与在途清空、无失败、凭据可信且记录覆盖时为 true。
	 */
	async isIndexComplete(): Promise<boolean> {
		const round = this.roundState();
		if (!round.scanComplete || round.queued > 0 || round.active > 0 || round.pendingTransactions > 0 || round.failures > 0) {
			return false;
		}
		if (!await this.credentialsCurrent()) return false;
		return this.fileRecordsCoverManifest();
	}

	/**
	 * 部分检索可用性 — 只读文件记录,排除 tombstone 与不可用路径。
	 *
	 * @returns 可检索记录视图;未注入文件记录端口时为 null(不可判定,不能当作空集)。
	 */
	async searchableFileRecords(): Promise<SearchableFileRecords | null> {
		const reader = this.deps.fileRecords;
		if (!reader) return null;
		const records = await reader.listSearchableReceipts();
		return { total: records.length, records };
	}

    /** 只读验证已提交元数据与索引存在性，不初始化存储、不读取vault、不修写凭据。 */
    readCommittedState(): Promise<CommittedIndexState | null> {
        return this.serialize(() => this.deps.worker.runExclusive(async () => {
            const data = await this.deps.manifest.load();
            const stamp = this.deps.getBuildStamp();
            if (!data || data.version !== 1 || !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)
                || !Number.isFinite(data.lastIndexTime) || data.lastIndexTime < 0
                || this.deps.manifest.shouldFullRebuild(data, stamp.embedModelId, stamp.chunkSize, stamp.chunkOverlap, stamp.chunkerVersion)
                || !isBuildStampCurrent(await readBuildStamp(this.deps.indexDir), stamp)) return null;
            for (const [filePath, entry] of Object.entries(data.entries)) {
                if (!entry || entry.path !== filePath || typeof entry.hash !== 'string'
                    || !Number.isFinite(entry.mtime) || !Number.isInteger(entry.chunkCount) || entry.chunkCount < 0) return null;
            }
            try {
                // 关键路径:VectraStore.isIndexCreated会触发懒初始化；此处必须直接只读检查磁盘。
                if (!(await fs.promises.stat(path.join(this.deps.indexDir, 'index.json'))).isFile()) return null;
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
                throw err;
            }
            return { totalDocs: Object.keys(data.entries).length, lastIndexTime: data.lastIndexTime };
        }));
    }

	/** 读取用于索引的文件内容快照。 */
	async listMarkdownFiles(): Promise<Array<{
		path: string;
		content: string;
	}>> {
		return this.snapshot();
	}
	private async full(): Promise<IndexResult> {
		const stamp = this.deps.getBuildStamp();
		const chunkOptions = this.deps.getChunkOptions();
		const files = await this.snapshot();
		const response = await this.deps.worker.request({
			type: 'index.full', payload: { files, chunkOptions },
		});
		this.requireSuccess(response);
		if (response.type !== 'index.done')
			throw this.unexpectedResponse();
		const data: IndexManifestData = { version: 1, ...stamp, entries: {}, lastIndexTime: Date.now() };
		for (const file of files)
			this.deps.manifest.recordEntry(data, file.path, file.hash, file.mtime, 0);
		await this.commit(data, stamp);
		return response.payload;
	}
	private async snapshot(): Promise<IndexSnapshot[]> {
		const files: IndexSnapshot[] = [];
		for (const filePath of this.deps.vault.listMarkdownFiles()) {
			// 关键路径:先 stat 再读内容；索引期间的后续修改不能被标为本次已处理。
			const mtime = this.deps.vault.stat(filePath)?.mtime ?? 0;
			const content = await this.deps.vault.readFile(filePath);
			files.push({ path: filePath, content, mtime, hash: await sha256(content) });
		}
		return files;
	}
	private async deleteVectors(filePath: string): Promise<number> {
		const response = await this.deps.worker.request({ type: 'index.delete', payload: { filePath } });
		if (response.type !== 'vector.delete.done')
			throw this.unexpectedResponse();
		return response.payload.count;
	}
	private async dropStore(): Promise<void> {
		await this.deps.worker.runExclusive(() => this.deps.getStore().dropIndex());
	}
	/**
	 * 本轮扫描的状态跟踪 — 成功才标记扫描结束,失败按次累加。
	 *
	 * 语义边界(scan 级):`failures` 的**唯一清零点**在这里的成功分支 ——
	 * 只有「本轮扫描重跑并成功」才能证明全库被重新核实。`commit()` 属于单文件提交,
	 * 成功后不清零本轮失败计数,否则「A 文件失败 + B 文件成功」会被静默说成全库完成。
	 */
	private async runScan<T>(operation: () => Promise<T>): Promise<T> {
		this.round.scanComplete = false;
		try {
			const result = await operation();
			this.round.scanComplete = true;
			this.round.failures = 0;
			return result;
		} catch (error) {
			this.round.failures += 1;
			throw error;
		}
	}
	/**
	 * 单文件任务的状态跟踪(unit 级) — 失败计入本轮失败,不能被后续成功静默掩盖。
	 *
	 * 语义边界:这里只累加、不清零;清零只发生在 `runScan` 成功分支,
	 * 因此「本次扫描成功」与「某个文件后来补提交成功」在状态上是两件不同的事。
	 */
	private async runUnit<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			this.round.failures += 1;
			throw error;
		}
	}
	/** 持久凭据是否可信(清单存在、参数兼容、构建戳一致)。 */
	private async credentialsCurrent(): Promise<boolean> {
		const data = await this.deps.manifest.load();
		const stamp = this.deps.getBuildStamp();
		if (!data || this.deps.manifest.shouldFullRebuild(data, stamp.embedModelId, stamp.chunkSize, stamp.chunkOverlap, stamp.chunkerVersion)) return false;
		return isBuildStampCurrent(await readBuildStamp(this.deps.indexDir), stamp);
	}
	/**
	 * 清单条目是否都有对应的文件完成记录 — 清单是派生视图,文件记录才描述每个文件。
	 *
	 * 关键路径:未注入记录端口时保持既有凭据语义(无法判定不伪装成已核验),返回 true;
	 * 这是缺省乐观语义,装配遗漏时会让 `isIndexComplete` 少一道核对,风险与 T7 待办见
	 * `PersistentIndexBackendOptions.fileRecords`。这里只消费 present 集:
	 * tombstone 由 `listTombstones` 提供,不得当作「该路径已提交」。
	 */
	private async fileRecordsCoverManifest(): Promise<boolean> {
		const reader = this.deps.fileRecords;
		if (!reader) return true;
		const data = await this.deps.manifest.load();
		if (!data) return false;
		const records = await reader.listReceipts();
		const byPath = new Map<string, CommittedFileRecord>();
		for (const record of records) {
			// 端口语义是 present-only;这里仍按 state 过滤,防止实现把 tombstone 混进来。
			if (record.state === 'present') byPath.set(record.path, record);
		}
		for (const [filePath, entry] of Object.entries(data.entries)) {
			const record = byPath.get(filePath);
			if (!record || record.inputHash !== entry.hash) return false;
		}
		return true;
	}
	/**
	 * 提交「清单 + 构建戳」这份派生视图。
	 *
	 * 关键路径:
	 * - **不触碰本轮失败计数**:`commit` 是 `incrementalIndex` / `deleteFile` 的唯一提交出口,
	 *   单文件提交成功不能证明本轮失败已消除(清零只发生在 `runScan` 成功分支),
	 *   否则「A 文件失败 → B 文件成功」会被静默说成全库完成。
	 * - 清单最后提交,构建戳自身不能证明任何文件内容已索引;失败时只回滚本次已写的构建戳,
	 *   **必须恢复提交前的既有戳**,而不是一律删除 —— 既有「清单 + 戳」是有效凭据,
	 *   一次写失败不得抹掉其他文件已提交的凭据(整库失效操作已移除)。
	 */
	private async commit(data: IndexManifestData, stamp: IndexBuildStamp): Promise<void> {
		data.lastIndexTime = Date.now();
		// 关键路径:写戳前记录既有戳,失败回滚时按原样恢复(没有旧戳才删除)。
		const previousStamp = await readBuildStamp(this.deps.indexDir);
		let stampWritten = false;
		try {
			await writeBuildStamp(this.deps.indexDir, stamp);
			stampWritten = true;
			await this.deps.manifest.save(data);
		}
		catch (err) {
			if (stampWritten) {
				try {
					if (previousStamp) await writeBuildStamp(this.deps.indexDir, previousStamp);
					else await fs.promises.rm(resolveBuildStampPath(this.deps.indexDir), { force: true });
				}
				catch {
					// 回滚失败不遮蔽原始错误:无清单佐证的构建戳会在下次启动被判定为缺失。
				}
			}
			throw err;
		}
	}
	private requireSuccess(response: WorkerResponse): void {
		if (response.type !== 'index.done' && response.type !== 'index.batch.done')
			throw this.unexpectedResponse();
		if (response.payload.errors > 0)
			throw new Error(tNow('notice.indexPartialFailure', { count: response.payload.errors }));
	}
	private unexpectedResponse(): Error {
		return new Error(tNow('notice.indexResponseFailed'));
	}
	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const task = this.tail.then(operation);
		this.tail = task.catch(() => undefined);
		return task;
	}
}
