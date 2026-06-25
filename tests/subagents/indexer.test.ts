/**
 * @file tests/subagents/indexer.test.ts
 * @description Indexer subagent 单元测试
 * @module tests/subagents/indexer
 * @depends src/subagents/indexer, src/adapters/obsidian-vault, src/core/index-controller
 */

import { describe, it, expect, vi } from 'vitest';
import { Indexer } from '../../src/subagents/indexer';
import type { ObsidianVault } from '../../src/adapters/obsidian-vault';
import type { IndexController } from '../../src/core/index-controller';

function createMockVault(): ObsidianVault {
	return {
		readFile: vi.fn(async (path: string) => `content-of-${path}`),
		listMarkdownFiles: vi.fn(() => ['a.md', 'b.md']),
	} as unknown as ObsidianVault;
}

function createMockIndexController(): IndexController {
	return {
		reindex: vi.fn().mockResolvedValue(undefined),
		indexManager: {
			enqueue: vi.fn(),
		},
	} as unknown as IndexController;
}

describe('Indexer', () => {
	it('fullReindex - 调用 indexController.reindex', async () => {
		const vault = createMockVault();
		const indexController = createMockIndexController();
		const indexer = new Indexer({ vault, indexController });

		const result = await indexer.fullReindex();

		// 关键路径:委托给 indexController.reindex,后者走全量重建
		expect(indexController.reindex).toHaveBeenCalledTimes(1);
		expect(result.indexed).toBeGreaterThan(0);
	});

	it('indexFile - 读取文件内容 + enqueue upsert', async () => {
		const vault = createMockVault();
		const indexController = createMockIndexController();
		const indexer = new Indexer({ vault, indexController });

		await indexer.indexFile('notes/foo.md');

		// 关键路径:先读文件全文,再 enqueue 到 IndexManager
		expect(vault.readFile).toHaveBeenCalledWith('notes/foo.md');
		expect(indexController.indexManager.enqueue).toHaveBeenCalledWith(
			'notes/foo.md',
			'upsert',
			'content-of-notes/foo.md',
		);
	});

	it('indexFile - 文件不存在 - readFile 抛错透传', async () => {
		const vault = {
			readFile: vi.fn().mockRejectedValue(new Error('File not found: missing.md')),
		} as unknown as ObsidianVault;
		const indexController = createMockIndexController();
		const indexer = new Indexer({ vault, indexController });

		// 关键路径:readFile 失败时透传错误,让调用方决定处理方式
		await expect(indexer.indexFile('missing.md')).rejects.toThrow('File not found: missing.md');
		expect(indexController.indexManager.enqueue).not.toHaveBeenCalled();
	});

	it('deleteFile - enqueue delete(不读文件)', async () => {
		const vault = createMockVault();
		const indexController = createMockIndexController();
		const indexer = new Indexer({ vault, indexController });

		await indexer.deleteFile('notes/gone.md');

		// 关键路径:删除不需要读文件内容,直接 enqueue delete
		expect(vault.readFile).not.toHaveBeenCalled();
		expect(indexController.indexManager.enqueue).toHaveBeenCalledWith(
			'notes/gone.md',
			'delete',
		);
	});
});
