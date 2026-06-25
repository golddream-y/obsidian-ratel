/**
 * @file tests/integration/settings-propagation.test.ts
 * @description 改 settings 后调 rebuild,adapter 实例被替换;钥匙串 Key 解析
 * @module tests/integration/settings-propagation
 * @depends main, settings, adapters/llm-deepseek, adapters/embedding-*
 *
 * 关键路径:本测试断言手动 rebuild 路径仍工作。当前实现下,settings 字段改动不会
 * 自动 rebuild,需手动调 `plugin.rebuildXxx()`。反应式 Proxy 自动化属于 P-DEFENSIVE-IMPL。
 *
 * 关键路径:Task 5 后 API Key 不再存 settings,改从 Obsidian 钥匙串读取。
 * 本测试 mock `plugin.app.secretStorage.getSecret`,验证 rebuild 时 Key 注入 config。
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

import type { App } from 'obsidian';
import RatelVaultPlugin from '../../src/main';
import { DEFAULT_SETTINGS } from '../../src/settings';
import { DeepSeekLLM } from '../../src/adapters/llm-deepseek';
import { EmbeddingLocal } from '../../src/adapters/embedding-local';
import { EmbeddingApi } from '../../src/adapters/embedding-api';
import { RATEL_SECRET_IDS } from '../../src/secrets/ratel-secrets';

// ==================== 测试辅助 ====================

/**
 * 创建带 mock 钥匙串的 plugin 实例(绕过 Obsidian 框架直接调 rebuild)。
 *
 * @param secrets - 钥匙串密钥字典(getSecret 返回值)
 * @param settingsOverrides - settings 覆盖项
 */
function createPlugin(
	secrets: Record<string, string> = {},
	settingsOverrides: Partial<typeof DEFAULT_SETTINGS> = {},
): RatelVaultPlugin {
	const plugin = Object.create(RatelVaultPlugin.prototype) as RatelVaultPlugin;
	plugin.settings = { ...DEFAULT_SETTINGS, ...settingsOverrides };
	// 关键路径:secretStorage.getSecret 同步返回(与 ratel-secrets.ts 实现一致)。
	plugin.app = {
		secretStorage: {
			getSecret: (id: string) => secrets[id] ?? null,
		},
	} as unknown as App;
	return plugin;
}

describe('Settings 变更传播', () => {
	it('钥匙串 chat key 变更后 rebuildLLM,新 key 进 config', () => {
		// 关键路径:chatApiBase 指向远端(非 localhost)才会读钥匙串。
		const secrets: Record<string, string> = {};
		const plugin = createPlugin(secrets, { chatApiBase: 'https://api.deepseek.com' });

		secrets[RATEL_SECRET_IDS.chatOpenAICompatible] = 'sk-old';
		plugin.rebuildLLM();
		const oldLlm = plugin.llm;

		secrets[RATEL_SECRET_IDS.chatOpenAICompatible] = 'sk-new';
		plugin.rebuildLLM();

		expect(plugin.llm).not.toBe(oldLlm);
		expect(plugin.llm).toBeInstanceOf(DeepSeekLLM);
		// 关键路径:新 LLM 的 config 反映钥匙串里的新 apiKey
		expect(plugin.llm.config.apiKey).toBe('sk-new');
	});

	it('本地 Ollama Chat 免 Key,rebuildLLM 不读钥匙串,apiKey 为空串', () => {
		const secrets: Record<string, string> = {};
		const plugin = createPlugin(secrets, { chatApiBase: 'http://localhost:11434/v1' });

		plugin.rebuildLLM();

		// 关键路径:localhost 端点 requiresChatApiKey=false,resolveChatApiKey 返回 null → 空串。
		expect(plugin.llm.config.apiKey).toBe('');
	});

	it('改 chatApiBase 后 rebuildLLM,新 base 生效', () => {
		const plugin = createPlugin({}, { chatApiBase: 'https://old.api' });
		plugin.rebuildLLM();

		plugin.settings.chatApiBase = 'https://new.api';
		plugin.rebuildLLM();

		expect(plugin.llm.config.apiBase).toBe('https://new.api');
	});

	it('改 embedProvider 从 local 到 api,embedding 类型切换', () => {
		const plugin = createPlugin({}, { embedProvider: 'local' });
		plugin.rebuildEmbeddingAdapter();
		expect(plugin.embedding).toBeInstanceOf(EmbeddingLocal);

		plugin.settings.embedProvider = 'api';
		plugin.rebuildEmbeddingAdapter();
		expect(plugin.embedding).toBeInstanceOf(EmbeddingApi);
	});

	it('钥匙串 embed key 变更后 rebuildEmbeddingAdapter,新 key 进 config', () => {
		// 关键路径:embedProvider=api 且 embedApiBase 远端才会读钥匙串。
		const secrets: Record<string, string> = {};
		const plugin = createPlugin(secrets, {
			embedProvider: 'api',
			embedApiBase: 'https://api.siliconflow.cn/v1',
		});

		secrets[RATEL_SECRET_IDS.embedOpenAICompatible] = 'sk-embed';
		plugin.rebuildEmbeddingAdapter();

		expect(plugin.embedding.config.apiKey).toBe('sk-embed');
	});

	it('local Embedding 免 Key,rebuildEmbeddingAdapter 不读钥匙串', () => {
		const plugin = createPlugin({}, { embedProvider: 'local' });
		plugin.rebuildEmbeddingAdapter();
		expect(plugin.embedding).toBeInstanceOf(EmbeddingLocal);
	});

	it('reranker / indexing / link 字段改动只走 save 路径,不重建 adapter', () => {
		// 关键路径:这些字段没有对应 adapter 重建需求。
		// 关键路径:rerankerApiKey 已移至钥匙串,本用例改用 chunkSize / linkConfidenceThreshold。
		const plugin = createPlugin({});
		plugin.rebuildLLM();
		plugin.rebuildEmbeddingAdapter();
		const oldLlm = plugin.llm;
		const oldEmbed = plugin.embedding;

		// 改 rerankerApiBase(走 save,不 rebuild)
		plugin.settings.rerankerApiBase = 'https://example.com';
		// 改 chunkSize
		plugin.settings.chunkSize = 800;
		// 改 linkConfidenceThreshold
		plugin.settings.linkConfidenceThreshold = 0.8;

		// 不调 rebuild,引用应保持不变
		expect(plugin.llm).toBe(oldLlm);
		expect(plugin.embedding).toBe(oldEmbed);
	});
});
