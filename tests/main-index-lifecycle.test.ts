/**
 * @file tests/main-index-lifecycle.test.ts
 * @description main.ts 启动索引结果与完成反馈集成测试
 * @module tests/main-index-lifecycle
 * @depends src/main
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import RatelVaultPlugin from '../src/main';
import { InlineWorker } from '../src/worker/inline-worker';
import { get, writable } from 'svelte/store';
import { IndexManager } from '../src/core/index-manager';
import { FeedbackController } from '../src/core/feedback-controller';
import { UserStatus } from '../src/user-feedback/user-status';
import type { ModelStatus } from '../src/core/model-manager';
// 关键路径:Node 测试环境没有真实 Obsidian 宿主,用最小 stub 让 Plugin 及其子类可实例化。
vi.mock('obsidian', () => ({
	App: class {
	},
	Plugin: class {
		loadData = vi.fn().mockResolvedValue({});
		saveData = vi.fn().mockResolvedValue(undefined);
		registerEvent = vi.fn().mockReturnValue(() => { });
		registerView = vi.fn();
		addRibbonIcon = vi.fn();
		addCommand = vi.fn();
		addSettingTab = vi.fn();
		addStatusBarItem = vi.fn().mockReturnValue({
			hide: vi.fn(),
			onClickEvent: vi.fn(),
		});
	},
	PluginSettingTab: class {
		app: unknown;
		// 修复:设置页构造依赖宿主 app，替身须保持父类注入契约。
		constructor(app: unknown) { this.app = app; }
	},
	SettingPage: class {
	},
	Setting: class {
	},
	Notice: class {
	},
	WorkspaceLeaf: class {
	},
	ItemView: class {
	},
	FileSystemAdapter: class {
	},
	TFile: class {
	},
	Modal: class {
		open() { }
		close() { }
	},
	requestUrl: vi.fn().mockResolvedValue({ json: () => Promise.resolve({ models: [] }) }),
}));
vi.mock('worker_threads', () => ({
	Worker: class {
		on = vi.fn();
		postMessage = vi.fn();
		terminate = vi.fn();
	},
	workerData: {},
}));
// 关键路径:避免测试时写 .gitignore 到文件系统。
vi.mock('../src/utils/gitignore-writer', () => ({
	ensurePluginGitignore: vi.fn(),
}));
// 关键路径:vitest 未配置 Svelte 编译器,避免加载 .svelte 文件。
vi.mock('../src/ui/chat/ChatView', () => ({
	ChatView: class {
	},
	VIEW_TYPE_CHAT: 'ratel-chat',
}));
// 关键路径:MemoryModal import MemoryPanel.svelte,vitest 没配 svelte 解析器,需 stub
vi.mock('../src/ui/memory-panel/MemoryModal', () => ({
	MemoryModal: class {
	},
	shouldCreateMemoryModal: (current: unknown) => current === null,
}));
function barePlugin(): any {
    const plugin = Object.create(RatelVaultPlugin.prototype) as any;
    // 关键路径:跳过构造函数时,**带初始化器的类字段不会被赋值**(原型上也没有),
    // 读取得到的是 `undefined`。装配代码用 `this.indexUnavailable !== null` 判定「已降级」时,
    // `undefined` 会被误判成已降级并走进报错出口;替身必须补齐构造期默认值才等价于真实实例。
    plugin.indexUnavailable = null;
    return plugin;
}

describe('启动完成通知', () => {
	it.each([true, false])('启动结果 - 空结果且 autoIndex=%s - 不通知完成', async (autoIndex) => {
		const plugin = barePlugin();
		plugin.settings = { embedProvider: 'api', autoIndex, lastSeenRelease: '1.2.0' };
		plugin.manifest = { version: '1.2.0' };
		plugin.indexController = { onLayoutReady: vi.fn(async () => null) };
		plugin.workerManager = { clearProgressCallback: vi.fn(), setProgressCallback: vi.fn() };
		plugin.feedbackController = { notifyFullIndexComplete: vi.fn() };
		plugin.userNotice = { toastError: vi.fn() };
		await plugin.onLayoutReady();
		expect(plugin.indexController.onLayoutReady).toHaveBeenCalledWith(autoIndex);
		expect(plugin.feedbackController.notifyFullIndexComplete).not.toHaveBeenCalled();
	});
    it.each([{ indexed: 0, skipped: 2 }, { indexed: 1, skipped: 1 }])('完成通知 - 热启动实际处理$indexed、跳过$skipped - 保留Ready全库数量', async result => {
        const manager = new IndexManager({
            fullReindex: vi.fn(), incrementalIndex: vi.fn(), deleteFile: vi.fn(),
            smartReindex: async () => ({ ...result, errors: 0 }),
        });
        const plugin = barePlugin();
        const userStatus = new UserStatus();
        const userNotice = { toastError: vi.fn(), toast: vi.fn(), toastProgress: vi.fn() } as any;
        const feedback = new FeedbackController({
            modelStatus$: writable<ModelStatus>({ state: 'NotStarted' }),
            indexStatus$: manager.status$, userStatus, userNotice,
            getEmbeddingReady: () => true,
            getSettings: () => ({ embedProvider: 'api', embedApiBase: '', chatApiBase: '' }),
        });
        plugin.settings = { embedProvider: 'api', autoIndex: true, lastSeenRelease: '1.2.0' };
        plugin.manifest = { version: '1.2.0' };
        plugin.indexController = { onLayoutReady: () => manager.onLayoutReady() };
        plugin.workerManager = { clearProgressCallback: vi.fn() };
        plugin.feedbackController = feedback;
        plugin.userNotice = userNotice;
        feedback.start();
        try {
            await plugin.onLayoutReady();
            expect(get(manager.status$)).toMatchObject({ state: 'Ready', totalDocs: 2 });
            expect(get(userStatus.statusBar$)).toMatchObject({ index: 'ready', indexDocCount: 2 });
        } finally { feedback.destroy(); manager.destroy(); }
    });

    it('完成通知 - 本轮尚未全库完成(isIndexComplete=false)- 不宣告完成', async () => {
        const manager = new IndexManager({
            fullReindex: vi.fn(), incrementalIndex: vi.fn(), deleteFile: vi.fn(),
            smartReindex: async () => ({ indexed: 1, errors: 0, skipped: 1 }),
        });
        const plugin = barePlugin();
        const userStatus = new UserStatus();
        const userNotice = { toastError: vi.fn(), toast: vi.fn(), toastProgress: vi.fn() } as any;
        const feedback = new FeedbackController({
            modelStatus$: writable<ModelStatus>({ state: 'NotStarted' }),
            indexStatus$: manager.status$, userStatus, userNotice,
            getEmbeddingReady: () => true,
            getSettings: () => ({ embedProvider: 'api', embedApiBase: '', chatApiBase: '' }),
        });
        const notify = vi.spyOn(feedback, 'notifyFullIndexComplete');
        plugin.settings = { embedProvider: 'api', autoIndex: true, lastSeenRelease: '1.2.0' };
        plugin.manifest = { version: '1.2.0' };
        plugin.indexController = { onLayoutReady: () => manager.onLayoutReady() };
        // 关键路径:本轮有队列/失败/凭据缺口时 isIndexComplete() 为假,不得弹「全库完成」。
        plugin.indexBackend = { isIndexComplete: vi.fn(async () => false) };
        plugin.workerManager = { clearProgressCallback: vi.fn() };
        plugin.feedbackController = feedback;
        plugin.userNotice = userNotice;
        feedback.start();
        try {
            await plugin.onLayoutReady();
            expect(plugin.indexBackend.isIndexComplete).toHaveBeenCalled();
            expect(notify).not.toHaveBeenCalled();
        } finally { feedback.destroy(); manager.destroy(); }
    });

    it('完成通知 - isIndexComplete=true - 才宣告本轮全库完成', async () => {
        const manager = new IndexManager({
            fullReindex: vi.fn(), incrementalIndex: vi.fn(), deleteFile: vi.fn(),
            smartReindex: async () => ({ indexed: 1, errors: 0, skipped: 1 }),
        });
        const plugin = barePlugin();
        const userStatus = new UserStatus();
        const userNotice = { toastError: vi.fn(), toast: vi.fn(), toastProgress: vi.fn() } as any;
        const feedback = new FeedbackController({
            modelStatus$: writable<ModelStatus>({ state: 'NotStarted' }),
            indexStatus$: manager.status$, userStatus, userNotice,
            getEmbeddingReady: () => true,
            getSettings: () => ({ embedProvider: 'api', embedApiBase: '', chatApiBase: '' }),
        });
        const notify = vi.spyOn(feedback, 'notifyFullIndexComplete');
        plugin.settings = { embedProvider: 'api', autoIndex: true, lastSeenRelease: '1.2.0' };
        plugin.manifest = { version: '1.2.0' };
        plugin.indexController = { onLayoutReady: () => manager.onLayoutReady() };
        plugin.indexBackend = { isIndexComplete: vi.fn(async () => true) };
        plugin.workerManager = { clearProgressCallback: vi.fn() };
        plugin.feedbackController = feedback;
        plugin.userNotice = userNotice;
        feedback.start();
        try {
            await plugin.onLayoutReady();
            expect(notify).toHaveBeenCalledWith(1, 0);
        } finally { feedback.destroy(); manager.destroy(); }
    });

});

describe('只读装配的检索可见性门(autoIndex=false)', () => {
    it('readOnlyChanged 的路径按 known-stale 拒绝 - 不是 unresolved-transaction', async () => {
        const plugin = barePlugin();
        plugin.settings = { autoIndex: false };
        const refreshed: Array<ReadonlySet<string>> = [];
        plugin.indexController = {
            readOnlyChanged: () => new Set(['changed.md']),
            isExcluded: () => false,
        };
        plugin.readOnlySearchView = {
            refresh: async (paths: ReadonlySet<string>) => { refreshed.push(paths); },
            decide: async (path: string) => ({ visible: true, path, freshness: 'unknown' }),
            recordsKind: () => 'known',
        };

        const gate = plugin.createSearchCandidateGate();
        await gate.refresh();

        // 关键路径:内存变更集必须传给只读视图(过滤依据),同时按 known-stale 归类。
        expect(refreshed).toHaveLength(1);
        expect([...refreshed[0]!]).toEqual(['changed.md']);
        expect(await gate.decide('changed.md')).toMatchObject({
            visible: false,
            reason: 'known-stale',
            freshness: 'known-stale',
        });
        // 未变更路径沿用只读视图的判定:记录可信、新鲜度 unknown(不声称已核对)。
        expect(await gate.decide('kept.md')).toMatchObject({ visible: true, freshness: 'unknown' });
        expect(gate.recordsKind()).toBe('known');
    });

    it('没有可信记录(无活动代际的只读装配)- 一律不可检索且不报告为空集', async () => {
        const plugin = barePlugin();
        plugin.settings = { autoIndex: false };
        plugin.indexController = { readOnlyChanged: () => new Set<string>(), isExcluded: () => false };
        plugin.readOnlySearchView = undefined;

        const gate = plugin.createSearchCandidateGate();
        await gate.refresh();

        expect(gate.recordsKind()).toBe('unjudgeable');
        expect(await gate.decide('a.md')).toMatchObject({ visible: false, reason: 'unjudgeable' });
    });

    it('写路径装配 - 门在未装配日志时按不可判定拒绝,不静默放行', async () => {
        const plugin = barePlugin();
        plugin.settings = { autoIndex: true };
        plugin.indexController = { readOnlyChanged: () => new Set<string>(), isExcluded: () => false };
        plugin.readOnlySearchView = undefined;
        plugin.indexJournal = undefined;

        const gate = plugin.createSearchCandidateGate();
        await gate.refresh();

        expect(await gate.decide('a.md')).toMatchObject({ visible: false, reason: 'unjudgeable' });
    });

    /**
     * 目录快照 — 相对路径 → 文件内容(base64,逐字节)。
     *
     * 关键路径(S7):「零写入」必须落在真实磁盘事实上,不能只看返回值 ——
     * 快照逐字节比对能同时发现「新增文件(如 owner.lock / index.json)」与「改写既有文件」。
     *
     * @param root - 快照根目录。
     * @returns 相对路径到内容摘要的映射。
     */
    function snapshotDirectory(root: string): Map<string, string> {
        const snapshot = new Map<string, string>();
        const pending = [root];
        while (pending.length > 0) {
            const current = pending.pop()!;
            for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
                const fullPath = path.join(current, entry.name);
                if (entry.isDirectory()) pending.push(fullPath);
                else if (entry.isFile()) snapshot.set(path.relative(root, fullPath), fs.readFileSync(fullPath).toString('base64'));
            }
        }
        return snapshot;
    }

    it('只读装配 - autoIndex=false 且有活动代际 - 除读取外零写入、store 以 autoInit:false 构造、不初始化 worker 存储', async () => {
        const pluginDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ratel-readonly-'));
        try {
            // 夹具:`.index/control.json` 指向一条真实存在的活动代际目录 —— 「有活动代际」是
            // 本用例与「无活动代际」分支的分界,必须真实落到磁盘上。
            const indexRoot = path.join(pluginDir, '.index');
            const generationId = 'gen-0123456789abcdef';
            const generationRoot = path.join(indexRoot, 'generations', generationId);
            await fsp.mkdir(generationRoot, { recursive: true });
            await fsp.writeFile(path.join(indexRoot, 'control.json'), JSON.stringify({
                schemaVersion: 2,
                activeGenerationId: generationId,
                generations: {
                    [generationId]: {
                        schemaVersion: 2,
                        generationId,
                        fingerprint: 'f'.repeat(64),
                        kind: 'fresh',
                        status: 'active',
                        root: generationRoot,
                        verifiedAt: null,
                        quarantineReason: null,
                        createdAt: 1,
                        updatedAt: 1,
                    },
                },
            }), 'utf8');
            // 关键路径(T7/I3):旧版插件根的 `index-manifest.json` 会被迁移函数 mkdir + rename ——
            // 只读装配必须在 autoIndex 判定**之后**才碰它,否则「零写入」契约直接失效。
            // 这里把它放进夹具,让快照断言真的覆盖「只读装配不迁移旧清单」这条路径。
            await fsp.writeFile(path.join(pluginDir, 'index-manifest.json'), JSON.stringify({
                version: 1, embedModelId: 'local-default', chunkSize: 1000, embedModelRevision: null,
                files: {},
            }), 'utf8');

            const plugin = barePlugin();
            plugin.settings = {
                autoIndex: false, chunkSize: 1000, chunkOverlap: 100,
                embedProvider: 'local', embedLocalModel: 'default', embedApiBase: '', embedApiModel: '',
            };
            plugin.embedding = { dimensions: 512 };
            plugin.vault = { fileExists: () => false };

            const before = snapshotDirectory(pluginDir);

            // 关键路径:store 的构造参数本身是可观测事实 —— 断言 `autoInit:false` 而不是断言内部状态。
            // `vi.spyOn` 默认透传原实现,这里只记录调用参数,不替换行为。
            const prototype = RatelVaultPlugin.prototype as any;
            const storeSpy = vi.spyOn(prototype, 'createVectraStore');
            // 关键路径:只读装配不得走模型就绪后的 `initWithStore` —— 那条路径会预热并落盘。
            const initWithStoreSpy = vi.spyOn(InlineWorker.prototype, 'initWithStore');
            // 关键路径:`mockRestore()` 会连调用记录一起清掉,因此在 finally 之前先把观测值取出来。
            let createStoreCallCount = -1;
            let createStoreArgs: readonly unknown[] | undefined;
            let initWithStoreCallCount = -1;
            try {
                await plugin.setupIndexRuntime(pluginDir);
                createStoreCallCount = storeSpy.mock.calls.length;
                createStoreArgs = storeSpy.mock.calls[0];
                initWithStoreCallCount = initWithStoreSpy.mock.calls.length;
            } finally {
                storeSpy.mockRestore();
                initWithStoreSpy.mockRestore();
            }

            // 非恒真保证:走的是「有活动代际」分支,而不是控制指针读取失败的早退分支。
            expect(plugin.activeGenerationId).toBe(generationId);
            expect(plugin.indexDirUsable).toBe(true);
            expect(plugin.resolvedGenerationId).toBe(generationId);
            expect(plugin.indexJournal).toBeDefined();
            expect(plugin.readOnlySearchView).toBeDefined();

            // 逐字节零写入:快照完全相等(同时覆盖 owner.lock 未建、index.json 未写、无新文件)。
            expect(snapshotDirectory(pluginDir)).toEqual(before);
            expect(fs.existsSync(path.join(indexRoot, 'owner.lock'))).toBe(false);
            // 旧清单原地未动、也没有被搬进 `.index/` —— 只读装配不做 legacy 迁移。
            expect(fs.existsSync(path.join(pluginDir, 'index-manifest.json'))).toBe(true);
            expect(fs.existsSync(path.join(indexRoot, 'ratel-manifest.json'))).toBe(false);

            // store 以 autoInit:false 构造,且**只**构造一次(不重复 init 会话)。
            expect(createStoreCallCount).toBe(1);
            expect(createStoreArgs?.[0]).toBe(false);
            // `initWithStore` 未被调用 —— 只读装配不预热 worker 存储。
            expect(initWithStoreCallCount).toBe(0);
        } finally {
            await fsp.rm(pluginDir, { recursive: true, force: true });
        }
    });
});
