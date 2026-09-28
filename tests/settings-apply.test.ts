/**
 * @file tests/settings-apply.test.ts
 * @description applySettingValue 共享设置应用逻辑单测(从 settings.declarative.test.ts 迁移写入/副作用类用例)
 * @module tests/settings-apply
 */

import { describe, it, expect, vi } from 'vitest';
import { applySettingValue } from '../src/settings/settings-apply';
import { DEFAULT_SETTINGS, type RatelVaultSettings } from '../src/settings';
import type { ModelContextLookup } from '../src/settings/chat-profiles';

// 关键路径:registry mock — 与 ModelContextLookup 结构兼容,不依赖真实网络
const makeRegistry = (map: Record<string, number>): ModelContextLookup => ({
	ensureRegistry: async () => map,
	lookupContextLength: (model: string, m: unknown) =>
		(m as Record<string, number | undefined>)[model],
});

// 关键路径:mock 最小宿主 — settings + 三个副作用回调;
// vi.fn<() => void>() 显式签名使其可赋给 SettingApplier 的回调类型
function mockApplier() {
	return {
		settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as RatelVaultSettings,
		rebuildLLM: vi.fn<() => void>(),
		rebuildEmbeddingAdapter: vi.fn<() => void>(),
		syncToolDefinitions: vi.fn<() => void>(),
		modelContextRegistry: undefined as ModelContextLookup | undefined,
	};
}

describe('applySettingValue', () => {
	it('嵌套 toolPermissions key - 写入嵌套对象而非字面量字段', () => {
		const p = mockApplier();
		applySettingValue(p, 'toolPermissions.search_vault', 'allow');
		expect(p.settings.toolPermissions.search_vault).toBe('allow');
		expect(
			(p.settings as unknown as Record<string, unknown>)['toolPermissions.search_vault'],
		).toBeUndefined();
	});

	it('嵌套 promptOverrides key - 写入嵌套对象并触发 syncToolDefinitions', () => {
		const p = mockApplier();
		applySettingValue(p, 'promptOverrides.system.role', 'custom text');
		expect((p.settings.promptOverrides as Record<string, string | undefined>)['system.role']).toBe('custom text');
		expect(p.syncToolDefinitions).toHaveBeenCalledTimes(1);
	});

	it('chatModel 变更 - 提供商按地址推断保持 deepseek 并 rebuildLLM', () => {
		const p = mockApplier();
		p.settings.chatPreset = 'deepseek';
		applySettingValue(p, 'chatModel', 'gpt-4');
		expect(p.settings.chatModel).toBe('gpt-4');
		// 关键路径:提供商不另存字段,由地址推断 — 官方 DeepSeek 地址上改模型名仍是 deepseek
		expect(p.settings.chatPreset).toBe('deepseek');
		expect(p.rebuildLLM).toHaveBeenCalledTimes(1);
	});

	it('chatApiBase 变更 - preset 切 custom 并 rebuildLLM', () => {
		const p = mockApplier();
		p.settings.chatPreset = 'deepseek';
		applySettingValue(p, 'chatApiBase', 'https://example.com/v1');
		expect(p.settings.chatPreset).toBe('custom');
		expect(p.rebuildLLM).toHaveBeenCalledTimes(1);
	});

	it('chatApiBase 变更为官方 DeepSeek 地址 - 提供商推断为 deepseek', () => {
		const p = mockApplier();
		p.settings.chatPreset = 'custom';
		applySettingValue(p, 'chatApiBase', 'https://api.deepseek.com');
		expect(p.settings.chatPreset).toBe('deepseek');
		expect(p.rebuildLLM).toHaveBeenCalledTimes(1);
	});

	it('embedApiBase 变更 - 触发 rebuildEmbeddingAdapter', () => {
		const p = mockApplier();
		applySettingValue(p, 'embedApiBase', 'http://new:11434/v1');
		expect(p.rebuildEmbeddingAdapter).toHaveBeenCalledTimes(1);
	});

	it('embedLocalModel 变更 - 不触发 rebuildEmbeddingAdapter', () => {
		const p = mockApplier();
		applySettingValue(p, 'embedLocalModel', 'Xenova/other');
		expect(p.rebuildEmbeddingAdapter).not.toHaveBeenCalled();
	});

	it('chatPreset deepseek - 写入多字段并 rebuildLLM', () => {
		const p = mockApplier();
		p.settings.chatModel = 'other';
		p.settings.chatApiBase = 'https://example.com';
		applySettingValue(p, 'chatPreset', 'deepseek');
		expect(p.settings.chatPreset).toBe('deepseek');
		expect(p.settings.chatModel).toBe('deepseek-v4-flash');
		expect(p.settings.chatApiBase).toBe('https://api.deepseek.com');
		expect(p.rebuildLLM).toHaveBeenCalledTimes(1);
	});

	it('contextLengthPreset 变更 - 同步 chatModelMaxTokens', () => {
		const p = mockApplier();
		// 关键路径:默认 preset 是 256k,选 128k 才能验证「变更」而非「写入原值」
		applySettingValue(p, 'contextLengthPreset', '128k');
		expect(p.settings.contextLengthPreset).toBe('128k');
		expect(p.settings.chatModelMaxTokens).toBe(128_000);
	});

	it('toolPermissionLevel 非法值 - 不写入', () => {
		const p = mockApplier();
		const before = p.settings.toolPermissionLevel;
		applySettingValue(p, 'toolPermissionLevel', 'yolo');
		expect(p.settings.toolPermissionLevel).toBe(before);
	});

	it('顶层普通 key - 直接写入', () => {
		const p = mockApplier();
		applySettingValue(p, 'chunkSize', 800);
		expect(p.settings.chunkSize).toBe(800);
	});
});

// S-CHAT-SETUP:当前套展开区的提供商 / 模型名 / 窗口写入语义
describe('applySettingValue - S-CHAT-SETUP 展开区语义', () => {
	/** 构造带活跃套 p1 的宿主(另含非活跃套 p2 用于隔离断言) */
	function withProfiles(p: ReturnType<typeof mockApplier>) {
		p.settings.chatProfiles = [
			{
				id: 'p1',
				name: '当前',
				apiBase: 'https://a',
				model: 'm1',
				contextLengthPreset: '256k',
				chatModelMaxTokens: 256_000,
			},
			{
				id: 'p2',
				name: '其它',
				apiBase: 'https://b',
				model: 'm2',
				contextLengthPreset: '128k',
				chatModelMaxTokens: 128_000,
			},
		];
		p.settings.activeChatProfileId = 'p1';
		// 关键路径:当前四字段须与活跃套一致(真实链路中二者始终镜像)
		p.settings.chatModel = 'm1';
		p.settings.chatApiBase = 'https://a';
		return p;
	}

	it('chatPreset 切 Ollama - 镜像四字段回活跃套、清 windowUserSet 并按映射表写窗口', async () => {
		const p = withProfiles(mockApplier());
		p.modelContextRegistry = makeRegistry({ 'llama3.2': 128_000 });
		p.settings.chatProfiles[0]!.windowUserSet = true;

		await applySettingValue(p, 'chatPreset', 'ollama');

		expect(p.settings.chatApiBase).toBe('http://localhost:11434/v1');
		expect(p.settings.chatModel).toBe('llama3.2');
		expect(p.settings.chatProfiles[0]!.apiBase).toBe('http://localhost:11434/v1');
		expect(p.settings.chatProfiles[0]!.model).toBe('llama3.2');
		expect(p.settings.chatProfiles[0]!.windowUserSet).toBe(false);
		// 换提供商后窗口按映射表写入,不再沿用旧值
		expect(p.settings.chatModelMaxTokens).toBe(128_000);
		expect(p.settings.chatProfiles[0]!.chatModelMaxTokens).toBe(128_000);
		expect(p.rebuildLLM).toHaveBeenCalledTimes(1);
	});

	it('chatPreset 切自定义 - 官方地址被清空、模型名保留并重查窗口', async () => {
		const p = withProfiles(mockApplier());
		p.modelContextRegistry = makeRegistry({ m1: 200_000 });
		// 关键路径:切自定义前地址是官方 DeepSeek(会被清空),模型名保留
		p.settings.chatApiBase = 'https://api.deepseek.com';
		p.settings.chatProfiles[0]!.apiBase = 'https://api.deepseek.com';
		p.settings.chatProfiles[0]!.windowUserSet = true;

		await applySettingValue(p, 'chatPreset', 'custom');

		expect(p.settings.chatPreset).toBe('custom');
		expect(p.settings.chatApiBase).toBe('');
		expect(p.settings.chatModel).toBe('m1');
		expect(p.settings.chatProfiles[0]!.apiBase).toBe('');
		expect(p.settings.chatProfiles[0]!.windowUserSet).toBe(false);
		expect(p.settings.chatModelMaxTokens).toBe(200_000);
	});

	it('chatPreset 切自定义 - 地址已是自定义 - 不清空用户地址', async () => {
		const p = withProfiles(mockApplier());

		await applySettingValue(p, 'chatPreset', 'custom');

		expect(p.settings.chatPreset).toBe('custom');
		expect(p.settings.chatApiBase).toBe('https://a');
	});

	it('chatModel 变更 - 清活跃套 windowUserSet 并按映射表写窗口', async () => {
		const p = withProfiles(mockApplier());
		p.modelContextRegistry = makeRegistry({ 'new-model': 200_000 });
		p.settings.chatProfiles[0]!.windowUserSet = true;

		await applySettingValue(p, 'chatModel', 'new-model');

		expect(p.settings.chatProfiles[0]!.windowUserSet).toBe(false);
		expect(p.settings.contextLengthPreset).toBe('200k');
		expect(p.settings.chatModelMaxTokens).toBe(200_000);
		expect(p.settings.chatProfiles[0]!.chatModelMaxTokens).toBe(200_000);
	});

	it('chatModel 变更未查到 - 清空旧上限不静默沿用', async () => {
		const p = withProfiles(mockApplier());
		p.modelContextRegistry = makeRegistry({});

		await applySettingValue(p, 'chatModel', 'unknown-model');

		expect(p.settings.contextLengthPreset).toBe('custom');
		expect(p.settings.chatModelMaxTokens).toBe(0);
		expect(p.settings.chatProfiles[0]!.contextLengthPreset).toBe('custom');
		expect(p.settings.chatProfiles[0]!.chatModelMaxTokens).toBe(0);
	});

	it('chatModelMaxTokens 用户改小 - 写入并标记 windowUserSet', async () => {
		const p = withProfiles(mockApplier());
		p.modelContextRegistry = makeRegistry({ m1: 256_000 });

		await applySettingValue(p, 'chatModelMaxTokens', 100_000);

		expect(p.settings.chatModelMaxTokens).toBe(100_000);
		expect(p.settings.contextLengthPreset).toBe('custom');
		expect(p.settings.chatProfiles[0]!.chatModelMaxTokens).toBe(100_000);
		expect(p.settings.chatProfiles[0]!.windowUserSet).toBe(true);
		// 非活跃套不受影响
		expect(p.settings.chatProfiles[1]!.chatModelMaxTokens).toBe(128_000);
	});

	it('chatModelMaxTokens 大于查到的窗口 - 钳到查到的值且不标 windowUserSet', async () => {
		const p = withProfiles(mockApplier());
		p.modelContextRegistry = makeRegistry({ m1: 200_000 });

		await applySettingValue(p, 'chatModelMaxTokens', 500_000);

		expect(p.settings.chatModelMaxTokens).toBe(200_000);
		expect(p.settings.contextLengthPreset).toBe('200k');
		expect(p.settings.chatProfiles[0]!.windowUserSet).toBe(false);
	});

	it('chatModelMaxTokens 非法值(0)- 静默忽略不写入', async () => {
		const p = withProfiles(mockApplier());

		await applySettingValue(p, 'chatModelMaxTokens', 0);

		expect(p.settings.chatModelMaxTokens).toBe(256_000);
		expect(p.settings.chatProfiles[0]!.chatModelMaxTokens).toBe(256_000);
	});
});
