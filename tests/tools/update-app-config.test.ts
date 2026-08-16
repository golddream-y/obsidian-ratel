/**
 * @file tests/tools/update-app-config.test.ts
 * @description update_app_config 工具单测 — 白名单写入持久化 / 副作用分发 / 单条拒绝不影响同批 / 空批次
 * @module tests/tools/update-app-config
 * @depends ../../src/tools/update-app-config, ../../src/settings, ../helpers/make-tool-def
 */

import { describe, it, expect, vi } from 'vitest';
import { createUpdateAppConfigTool, type ConfigUpdateHost } from '../../src/tools/update-app-config';
import { DEFAULT_SETTINGS, type RatelVaultSettings } from '../../src/settings';
import { makeToolDef } from '../helpers/make-tool-def';

/** 构造 mock 宿主 — 形状对齐 RatelVaultPlugin(SettingApplier + saveSettings),返回类型交由推断 */
function makeHost(patch?: Partial<RatelVaultSettings>) {
	// 关键路径:深拷贝嵌套容器,避免 applySettingValue 污染共享的 DEFAULT_SETTINGS
	const settings: RatelVaultSettings = {
		...DEFAULT_SETTINGS,
		toolPermissions: { ...DEFAULT_SETTINGS.toolPermissions },
		promptOverrides: {},
		embedAvailableModels: [],
		embedDownloadedModels: [],
		mcpServers: [],
		mcpApprovedSpawns: [],
		...patch,
	};
	return {
		settings,
		rebuildLLM: vi.fn<() => void>(),
		rebuildEmbeddingAdapter: vi.fn<() => void>(),
		syncToolDefinitions: vi.fn<() => void>(),
		saveSettings: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
	};
}

describe('update_app_config', () => {
	it('宿主兼容 - makeHost 返回值满足 ConfigUpdateHost 结构(对齐 RatelVaultPlugin)', () => {
		// 关键路径:编译期结构守卫 — main.ts 传 this 能否通过同一契约
		const host: ConfigUpdateHost = makeHost();
		expect(host.settings).toBeDefined();
	});

	it('readOnly - 工具标记为可写(false)', () => {
		const tool = createUpdateAppConfigTool(makeHost(), makeToolDef('update_app_config'));
		expect(tool.readOnly).toBe(false);
	});

	it('白名单内写入 - 持久化一次并更新 settings - chunkSize 生效', async () => {
		const host = makeHost();
		const tool = createUpdateAppConfigTool(host, makeToolDef('update_app_config'));
		const result = (await tool.execute({ updates: { chunkSize: 800 } })) as Record<string, any>;

		expect(host.settings.chunkSize).toBe(800);
		expect(host.saveSettings).toHaveBeenCalledTimes(1);
		expect(result.applied).toEqual(['chunkSize']);
		expect(result.results).toEqual([{ key: 'chunkSize', ok: true }]);
	});

	it('chatModel 写入 - 触发 rebuildLLM 且场景预设切到 custom', async () => {
		const host = makeHost();
		const tool = createUpdateAppConfigTool(host, makeToolDef('update_app_config'));
		await tool.execute({ updates: { chatModel: 'deepseek-reasoner' } });

		expect(host.settings.chatModel).toBe('deepseek-reasoner');
		// 关键路径:applySettingValue 副作用 — 手改模型后 chatPreset 自动切 custom
		expect(host.settings.chatPreset).toBe('custom');
		expect(host.rebuildLLM).toHaveBeenCalled();
	});

	it('embedProvider 写入 - 触发 rebuildEmbeddingAdapter', async () => {
		const host = makeHost();
		const tool = createUpdateAppConfigTool(host, makeToolDef('update_app_config'));
		await tool.execute({ updates: { embedProvider: 'api', embedApiModel: 'bge-m3' } });

		expect(host.settings.embedProvider).toBe('api');
		expect(host.rebuildEmbeddingAdapter).toHaveBeenCalled();
	});

	it('批次含白名单外 key - 单条拒绝其余照常应用 - 提权项零改动', async () => {
		const host = makeHost();
		const tool = createUpdateAppConfigTool(host, makeToolDef('update_app_config'));
		const result = (await tool.execute({
			updates: {
				toolPermissionLevel: 'danger',
				autoIndex: false,
			},
		})) as Record<string, any>;

		// 提权项被拒且原值不动
		expect(host.settings.toolPermissionLevel).toBe('safe');
		// 其余白名单 key 正常应用
		expect(host.settings.autoIndex).toBe(false);
		expect(host.saveSettings).toHaveBeenCalledTimes(1);
		expect(result.applied).toEqual(['autoIndex']);
		const rejected = result.results.find((r: any) => r.key === 'toolPermissionLevel');
		expect(rejected.ok).toBe(false);
		expect(rejected.reason).toContain('白名单');
	});

	it('非法枚举值 - 单条拒绝并给出合法取值 - 同批其他 key 照常应用', async () => {
		const host = makeHost();
		const tool = createUpdateAppConfigTool(host, makeToolDef('update_app_config'));
		const result = (await tool.execute({
			updates: {
				embedProvider: 'remote',
				chunkOverlap: 60,
			},
		})) as Record<string, any>;

		expect(host.settings.embedProvider).toBe('local');
		expect(host.settings.chunkOverlap).toBe(60);
		const rejected = result.results.find((r: any) => r.key === 'embedProvider');
		expect(rejected.reason).toContain('local');
	});

	it('全部 key 被拒 - 不调用 saveSettings', async () => {
		const host = makeHost();
		const tool = createUpdateAppConfigTool(host, makeToolDef('update_app_config'));
		const result = (await tool.execute({
			updates: { agentMaxSteps: 999, debugLog: true },
		})) as Record<string, any>;

		expect(result.applied).toEqual([]);
		expect(result.results.every((r: any) => !r.ok)).toBe(true);
		expect(host.saveSettings).not.toHaveBeenCalled();
	});

	it('空 updates - 返回空结果且不持久化', async () => {
		const host = makeHost();
		const tool = createUpdateAppConfigTool(host, makeToolDef('update_app_config'));
		const result = (await tool.execute({ updates: {} })) as Record<string, any>;

		expect(result).toEqual({ results: [], applied: [] });
		expect(host.saveSettings).not.toHaveBeenCalled();
	});

	it('updates 缺失或非对象 - 按空批次处理不抛错', async () => {
		const host = makeHost();
		const tool = createUpdateAppConfigTool(host, makeToolDef('update_app_config'));
		const missing = (await tool.execute({})) as Record<string, any>;
		const nullUpdates = (await tool.execute({ updates: null })) as Record<string, any>;

		expect(missing).toEqual({ results: [], applied: [] });
		expect(nullUpdates).toEqual({ results: [], applied: [] });
		expect(host.saveSettings).not.toHaveBeenCalled();
	});

	it('updates 为数组 - 按空批次处理 - 不抛错且不持久化', async () => {
		const host = makeHost();
		const tool = createUpdateAppConfigTool(host, makeToolDef('update_app_config'));
		// 关键路径:回归守卫 — Array.isArray 守卫若被误删,数组会被当对象遍历出脏 key
		const result = (await tool.execute({ updates: [{ chunkSize: 600 }] })) as Record<string, any>;

		expect(result).toEqual({ results: [], applied: [] });
		expect(host.settings.chunkSize).toBe(DEFAULT_SETTINGS.chunkSize);
		expect(host.saveSettings).not.toHaveBeenCalled();
	});

	it('contextLengthPreset 写入 - 与设置面板同路径联动 chatModelMaxTokens', async () => {
		const host = makeHost();
		const tool = createUpdateAppConfigTool(host, makeToolDef('update_app_config'));
		await tool.execute({ updates: { contextLengthPreset: '1M' } });

		// 关键路径:applyContextLengthPreset 同步 token 上限,防止抽屉仍读旧值
		expect(host.settings.contextLengthPreset).toBe('1M');
		expect(host.settings.chatModelMaxTokens).toBe(1_048_576);
	});
});
