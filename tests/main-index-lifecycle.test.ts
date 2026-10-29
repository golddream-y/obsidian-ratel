/**
 * @file tests/main-index-lifecycle.test.ts
 * @description main.ts 启动索引结果与完成反馈集成测试
 * @module tests/main-index-lifecycle
 * @depends src/main
 */
import { describe, it, expect, vi } from 'vitest';
import RatelVaultPlugin from '../src/main';
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
describe('启动完成通知', () => {
	it.each([true, false])('启动结果 - 空结果且 autoIndex=%s - 不通知完成', async (autoIndex) => {
		const plugin = Object.create(RatelVaultPlugin.prototype) as any;
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
        const plugin = Object.create(RatelVaultPlugin.prototype) as any;
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

});
