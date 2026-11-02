/**
 * @file tests/core/index-thread-coordinator.test.ts
 * @description 线程版协调器 — 枚举、逐文件索引、失败保留、暂停与就绪判据
 * @module tests/core/index-thread-coordinator
 */

import { describe, expect, it, vi } from 'vitest';
import { IndexThreadCoordinator, type ThreadIndexClient } from '../../src/core/index-thread-coordinator';

/** 记录调用的假客户端。 */
function makeClient(options: { failPaths?: string[]; delay?: () => Promise<void> } = {}): {
	client: ThreadIndexClient & {
		start: ReturnType<typeof vi.fn>;
		indexFile: ReturnType<typeof vi.fn>;
		deleteFile: ReturnType<typeof vi.fn>;
		recover: ReturnType<typeof vi.fn>;
		close: ReturnType<typeof vi.fn>;
	};
	indexed: string[];
} {
	const indexed: string[] = [];
	const failPaths = new Set(options.failPaths ?? []);
	return {
		indexed,
		client: {
			start: vi.fn(async () => undefined),
			indexFile: vi.fn(async (filePath: string) => {
				if (options.delay) await options.delay();
				if (failPaths.has(filePath)) throw new Error('嵌入失败');
				indexed.push(filePath);
				return { chunkCount: 1 };
			}),
			deleteFile: vi.fn(async () => ({ removed: 0 })),
			recover: vi.fn(async () => ({ pending: 0, decisions: 0, failures: 0 })),
			close: vi.fn(async () => undefined),
		} as unknown as ThreadIndexClient & Record<'start' | 'indexFile' | 'deleteFile' | 'recover' | 'close', ReturnType<typeof vi.fn>>,
	};
}

const VAULT = {
	listMarkdownFiles: () => ['a.md', 'b.md'],
	readFile: async (filePath: string) => `正文 ${filePath}`,
};

const START = { root: '/tmp/x', generationId: 'g', configFingerprint: 'a'.repeat(64) };

describe('线程版协调器', () => {
	it('启动 - 枚举后逐文件索引 - 全部成功即就绪', async () => {
		const { client, indexed } = makeClient();
		const coordinator = new IndexThreadCoordinator({ client, vault: VAULT, start: START });
		const counters = await coordinator.start();
		expect(indexed).toEqual(['a.md', 'b.md']);
		expect(counters).toMatchObject({ total: 2, committed: 2, failures: 0, scanComplete: true, phase: 'ready' });
		expect(coordinator.isReady()).toBe(true);
		coordinator.destroy();
	});

	it('有文件失败 - 计数保留 - 不得标记就绪', async () => {
		const { client } = makeClient({ failPaths: ['b.md'] });
		const coordinator = new IndexThreadCoordinator({ client, vault: VAULT, start: START });
		const counters = await coordinator.start();
		expect(counters).toMatchObject({ committed: 1, failures: 1, phase: 'partial-failure' });
		expect(coordinator.isReady()).toBe(false);
		coordinator.destroy();
	});

	it('暂停 - 不再开始新文件 - 恢复后继续', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const { client } = makeClient({ delay: () => gate });
		const coordinator = new IndexThreadCoordinator({ client, vault: VAULT, start: START });
		const running = coordinator.start();
		await Promise.resolve();
		coordinator.pause();
		release();
		const counters = await running;
		expect(counters.phase).toBe('paused');
		// 首个文件已提交,第二个未开始。
		expect(client.indexFile).toHaveBeenCalledTimes(1);
		coordinator.destroy();
	});

	it('撤销在途 - 停止调度后续文件 - 阶段为 stopping', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const { client } = makeClient({ delay: () => gate });
		const coordinator = new IndexThreadCoordinator({ client, vault: VAULT, start: START });
		const running = coordinator.start();
		await Promise.resolve();
		coordinator.abortActive('用户暂停');
		release();
		const counters = await running;
		expect(counters.phase).toBe('stopping');
		expect(client.indexFile).toHaveBeenCalledTimes(1);
		coordinator.destroy();
	});

	it('销毁 - 关闭线程 - 不再接收事件', async () => {
		const { client } = makeClient();
		const coordinator = new IndexThreadCoordinator({ client, vault: VAULT, start: START });
		await coordinator.start();
		coordinator.destroy();
		expect(client.close).toHaveBeenCalledTimes(1);
		coordinator.notify('c.md', 'upsert');
		expect(coordinator.counters().queued).toBe(0);
	});
});

describe('线程崩溃恢复', () => {
	it('首次写入遇到线程退出 - 重启后重试同一文件 - 不记为失败', async () => {
		let attempts = 0;
		const client = {
			start: vi.fn(async () => undefined),
			indexFile: vi.fn(async () => {
				attempts += 1;
				if (attempts === 1) throw new Error('worker-exit');
				return { chunkCount: 1 };
			}),
			deleteFile: vi.fn(async () => ({ removed: 0 })),
			recover: vi.fn(async () => ({ pending: 0, decisions: 0, failures: 0 })),
			close: vi.fn(async () => undefined),
			restart: vi.fn(async () => undefined),
		};
		const coordinator = new IndexThreadCoordinator({
			client: client as never,
			vault: { listMarkdownFiles: () => ['a.md'], readFile: async () => '正文' },
			start: START,
		});
		const counters = await coordinator.start();
		expect(client.restart).toHaveBeenCalledTimes(1);
		expect(counters).toMatchObject({ committed: 1, failures: 0 });
		coordinator.destroy();
	});

	it('重启次数用尽后仍崩溃 - 该文件记为失败 - 不无限循环', async () => {
		const client = {
			start: vi.fn(async () => undefined),
			indexFile: vi.fn(async () => { throw new Error('worker-exit'); }),
			deleteFile: vi.fn(async () => ({ removed: 0 })),
			recover: vi.fn(async () => ({ pending: 0, decisions: 0, failures: 0 })),
			close: vi.fn(async () => undefined),
			restart: vi.fn(async () => undefined),
		};
		const coordinator = new IndexThreadCoordinator({
			client: client as never,
			vault: { listMarkdownFiles: () => ['a.md'], readFile: async () => '正文' },
			start: START,
		});
		const counters = await coordinator.start();
		expect(client.restart).toHaveBeenCalledTimes(2);
		expect(counters).toMatchObject({ committed: 0, failures: 1 });
		coordinator.destroy();
	});

	it('非崩溃类错误 - 不触发重启 - 直接记失败', async () => {
		const client = {
			start: vi.fn(async () => undefined),
			indexFile: vi.fn(async () => { throw new Error('提交冲突'); }),
			deleteFile: vi.fn(async () => ({ removed: 0 })),
			recover: vi.fn(async () => ({ pending: 0, decisions: 0, failures: 0 })),
			close: vi.fn(async () => undefined),
			restart: vi.fn(async () => undefined),
		};
		const coordinator = new IndexThreadCoordinator({
			client: client as never,
			vault: { listMarkdownFiles: () => ['a.md'], readFile: async () => '正文' },
			start: START,
		});
		const counters = await coordinator.start();
		expect(client.restart).not.toHaveBeenCalled();
		expect(counters).toMatchObject({ committed: 0, failures: 1 });
		coordinator.destroy();
	});
});

describe('撤销在途请求', () => {
	it('撤销时 - 通知客户端停止在途 - 该文件不记为失败', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const client = {
			start: vi.fn(async () => undefined),
			indexFile: vi.fn(async () => {
				await gate;
				throw new Error('请求已取消');
			}),
			deleteFile: vi.fn(async () => ({ removed: 0 })),
			recover: vi.fn(async () => ({ pending: 0, decisions: 0, failures: 0 })),
			close: vi.fn(async () => undefined),
			abortActive: vi.fn(() => { release(); }),
		};
		const coordinator = new IndexThreadCoordinator({
			client: client as never,
			vault: { listMarkdownFiles: () => ['a.md'], readFile: async () => '正文' },
			start: START,
		});
		const running = coordinator.start();
		await Promise.resolve();
		await Promise.resolve();
		coordinator.abortActive('用户暂停');
		const counters = await running;
		expect(client.abortActive).toHaveBeenCalledWith('用户暂停');
		// 撤销不是数据问题:不得记为失败,也不得谎报已提交。
		expect(counters).toMatchObject({ committed: 0, failures: 0 });
		expect(coordinator.isReady()).toBe(false);
		coordinator.destroy();
	});
});

describe('增量收敛与阶段', () => {
	it('启动后收到文件事件 - drain 处理 - 阶段回到 ready', async () => {
		const { client, indexed } = makeClient();
		const coordinator = new IndexThreadCoordinator({ client, vault: VAULT, start: START });
		await coordinator.start();
		coordinator.notify('c.md', 'upsert');
		expect(coordinator.counters().phase).toBe('processing');
		await coordinator.drain();
		expect(indexed).toContain('c.md');
		expect(coordinator.counters().phase).toBe('ready');
		coordinator.destroy();
	});

	it('尚未启动时收到事件 - 只入队 - 不调用线程（避免「尚未打开」被记成失败）', async () => {
		const { client } = makeClient();
		const coordinator = new IndexThreadCoordinator({ client, vault: VAULT, start: START });
		coordinator.notify('a.md', 'upsert');
		await coordinator.drain();
		expect(client.indexFile).not.toHaveBeenCalled();
		expect(coordinator.counters().queued).toBe(1);
		coordinator.destroy();
	});
});
