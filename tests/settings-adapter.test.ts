/**
 * @file tests/settings-adapter.test.ts
 * @description embedProvider 切换 → rebuildEmbeddingAdapter 创建正确的 adapter
 * @module tests/settings-adapter
 * @depends main, adapters/embedding-*
 *
 * 关键路径:用 Object.create(prototype) 绕过 Obsidian 框架,只测方法本身。
 * 这是 L2 集成测试 — 调真实 EmbeddingLocal / EmbeddingApi 构造,不 mock。
 */

import { describe, it, expect, vi } from 'vitest';

// 关键路径:src/main.ts 顶部 import obsidian,需要 stub 才能加载
vi.mock('obsidian', () => ({
	App: class {},
	Plugin: class {},
	PluginSettingTab: class {},
	Setting: class {},
	Notice: class {},
	WorkspaceLeaf: class {},
	ItemView: class {},
	editor: { Editor: class {} },
	Modal: class {
		open() {}
		close() {}
	},
}));

// 关键路径:ChatView.ts 拉 ChatView.svelte,svelte 解析器在 vitest 没配会失败。
// 提供最小 stub 让 main.ts 的 ChatView import 走得通。
vi.mock('svelte', () => ({
	mount: () => ({}),
	unmount: () => {},
}));

vi.mock('../src/ui/chat/ChatView.svelte', () => ({
	default: class {},
}));

vi.mock('../src/ui/chat/ChatView', () => ({
	ChatView: class {},
	VIEW_TYPE_CHAT: 'ratel-chat',
}));

import RatelVaultPlugin from '../src/main';
import { DEFAULT_SETTINGS } from '../src/settings';
import { EmbeddingLocal } from '../src/adapters/embedding-local';
import { EmbeddingApi } from '../src/adapters/embedding-api';

describe('RatelVaultPlugin.rebuildEmbeddingAdapter', () => {
	it('embedProvider=local → 创建 EmbeddingLocal', () => {
		// 关键路径:用 Object.create 绕过 Obsidian 框架,只测方法本身
		const plugin = Object.create(RatelVaultPlugin.prototype) as RatelVaultPlugin;
		plugin.settings = { ...DEFAULT_SETTINGS, embedProvider: 'local' };

		plugin.rebuildEmbeddingAdapter();

		expect(plugin.embedding).toBeInstanceOf(EmbeddingLocal);
	});

	it('embedProvider=api → 创建 EmbeddingApi', () => {
		const plugin = Object.create(RatelVaultPlugin.prototype) as RatelVaultPlugin;
		plugin.settings = { ...DEFAULT_SETTINGS, embedProvider: 'api' };

		plugin.rebuildEmbeddingAdapter();

		expect(plugin.embedding).toBeInstanceOf(EmbeddingApi);
	});

	it('切换 provider 后,旧 adapter 引用被替换', () => {
		const plugin = Object.create(RatelVaultPlugin.prototype) as RatelVaultPlugin;
		plugin.settings = { ...DEFAULT_SETTINGS, embedProvider: 'local' };

		plugin.rebuildEmbeddingAdapter();
		const localAdapter = plugin.embedding;

		plugin.settings.embedProvider = 'api';
		plugin.rebuildEmbeddingAdapter();

		expect(plugin.embedding).not.toBe(localAdapter);
		expect(plugin.embedding).toBeInstanceOf(EmbeddingApi);
	});

	it('EmbeddingLocal 固定使用 512 维', () => {
		const plugin = Object.create(RatelVaultPlugin.prototype) as RatelVaultPlugin;
		plugin.settings = {
			...DEFAULT_SETTINGS,
			embedProvider: 'local',
		};

		plugin.rebuildEmbeddingAdapter();

		expect(plugin.embedding).toBeInstanceOf(EmbeddingLocal);
		// 关键路径:本地只内置 bge-small-zh-v1.5,维度固定 512,与 settings.embedLocalDimensions 无关。
		expect((plugin.embedding as EmbeddingLocal).dimensions).toBe(512);
	});

	it('EmbeddingApi 接收 dimensions 参数', () => {
		const plugin = Object.create(RatelVaultPlugin.prototype) as RatelVaultPlugin;
		plugin.settings = {
			...DEFAULT_SETTINGS,
			embedProvider: 'api',
			embedApiDimensions: 1536,
		};

		plugin.rebuildEmbeddingAdapter();

		expect(plugin.embedding).toBeInstanceOf(EmbeddingApi);
		expect((plugin.embedding as EmbeddingApi).dimensions).toBe(1536);
	});
});
