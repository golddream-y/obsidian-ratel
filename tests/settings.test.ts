/**
 * @file tests/settings.test.ts
 * @description DEFAULT_SETTINGS 完整性 + 字段全可读
 * @module tests/settings
 * @depends settings
 */

import { describe, it, expect, vi } from 'vitest';

// 关键路径:settings.ts 顶部 import 了 obsidian(类型定义包,main 字段为空),
// vitest 运行时无法解析;同时它把 RatelVaultPlugin 作为类型引用,
// 所以 ./main 也必须能加载(只 type-only 使用)。用最小 stub 满足模块求值。
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

describe('DEFAULT_SETTINGS', () => {
    it('包含全部 RatelVaultSettings 字段', () => {
        // 关键路径:用类型断言做编译期检查,运行时遍历字段名验证
        const required: Array<keyof RatelVaultSettings> = [
            'chatModel', 'chatApiKey', 'chatApiBase',
            'embedProvider', 'embedLocalModel', 'embedLocalDimensions',
            'embedApiBase', 'embedApiKey', 'embedApiModel', 'embedApiDimensions',
            'rerankerProvider', 'rerankerApiBase', 'rerankerApiKey', 'rerankerModel',
            'chunkSize', 'chunkOverlap', 'autoIndex',
            'autoSuggestLinks', 'linkConfidenceThreshold',
        ];
        for (const key of required) {
            expect(DEFAULT_SETTINGS).toHaveProperty(key);
        }
    });

    it('所有字段类型正确', () => {
        expect(typeof DEFAULT_SETTINGS.chatModel).toBe('string');
        expect(typeof DEFAULT_SETTINGS.chatApiKey).toBe('string');
        expect(typeof DEFAULT_SETTINGS.embedProvider).toBe('string');
        expect(typeof DEFAULT_SETTINGS.embedLocalDimensions).toBe('number');
        expect(typeof DEFAULT_SETTINGS.chunkSize).toBe('number');
        expect(typeof DEFAULT_SETTINGS.autoIndex).toBe('boolean');
        expect(typeof DEFAULT_SETTINGS.linkConfidenceThreshold).toBe('number');
    });

    it('embedProvider 默认是 local', () => {
        // 关键路径:开箱即用的零配置嵌入
        expect(DEFAULT_SETTINGS.embedProvider).toBe('local');
    });

    it('数值字段在合理范围内', () => {
        expect(DEFAULT_SETTINGS.chunkSize).toBeGreaterThan(0);
        expect(DEFAULT_SETTINGS.chunkOverlap).toBeGreaterThanOrEqual(0);
        expect(DEFAULT_SETTINGS.chunkOverlap).toBeLessThan(DEFAULT_SETTINGS.chunkSize);
        expect(DEFAULT_SETTINGS.linkConfidenceThreshold).toBeGreaterThanOrEqual(0);
        expect(DEFAULT_SETTINGS.linkConfidenceThreshold).toBeLessThanOrEqual(1);
    });
});
