/**
 * @file tests/main-rag-loop.test.ts
 * @description main.ts RAG 闭环接入集成测试
 * @module tests/main-rag-loop
 * @depends src/main
 */
import { describe, it, expect, vi } from 'vitest';
import RatelVaultPlugin from '../src/main';
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
});
