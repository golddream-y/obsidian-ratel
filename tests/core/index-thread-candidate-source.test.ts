/**
 * @file tests/core/index-thread-candidate-source.test.ts
 * @description 线程候选来源 — 命中映射、空路径丢弃与调用透传
 * @module tests/core/index-thread-candidate-source
 */

import { describe, expect, it, vi } from 'vitest';
import { createThreadCandidateSource } from '../../src/core/index-thread-candidate-source';

describe('线程候选来源', () => {
	it('命中映射 - 文档级标识用路径 - 块号进 metadata', async () => {
		const client = {
			searchByVector: vi.fn(async () => [
				{ path: 'a.md', score: 0.9, chunkIndex: 2 },
				{ docId: 'b.md', path: 'b.md', score: 0.5, chunkIndex: null },
			]),
		};
		const source = createThreadCandidateSource(client);
		const results = await source.search([0.1, 0.2], 7);
		expect(client.searchByVector).toHaveBeenCalledWith([0.1, 0.2], 7);
		expect(results).toEqual([
			{ docId: 'a.md', score: 0.9, metadata: { path: 'a.md', chunkIndex: 2 } },
			{ docId: 'b.md', score: 0.5, metadata: { path: 'b.md', chunkIndex: null } },
		]);
	});

	it('空路径命中 - 直接丢弃 - 不制造假文档标识', async () => {
		const client = { searchByVector: async () => [{ path: '', score: 1, chunkIndex: 0 }] };
		const source = createThreadCandidateSource(client);
		await expect(source.search([0.1], 5)).resolves.toEqual([]);
	});

	it('线程查询失败 - 错误上抛 - 由编排层按 Worker 失败同语义处理', async () => {
		const client = { searchByVector: async () => { throw new Error('线程已停止'); } };
		const source = createThreadCandidateSource(client);
		await expect(source.search([0.1], 5)).rejects.toThrow('线程已停止');
	});
});
