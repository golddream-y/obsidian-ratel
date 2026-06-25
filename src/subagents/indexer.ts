/**
 * @file src/subagents/indexer.ts
 * @description Indexer subagent — 封装 IndexController,供其他子代理通过统一接口触发索引操作
 * @module subagents/indexer
 * @depends adapters/obsidian-vault, core/index-controller
 */

import type { ObsidianVault } from '../adapters/obsidian-vault';
import type { IndexController } from '../core/index-controller';

/**
 * Indexer subagent 依赖。
 */
export interface IndexerDeps {
	vault: ObsidianVault;
	indexController: IndexController;
}

/**
 * Indexer subagent — 索引操作子代理。
 *
 * 设计要点:
 * - 封装 IndexController,让其他子代理(如 Librarian)能通过统一接口触发索引操作,
 *   不直接调 IndexController(降低耦合)。
 * - 全量重建委托给 `indexController.reindex`(后者走 IndexManager.reindex → backend.fullReindex)。
 * - 增量索引先读文件全文,再 enqueue 到 IndexManager(去抖 + 批处理由 IndexController 内部处理)。
 * - 删除文件不读内容,直接 enqueue delete。
 *
 * @example
 *   const indexer = new Indexer({ vault, indexController });
 *   await indexer.fullReindex();
 *   await indexer.indexFile('notes/new.md');
 *   await indexer.deleteFile('notes/gone.md');
 */
export class Indexer {
	constructor(private deps: IndexerDeps) {}

	/**
	 * 全量重建索引 — 遍历 vault 所有 markdown 文件,送 Worker 索引。
	 *
	 * 关键路径:委托给 `indexController.reindex`,后者清队列 + 走全量。
	 *
	 * @returns 索引统计(indexed 为文件数;当前实现通过 vault.listMarkdownFiles 推断)。
	 */
	async fullReindex(): Promise<{ indexed: number; errors: number }> {
		await this.deps.indexController.reindex();
		// 关键路径:reindex 不返回统计,这里用 vault 文件数近似(实际索引数由 Worker 返回,subagent 层不深究)。
		const totalFiles = this.deps.vault.listMarkdownFiles().length;
		return { indexed: totalFiles, errors: 0 };
	}

	/**
	 * 增量索引 — 单文件变更后送 Worker。
	 *
	 * 关键路径:先读文件全文,再 enqueue 'upsert'。IndexController 内部去抖 + 批处理。
	 *
	 * @param path - vault 相对路径。
	 * @throws 文件不存在时 readFile 抛错,透传给调用方。
	 */
	async indexFile(path: string): Promise<void> {
		const content = await this.deps.vault.readFile(path);
		this.deps.indexController.indexManager.enqueue(path, 'upsert', content);
	}

	/**
	 * 删除文件的所有 chunk。
	 *
	 * 关键路径:不读文件内容,直接 enqueue 'delete'。
	 *
	 * @param path - vault 相对路径。
	 */
	async deleteFile(path: string): Promise<void> {
		this.deps.indexController.indexManager.enqueue(path, 'delete');
	}
}
