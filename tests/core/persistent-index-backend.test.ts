/**
 * @file tests/core/persistent-index-backend.test.ts
 * @description 真实磁盘和 Worker 链路的索引生命周期回归
 * @module tests/core/persistent-index-backend
 * @depends core/persistent-index-backend, worker/inline-worker
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { get } from 'svelte/store';
import type { WorkerResponse } from '../../src/types';
import { PersistentIndexBackend } from '../../src/core/persistent-index-backend';
import { IndexManager } from '../../src/core/index-manager';
import { IndexManifest, resolveIndexManifestPath, CURRENT_CHUNKER_VERSION } from '../../src/core/index-manifest';
import { resolveBuildStampPath, readBuildStamp } from '../../src/core/index-build-stamp';
import { VectraStore } from '../../src/adapters/vector-vectra';
import { InlineWorker } from '../../src/worker/inline-worker';
import { WorkerManager } from '../../src/worker/manager';
import { tNow } from '../../src/i18n';
import { sha256 } from '../../src/utils/hash';
describe('真实索引持久化', () => {
	let dir: string;
	let workers: WorkerManager[];
	let files: Map<string, string>;
	const stamp = { chunkerVersion: CURRENT_CHUNKER_VERSION, chunkSize: 500, chunkOverlap: 100, embedModelId: 'test' };
	beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-index-')); workers = []; files = new Map([['a.md', 'original'], ['b.md', 'unchanged']]); });
	afterEach(() => { for (const worker of workers)
		worker.destroy(); vi.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true }); });
	async function drainUntil(ready: () => boolean) {
		for (let i = 0; i < 1000; i++) {
			await new Promise<void>(resolve => setImmediate(resolve));
			await vi.advanceTimersByTimeAsync(0);
			if (ready())
				return;
		}
		throw new Error('真实磁盘操作未完成');
	}
	async function create(embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0])), timeoutMs = 1000) {
		const store = new VectraStore(dir);
		await store.init();
		const inline = new InlineWorker();
		inline.initWithStore(store, { modelId: 'test', dimensions: 3, embed });
		const worker = new WorkerManager(inline, { timeoutMs });
		workers.push(worker);
		const manifest = new IndexManifest(resolveIndexManifestPath(dir));
		const backend = new PersistentIndexBackend({
			indexDir: dir, manifest, worker, getStore: () => store,
			vault: { listMarkdownFiles: () => [...files.keys()], readFile: async (p) => files.get(p)!, stat: () => ({ mtime: 1 }) },
			getBuildStamp: () => stamp, getChunkOptions: () => ({ maxTokens: 100, overlapTokens: 0 }),
		});
		return { store, inline, worker, manifest, backend, embed, manager: new IndexManager(backend) };
	}
	it('真实重启 - 重新构造全部启动对象 - 未改文件零嵌入且修改文件更新', async () => {
		const first = await create();
		expect(await first.manager.onLayoutReady()).toEqual({ indexed: 2, errors: 0 });
		expect(await readBuildStamp(dir)).toEqual(stamp);
		first.worker.destroy();
		const second = await create();
		expect(await second.manager.onLayoutReady()).toEqual({ indexed: 0, errors: 0 });
		expect(second.embed).not.toHaveBeenCalled();
		second.worker.destroy();
		files.set('a.md', 'changed');
		const third = await create();
		expect(await third.manager.onLayoutReady()).toEqual({ indexed: 1, errors: 0 });
		expect(third.embed).toHaveBeenCalledTimes(1);
		expect((await third.manifest.load())!.entries['a.md']!.hash).toBe(await sha256('changed'));
	});
	it('输入快照 - 嵌入期间文件修改 - 只提交原内容hash并在重启更新', async () => {
		let release!: () => void;
		let started!: () => void;
		const ready = new Promise<void>(r => { started = r; });
		const embed = vi.fn(async (texts: string[]) => { started(); await new Promise<void>(r => { release = r; }); return texts.map(() => [1, 0, 0]); });
		files.delete('b.md');
		const first = await create(embed);
		const task = first.manager.onLayoutReady();
		await ready;
		files.set('a.md', 'changed during embedding');
		release();
		await task;
		expect((await first.manifest.load())!.entries['a.md']!.hash).toBe(await sha256('original'));
		first.worker.destroy();
		const second = await create();
		expect(await second.manager.onLayoutReady()).toEqual({ indexed: 1, errors: 0 });
	});
	it('全量提交 - 部分嵌入失败 - 不Ready且不留下成功清单和戳', async () => {
		const embed = vi.fn(async (_texts: string[]) => { throw new Error('embed failed'); });
		const first = await create(embed);
		expect(await first.manager.onLayoutReady()).toBeNull();
		expect(get(first.manager.status$).state).toBe('Failed');
		expect(await first.manifest.load()).toBeNull();
		expect(await readBuildStamp(dir)).toBeNull();
	});
	it.each(['manifest', 'stamp'])('全量提交 - %s写入失败 - 不完成且下次重新处理', async (failed) => {
		const first = await create();
		let restore: (() => void) | undefined;
		if (failed === 'manifest')
			restore = vi.spyOn(first.manifest, 'save').mockRejectedValue(new Error('disk full')).mockRestore;
		else {
			const original = fs.promises.rename;
			const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (oldPath, newPath) => {
				if (newPath === resolveBuildStampPath(dir))
					throw new Error('stamp failed');
				return original(oldPath, newPath);
			});
			restore = () => spy.mockRestore();
		}
		try {
			expect(await first.manager.onLayoutReady()).toBeNull();
			expect(get(first.manager.status$).state).toBe('Failed');
			expect(await first.manifest.load()).toBeNull();
			expect(await readBuildStamp(dir)).toBeNull();
		}
		finally {
			restore?.();
		}
		first.worker.destroy();
		const second = await create();
		expect(await second.manager.onLayoutReady()).toEqual({ indexed: 2, errors: 0 });
		expect(second.embed).toHaveBeenCalledTimes(2);
	});
	it('无进展超时 - 旧任务未结束 - 不清库重试且后续写入失败直至迟到终态', async () => {
		let release!: () => void;
		let started = false;
		const embed = vi.fn(async (texts: string[]) => { started = true; await new Promise<void>(r => { release = r; }); return texts.map(() => [1, 0, 0]); });
		files.delete('b.md');
		const first = await create(embed, 100);
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const drop = vi.spyOn(first.store, 'dropIndex');
		const task = first.manager.onLayoutReady();
		await drainUntil(() => started);
		await vi.advanceTimersByTimeAsync(101);
		expect(await task).toBeNull();
		const dropsBefore = drop.mock.calls.length;
		await expect(first.backend.dropIndex()).rejects.toThrow(tNow('notice.indexStillRunning'));
		expect(drop).toHaveBeenCalledTimes(dropsBefore);
		expect(embed).toHaveBeenCalledTimes(1);
		let terminal = false;
		first.inline.on('message', (message: WorkerResponse & { _requestId?: string }) => { if (message.type === 'index.done')
			terminal = true; });
		release();
		await drainUntil(() => terminal);
		await first.backend.dropIndex();
		expect(drop).toHaveBeenCalledTimes(dropsBefore + 1);
		expect(get(first.manager.status$).state).toBe('Failed');
	});
	it('活动超时 - 连续文件完成跨过原总时限 - 只运行一次全量并持久化', async () => {
		files.set('c.md', 'third');
		files.set('d.md', 'fourth');
		let release: (() => void) | undefined;
		const embed = vi.fn(async (texts: string[]) => { await new Promise<void>(resolve => { release = resolve; }); return texts.map(() => [1, 0, 0]); });
		const first = await create(embed, 100);
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const fullRequests: string[] = [];
		const post = first.inline.postMessage.bind(first.inline);
		vi.spyOn(first.inline, 'postMessage').mockImplementation(message => { fullRequests.push(message.type); post(message); });
		const task = first.manager.onLayoutReady();
		let done = false;
		void task.then(() => { done = true; });
		for (let i = 0; i < 4; i++) {
			await drainUntil(() => release !== undefined);
			await vi.advanceTimersByTimeAsync(80);
			const finish = release!;
			release = undefined;
			finish();
		}
		await drainUntil(() => done);
		expect(await task).toEqual({ indexed: 4, errors: 0 });
		expect(fullRequests.filter(type => type === 'index.full')).toHaveLength(1);
		expect(embed).toHaveBeenCalledTimes(4);
		expect(await first.manifest.load()).not.toBeNull();
		expect(get(first.manager.status$).state).toBe('Ready');
	});
	it('关闭自动扫描 - 缺少成功清单时收到文件事件 - 可更新向量但不宣告全库Ready', async () => {
		const first = await create();
		first.manager.enqueue('a.md', 'upsert', 'original');
		await first.manager.flush();
		expect((await first.store.status()).totalDocs).toBe(1);
		expect(get(first.manager.status$).state).toBe('Idle');
		expect(await first.manifest.load()).toBeNull();
		expect(await readBuildStamp(dir)).toBeNull();
	});
});
