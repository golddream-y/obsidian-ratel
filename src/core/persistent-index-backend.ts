/**
 * @file src/core/persistent-index-backend.ts
 * @description 索引快照、差异更新与成功元数据提交
 * @module core/persistent-index-backend
 * @depends worker/manager, core/index-manifest, core/index-build-stamp
 */
import fs from 'node:fs';
import type { VectraStore } from '../adapters/vector-vectra';
import type { WorkerManager } from '../worker/manager';
import type { ChunkOptionsPayload, WorkerResponse } from '../types';
import type { IndexBackend } from './index-manager';
import { IndexManifest, resolveIndexManifestPath, type IndexManifestData } from './index-manifest';
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
}
/**
 * 统一持久化入口：输入快照决定向量与清单，成功必须完成向量、清单、构建戳三步。
 * 所有写入前先撤销成功凭据；任一步失败都不能让下次启动误判已经完整索引。
 */
export class PersistentIndexBackend implements IndexBackend {
	private tail: Promise<unknown> = Promise.resolve();
	constructor(private deps: PersistentIndexBackendOptions) {}

	/** 启动时对已成功提交的清单做 hash diff；未知完整性的旧索引保守重建一次。 */
	smartReindex(): Promise<IndexResult & {
		skipped: number;
	}> {
		return this.serialize(async () => {
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
			await this.invalidateMetadata();
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
		});
	}

	/** 手动全量入口；只有所有输入文件与元数据都写成功才返回。 */
	fullReindex(): Promise<IndexResult> {
		return this.serialize(() => this.full());
	}

	/** 单文件更新与清单提交使用相同输入内容；失败后清单保持无效。 */
	incrementalIndex(file: {
		path: string;
		content: string;
	}): Promise<IndexResult> {
		return this.serialize(async () => {
			const data = await this.deps.manifest.load();
			const stamp = this.deps.getBuildStamp();
			const chunkOptions = this.deps.getChunkOptions();
			await this.invalidateMetadata();
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
		});
	}

	/** 删除向量成功后再移除清单条目。 */
	deleteFile(filePath: string): Promise<number> {
		return this.serialize(async () => {
			const data = await this.deps.manifest.load();
			const stamp = this.deps.getBuildStamp();
			await this.invalidateMetadata();
			const count = await this.deleteVectors(filePath);
			if (data) {
				this.deps.manifest.removeEntry(data, filePath);
				await this.commit(data, stamp);
			}
			return count;
		});
	}

	/** 清库同样经过 WorkerManager 写通道，超时仍在运行的旧任务不能与之重叠。 */
	dropIndex(): Promise<void> {
		return this.serialize(() => this.dropStore());
	}

	/** 查询当前向量目录。 */
	isIndexCreated(): Promise<boolean> {
		return this.deps.getStore().isIndexCreated();
	}

	/** 检查全库持久化凭据；单文件成功不能替代完整清单。 */
	async isIndexComplete(): Promise<boolean> {
		const data = await this.deps.manifest.load();
		const stamp = this.deps.getBuildStamp();
		return !!data && !this.deps.manifest.shouldFullRebuild(data, stamp.embedModelId, stamp.chunkSize, stamp.chunkOverlap, stamp.chunkerVersion) && isBuildStampCurrent(await readBuildStamp(this.deps.indexDir), stamp);
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
		await this.invalidateMetadata();
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
	private async invalidateMetadata(): Promise<void> {
		for (const file of [resolveIndexManifestPath(this.deps.indexDir), resolveBuildStampPath(this.deps.indexDir)]) {
			await fs.promises.rm(file, { force: true });
		}
	}
	private async commit(data: IndexManifestData, stamp: IndexBuildStamp): Promise<void> {
		data.lastIndexTime = Date.now();
		try {
			// 关键路径:清单最后提交；构建戳自身不能证明任何文件内容已索引。
			await writeBuildStamp(this.deps.indexDir, stamp);
			await this.deps.manifest.save(data);
		}
		catch (err) {
			await this.invalidateMetadata();
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
