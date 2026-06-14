/**
 * @file tests/integration/settings-propagation.test.ts
 * @description 改 settings 后调 rebuild,adapter 实例被替换
 * @module tests/integration/settings-propagation
 * @depends main, settings, adapters/llm-deepseek, adapters/embedding-*
 *
 * 关键路径:本测试断言手动 rebuild 路径仍工作。当前实现下,settings 字段改动不会
 * 自动 rebuild,需手动调 `plugin.rebuildXxx()`。反应式 Proxy 自动化属于 P-DEFENSIVE-IMPL。
 */

import { describe, it, expect, vi } from 'vitest';

// 关键路径:同 settings-adapter.test.ts,需要 stub obsidian + svelte + ChatView
vi.mock('obsidian', () => ({
	App: class {},
	Plugin: class {},
	PluginSettingTab: class {},
	Setting: class {},
	Notice: class {},
	WorkspaceLeaf: class {},
	ItemView: class {},
	editor: { Editor: class {} },
}));

vi.mock('svelte', () => ({
	mount: () => ({}),
	unmount: () => {},
}));

vi.mock('../../src/ui/ChatView.svelte', () => ({
	default: class {},
}));

vi.mock('../../src/ui/ChatView', () => ({
	ChatView: class {},
	VIEW_TYPE_CHAT: 'ratel-chat',
}));

import RatelVaultPlugin from '../../src/main';
import { DEFAULT_SETTINGS } from '../../src/settings';
import { DeepSeekLLM } from '../../src/adapters/llm-deepseek';
import { EmbeddingLocal } from '../../src/adapters/embedding-local';
import { EmbeddingApi } from '../../src/adapters/embedding-api';

describe('Settings 变更传播', () => {
	it('改 chatApiKey 后 rebuildLLM 产生新 LLM 实例,config 含新 key', () => {
		// 关键路径:用 Object.create 绕过 Obsidian 框架,直接调 rebuild 验证 config 注入
		const plugin = Object.create(RatelVaultPlugin.prototype) as RatelVaultPlugin;
		plugin.settings = { ...DEFAULT_SETTINGS, chatApiKey: 'old-key' };
		plugin.rebuildLLM();
		const oldLlm = plugin.llm;

		plugin.settings.chatApiKey = 'sk-new';
		plugin.rebuildLLM();

		expect(plugin.llm).not.toBe(oldLlm);
		expect(plugin.llm).toBeInstanceOf(DeepSeekLLM);
		// 关键路径:新 LLM 的 config 反映新 apiKey
		expect(plugin.llm.config.apiKey).toBe('sk-new');
	});

	it('改 chatApiBase 后 rebuildLLM,新 base 生效', () => {
		const plugin = Object.create(RatelVaultPlugin.prototype) as RatelVaultPlugin;
		plugin.settings = { ...DEFAULT_SETTINGS, chatApiBase: 'https://old.api' };
		plugin.rebuildLLM();

		plugin.settings.chatApiBase = 'https://new.api';
		plugin.rebuildLLM();

		expect(plugin.llm.config.apiBase).toBe('https://new.api');
	});

	it('改 embedProvider 从 local 到 api,embedding 类型切换', () => {
		const plugin = Object.create(RatelVaultPlugin.prototype) as RatelVaultPlugin;
		plugin.settings = { ...DEFAULT_SETTINGS, embedProvider: 'local' };
		plugin.rebuildEmbeddingAdapter();
		expect(plugin.embedding).toBeInstanceOf(EmbeddingLocal);

		plugin.settings.embedProvider = 'api';
		plugin.rebuildEmbeddingAdapter();
		expect(plugin.embedding).toBeInstanceOf(EmbeddingApi);
	});

	it('改 embedApiKey 后 rebuildEmbeddingAdapter,新 key 进 config', () => {
		const plugin = Object.create(RatelVaultPlugin.prototype) as RatelVaultPlugin;
		plugin.settings = {
			...DEFAULT_SETTINGS,
			embedProvider: 'api',
			embedApiKey: '',
		};
		plugin.rebuildEmbeddingAdapter();

		plugin.settings.embedApiKey = 'sk-embed';
		plugin.rebuildEmbeddingAdapter();

		expect(plugin.embedding.config.apiKey).toBe('sk-embed');
	});

	it('reranker / indexing / link 字段改动只走 save 路径,不重建 adapter', () => {
		// 关键路径:这些字段没有对应 adapter 重建需求
		const plugin = Object.create(RatelVaultPlugin.prototype) as RatelVaultPlugin;
		plugin.settings = { ...DEFAULT_SETTINGS };
		plugin.rebuildLLM();
		plugin.rebuildEmbeddingAdapter();
		const oldLlm = plugin.llm;
		const oldEmbed = plugin.embedding;

		// 改 rerankerApiKey,不该触发 rebuild
		plugin.settings.rerankerApiKey = 'sk-rerank';
		// 改 chunkSize
		plugin.settings.chunkSize = 800;
		// 改 linkConfidenceThreshold
		plugin.settings.linkConfidenceThreshold = 0.8;

		// 不调 rebuild,引用应保持不变
		expect(plugin.llm).toBe(oldLlm);
		expect(plugin.embedding).toBe(oldEmbed);
	});
});
