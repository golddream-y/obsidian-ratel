/**
 * @file tests/core/index-thread-backend.test.ts
 * @description 线程版后端 — 契约映射、失败如实计数与不支持操作的明确拒绝
 * @module tests/core/index-thread-backend
 */

import { describe, expect, it, vi } from 'vitest';
import { createThreadIndexBackend } from '../../src/core/index-thread-backend';

/** 组装后端与探针。 */
function makeBackend(overrides: { totalDocs?: number; ready?: boolean; committed?: number; failures?: number } = {}) {
	const client = {
		indexFile: vi.fn(async () => ({ chunkCount: 3 })),
		deleteFile: vi.fn(async () => ({ removed: 2 })),
		status: vi.fn(async () => ({ totalDocs: overrides.totalDocs ?? 5, written: 5 })),
	};
	const coordinator = {
		start: vi.fn(async () => ({
			committed: overrides.committed ?? 5,
			failures: overrides.failures ?? 0,
			total: 5,
		})),
		isReady: vi.fn(() => overrides.ready ?? true),
	};
	return { backend: createThreadIndexBackend(client, coordinator), client, coordinator };
}

describe('线程版后端', () => {
	it('全量重建 - 用协调器计数 - 不编造跳过数', async () => {
		const { backend, coordinator } = makeBackend({ committed: 4, failures: 1 });
		await expect(backend.fullReindex()).resolves.toEqual({ indexed: 4, errors: 1 });
		await expect(backend.smartReindex?.()).resolves.toEqual({ indexed: 4, errors: 1, skipped: 0 });
		expect(coordinator.start).toHaveBeenCalledTimes(2);
	});

	it('增量写入 - 交线程处理 - 返回块数', async () => {
		const { backend, client } = makeBackend();
		await expect(backend.incrementalIndex({ path: 'a.md', content: '正文' })).resolves.toEqual({
			indexed: 1,
			errors: 0,
			chunkCount: 3,
		});
		expect(client.indexFile).toHaveBeenCalledWith('a.md', '正文');
	});

	it('删除与状态 - 透传线程读数', async () => {
		const { backend } = makeBackend({ totalDocs: 2, ready: false });
		await expect(backend.deleteFile('a.md')).resolves.toBe(2);
		await expect(backend.isIndexCreated?.()).resolves.toBe(true);
		await expect(backend.isIndexComplete?.()).resolves.toBe(false);
	});

	it('删除整个索引目录 - 明确拒绝 - 不静默成功', async () => {
		const { backend } = makeBackend();
		await expect(backend.dropIndex?.()).rejects.toThrow('不支持直接删除索引目录');
	});
});
