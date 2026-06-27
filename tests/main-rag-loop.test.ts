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
	App: class {},
	Plugin: class {
		loadData = vi.fn().mockResolvedValue({});
		saveData = vi.fn().mockResolvedValue(undefined);
		registerEvent = vi.fn().mockReturnValue(() => {});
		registerView = vi.fn();
		addRibbonIcon = vi.fn();
		addCommand = vi.fn();
		addSettingTab = vi.fn();
	},
	PluginSettingTab: class {},
	Setting: class {},
	Notice: class {},
	FileSystemAdapter: class {},
	TFile: class {},
	Modal: class {
		open() {}
		close() {}
	},
}));
vi.mock('worker_threads', () => ({
	Worker: class {
		on = vi.fn();
		postMessage = vi.fn();
		terminate = vi.fn();
	},
	workerData: {},
}));

// 关键路径:避免测试时创建真实 vectra 索引目录。
vi.mock('../src/adapters/vector-vectra', () => ({
	VectraStore: class {},
}));

// 关键路径:避免测试时写 .gitignore 到文件系统。
vi.mock('../src/utils/gitignore-writer', () => ({
	ensurePluginGitignore: vi.fn(),
}));

// 关键路径:vitest 未配置 Svelte 编译器,避免加载 .svelte 文件。
vi.mock('../src/ui/chat/ChatView', () => ({
	ChatView: class {},
	VIEW_TYPE_CHAT: 'ratel-chat',
}));

describe('main rag loop integration', () => {
	it('main.ts - search_vault 工具已注册', async () => {
		const plugin = new RatelVaultPlugin();
		plugin.app = {
			vault: {
				adapter: { getBasePath: () => '/tmp/vault' },
				on: vi.fn().mockReturnValue({}),
				offref: vi.fn(),
				getMarkdownFiles: () => [],
				getAbstractFileByPath: () => null,
				read: vi.fn(),
				modify: vi.fn(),
				create: vi.fn(),
				createFolder: vi.fn(),
			},
			workspace: {
				getLeavesOfType: () => [],
				getRightLeaf: () => null,
				onLayoutReady: vi.fn(),
			},
			metadataCache: {
				resolvedLinks: {},
				getFileCache: () => null,
			},
		} as unknown as typeof plugin.app;

		await plugin.onload();

		const defs = plugin.tools.definitions();
		const names = defs.map((d) => d.name);
		expect(names).toContain('search_vault');
		expect(names).toContain('read_note');
	});
});
