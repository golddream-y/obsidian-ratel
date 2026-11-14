/**
 * @file tests/core/thread-coordinator-restoring.test.ts
 * @description 恢复阶段判定 — 按当前库中的唯一完成记录路径核对进度
 * @module tests/core/thread-coordinator-restoring
 */

import { describe, expect, it, vi } from 'vitest';
import { IndexThreadCoordinator, type ThreadIndexClient, type ThreadIndexVault } from '../../src/core/index-thread-coordinator';

/** 构造真实调度器；仅替换线程与库的 IO 边界。 */
function makeCoordinator(files = ['a.md', 'b.md', 'c.md'], receipts = files) {
	const client: ThreadIndexClient = {
		start: async () => undefined,
		indexFile: vi.fn(async (_path: string, _content: string) => ({ chunkCount: 1, skipped: true })),
		deleteFile: async () => ({ removed: 0 }),
		recover: async () => ({ pending: 0, decisions: 0, failures: 0 }),
		close: async () => undefined,
		listCommitted: async () => receipts.map((path) => ({ path, state: 'present' as const })),
		onFileCommitted: null,
	};
	const vault: ThreadIndexVault = {
		listMarkdownFiles: () => files,
		readFile: vi.fn(async (path: string) => `content:${path}`),
	};
	const coordinator = new IndexThreadCoordinator({
		client,
		vault,
		start: { root: '/tmp/restoring-test', generationId: 'gen-x', configFingerprint: 'f'.repeat(64) },
	});
	return { coordinator, client, vault };
}

describe('恢复阶段判定', () => {
	it('恢复核对 - 内容变更后重做 - 不依赖跳过数追平并立即退出', async () => {
		const { coordinator, client } = makeCoordinator();
		client.indexFile = async (path) => ({ chunkCount: 2, skipped: path !== 'c.md' });
		const counters = await coordinator.start();
		expect(counters).toMatchObject({ restoredTotal: 3, restoredFiles: 3, restoring: false, committedThisRound: 1, phase: 'ready' });
	});

	it('恢复核对 - 二十条旧记录已不在库中且全部跳过 - 排除旧路径并立即退出', async () => {
		const files = Array.from({ length: 2877 }, (_, i) => `note-${i}.md`);
		const stale = Array.from({ length: 20 }, (_, i) => `old-${i}.md`);
		const { coordinator, client, vault } = makeCoordinator(files, [...files, ...stale]);
		const counters = await coordinator.start();
		expect(counters).toMatchObject({ restoredTotal: 2877, restoredFiles: 2877, restoring: false, committed: 2877, committedThisRound: 0, removedFiles: 20, phase: 'ready' });
		expect(vault.readFile).toHaveBeenCalledTimes(2877);
		expect(client.indexFile).toHaveBeenCalledTimes(2877);
		expect(client.indexFile).toHaveBeenLastCalledWith('note-2876.md', 'content:note-2876.md');
	});

	it('恢复核对 - 最后一条记录最终失败 - 退出恢复但保留失败而非伪造提交', async () => {
		const { coordinator, client } = makeCoordinator(['a.md', 'bad.md']);
		let attempts = 0;
		const restoringDuringAttempts: boolean[] = [];
		client.indexFile = async (path) => {
			if (path === 'bad.md') {
				attempts += 1;
				restoringDuringAttempts.push(coordinator.counters().restoring === true);
				throw new Error('注入失败');
			}
			return { chunkCount: 1, skipped: true };
		};
		const counters = await coordinator.start();
		expect(attempts).toBe(3);
		expect(restoringDuringAttempts).toEqual([true, true, true]);
		expect(counters).toMatchObject({ restoredTotal: 2, restoredFiles: 2, restoring: false, failures: 1, committed: 1, phase: 'partial-failure' });
		expect(coordinator.isReady()).toBe(false);
		// 已放弃路径下一轮不重试，不能伪造本轮已核对数，也不能保留恢复提示。
		expect(await coordinator.start()).toMatchObject({ restoredTotal: 2, restoredFiles: 1, restoring: false, failures: 1, committed: 1, phase: 'partial-failure' });
		expect(attempts).toBe(3);
	});

	it('恢复核对 - 新文件先处理后暂停 - 不提前结束旧记录核对', async () => {
		const { coordinator, client } = makeCoordinator(['new.md', 'a.md'], ['a.md']);
		client.indexFile = async () => {
			coordinator.pause();
			return { chunkCount: 1 };
		};
		const counters = await coordinator.start();
		expect(counters).toMatchObject({ restoredTotal: 1, restoredFiles: 0, restoring: true, pendingFiles: 1, phase: 'paused' });
		client.indexFile = async () => ({ chunkCount: 1, skipped: true });
		coordinator.resume();
		await coordinator.drain();
		expect(coordinator.counters()).toMatchObject({ restoredFiles: 1, restoring: false, phase: 'ready' });
	});

	it('恢复核对 - 重复记录和完成事件及重复调度 - 唯一路径只计一次', async () => {
		const { coordinator, client } = makeCoordinator(['a.md', 'b.md'], ['a.md', 'a.md', 'b.md']);
		client.indexFile = async (path) => {
			client.onFileCommitted?.({ path, chunkCount: 1, skipped: true });
			client.onFileCommitted?.({ path, chunkCount: 1, skipped: true });
			if (path === 'a.md') coordinator.pause();
			return { chunkCount: 1, skipped: true };
		};
		await coordinator.start();
		expect(coordinator.counters()).toMatchObject({ restoredTotal: 2, restoredFiles: 1, restoring: true });
		coordinator.notify('a.md', 'upsert');
		client.indexFile = async () => ({ chunkCount: 1, skipped: true });
		coordinator.resume();
		await coordinator.drain();
		expect(coordinator.counters()).toMatchObject({ restoredTotal: 2, restoredFiles: 2, restoring: false });
	});

	it('恢复核对 - 实际核对超过六十秒仍有未处理路径 - 不按墙钟退出', async () => {
		const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
		try {
			const { coordinator, client } = makeCoordinator(['a.md', 'b.md']);
			client.indexFile = async () => {
				clock.mockReturnValue(62_000);
				coordinator.pause();
				return { chunkCount: 1, skipped: true };
			};
			await coordinator.start();
			expect(coordinator.counters()).toMatchObject({ restoredFiles: 1, restoredTotal: 2, restoring: true, pendingFiles: 1 });
		} finally {
			clock.mockRestore();
		}
	});

	it('恢复核对 - 再次启动 - 重置进度且仍逐篇读取核对', async () => {
		const { coordinator, client, vault } = makeCoordinator(['a.md']);
		await coordinator.start();
		client.start = async () => {
			expect(coordinator.counters()).toMatchObject({ restoring: false, restoredFiles: 0, restoredTotal: 0 });
		};
		expect(await coordinator.start()).toMatchObject({ restoredFiles: 1, restoredTotal: 1, restoring: false });
		expect(vault.readFile).toHaveBeenCalledTimes(2);
		expect(client.indexFile).toHaveBeenCalledTimes(2);
	});
});
