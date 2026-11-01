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
import { PersistentIndexBackend, IndexDirectoryNotOwnedError } from '../../src/core/persistent-index-backend';
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
import { REGISTERED_INDEX_ASSEMBLY } from '../helpers/index-assembly-registry';
import { InlineWorker } from '../../src/worker/inline-worker';
import { WorkerManager } from '../../src/worker/manager';
import { tNow } from '../../src/i18n';
import { sha256 } from '../../src/utils/hash';
import { devLogger } from '../../src/logging/dev-logger';
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
	/**
	 * 只推进微任务与零延迟定时器,不依赖被 fake 的定时器。
	 *
	 * @param ready - 条件。
	 */
	async function flushUntil(ready: () => boolean): Promise<void> {
		for (let attempt = 0; attempt < 200; attempt += 1) {
			await new Promise<void>(resolve => setImmediate(resolve));
			// 零延迟定时器与微任务交替推进:不依赖被测代码是否使用定时器,也不要求 mock 定时器。
			await new Promise<void>(resolve => setTimeout(resolve, 0));
			if (ready()) return;
		}
		throw new Error('条件在 200 次推进内未满足');
	}
	/**
	 * 轮询到某个**异步读取**条件成立(墙钟预算)。
	 *
	 * 关键路径(修掉全量并发下的假失败):「写盘被调用」不等于「落盘完成」,
	 * 定点推进若干次微任务后读磁盘会读到写之前的状态。这里按墙钟等真实 I/O 完成,
	 * 超时后仍如实失败,不放宽被测语义。
	 *
	 * @param ready - 异步条件(通常是一次真实磁盘读取)。
	 * @param timeoutMs - 墙钟预算。
	 */
	async function waitUntil(ready: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			if (await ready()) return;
			if (Date.now() >= deadline) throw new Error(`异步条件在 ${timeoutMs}ms 墙钟预算内未满足`);
			await new Promise<void>(resolve => setImmediate(resolve));
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
		// 关键路径(T7 收紧后的夹具口径):生产装配**总是**注入 `fileRecords`,所以默认夹具
		// 也注入一份「与磁盘清单一致」的记录端口 —— 否则「本轮扫描成功即完成」这类用例会
		// 因为「缺端口 = 不可判定」而全部变成 false,不再检验它们真正想检验的收敛判据。
		// 需要「缺端口」语义的用例显式传 `fileRecords: null`(见 `'fileRecords' in extra`)。
		const backend = new PersistentIndexBackend({
			indexDir: dir, manifest, worker, getStore: () => store,
			vault,
			getBuildStamp: () => stamp, getChunkOptions: () => ({ maxTokens: 100, overlapTokens: 0 }),
			fileRecords: 'fileRecords' in extra ? extra.fileRecords : manifestDerivedRecords(manifest),
			...extra,
		});
		return { store, inline, worker, manifest, backend, embed, vault, manager: new IndexManager(backend) };
	}
	/**
	 * 从磁盘清单推导的完成记录端口 — 只用于让默认夹具具备「记录覆盖清单」的前提。
	 *
	 * 关键路径:它不是产品实现,只代表「装配正确时记录端口与清单一致」。
	 * 记录语义(含 tombstone 二分、隔离路径排除)由真实 `IndexFileJournal` 用例单独证明。
	 */
	function manifestDerivedRecords(manifest: IndexManifest): FileRecordReader {
		const read = async (): Promise<ReadonlyArray<CommittedFileRecord>> => {
			const data = await manifest.load();
			if (!data) return [];
			return Object.entries(data.entries).map(([entryPath, entry]) => ({
				path: entryPath,
				state: 'present' as const,
				revision: 1,
				inputHash: entry.hash,
				chunkCount: entry.chunkCount,
			}));
		};
		return {
			listReceipts: read,
			listTombstones: async () => [],
			listSearchableReceipts: read,
		};
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

    it('部分可用性 - 未注入文件记录端口 - 返回 null 且完整性判为不可判定', async () => {
        const first = await create(undefined, 1000, { fileRecords: null });
        await first.manager.onLayoutReady();
        expect(await first.backend.searchableFileRecords()).toBeNull();
        // 关键路径(T7 收紧):缺记录端口是**不可判定**,不是「已核验」—— 不再乐观返回 true。
        // 生产装配已注入 `IndexFileJournal`(装配守卫强制),因此该分支只应出现在错误装配中,
        // 而错误装配必须失败关闭、不能宣告全库完成。
        expect(await first.backend.isIndexComplete()).toBe(false);
        // 反向对照:同一份磁盘状态注入记录端口后,完整性判定才可能为真。
        const covered = await create(undefined, 1000, { fileRecords: manifestDerivedRecords(first.manifest) });
        await covered.manager.onLayoutReady();
        expect(await covered.backend.isIndexComplete()).toBe(true);
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

        // 关键路径(T7 收口):装配点与「记录端口注入」都用**同一份**登记账本
// (`tests/helpers/index-assembly-registry.ts`)双向断言 —— 该账本同时被可见性门守卫复用,
// 不再保留第二份平行清单;新增装配点未登记、或登记项与实际不符都会失败。
        const constructionPointCounts: Record<string, number> = {};
        const pendingPointCounts: Record<string, number> = {};
        for (const site of sites) {
            constructionPointCounts[site.file] = (constructionPointCounts[site.file] ?? 0) + 1;
            if (!site.args.includes('fileRecords:')) {
                pendingPointCounts[site.file] = (pendingPointCounts[site.file] ?? 0) + 1;
            }
        }
        expect(sites.length).toBeGreaterThanOrEqual(1);
        // 关键路径(S5):**逐点计数**而不是「哪些文件有构造点」—— 同一文件里的第二个构造点
        // 会改变计数,不会因为「该文件另有一处合规」被文件级布尔吞掉。
        expect(constructionPointCounts).toEqual(REGISTERED_INDEX_ASSEMBLY.backendConstructionPointCounts);
        // 关键路径:缺 `fileRecords` 的装配点**计数**必须与账本精确相等(双向):
        // 新增漏点未登记立即失败;登记项在注入后未删除同样失败。
        expect(pendingPointCounts).toEqual(REGISTERED_INDEX_ASSEMBLY.pendingFileRecordsPointCounts);
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


	describe('迟到终态登记(T6 还清 T5 登记债)', () => {
		/** 替身捕获到的一次写请求。 */
		interface DeferredCall {
			request: { type: string; payload: Record<string, unknown> };
			options: { taskId?: string; epoch?: number; onLateTerminal?: (response: WorkerResponse) => void };
			/** 正常终态:结算调用方的等待。 */
			deliverNormal: (response: WorkerResponse) => void;
			/** 等待先结束(停滞/超时/取消):此后真实终态只能经迟到通道交付。 */
			failWaiting: (error: Error) => void;
			/** 迟到终态:按真实契约要求「等待已结束」,否则显式失败。 */
			deliverLate: (response: WorkerResponse) => void;
			/** 人工逆序:迟到回调先于等待结算 —— 仅用于验证 settle-once(真实管理器不会这样交付)。 */
			deliverLateBeforeSettle: (response: WorkerResponse) => void;
		}

		/** 捕获 `options` 并允许延后投递真实终态的 WorkerManager 替身。 */
		interface DeferredWorker {
			calls: DeferredCall[];
			/** 被派发的独占操作数 — 证明归属断言不通过时根本没走到 `dropIndex`。 */
			exclusiveRuns: number;
			runExclusive: <T>(operation: () => Promise<T> | T) => Promise<T>;
			request: (
				request: { type: string; payload: Record<string, unknown> },
				options?: DeferredCall['options'],
			) => Promise<WorkerResponse>;
		}

		/**
		 * 构造替身 — 「正常结算」与「迟到交付」严格分开。
		 *
		 * 关键路径(修掉用例的隐性竞态):真实 `WorkerManager.finishPending` 的契约是
		 * `onLateTerminal ⟹ 调用方的等待已经结束`。旧替身在 `settle` 之前先调 `onLateTerminal`,
		 * 违反了这条契约,断言点之后状态还会翻转(约 100ms 才暴露)。这里把两条交付路径显式分开:
		 * `deliverLate` 在等待未结束时直接抛错,而逆序场景只能通过 `deliverLateBeforeSettle` 显式声明。
		 */
		function createDeferredWorker(): DeferredWorker {
			const calls: DeferredCall[] = [];
			const worker: DeferredWorker = {
				calls,
				exclusiveRuns: 0,
				runExclusive<T>(operation: () => Promise<T> | T): Promise<T> {
					worker.exclusiveRuns += 1;
					return Promise.resolve(operation());
				},
				request(request, options = {}): Promise<WorkerResponse> {
					let waiterSettled = false;
					let settle: ((value: WorkerResponse) => void) | null = null;
					let fail: ((reason: Error) => void) | null = null;
					const waiting = new Promise<WorkerResponse>((resolve, reject) => {
						settle = resolve;
						fail = reject;
					});
					calls.push({
						request,
						options,
						deliverNormal: (response: WorkerResponse): void => {
							waiterSettled = true;
							settle?.(response);
						},
						failWaiting: (error: Error): void => {
							waiterSettled = true;
							fail?.(error);
						},
						deliverLate: (response: WorkerResponse): void => {
							if (!waiterSettled) throw new Error('契约违例:调用方等待未结束就投递迟到终态');
							options.onLateTerminal?.(response);
						},
						deliverLateBeforeSettle: (response: WorkerResponse): void => {
							options.onLateTerminal?.(response);
							waiterSettled = true;
							settle?.(response);
						},
					});
					return waiting;
				},
			};
			return worker;
		}

		/** 装配一个 Worker 走替身、其余全走真实磁盘的后端。 */
		async function createDeferredBackend(options: {
			indexDir?: string;
			getTaskId?: () => string;
			getEpoch?: () => number;
			onLateTerminalCommitted?: PersistentIndexBackendOptions['onLateTerminalCommitted'];
			pendingWriteLimit?: number;
			assertDropOwnership?: PersistentIndexBackendOptions['assertDropOwnership'];
			/**
			 * 覆盖磁盘存储。
			 *
			 * 关键路径(守卫用例):默认路径会在 `indexDir` 上构造真实 `VectraStore` 并 `autoInit`
			 * —— 它往被判定目录里写 `index.json`,反而让 pluginDir 形状的目录「看起来像索引目录」。
			 * 传入未初始化的存储后,目录形状保持原样,守卫是否闭合仍然可证。
			 */
			store?: VectraStore;
		} = {}): Promise<{ dir: string; deferred: DeferredWorker; manifest: IndexManifest; backend: PersistentIndexBackend }> {
			const indexDir = options.indexDir ?? dir;
			const deferred = createDeferredWorker();
			const manifest = new IndexManifest(resolveIndexManifestPath(indexDir));
			const store = options.store ?? new VectraStore(indexDir);
			if (!options.store) await store.isIndexCreated();
			const { indexDir: _unusedIndexDir, store: _unusedStore, ...rest } = options;
			void _unusedIndexDir;
			void _unusedStore;
			const backend = new PersistentIndexBackend({
				indexDir, manifest, worker: deferred as never, getStore: () => store,
				vault: { listMarkdownFiles: () => [...files.keys()], readFile: async (p: string) => files.get(p)!, stat: () => ({ mtime: 1 }) },
				getBuildStamp: () => stamp, getChunkOptions: () => ({ maxTokens: 100, overlapTokens: 0 }),
				...rest,
			} as PersistentIndexBackendOptions);
			return { dir: indexDir, deferred, manifest, backend };
		}

		/** 写一份空清单 — 单文件提交路径需要磁盘上已有派生视图可写。 */
		async function seedEmptyManifest(manifest: IndexManifest): Promise<void> {
			await manifest.save({ version: 1, ...stamp, entries: {}, lastIndexTime: Date.now() });
		}

		it('迟到终态 - 等待结束前的真实终态 - 正常提交清单与构建戳且不触发迟到回调', async () => {
			const committed: Array<{ requestType: string; indexed: number }> = [];
			const { deferred, manifest, backend } = await createDeferredBackend({
				getTaskId: () => 'task-from-coordinator',
				getEpoch: () => 7,
				onLateTerminalCommitted: (info) => committed.push({ requestType: info.requestType, indexed: info.indexed }),
			});

			const task = backend.fullReindex();
			void task.catch(() => undefined);
			await flushUntil(() => deferred.calls.length > 0);
			const call = deferred.calls[0]!;
			// 关键路径:T5 登记债的接线证据 —— 任务标识与 epoch 必须随请求显式下发。
			expect(call.options.taskId).toBe('task-from-coordinator');
			expect(call.options.epoch).toBe(7);
			call.deliverNormal({ type: 'index.done', payload: { indexed: 1, errors: 0 } } as never);
			await task;

			const data = await manifest.load();
			expect(data?.entries['a.md']).toBeDefined();
			expect(await readBuildStamp(dir)).toEqual(stamp);
			// 正常路径不触发迟到回调。
			expect(committed).toEqual([]);
			expect(backend.pendingWriteCount()).toBe(0);
		});

		it('迟到终态 - 正常等待已结算的同一条终态再次投递 - 不重复提交', async () => {
			const lateCallbacks: unknown[] = [];
			const { deferred, manifest, backend } = await createDeferredBackend({
				getTaskId: () => 'task-once',
				onLateTerminalCommitted: () => lateCallbacks.push('late'),
			});
			const save = vi.spyOn(manifest, 'save');

			const task = backend.fullReindex();
			void task.catch(() => undefined);
			await flushUntil(() => deferred.calls.length > 0);
			const call = deferred.calls[0]!;
			call.deliverNormal({ type: 'index.done', payload: { indexed: 1, errors: 0 } } as never);
			await task;
			expect(save).toHaveBeenCalledTimes(1);

			// 同一条终态再经迟到通道到达:settle-once 必须让它成为空操作。
			call.deliverLate({ type: 'index.done', payload: { indexed: 1, errors: 0 } } as never);
			// 负向断言的观察窗:重复终态若被排进提交队列,这里才会看到第二次写盘。
			await new Promise<void>(resolve => setTimeout(resolve, 20));

			expect(save).toHaveBeenCalledTimes(1);
			// 正常路径已完成提交时,迟到回调不得再报一次成功。
			expect(lateCallbacks).toEqual([]);
			const data = await manifest.load();
			expect(Object.keys(data?.entries ?? {}).sort()).toEqual(['a.md', 'b.md']);
		});

		it('迟到终态 - 逆序投递(迟到回调先到) - settle-once 保证只提交一次', async () => {
			// 关键路径:这是审查者探针的顺序。真实管理器不会这样交付,但模块注释声称的
			// 「同一终态只提交一次」必须在两条顺序下都成立。
			const lateCallbacks: unknown[] = [];
			const { deferred, manifest, backend } = await createDeferredBackend({
				getTaskId: () => 'task-reversed',
				onLateTerminalCommitted: (info) => lateCallbacks.push(info),
			});
			const save = vi.spyOn(manifest, 'save');

			const task = backend.fullReindex();
			await flushUntil(() => deferred.calls.length > 0);
			deferred.calls[0]!.deliverLateBeforeSettle({ type: 'index.done', payload: { indexed: 1, errors: 0 } } as never);
			// 关键路径:逆序下正常路径复用迟到路径的 settlement —— `await task` 返回时提交已完成,
			// 这里只需一个观察窗确认没有第二次提交被排队。
			await task;
			await new Promise<void>(resolve => setTimeout(resolve, 20));

			expect(save).toHaveBeenCalledTimes(1);
			expect(lateCallbacks).toHaveLength(1);
			const data = await manifest.load();
			expect(Object.keys(data?.entries ?? {}).sort()).toEqual(['a.md', 'b.md']);
		});

		it('迟到终态 - 停滞超时后真实终态到达 - 仍被后端接收并完成提交,回调只在落盘后触发', async () => {
			const observed: Array<{ diskHash: string | null; stampOnDisk: unknown }> = [];
			const { deferred, manifest, backend } = await createDeferredBackend({
				getTaskId: () => 'task-stalled',
				getEpoch: () => 3,
				onLateTerminalCommitted: () => {
					// 关键路径:回调必须在落盘之后触发 —— 这里直接读磁盘证明,而不是只断言「回调被调用」。
					let diskHash: string | null = null;
					try {
						const raw = JSON.parse(fs.readFileSync(resolveIndexManifestPath(dir), 'utf8')) as { entries?: Record<string, { hash?: string }> };
						diskHash = raw.entries?.['a.md']?.hash ?? null;
					}
					catch {
						diskHash = null;
					}
					observed.push({ diskHash, stampOnDisk: fs.existsSync(resolveBuildStampPath(dir)) });
				},
			});

			const task = backend.fullReindex();
			const rejected = expect(task).rejects.toThrow('index-stalled');
			await flushUntil(() => deferred.calls.length > 0);
			const call = deferred.calls[0]!;
			expect(call.options.taskId).toBe('task-stalled');
			expect(call.options.epoch).toBe(3);

			// 模拟停滞:调用方的等待以超时结束(真实终态此刻还没到)。
			call.failWaiting(new Error('index-stalled'));
			await rejected;
			// 等待结束不等于已提交:此刻不得留下半成品凭据。
			expect(await manifest.load()).toBeNull();

			// 真实终态迟到到达 —— 必须仍被后端接收并完成清单与构建戳提交。
			call.deliverLate({ type: 'index.done', payload: { indexed: 2, errors: 0 } } as never);
			await flushUntil(() => observed.length > 0);
			const data = await manifest.load();
			expect(data?.entries['a.md']?.hash).toBe(await sha256('original'));
			expect(await readBuildStamp(dir)).toEqual(stamp);
			expect(observed).toEqual([{ diskHash: await sha256('original'), stampOnDisk: true }]);
		});

		it('阻断 B1 - 同 taskId 的两个请求先后停滞 - 各自终态只作用于自己的提交,无错配无丢失', async () => {
			// 关键路径:协调器的 taskId 轮内恒定,两个写请求必然拿到同一个 taskId;
			// 旧实现用 taskId 当 pendingWrites 的键,第二个请求会覆盖第一个的上下文。
			const { deferred, manifest, backend } = await createDeferredBackend({
				getTaskId: () => 'same-task',
				getEpoch: () => 1,
			});
			await seedEmptyManifest(manifest);

			const first = backend.incrementalIndex({ path: 'a.md', content: 'A' });
			const firstRejected = expect(first).rejects.toThrow('index-stalled');
			void first.catch(() => undefined);
			await flushUntil(() => deferred.calls.length > 0);
			deferred.calls[0]!.failWaiting(new Error('index-stalled'));
			await firstRejected;

			const second = backend.incrementalIndex({ path: 'b.md', content: 'B' });
			void second.catch(() => undefined);
			await flushUntil(() => deferred.calls.length > 1);
			expect(deferred.calls[1]!.options.taskId).toBe('same-task');
			// 两个请求的挂起上下文都在:每请求唯一键不会被同轮的第二个请求顶掉。
			expect(backend.pendingWriteCount()).toBe(2);

			// 第一个请求的真实终态迟到到达 —— 只能作用于 a.md。
			deferred.calls[0]!.deliverLate({ type: 'index.done', payload: { indexed: 1, errors: 0, chunkCount: 1 } } as never);
			// 第二个请求自己的终态随后到达,不能被顶替,也不能丢失。
			deferred.calls[1]!.deliverNormal({ type: 'index.done', payload: { indexed: 1, errors: 0, chunkCount: 1 } } as never);
			await second;
			// 关键路径:等在途的迟到提交真正落盘后再断言磁盘(「写盘被调用」不等于「已完成」)。
			await waitUntil(async () => Object.keys((await manifest.load())?.entries ?? {}).length === 2);

			const data = await manifest.load();
			expect(Object.keys(data?.entries ?? {}).sort()).toEqual(['a.md', 'b.md']);
			expect(data?.entries['a.md']?.hash).toBe(await sha256('A'));
			expect(data?.entries['b.md']?.hash).toBe(await sha256('B'));
			expect(backend.pendingWriteCount()).toBe(0);
		});

		it('阻断 B2 - index.batch 迟到终态 - 磁盘清单与构建戳必须真的落盘', async () => {
			const { deferred, manifest, backend } = await createDeferredBackend({
				getTaskId: () => 'batch-task',
				getEpoch: () => 1,
			});
			// 已有兼容清单 + 已建索引 → smartReindex 走 hash diff 的 index.batch 分支。
			await seedEmptyManifest(manifest);

			const task = backend.smartReindex();
			const rejected = expect(task).rejects.toThrow('index-stalled');
			void task.catch(() => undefined);
			await flushUntil(() => deferred.calls.length > 0);
			expect(deferred.calls[0]!.request.type).toBe('index.batch');
			deferred.calls[0]!.failWaiting(new Error('index-stalled'));
			await rejected;
			// 等待结束时刻:清单与戳都还没有本次提交的内容。
			expect(await manifest.load()).toMatchObject({ entries: {} });
			expect(await readBuildStamp(dir)).toBeNull();

			deferred.calls[0]!.deliverLate({
				type: 'index.batch.done',
				payload: { indexed: 2, errors: 0, chunkCounts: { 'a.md': 1, 'b.md': 1 } },
			} as never);
			await waitUntil(async () => (await manifest.load())?.entries['b.md'] !== undefined);

			const data = await manifest.load();
			expect(data?.entries['a.md']?.hash).toBe(await sha256('original'));
			expect(data?.entries['b.md']?.hash).toBe(await sha256('unchanged'));
			expect(await readBuildStamp(dir)).toEqual(stamp);
		});

		it('迟到终态 - 逆序投递 index.batch(迟到回调先到) - 工作副本改从磁盘真值重建,不覆盖本批', async () => {
			// 关键路径:审查者探针顺序(真实管理器不会这样交付)。补强前该顺序下批量的正常提交闭包
			// 被 settle-once 跳过,末尾 `commit` 用「没有本批条目」的陈旧工作副本覆盖磁盘 →
			// 实测 manifest.save 被调 2 次、磁盘 keys=[]。这里断言磁盘必须保住本批。
			const { deferred, manifest, backend } = await createDeferredBackend({
				getTaskId: () => 'batch-reversed',
				getEpoch: () => 1,
			});
			await seedEmptyManifest(manifest);
			const save = vi.spyOn(manifest, 'save');

			const task = backend.smartReindex();
			void task.catch(() => undefined);
			await flushUntil(() => deferred.calls.length > 0);
			expect(deferred.calls[0]!.request.type).toBe('index.batch');
			deferred.calls[0]!.deliverLateBeforeSettle({
				type: 'index.batch.done',
				payload: { indexed: 2, errors: 0, chunkCounts: { 'a.md': 1, 'b.md': 1 } },
			} as never);
			await task;
			// 负向断言的观察窗:若末尾还排队了一次覆盖写,这里才会看到第二次落盘。
			await new Promise<void>(resolve => setTimeout(resolve, 20));

			const data = await manifest.load();
			expect(Object.keys(data?.entries ?? {}).sort()).toEqual(['a.md', 'b.md']);
			expect(data?.entries['a.md']?.hash).toBe(await sha256('original'));
			expect(data?.entries['b.md']?.hash).toBe(await sha256('unchanged'));
			expect(await readBuildStamp(dir)).toEqual(stamp);
			// 关键路径:迟到路径已把本批落盘,调用方不该再重复同一次提交 —— 逆序与正序都是 1 次。
			expect(save).toHaveBeenCalledTimes(1);
		});

		it('影响 - 批量成功但后续删除停滞 - 批量新增先落盘一次,迟到删除不连带丢掉本轮新增', async () => {
			// 关键路径(镜像代价):旧语义下本轮只有末尾一次 commit。批量正常成功后若某个删除停滞,
			// 调用方永远走不到末尾 commit,迟到删除只从磁盘真值移除目标条目 —— 本轮全部批量新增
			// 在磁盘上消失(审查者实测 keys=[])。这里断言批量侧已先落盘一次,迟到删除保留它。
			const { deferred, manifest, backend } = await createDeferredBackend({
				getTaskId: () => 'batch-then-stall',
				getEpoch: () => 1,
			});
			await manifest.save({
				version: 1,
				...stamp,
				lastIndexTime: Date.now(),
				entries: { 'gone.md': { path: 'gone.md', hash: await sha256('G'), mtime: 1, chunkCount: 1 } },
			});

			const task = backend.smartReindex();
			const rejected = expect(task).rejects.toThrow('index-stalled');
			void task.catch(() => undefined);
			await flushUntil(() => deferred.calls.length > 0);
			expect(deferred.calls[0]!.request.type).toBe('index.batch');
			deferred.calls[0]!.deliverNormal({
				type: 'index.batch.done',
				payload: { indexed: 2, errors: 0, chunkCounts: { 'a.md': 1, 'b.md': 1 } },
			} as never);
			await flushUntil(() => deferred.calls.length > 1);
			expect(deferred.calls[1]!.request.type).toBe('index.delete');
			// 关键路径:进入删除循环前批量新增必须已经在磁盘上(否则迟到删除会把它一起丢掉)。
			const afterBatch = await manifest.load();
			expect(Object.keys(afterBatch?.entries ?? {}).sort()).toEqual(['a.md', 'b.md', 'gone.md']);

			// 删除停滞:调用方的等待以超时结束,末尾 commit 不会执行。
			deferred.calls[1]!.failWaiting(new Error('index-stalled'));
			await rejected;
			expect(Object.keys((await manifest.load())?.entries ?? {}).sort()).toEqual(['a.md', 'b.md', 'gone.md']);

			deferred.calls[1]!.deliverLate({ type: 'vector.delete.done', payload: { count: 1 } } as never);
			await waitUntil(async () => (await manifest.load())?.entries['gone.md'] === undefined);

			// 关键路径:最终磁盘 = 本轮批量新增 + 删除已生效,而不是「只剩删除结果」。
			const data = await manifest.load();
			expect(Object.keys(data?.entries ?? {}).sort()).toEqual(['a.md', 'b.md']);
			expect(data?.entries['a.md']?.hash).toBe(await sha256('original'));
			expect(await readBuildStamp(dir)).toEqual(stamp);
		});

		it('影响 - 删除路径写盘次数 - deleteFile 一次、smartReindex 的 N 个删除共一次', async () => {
			// 关键路径:选定语义 = 闭包只改内存、调用方统一落盘(见 `deleteVectors` JSDoc)。
			// 旧实现闭包内 commitDelete + 调用方再 commit,单文件 2 次、N 个删除 N+1 次。
			files.set('c.md', 'C');
			files.set('d.md', 'D');
			const { deferred, manifest, backend } = await createDeferredBackend({ getEpoch: () => 1 });

			const full = backend.fullReindex();
			void full.catch(() => undefined);
			await flushUntil(() => deferred.calls.length > 0);
			deferred.calls[0]!.deliverNormal({ type: 'index.done', payload: { indexed: 4, errors: 0 } } as never);
			await full;
			expect(Object.keys((await manifest.load())?.entries ?? {}).sort()).toEqual(['a.md', 'b.md', 'c.md', 'd.md']);

			const save = vi.spyOn(manifest, 'save');
			// 单文件删除:1 次写盘。
			const single = backend.deleteFile('a.md');
			void single.catch(() => undefined);
			await flushUntil(() => deferred.calls.length > 1);
			deferred.calls[1]!.deliverNormal({ type: 'vector.delete.done', payload: { count: 1 } } as never);
			await single;
			expect(save).toHaveBeenCalledTimes(1);
			expect(Object.keys((await manifest.load())?.entries ?? {}).sort()).toEqual(['b.md', 'c.md', 'd.md']);

			// 一轮里删除 2 个文件:共 1 次写盘(N+1 → 1);文件快照与清单同步收缩,避免多出 index.batch。
			save.mockClear();
			files.delete('a.md');
			files.delete('c.md');
			files.delete('d.md');
			const diff = backend.smartReindex();
			void diff.catch(() => undefined);
			await flushUntil(() => deferred.calls.length > 2);
			deferred.calls[2]!.deliverNormal({ type: 'vector.delete.done', payload: { count: 1 } } as never);
			await flushUntil(() => deferred.calls.length > 3);
			deferred.calls[3]!.deliverNormal({ type: 'vector.delete.done', payload: { count: 1 } } as never);
			await diff;
			expect(deferred.calls[2]!.request.type).toBe('index.delete');
			expect(deferred.calls[3]!.request.type).toBe('index.delete');
			expect(save).toHaveBeenCalledTimes(1);
			expect(Object.keys((await manifest.load())?.entries ?? {})).toEqual(['b.md']);
		});

		it('影响 - 删除迟到终态 - 调用方退出后仍落盘移除条目且只写一次', async () => {
			// 关键路径:删除的正常路径由调用方落盘;等待一旦停滞,调用方就不会再走到那一步,
			// 因此迟到路径必须自己完成「重载清单 → removeEntry → 落盘」,且只 removeEntry 一次。
			const { deferred, manifest, backend } = await createDeferredBackend({ getEpoch: () => 1 });

			const full = backend.fullReindex();
			void full.catch(() => undefined);
			await flushUntil(() => deferred.calls.length > 0);
			deferred.calls[0]!.deliverNormal({ type: 'index.done', payload: { indexed: 2, errors: 0 } } as never);
			await full;
			expect(Object.keys((await manifest.load())?.entries ?? {}).sort()).toEqual(['a.md', 'b.md']);

			const save = vi.spyOn(manifest, 'save');
			const single = backend.deleteFile('a.md');
			const rejected = expect(single).rejects.toThrow('index-stalled');
			void single.catch(() => undefined);
			await flushUntil(() => deferred.calls.length > 1);
			deferred.calls[1]!.failWaiting(new Error('index-stalled'));
			await rejected;
			// 等待结束不等于已提交:此刻磁盘仍是完整旧版。
			expect(Object.keys((await manifest.load())?.entries ?? {}).sort()).toEqual(['a.md', 'b.md']);
			expect(save).not.toHaveBeenCalled();

			deferred.calls[1]!.deliverLate({ type: 'vector.delete.done', payload: { count: 1 } } as never);
			await waitUntil(async () => Object.keys((await manifest.load())?.entries ?? {}).join(',') === 'b.md');

			// 只移除目标路径,且只写盘一次(不重复 removeEntry、不重复 commit)。
			expect(save).toHaveBeenCalledTimes(1);
			expect(Object.keys((await manifest.load())?.entries ?? {})).toEqual(['b.md']);
		});

		it('影响 - pendingWrites 有界回收 - 超限淘汰最旧且清空后迟到终态成为空操作', async () => {
			const { deferred, manifest, backend } = await createDeferredBackend({
				getTaskId: () => 'bounded',
				getEpoch: () => 1,
				pendingWriteLimit: 1,
			});
			await seedEmptyManifest(manifest);

			const first = backend.incrementalIndex({ path: 'a.md', content: 'A' });
			const firstRejected = expect(first).rejects.toThrow('index-stalled');
			void first.catch(() => undefined);
			await flushUntil(() => deferred.calls.length > 0);
			deferred.calls[0]!.failWaiting(new Error('index-stalled'));
			await firstRejected;
			expect(backend.pendingWriteCount()).toBe(1);

			// 第二个停滞请求登记时超限 → 最旧的第一个被淘汰,其闭包不再驻留。
			const second = backend.incrementalIndex({ path: 'b.md', content: 'B' });
			const secondRejected = expect(second).rejects.toThrow('index-stalled');
			void second.catch(() => undefined);
			await flushUntil(() => deferred.calls.length > 1);
			deferred.calls[1]!.failWaiting(new Error('index-stalled'));
			await secondRejected;
			expect(backend.pendingWriteCount()).toBe(1);

			// 被淘汰的终态不再提交;仍登记的终态照常提交。
			deferred.calls[0]!.deliverLate({ type: 'index.done', payload: { indexed: 1, errors: 0, chunkCount: 1 } } as never);
			deferred.calls[1]!.deliverLate({ type: 'index.done', payload: { indexed: 1, errors: 0, chunkCount: 1 } } as never);
			await flushUntil(() => backend.pendingWriteCount() === 0);
			await waitUntil(async () => Object.keys((await manifest.load())?.entries ?? {}).join(',') === 'b.md');

			// 显式清空:取消/运行时重置后终态永不投递,闭包必须立刻释放。
			const third = backend.incrementalIndex({ path: 'a.md', content: 'A2' });
			const thirdRejected = expect(third).rejects.toThrow('index-stalled');
			void third.catch(() => undefined);
			await flushUntil(() => deferred.calls.length > 2);
			deferred.calls[2]!.failWaiting(new Error('index-stalled'));
			await thirdRejected;
			expect(backend.pendingWriteCount()).toBe(1);
			expect(backend.clearPendingWrites()).toBe(1);
			expect(backend.pendingWriteCount()).toBe(0);
			deferred.calls[2]!.deliverLate({ type: 'index.done', payload: { indexed: 1, errors: 0, chunkCount: 1 } } as never);
			for (let attempt = 0; attempt < 100; attempt += 1) await new Promise<void>(resolve => setImmediate(resolve));
			expect(Object.keys((await manifest.load())?.entries ?? {})).toEqual(['b.md']);
		});

		it('阻断 B2 - 归属断言不通过 - 拒绝清库且不删除任何文件', async () => {
			const root = path.join(dir, '.index');
			const generation = path.join(root, 'generations', 'gen-0123456789abcdef');
			fs.mkdirSync(generation, { recursive: true });
			fs.writeFileSync(path.join(root, 'control.json'), '{"activeGenerationId":"gen-0123456789abcdef"}', 'utf8');
			fs.writeFileSync(path.join(root, 'owner.lock'), '{}', 'utf8');
			fs.writeFileSync(path.join(generation, 'index.json'), '{}', 'utf8');

			const { deferred, backend } = await createDeferredBackend({ indexDir: root, getEpoch: () => 1 });
			await expect(backend.dropIndex()).rejects.toMatchObject({ code: 'index-directory-not-owned' });
			// 关键路径:断言在 `dropIndex` 之前闭合 —— 独占操作根本没被派发,文件一个都没少。
			expect(deferred.exclusiveRuns).toBe(0);
			expect(fs.existsSync(path.join(root, 'control.json'))).toBe(true);
			expect(fs.existsSync(path.join(root, 'owner.lock'))).toBe(true);
			expect(fs.existsSync(path.join(generation, 'index.json'))).toBe(true);
		});

		it('阻断 B2 - generations 下的异形目录 - 归属断言同样拒绝', async () => {
			const root = path.join(dir, '.index');
			const foreign = path.join(root, 'generations', 'legacy-index');
			fs.mkdirSync(foreign, { recursive: true });
			fs.writeFileSync(path.join(foreign, 'index.json'), '{}', 'utf8');

			const { deferred, backend } = await createDeferredBackend({ indexDir: foreign, getEpoch: () => 1 });
			await expect(backend.dropIndex()).rejects.toMatchObject({ code: 'index-directory-not-owned' });
			expect(deferred.exclusiveRuns).toBe(0);
			expect(fs.existsSync(path.join(foreign, 'index.json'))).toBe(true);
		});

		it('阻断 B2 - 缺省守卫 - pluginDir 形状的目录 - 拒绝清库且不删除任何文件', async () => {
			// 关键路径:审查者实测 —— 收紧形状白名单前后端缺省判定也放行了这个目录。
			// 这里用未初始化的存储:真实 `VectraStore` 的 autoInit 会往被判定目录写 index.json,
			// 反而让 pluginDir 形状的目标「看起来像索引目录」。
			const pluginDir = path.join(dir, 'plugin-dir-shape');
			const attachments = path.join(pluginDir, 'attachments');
			fs.mkdirSync(attachments, { recursive: true });
			fs.writeFileSync(path.join(pluginDir, 'main.js'), 'module.exports = {};', 'utf8');
			fs.writeFileSync(path.join(pluginDir, 'manifest.json'), '{"id":"ratel-vault"}', 'utf8');
			fs.writeFileSync(path.join(pluginDir, 'data.json'), '{}', 'utf8');
			fs.writeFileSync(path.join(attachments, 'note.png'), 'BIN', 'utf8');

			const { deferred, backend } = await createDeferredBackend({
				indexDir: pluginDir,
				getEpoch: () => 1,
				store: new VectraStore(path.join(dir, 'unused-store'), { autoInit: false }),
			});
			await expect(backend.dropIndex()).rejects.toMatchObject({ code: 'index-directory-not-owned' });
			// 关键路径:断言在 `dropIndex` 之前闭合 —— 独占操作根本没被派发,文件一个都没少。
			expect(deferred.exclusiveRuns).toBe(0);
			expect(fs.readdirSync(pluginDir).sort()).toEqual(['attachments', 'data.json', 'main.js', 'manifest.json']);
			expect(fs.readdirSync(attachments)).toEqual(['note.png']);
			expect(fs.existsSync(path.join(pluginDir, 'index.json'))).toBe(false);
		});

		it('阻断 B2 - 注入严格版归属端口 - 优先于缺省形状白名单(T7 的收紧入口)', async () => {
			// 关键路径:缺省判定只做到形状白名单(含 index.json 的普通目录放行);T7 装配代际目录后
			// **必须**注入「basename 是本索引根 `generations/` 下的 `gen-16hex`」的严格版。
			// 这里证明注入端口确实存在、被优先使用,并且能拒绝缺省会放行的目标。
			const plain = path.join(dir, 'plain-index-strict');
			fs.mkdirSync(plain, { recursive: true });
			fs.writeFileSync(path.join(plain, 'index.json'), '{"version":1,"items":[]}', 'utf8');
			const rejections: string[] = [];
			const { deferred, backend } = await createDeferredBackend({
				indexDir: plain,
				getEpoch: () => 1,
				store: new VectraStore(path.join(dir, 'unused-strict'), { autoInit: false }),
				assertDropOwnership: (indexDir) => {
					rejections.push(indexDir);
					throw new IndexDirectoryNotOwnedError(indexDir, '严格版(T7):目标不是本索引根 generations/ 下的代际目录');
				},
			});

			await expect(backend.dropIndex()).rejects.toMatchObject({
				code: 'index-directory-not-owned',
				reason: expect.stringContaining('严格版(T7)'),
			});
			expect(rejections).toEqual([path.resolve(plain)]);
			expect(deferred.exclusiveRuns).toBe(0);
			expect(fs.existsSync(path.join(plain, 'index.json'))).toBe(true);
		});

		it('阻断 B2 - 缺省守卫 - 目录不存在或为空 - 允许清库(形状白名单不误伤)', async () => {
			// 关键路径:形状白名单只拒绝「非空且无索引特征」;空目录与不存在没有可误删的内容,
			// 不能因为它们不是索引目录就把清库路径一并堵死。
			const missing = path.join(dir, 'missing-index');
			const empty = path.join(dir, 'empty-index');
			fs.mkdirSync(empty, { recursive: true });
			for (const [name, target] of [['missing', missing], ['empty', empty]] as const) {
				const { deferred, backend } = await createDeferredBackend({
					indexDir: target,
					getEpoch: () => 1,
					store: new VectraStore(path.join(dir, `unused-store-${name}`), { autoInit: false }),
				});
				await expect(backend.dropIndex()).resolves.not.toThrow();
				// 允许的判定必须真的走到独占写通道 —— 不是「被拒绝后静默当成功」。
				expect(deferred.exclusiveRuns).toBe(1);
			}
			// 被判定目录本身保持原样:空目录仍为空、不存在的仍未创建。
			expect(fs.readdirSync(empty)).toEqual([]);
			expect(fs.existsSync(missing)).toBe(false);
		});

		it('影响 - getEpoch 缺省 - 明确告警一次且不下发 epoch(fail-open 不静默)', async () => {
			const warn = vi.spyOn(devLogger, 'warn');
			try {
				const { deferred, manifest, backend } = await createDeferredBackend({ getTaskId: () => 'no-epoch' });
				// 关键路径:缺省必须**可查询**,不能只靠受 `debugLog` 门控的告警 ——
				// 第一次写请求之前状态里就要能看出「本轮缺少 epoch 保护」。
				expect(backend.roundState().epochSourceMissing).toBe(true);
				await seedEmptyManifest(manifest);
				const task = backend.fullReindex();
				void task.catch(() => undefined);
				await flushUntil(() => deferred.calls.length > 0);
				// 缺省不硬拒绝(装配尚未注入),但必须显式告警且把事实说清楚。
				expect(deferred.calls[0]!.options.epoch).toBeUndefined();
				expect(warn).toHaveBeenCalledTimes(1);
				expect(String(warn.mock.calls[0]?.[1])).toContain('getEpoch');
				deferred.calls[0]!.deliverNormal({ type: 'index.done', payload: { indexed: 1, errors: 0 } } as never);
				await task;
				// 告警有界:后续写请求不再刷屏;结构化标记保持为 true。
				expect(warn).toHaveBeenCalledTimes(1);
				expect(backend.roundState().epochSourceMissing).toBe(true);
			}
			finally {
				warn.mockRestore();
			}
		});

		it('影响 - getEpoch 注入 - epochSourceMissing 为 false 且不发告警(T7 关闭 fail-open 的判定依据)', async () => {
			const warn = vi.spyOn(devLogger, 'warn');
			try {
				const { deferred, manifest, backend } = await createDeferredBackend({ getEpoch: () => 9 });
				expect(backend.roundState().epochSourceMissing).toBe(false);
				await seedEmptyManifest(manifest);
				const task = backend.fullReindex();
				void task.catch(() => undefined);
				await flushUntil(() => deferred.calls.length > 0);
				expect(deferred.calls[0]!.options.epoch).toBe(9);
				deferred.calls[0]!.deliverNormal({ type: 'index.done', payload: { indexed: 1, errors: 0 } } as never);
				await task;
				expect(warn).not.toHaveBeenCalled();
				expect(backend.roundState().epochSourceMissing).toBe(false);
			}
			finally {
				warn.mockRestore();
			}
		});
	});

});
