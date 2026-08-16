/**
 * @file tests/tools/get-app-config.test.ts
 * @description get_app_config 工具单测 — 配置快照 / 密钥存在性探测 / 索引状态 / 脱敏约束
 * @module tests/tools/get-app-config
 * @depends ../../src/tools/get-app-config, ../../src/core/index-manager, ../../src/settings, ../helpers/make-tool-def
 */

import { describe, it, expect, vi } from 'vitest';
import { writable } from 'svelte/store';
import {
	createGetAppConfigTool,
	type SecretProbe,
} from '../../src/tools/get-app-config';
import type { IndexStatus } from '../../src/core/index-manager';
import { DEFAULT_SETTINGS, type RatelVaultSettings } from '../../src/settings';
import { makeToolDef } from '../helpers/make-tool-def';

/** 构造密钥探测 mock — 形状对齐 src/secrets/ratel-secrets 真实函数签名(带 app 参数) */
function makeSecretProbe(overrides?: Partial<SecretProbe>): SecretProbe {
	return {
		hasChatApiKey: vi.fn().mockReturnValue(true),
		getChatSecretId: vi.fn().mockReturnValue('ratel-chat-openai-compatible'),
		hasEmbedApiKey: vi.fn().mockReturnValue(false),
		getEmbedSecretId: vi.fn().mockReturnValue(null),
		hasRerankApiKey: vi.fn().mockReturnValue(false),
		...overrides,
	};
}

function makeSettings(patch?: Partial<RatelVaultSettings>): RatelVaultSettings {
	return {
		...DEFAULT_SETTINGS,
		chatApiBase: 'https://api.deepseek.com/v1',
		embedProvider: 'api',
		embedApiBase: 'https://api.siliconflow.cn/v1',
		indexPaused: true,
		...patch,
	};
}

describe('get_app_config', () => {
	it('readOnly - 工具标记为只读', () => {
		const tool = createGetAppConfigTool(
			{ app: {}, secrets: makeSecretProbe() },
			{ settings: makeSettings() },
			writable<IndexStatus>({ state: 'Idle' }),
			makeToolDef('get_app_config'),
		);
		expect(tool.readOnly).toBe(true);
	});

	it('execute - Ready 状态 - 返回 config/secrets/index 三段快照', async () => {
		const probe = makeSecretProbe();
		const settings = makeSettings();
		const tool = createGetAppConfigTool(
			{ app: { marker: 'app-instance' }, secrets: probe },
			{ settings },
			writable<IndexStatus>({ state: 'Ready', totalDocs: 42, lastIndexTime: 1700000000000 }),
			makeToolDef('get_app_config'),
		);
		const result = (await tool.execute({})) as Record<string, any>;

		expect(result.config).toEqual(settings);
		expect(result.secrets).toEqual({
			hasChatApiKey: true,
			requiredChatSecretId: 'ratel-chat-openai-compatible',
			hasEmbedApiKey: false,
			requiredEmbedSecretId: null,
			hasRerankApiKey: false,
		});
		expect(result.index).toEqual({
			state: 'Ready',
			totalDocs: 42,
			lastIndexTime: 1700000000000,
			paused: true,
		});
	});

	it('execute - probe 参数转发 - 用 host.app 与当前 settings 调用', async () => {
		const probe = makeSecretProbe();
		const app = { marker: 'app-instance' };
		const settings = makeSettings();
		const tool = createGetAppConfigTool(
			{ app, secrets: probe },
			{ settings },
			writable<IndexStatus>({ state: 'Idle' }),
			makeToolDef('get_app_config'),
		);
		await tool.execute({});
		expect(probe.hasChatApiKey).toHaveBeenCalledWith(app, settings);
		expect(probe.hasEmbedApiKey).toHaveBeenCalledWith(app, settings);
		expect(probe.hasRerankApiKey).toHaveBeenCalledWith(app);
		expect(probe.getChatSecretId).toHaveBeenCalledWith(settings);
		expect(probe.getEmbedSecretId).toHaveBeenCalledWith(settings);
	});

	it('config 快照 - 浅拷贝隔离 - settings 后续变更不影响已返回快照', async () => {
		const settings = makeSettings();
		const tool = createGetAppConfigTool(
			{ app: {}, secrets: makeSecretProbe() },
			{ settings },
			writable<IndexStatus>({ state: 'Idle' }),
			makeToolDef('get_app_config'),
		);
		const first = (await tool.execute({})) as Record<string, any>;
		settings.indexPaused = false;
		settings.chatApiBase = 'http://localhost:11434/v1';
		expect(first.config).toEqual({ ...makeSettings() });
		expect(first.index.paused).toBe(true);
	});

	it('settings live 引用 - 修改后再次 execute 读到新值', async () => {
		const settings = makeSettings({ indexPaused: false });
		const tool = createGetAppConfigTool(
			{ app: {}, secrets: makeSecretProbe() },
			{ settings },
			writable<IndexStatus>({ state: 'Idle' }),
			makeToolDef('get_app_config'),
		);
		await tool.execute({});
		settings.indexPaused = true;
		const second = (await tool.execute({})) as Record<string, any>;
		expect(second.index.paused).toBe(true);
		expect(second.config.indexPaused).toBe(true);
	});

	it('index 非 Ready 状态 - 省略 totalDocs/lastIndexTime', async () => {
		const tool = createGetAppConfigTool(
			{ app: {}, secrets: makeSecretProbe() },
			{ settings: makeSettings({ indexPaused: false }) },
			writable<IndexStatus>({ state: 'Idle' }),
			makeToolDef('get_app_config'),
		);
		const result = (await tool.execute({})) as Record<string, any>;
		expect(result.index).toEqual({ state: 'Idle', paused: false });
		expect('totalDocs' in result.index).toBe(false);
		expect('lastIndexTime' in result.index).toBe(false);
	});

	it('index 状态变化 - store 更新后 execute 读到新状态', async () => {
		const store = writable<IndexStatus>({ state: 'Idle' });
		const tool = createGetAppConfigTool(
			{ app: {}, secrets: makeSecretProbe() },
			{ settings: makeSettings() },
			store,
			makeToolDef('get_app_config'),
		);
		store.set({ state: 'Failed', reason: 'boom' });
		const result = (await tool.execute({})) as Record<string, any>;
		expect(result.index.state).toBe('Failed');
	});

	it('快照脱敏 - secrets 段仅含 boolean 与 secret ID,无密钥值泄漏', async () => {
		const tool = createGetAppConfigTool(
			{ app: {}, secrets: makeSecretProbe() },
			{ settings: makeSettings() },
			writable<IndexStatus>({ state: 'Idle' }),
			makeToolDef('get_app_config'),
		);
		const result = (await tool.execute({})) as Record<string, any>;
		// 关键路径:secrets 只允许 boolean / string(secret ID)/ null,出现任何密钥值形态即违规
		expect(Object.keys(result.secrets).sort()).toEqual(
			['hasChatApiKey', 'hasEmbedApiKey', 'hasRerankApiKey', 'requiredChatSecretId', 'requiredEmbedSecretId'],
		);
		const serialized = JSON.stringify(result);
		expect(serialized).not.toMatch(/sk-[A-Za-z0-9]/);
		expect(serialized).not.toMatch(/Bearer\s/i);
	});
});
