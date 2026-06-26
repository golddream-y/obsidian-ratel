/**
 * @file tests/settings-migration.test.ts
 * @description 旧版 data.json(embedModel)加载后不污染新字段
 * @module tests/settings-migration
 * @depends settings
 *
 * 关键路径:项目不存留 migration 函数,main.ts:loadSettings 用 Object.assign
 * 浅合并 DEFAULT_SETTINGS + raw。旧字段(如 embedModel)如果出现在 raw 里,
 * 会保留在合并后对象上但不参与任何逻辑。本测试断言"旧字段不污染新字段"。
 */

import { describe, it, expect, vi } from 'vitest';

// 关键路径:settings.ts 顶部 import obsidian + ./main,vitest 需最小 stub 才能加载
vi.mock('obsidian', () => ({
    App: class {},
    Plugin: class {},
    PluginSettingTab: class {},
    Setting: class {},
    Notice: class {},
}));

vi.mock('../src/main', () => ({
    default: class RatelVaultPlugin {},
}));

import { DEFAULT_SETTINGS, type RatelVaultSettings } from '../src/settings';

/**
 * 模拟 src/main.ts:loadSettings 的合并逻辑,验证旧字段兼容性。
 * 关键路径:Object.assign 后,新字段用 DEFAULT 兜底,旧字段被 raw 覆盖但不影响新字段。
 */
function simulateLoadSettings(raw: Partial<RatelVaultSettings> | null): RatelVaultSettings {
	const loaded = raw ?? {};
	const settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
	settings.toolPermissions = {
		...DEFAULT_SETTINGS.toolPermissions,
		...(loaded.toolPermissions ?? {}),
	};
	return settings;
}

describe('Settings 迁移', () => {
    it('旧版 embedModel 字段加载后不污染 embedApiModel', () => {
        // 关键路径:旧 vault 里可能存了 embedModel='bge-large',新版会忽略
        const oldFormat = {
            embedModel: 'bge-large',
        } as unknown as Partial<RatelVaultSettings>;

        const merged = simulateLoadSettings(oldFormat);

        // 旧字段残留(无害,因为没代码读)
        expect((merged as Record<string, unknown>).embedModel).toBe('bge-large');
        // 新字段保持默认值
        expect(merged.embedApiModel).toBe(DEFAULT_SETTINGS.embedApiModel);
        expect(merged.embedLocalModel).toBe(DEFAULT_SETTINGS.embedLocalModel);
    });

    it('缺省 raw(null)时所有字段用 DEFAULT', () => {
        const merged = simulateLoadSettings(null);
        expect(merged).toEqual(DEFAULT_SETTINGS);
    });

    it('缺省 raw(undefined)时所有字段用 DEFAULT', () => {
        const merged = simulateLoadSettings(undefined);
        expect(merged).toEqual(DEFAULT_SETTINGS);
    });

    it('部分字段被 raw 覆盖,其余保持 DEFAULT', () => {
        // 关键路径:chatApiKey 已移至钥匙串,改用 chunkSize 等非 Key 字段测试覆盖。
        const partial: Partial<RatelVaultSettings> = {
            chunkSize: 1000,
            chatApiBase: 'https://api.openai.com',
        };

        const merged = simulateLoadSettings(partial);

        expect(merged.chunkSize).toBe(1000);
        expect(merged.chatApiBase).toBe('https://api.openai.com');
        // 未提供的字段保持默认
        expect(merged.embedProvider).toBe(DEFAULT_SETTINGS.embedProvider);
    });

    it('toolPermissions 为空对象时合并 DEFAULT 默认值', () => {
        const merged = simulateLoadSettings({ toolPermissions: {} });

        expect(merged.toolPermissions.read_note).toBe('allow');
        expect(merged.toolPermissions.write_note).toBe('ask');
    });
});
