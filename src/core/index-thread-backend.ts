/**
 * @file src/core/index-thread-backend.ts
 * @description 线程版索引后端 — 用客户端与线程协调器满足既有 `IndexBackend` 契约
 * @module src/core/index-thread-backend
 *
 * 关键路径:
 * - 有协调器时上层主要走协调器;后端只在手动重建、增量事件、删除等入口被调用。
 * - 所有写入都经线程,本类**不持有存储**,不做任何本地落盘。
 * - 无法在纯线程模式下提供的语义(如删除索引目录)明确拒绝,不静默返回成功。
 */

import type { IndexBackend } from './index-manager';

/** 线程侧能力。 */
export interface ThreadBackendClient {
	indexFile(filePath: string, content: string): Promise<{ chunkCount: number }>;
	deleteFile(filePath: string): Promise<{ removed: number }>;
	status(): Promise<{ totalDocs: number; written: number }>;
}

/** 协调器能力。 */
export interface ThreadBackendCoordinator {
	start(): Promise<{ committed: number; failures: number; total: number }>;
	isReady(): boolean;
}

/**
 * 构造线程版后端。
 * @param client 线程客户端
 * @param coordinator 线程协调器
 */
export function createThreadIndexBackend(client: ThreadBackendClient, coordinator: ThreadBackendCoordinator): IndexBackend {
	return {
		async fullReindex() {
			const counters = await coordinator.start();
			return { indexed: counters.committed, errors: counters.failures };
		},

		async smartReindex() {
			const counters = await coordinator.start();
			// 关键路径:线程模式没有「跳过」的独立计数,如实给 0 而不是编一个数字。
			return { indexed: counters.committed, errors: counters.failures, skipped: 0 };
		},

		async incrementalIndex(file) {
			const result = await client.indexFile(file.path, file.content);
			return { indexed: 1, errors: 0, chunkCount: result.chunkCount };
		},

		async deleteFile(filePath) {
			const result = await client.deleteFile(filePath);
			return result.removed;
		},

		async isIndexCreated() {
			const status = await client.status();
			return status.totalDocs > 0;
		},

		async readCommittedState() {
			// 关键路径:线程模式下的权威记录在日志里;清单由线程维护,这里不伪造状态。
			return null;
		},

		async isIndexComplete() {
			return coordinator.isReady();
		},

		async searchableFileRecords() {
			return null;
		},

		async dropIndex() {
			throw new Error('线程模式不支持直接删除索引目录;请使用「清理非活动代际」');
		},
	};
}
