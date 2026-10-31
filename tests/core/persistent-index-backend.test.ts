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
import { get, writable } from 'svelte/store';
import { IndexController } from '../../src/core/index-controller';
import { FeedbackController } from '../../src/core/feedback-controller';
import { UserStatus } from '../../src/user-feedback/user-status';
import type { ModelStatus } from '../../src/core/model-manager';
import { isSearchReady } from '../../src/ui/chat/chat-send-gate';
import { createSearchVaultTool } from '../../src/tools/search-vault';
import { makeToolDef } from '../helpers/make-tool-def';
import type { WorkerResponse } from '../../src/types';
import { PersistentIndexBackend } from '../../src/core/persistent-index-backend';
import type {
	CommittedFileRecord,
	FileRecordReader,
	IndexRoundCounters,
	PersistentIndexBackendOptions,
	SearchableFileRecords,
} from '../../src/core/persistent-index-backend';
import { IndexFileJournal } from '../../src/core/index-file-journal';
import type { JournalWriteOwner } from '../../src/core/index-file-journal';
import { AtomicIndexStorage } from '../../src/adapters/atomic-index-storage';
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
	let journalDir: string;
	let workers: WorkerManager[];
	let files: Map<string, string>;
	const stamp = { chunkerVersion: CURRENT_CHUNKER_VERSION, chunkSize: 500, chunkOverlap: 100, embedModelId: 'test' };
	/** 等待真实磁盘/Worker 的墙钟预算 —— 与迭代次数无关,负载下仍按真实进度判定。 */
	const DRAIN_TIMEOUT_MS = 15_000;
	/** 两个定时器用例的显式超时:必须大于墙钟预算,否则夹具还没来得及报「未完成」就被用例超时打断。 */
	const TIMER_TEST_TIMEOUT_MS = 30_000;
	beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-index-')); journalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-journal-')); workers = []; files = new Map([['a.md', 'original'], ['b.md', 'unchanged']]); });
	afterEach(() => { for (const worker of workers)
		worker.destroy(); vi.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(journalDir, { recursive: true, force: true }); });
	/**
	 * 轮询到条件满足为止,超时按**墙钟**预算而不是固定迭代次数。
	 *
	 * 关键路径(夹具缺陷,不是产品缺陷):此前用固定 1000 次 `setImmediate` 迭代当超时上界,
	 * 迭代本身廉价,真实磁盘与 Worker 在多测试文件并发时远未完成就会抛「真实磁盘操作未完成」。
	 * 这里保留轮询语义(不依赖被 fake 的定时器,`Date.now` 未被 fake),
	 * 只把预算换成墙钟,超时后仍如实失败,不放宽被测语义。
	 */
	async function drainUntil(ready: () => boolean, timeoutMs = DRAIN_TIMEOUT_MS) {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			await new Promise<void>(resolve => setImmediate(resolve));
			await vi.advanceTimersByTimeAsync(0);
			if (ready())
				return;
			if (Date.now() >= deadline)
				throw new Error(`真实磁盘操作在 ${timeoutMs}ms 墙钟预算内未完成`);
		}
	}
	async function create(embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0])), timeoutMs = 1000, extra: Partial<PersistentIndexBackendOptions> = {}) {
		const store = new VectraStore(dir);
		// 关键路径:构造器已启动初始化；通过公共读取等待同一个就绪 Promise，避免重入 init 提前返回。
		await store.isIndexCreated();
		const inline = new InlineWorker();
		inline.initWithStore(store, { modelId: 'test', dimensions: 3, embed });
		const worker = new WorkerManager(inline, { timeoutMs });
		workers.push(worker);
		const manifest = new IndexManifest(resolveIndexManifestPath(dir));
		const vault = { listMarkdownFiles: () => [...files.keys()], readFile: async (p: string) => files.get(p)!, stat: () => ({ mtime: 1 }) };
		const backend = new PersistentIndexBackend({
			indexDir: dir, manifest, worker, getStore: () => store,
			vault,
			getBuildStamp: () => stamp, getChunkOptions: () => ({ maxTokens: 100, overlapTokens: 0 }),
			...extra,
		});
		return { store, inline, worker, manifest, backend, embed, vault, manager: new IndexManager(backend) };
	}
	/**
	 * 在独立代际根上装配真实的 `IndexFileJournal`。
	 *
	 * 关键路径:端口语义必须用真实日志验证 —— 结构替身只能证明类型可赋值,
	 * 发现不了「注释说含删除凭据、实现只给 present」这类分歧。
	 *
	 * `root` 必须独立于后端 `indexDir`:后端全量扫描会调用 `VectraStore.dropIndex()`,
	 * 它递归删除整个 indexDir,落在其中的日志会连同凭据一起被抹掉。
	 */
	async function createJournal(root: string): Promise<IndexFileJournal> {
		const storage = new AtomicIndexStorage({ generationRoot: root });
		const store = new VectraStore(root, { storage });
		await store.init();
		const owner: JournalWriteOwner = {
			epoch: 1,
			assertWritable: () => {},
			beginCommit: () => ({ settle: () => {} }),
		};
		return new IndexFileJournal({
			generationRoot: root,
			generationId: 'gen-1',
			configFingerprint: 'a'.repeat(64),
			owner,
			store,
			storage,
		});
	}
	/** 走真实日志完整提交一个 present 版本。 */
	async function commitJournalReceipt(journal: IndexFileJournal, filePath: string, content: string): Promise<void> {
		const previous = await journal.readReceipt(filePath);
		const prepared = await journal.prepare({
			path: filePath,
			operation: 'replace',
			inputHash: await sha256(content),
			revision: (previous?.revision ?? 0) + 1,
			previousCommitId: previous?.commitId ?? null,
			previousRevision: previous?.revision ?? 0,
			blocks: [{ id: `${filePath}#chunk-0`, vector: [1, 0, 0], metadata: { index: 0 } }],
		});
		await journal.commit(prepared.transactionId);
	}
	/** 走真实日志提交一次删除(零块事务),只留下删除凭据。 */
	async function commitJournalTombstone(journal: IndexFileJournal, filePath: string): Promise<void> {
		const previous = await journal.readReceipt(filePath);
		const prepared = await journal.prepare({
			path: filePath,
			operation: 'delete',
			inputHash: null,
			revision: (previous?.revision ?? 0) + 1,
			previousCommitId: previous?.commitId ?? null,
			previousRevision: previous?.revision ?? 0,
			blocks: [],
		});
		await journal.commit(prepared.transactionId);
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
	}, TIMER_TEST_TIMEOUT_MS);
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
	}, TIMER_TEST_TIMEOUT_MS);
	it('关闭自动扫描 - 缺少成功清单时收到文件事件 - 可更新向量但不宣告全库Ready', async () => {
		const first = await create();
		first.manager.enqueue('a.md', 'upsert', 'original');
		await first.manager.flush();
		expect((await first.store.status()).totalDocs).toBe(1);
		expect(get(first.manager.status$).state).toBe('Idle');
		expect(await first.manifest.load()).toBeNull();
		expect(await readBuildStamp(dir)).toBeNull();
	});
    it.each([false, true])('扫描恢复 - B快照读取失败且A排队，恢复再次失败=%s - 先修复扫描再消费增量', async retryFails => {
        const initial = await create();
        expect(await initial.manager.onLayoutReady()).toEqual({ indexed: 2, errors: 0 });
        const oldManifest = await initial.manifest.load();
        initial.worker.destroy();
        files.set('b.md', 'offline changed B');
        const next = await create();
        const originalRead = next.vault.readFile;
        let failRead!: () => void;
        let enteredRead!: () => void;
        const readingB = new Promise<void>(resolve => { enteredRead = resolve; });
        let attempts = 0;
        vi.spyOn(next.vault, 'readFile').mockImplementation(async filePath => {
            if (filePath === 'b.md') {
                attempts++;
                if (attempts === 1) {
                    enteredRead();
                    await new Promise<void>((_resolve, reject) => { failRead = () => reject(new Error('temporary read failure')); });
                }
                if (retryFails) throw new Error('read retry failure');
            }
            return originalRead(filePath);
        });
        const scan = next.manager.onLayoutReady();
        await readingB;
        files.set('a.md', 'event changed A');
        next.manager.enqueue('a.md', 'upsert', 'event changed A');
        failRead();
        expect(await scan).toBeNull();
        await next.manager.flush();
        expect(get(next.manager.status$).state).toBe('Failed');
        expect(await next.manifest.load()).toEqual(oldManifest);
        expect(await readBuildStamp(dir)).toEqual(stamp);
        const incremental = vi.spyOn(next.backend, 'incrementalIndex');
        const scanBatches: string[][] = [];
        const originalPost = next.inline.postMessage.bind(next.inline);
        vi.spyOn(next.inline, 'postMessage').mockImplementation(message => {
            if (message.type === 'index.batch') scanBatches.push(message.payload.files.map(file => file.path));
            originalPost(message);
        });
        const readyBHashes: string[] = [];
        const unsubscribe = next.manager.status$.subscribe(status => {
            if (status.state === 'Ready') {
                const data = JSON.parse(fs.readFileSync(resolveIndexManifestPath(dir), 'utf8')) as { entries: Record<string, { hash: string }> };
                readyBHashes.push(data.entries['b.md']!.hash);
            }
        });
        try {
            next.manager.resume();
            await vi.waitFor(() => {
                expect(attempts).toBe(2);
                expect(get(next.manager.status$).state).toBe(retryFails ? 'Failed' : 'Ready');
            });
            await next.manager.flush();
            if (retryFails) {
                expect(incremental).not.toHaveBeenCalled();
                expect(readyBHashes).toEqual([]);
                expect(await next.manifest.load()).toEqual(oldManifest);
            } else {
                expect(scanBatches).toEqual([['a.md', 'b.md']]);
                expect(incremental).toHaveBeenCalledOnce();
                expect(readyBHashes.length).toBeGreaterThan(0);
                expect(readyBHashes.every(hash => hash === readyBHashes[0])).toBe(true);
                expect(readyBHashes[0]).toBe(await sha256('offline changed B'));
                expect((await next.manifest.load())!.entries['b.md']!.hash).toBe(await sha256('offline changed B'));
            }
        } finally { unsubscribe(); next.manager.destroy(); }
    });

    function controllerFor(context: Awaited<ReturnType<typeof create>>) {
        return new IndexController({
            ...context.vault,
            onFileCreate: () => () => {}, onFileModify: () => () => {},
            onFileDelete: () => () => {}, onFileRename: () => () => {},
        }, context.backend, dir);
    }

    it('关闭自动扫描 - 重启后已有成功提交索引 - 只读恢复Ready且实际检索可用', async () => {
        const initial = await create();
        await initial.manager.onLayoutReady();
        initial.worker.destroy();
        const next = await create();
        const controller = controllerFor(next);
        const userStatus = new UserStatus();
        const complete = vi.fn();
        const feedback = new FeedbackController({
            modelStatus$: writable<ModelStatus>({ state: 'NotStarted' }),
            indexStatus$: controller.indexManager.status$, userStatus,
            userNotice: { toastError: vi.fn() } as never,
            getEmbeddingReady: () => true,
            getSettings: () => ({ embedProvider: 'api', embedApiBase: '', chatApiBase: '' }),
            onFullIndexComplete: complete,
        });
        const snapshots = new Map(['index.json', path.basename(resolveIndexManifestPath(dir)), path.basename(resolveBuildStampPath(dir))].map(name => {
            const filePath = path.join(dir, name);
            return [filePath, { content: fs.readFileSync(filePath, 'utf8'), mtime: fs.statSync(filePath).mtimeMs }];
        }));
        const readVault = vi.spyOn(next.vault, 'readFile');
        const posted = vi.spyOn(next.inline, 'postMessage');
        feedback.start();
        try {
            expect(await controller.onLayoutReady(false)).toBeNull();
            expect(get(controller.indexManager.status$)).toMatchObject({ state: 'Ready', totalDocs: 2 });
            expect(get(userStatus.statusBar$)).toMatchObject({ index: 'ready', indexDocCount: 2 });
            expect(isSearchReady(get(userStatus.statusBar$))).toBe(true);
            const tool = createSearchVaultTool({
                search: async (_query: string, topK: number) => next.store.search([1, 0, 0], topK),
            } as never, () => isSearchReady(get(userStatus.statusBar$)), makeToolDef('search_vault'), {
                getMetadata: () => null, getBacklinks: () => new Map(),
            } as never);
            const results = await tool.execute({ query: 'original' });
            expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ metadata: expect.objectContaining({ path: 'a.md' }) })]));
            expect(next.embed).not.toHaveBeenCalled();
            expect(readVault).not.toHaveBeenCalled();
            expect(posted).not.toHaveBeenCalled();
            expect(complete).not.toHaveBeenCalled();
            for (const [filePath, before] of snapshots) {
                expect(fs.readFileSync(filePath, 'utf8')).toBe(before.content);
                expect(fs.statSync(filePath).mtimeMs).toBe(before.mtime);
            }
        } finally { feedback.destroy(); controller.destroy(); }
    });

    it.each(['missing-manifest', 'missing-stamp', 'missing-index', 'invalid-manifest', 'incompatible-manifest', 'incompatible-stamp'])('关闭自动扫描 - %s - 不恢复Ready且不修写文件', async invalid => {
        const initial = await create();
        await initial.manager.onLayoutReady();
        initial.worker.destroy();
        const next = await create();
        if (invalid === 'missing-manifest') fs.unlinkSync(resolveIndexManifestPath(dir));
        if (invalid === 'missing-stamp') fs.unlinkSync(resolveBuildStampPath(dir));
        if (invalid === 'missing-index') fs.unlinkSync(path.join(dir, 'index.json'));
        if (invalid === 'invalid-manifest') fs.writeFileSync(resolveIndexManifestPath(dir), '{broken');
        if (invalid === 'incompatible-manifest') {
            const data = (await next.manifest.load())!;
            data.embedModelId = 'other-model';
            await next.manifest.save(data);
        }
        if (invalid === 'incompatible-stamp') fs.writeFileSync(resolveBuildStampPath(dir), JSON.stringify({ ...stamp, chunkSize: 1 }));
        const snapshot = () => Object.fromEntries(fs.readdirSync(dir).map(name => [name, fs.readFileSync(path.join(dir, name), 'utf8')]));
        const before = snapshot();
        const controller = controllerFor(next);
        try {
            expect(await controller.onLayoutReady(false)).toBeNull();
            expect(get(controller.indexManager.status$).state).not.toBe('Ready');
            expect(next.embed).not.toHaveBeenCalled();
            expect(snapshot()).toEqual(before);
        } finally { controller.destroy(); }
    });

    it('整批失败 - 已有有效清单与戳 - 保留既有凭据且不整库失效', async () => {
        const first = await create();
        expect(await first.manager.onLayoutReady()).toEqual({ indexed: 2, errors: 0 });
        const committedManifest = await first.manifest.load();
        const committedStamp = await readBuildStamp(dir);
        expect(committedManifest).not.toBeNull();
        first.worker.destroy();

        files.set('a.md', 'changed');
        const failing = vi.fn(async (_texts: string[]) => { throw new Error('embed failed'); });
        const second = await create(failing);
        expect(await second.manager.onLayoutReady()).toBeNull();
        expect(get(second.manager.status$).state).toBe('Failed');
        // 关键路径:整批失败不得抹掉其他文件已提交的清单与构建戳(整库失效操作已移除)。
        expect(await second.manifest.load()).toEqual(committedManifest);
        expect(await readBuildStamp(dir)).toEqual(committedStamp);
        // 只读状态仍可恢复:已提交文件不因本批失败失效。
        expect(await second.backend.readCommittedState()).toEqual({
            totalDocs: 2,
            lastIndexTime: committedManifest!.lastIndexTime,
        });
        // 但本轮扫描失败未清除 → 不能宣告全库完成。
        expect(await second.backend.isIndexComplete()).toBe(false);
        expect(second.backend.roundState()).toMatchObject({ scanComplete: false, failures: 1 });
    });

    it('完整性判定 - 本轮扫描成功 - 无失败时完成;单文件任务失败后不再完成', async () => {
        const first = await create();
        expect(await first.manager.onLayoutReady()).toEqual({ indexed: 2, errors: 0 });
        expect(first.backend.roundState()).toMatchObject({ scanComplete: true, failures: 0 });
        expect(await first.backend.isIndexComplete()).toBe(true);

        // 单文件任务失败 → 本轮存在失败,不允许宣告全库完成;既有凭据仍保留。
        first.inline.initWithStore(first.store, {
            modelId: 'test',
            dimensions: 3,
            embed: vi.fn(async () => { throw new Error('embed failed'); }),
        });
        await expect(first.backend.incrementalIndex({ path: 'a.md', content: 'changed' })).rejects.toThrow();
        expect(first.backend.roundState()).toMatchObject({ scanComplete: true, failures: 1 });
        expect(await first.backend.isIndexComplete()).toBe(false);
        expect(await first.manifest.load()).not.toBeNull();
        expect(await readBuildStamp(dir)).toEqual(stamp);
    });

    it('完整性判定 - 单文件失败后另一文件成功提交 - 仍不宣告全库完成', async () => {
        const first = await create();
        expect(await first.manager.onLayoutReady()).toEqual({ indexed: 2, errors: 0 });
        expect(await first.backend.isIndexComplete()).toBe(true);

        // 探针:让 a.md 的增量提交失败 → 本轮失败 +1,本轮未再成功扫描过。
        first.inline.initWithStore(first.store, {
            modelId: 'test',
            dimensions: 3,
            embed: vi.fn(async () => { throw new Error('embed failed'); }),
        });
        await expect(first.backend.incrementalIndex({ path: 'a.md', content: 'changed' })).rejects.toThrow();
        expect(first.backend.roundState()).toMatchObject({ scanComplete: true, failures: 1 });
        expect(await first.backend.isIndexComplete()).toBe(false);

        // 回归点:另一个文件走增量队列成功提交(经 `commit` 出口),
        // 单文件提交成功绝不允许清零本轮失败计数。
        first.inline.initWithStore(first.store, {
            modelId: 'test',
            dimensions: 3,
            embed: vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0])),
        });
        first.manager.enqueue('b.md', 'upsert', 'also changed');
        await first.manager.flush();
        expect(first.backend.roundState()).toMatchObject({ scanComplete: true, failures: 1 });
        expect(await first.backend.isIndexComplete()).toBe(false);
        // 提交确实成功了(清单已更新),只是不能据此宣告全库完成。
        expect((await first.manifest.load())!.entries['b.md']!.hash).toBe(await sha256('also changed'));
        expect(await readBuildStamp(dir)).toEqual(stamp);
        // index-manager 的可见性门据此保持非 Ready。
        expect(get(first.manager.status$).state).not.toBe('Ready');
    });

    it('提交回滚 - 构建戳已写但清单保存失败 - 保留既有凭据且不整库失效', async () => {
        const first = await create();
        expect(await first.manager.onLayoutReady()).toEqual({ indexed: 2, errors: 0 });
        const committedManifest = await first.manifest.load();
        expect(await readBuildStamp(dir)).toEqual(stamp);

        // 注入清单保存失败:构建戳已写成功、清单未写 —— 必须回滚本次写的戳。
        const save = vi.spyOn(first.manifest, 'save').mockRejectedValue(new Error('disk full'));
        try {
            await expect(first.backend.incrementalIndex({ path: 'a.md', content: 'changed' })).rejects.toThrow('disk full');
        } finally {
            save.mockRestore();
        }

        // 既有「清单 + 戳」是有效凭据:回滚不能把它删掉(一律删除会让下次启动判定凭据缺失)。
        expect(await first.manifest.load()).toEqual(committedManifest);
        expect(await readBuildStamp(dir)).toEqual(stamp);
        expect(await first.backend.readCommittedState()).toEqual({
            totalDocs: 2,
            lastIndexTime: committedManifest!.lastIndexTime,
        });
    });

    it('完整性判定 - 本轮队列或在途未收敛 - 不宣告全库完成', async () => {
        let counters = { queued: 0, active: 0, pendingTransactions: 0 };
        const first = await create(undefined, 1000, { getRoundCounters: () => counters });
        await first.manager.onLayoutReady();
        expect(await first.backend.isIndexComplete()).toBe(true);
        counters = { queued: 2, active: 0, pendingTransactions: 0 };
        expect(await first.backend.isIndexComplete()).toBe(false);
        counters = { queued: 0, active: 1, pendingTransactions: 0 };
        expect(await first.backend.isIndexComplete()).toBe(false);
        counters = { queued: 0, active: 0, pendingTransactions: 1 };
        expect(await first.backend.isIndexComplete()).toBe(false);
        expect(first.backend.roundState()).toMatchObject({
            scanComplete: true, queued: 0, active: 0, pendingTransactions: 1,
        });
    });

    it('完整性判定 - 协调器模式 - 收敛信号注入后才按真实扫描状态宣告完成', async () => {
        // 协调器模式下本轮扫描不由 `runScan` 驱动:`round.scanComplete` 只能来自协调器计数器。
        const first = await create();
        expect(await first.manager.onLayoutReady()).toEqual({ indexed: 2, errors: 0 });
        first.worker.destroy();

        let counters: IndexRoundCounters = { queued: 0, active: 0, pendingTransactions: 0, scanComplete: false };
        const second = await create(undefined, 1000, { getRoundCounters: () => counters });
        // 未收敛:协调器尚未标记扫描结束 → 不得宣告全库完成(T7 只装配协调器而不注入计数器时恒假)。
        expect(second.backend.roundState()).toMatchObject({ scanComplete: false });
        expect(await second.backend.isIndexComplete()).toBe(false);
        // 收敛:协调器标记扫描结束且队列/在途/未决事务清空 → 以真实收敛宣告完成。
        counters = { ...counters, scanComplete: true };
        expect(second.backend.roundState()).toMatchObject({ scanComplete: true, failures: 0 });
        expect(await second.backend.isIndexComplete()).toBe(true);
        // 未收敛(队列未清空 / 仍有失败)时,即使扫描结束也不能宣告完成。
        counters = { ...counters, queued: 1 };
        expect(await second.backend.isIndexComplete()).toBe(false);
        counters = { queued: 0, active: 0, pendingTransactions: 0, scanComplete: true, failures: 1 };
        expect(second.backend.roundState()).toMatchObject({ scanComplete: true, failures: 1 });
        expect(await second.backend.isIndexComplete()).toBe(false);
    });

    it('部分可用性 - 注入文件记录端口 - 只返回可检索记录且完整性要求记录覆盖清单', async () => {
        // 端口语义二分:present 集只放完成记录,删除凭据单独走 listTombstones。
        const records: CommittedFileRecord[] = [
            { path: 'a.md', state: 'present', revision: 2, inputHash: await sha256('original'), chunkCount: 1 },
            { path: 'b.md', state: 'present', revision: 1, inputHash: await sha256('unchanged'), chunkCount: 1 },
        ];
        const tombstones: CommittedFileRecord[] = [
            { path: 'gone.md', state: 'deleted', revision: 3, inputHash: null, chunkCount: 0 },
        ];
        let receipts: ReadonlyArray<CommittedFileRecord> = records;
        const reader: FileRecordReader = {
            listReceipts: async () => receipts,
            listTombstones: async () => tombstones,
            // 关键路径:检索视图由日志负责排除 tombstone 与不可用路径。
            listSearchableReceipts: async () => receipts.filter(record => record.state === 'present'),
        };
        const first = await create(undefined, 1000, { fileRecords: reader });
        expect(await first.manager.onLayoutReady()).toEqual({ indexed: 2, errors: 0 });

        // 两个集合互不混入:present 集没有已删除路径,删除凭据也不冒充完成记录。
        expect((await reader.listReceipts()).map(record => record.path)).toEqual(['a.md', 'b.md']);
        expect((await reader.listTombstones()).map(record => record.path)).toEqual(['gone.md']);
        expect((await reader.listReceipts()).some(record => record.path === 'gone.md')).toBe(false);

        const view: SearchableFileRecords | null = await first.backend.searchableFileRecords();
        expect(view?.total).toBe(2);
        expect(view?.records.map(record => record.path)).toEqual(['a.md', 'b.md']);
        expect(view?.records.every(record => record.state === 'present')).toBe(true);
        expect(await first.backend.isIndexComplete()).toBe(true);

        // 清单条目缺少文件记录或 hash 不符 → 不能宣告完整。
        receipts = records.filter(record => record.path !== 'b.md');
        expect(await first.backend.isIndexComplete()).toBe(false);
        expect(await first.backend.searchableFileRecords()).toMatchObject({ total: 1 });
        const otherHash = await sha256('other content');
        receipts = records.map(record => record.path === 'a.md' ? { ...record, inputHash: otherHash } : record);
        expect(await first.backend.isIndexComplete()).toBe(false);
    });

    it('部分可用性 - 未注入文件记录端口 - 返回 null 表示不可判定', async () => {
        const first = await create();
        await first.manager.onLayoutReady();
        expect(await first.backend.searchableFileRecords()).toBeNull();
        // 未注入端口时完整性仍按持久凭据与本轮状态判定,不伪装成已核验文件记录。
        expect(await first.backend.isIndexComplete()).toBe(true);
    });

    it('契约 - 真实日志注入 - present 集与 tombstone 集语义正确且不互相混入', async () => {
        // 关键路径:直接注入真实 `IndexFileJournal`,断言端口注释描述的实际语义,
        // 而不是只做一次结构赋值(结构赋值发现不了「注释含删除凭据、实现只给 present」)。
        const journal = await createJournal(journalDir);
        await commitJournalReceipt(journal, 'a.md', 'original');
        await commitJournalReceipt(journal, 'b.md', 'unchanged');
        await commitJournalTombstone(journal, 'gone.md');

        // 第一手证据:present 集只有完成记录,删除凭据只在 tombstone 集。
        expect((await journal.listReceipts()).map(entry => entry.path)).toEqual(['a.md', 'b.md']);
        expect((await journal.listReceipts()).every(entry => entry.state === 'present')).toBe(true);
        expect((await journal.listTombstones()).map(entry => entry.path)).toEqual(['gone.md']);
        expect((await journal.listTombstones()).every(entry => entry.state === 'deleted')).toBe(true);

        // 端口契约:真实日志可直接作 reader 注入,且记录与清单 hash 一致时才算覆盖。
        // 关键路径:日志代际根必须放在 indexDir **之外** —— 后端全量扫描会走
        // `VectraStore.dropIndex()`(递归删除整个 indexDir),把 indexDir 内的日志一起抹掉。
        const reader: FileRecordReader = journal;
        const first = await create(undefined, 1000, { fileRecords: reader });
        expect(await first.manager.onLayoutReady()).toEqual({ indexed: 2, errors: 0 });
        expect(await first.backend.isIndexComplete()).toBe(true);
        const view = await first.backend.searchableFileRecords();
        expect(view?.records.map(record => record.path)).toEqual(['a.md', 'b.md']);
        expect(view?.records.some(record => record.path === 'gone.md')).toBe(false);

        // 删除凭据不冒充「已提交」:b.md 变 tombstone 后清单仍有它,但 present 集已不含它,
        // 完整性判定与检索视图都必须随之收缩(可见性门不能放过已删除路径)。
        await commitJournalTombstone(journal, 'b.md');
        expect((await journal.listTombstones()).map(entry => entry.path)).toEqual(['b.md', 'gone.md']);
        expect((await journal.listReceipts()).map(entry => entry.path)).toEqual(['a.md']);
        expect(await first.backend.isIndexComplete()).toBe(false);
        expect((await first.backend.searchableFileRecords())?.records.map(record => record.path)).toEqual(['a.md']);
    });

    it('生产装配点 - new PersistentIndexBackend - 装配点已显式登记', () => {
        const repoRoot = path.resolve(__dirname, '../..');
        const sites: Array<{ file: string; args: string }> = [];
        for (const file of collectSourceFiles(path.join(repoRoot, 'src'))) {
            const source = fs.readFileSync(file, 'utf8');
            for (const args of constructArguments(source))
                sites.push({ file: path.relative(repoRoot, file), args });
        }

        // 关键路径(T7 待办):文件记录端口与协调器计数器的注入点必须显式登记,
        // 新增装配点而没有登记时本用例失败,不允许静默多出一个漏注入可选端口的构造点。
        expect([...new Set(sites.map(site => site.file))]).toEqual(['src/main.ts']);
        expect(sites.length).toBeGreaterThanOrEqual(1);
        // 关键路径:尚未注入 `fileRecords` 的装配点必须在「待注入登记」里,
        // T7 注入后待注入集合收缩,本断言仍然成立(只拦未登记的新漏点)。
        const registeredPendingInjection = ['src/main.ts'];
        const missing = sites.filter(site => !site.args.includes('fileRecords:')).map(site => site.file);
        expect(missing.filter(file => !registeredPendingInjection.includes(file))).toEqual([]);
    });

    /**
     * 递归收集目录下的 TypeScript 源文件。
     *
     * @param root - 起始目录。
     * @returns 绝对路径列表(已排序,保证断言稳定)。
     */
    function collectSourceFiles(root: string): string[] {
        const collected: string[] = [];
        const pending: string[] = [root];
        while (pending.length > 0) {
            const current = pending.pop();
            if (!current) continue;
            for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
                const fullPath = path.join(current, entry.name);
                if (entry.isDirectory()) pending.push(fullPath);
                else if (entry.isFile() && entry.name.endsWith('.ts')) collected.push(fullPath);
            }
        }
        return collected.sort();
    }

    /**
     * 取出每个 `new PersistentIndexBackend(` 的完整实参文本。
     *
     * 关键路径:用括号配平切出整段实参 —— 构造参数跨多行,按行匹配会漏掉未注入端口的写法。
     *
     * @param source - 源文件内容。
     * @returns 每处构造的实参文本(含外层括号)。
     */
    function constructArguments(source: string): string[] {
        const calls: string[] = [];
        const marker = 'new PersistentIndexBackend(';
        let index = source.indexOf(marker);
        while (index >= 0) {
            const start = index + marker.length - 1;
            let depth = 0;
            let end = start;
            for (; end < source.length; end += 1) {
                const char = source[end];
                if (char === '(') depth += 1;
                else if (char === ')') {
                    depth -= 1;
                    if (depth === 0) break;
                }
            }
            calls.push(source.slice(start, end + 1));
            index = source.indexOf(marker, end + 1);
        }
        return calls;
    }

});
