/**
 * @file tests/settings/config-whitelist.test.ts
 * @description config-whitelist 单测 — 白名单边界 / 提权项排除 / 值校验(枚举、数值、布尔、字符串)
 * @module tests/settings/config-whitelist
 * @depends ../../src/settings/config-whitelist, ../../src/settings
 */

import { describe, it, expect } from 'vitest';
import {
	CONFIG_UPDATE_WHITELIST,
	isWhitelistedKey,
	validateConfigValue,
} from '../../src/settings/config-whitelist';
import { DEFAULT_SETTINGS } from '../../src/settings';

/** 安全红线 — 永不进入白名单的提权 / 敏感 key(与 Task 5 规格一致) */
const PRIVILEGE_ESCALATION_KEYS = [
	'toolPermissions',
	'toolPermissionLevel',
	'mcpServers',
	'mcpApprovedSpawns',
	'promptOverrides',
	'chatPreset',
	'debugLog',
	'agentMaxSteps',
	'modelRegistryUrl',
	// 嵌套 key 形态同样拒绝
	'toolPermissions.delete_note',
	'promptOverrides.agent.base',
];

describe('CONFIG_UPDATE_WHITELIST', () => {
	it('白名单 - 不含提权与敏感 key - 全部拒绝', () => {
		for (const key of PRIVILEGE_ESCALATION_KEYS) {
			expect(isWhitelistedKey(key)).toBe(false);
			expect(CONFIG_UPDATE_WHITELIST.has(key)).toBe(false);
		}
	});

	it('白名单 - 含常规配置 key - 对话模型/索引/Embedding/记忆/外观', () => {
		const expected = [
			// 对话模型
			'chatModel', 'chatApiBase', 'contextLengthPreset', 'chatModelMaxTokens', 'autoCompactEnabled',
			// 分块与索引
			'chunkSize', 'chunkOverlap', 'autoIndex', 'indexPaused',
			// Embedding / Rerank
			'embedProvider', 'embedApiBase', 'embedApiModel', 'embedApiDimensions',
			'rerankerApiBase', 'rerankerModel',
			// 记忆
			'memoryEnabled', 'memoryAutoWrite', 'memoryStorageLimitMB',
			'memoryInjectLimitKB', 'memoryDynamicLimitKB', 'memoryContextTotalLimitKB',
			// 日记
			'dailyNoteFolder', 'dailyNoteFormat',
			// 语言外观
			'language', 'uiColorScheme', 'uiAccent',
			'chatNavRailEnabled', 'chatNavRailSide', 'chatMotionEnabled',
		];
		for (const key of expected) {
			expect(isWhitelistedKey(key)).toBe(true);
		}
	});

	it('白名单 - 所有 key 都存在于 DEFAULT_SETTINGS - 不允许幽灵 key', () => {
		for (const key of CONFIG_UPDATE_WHITELIST) {
			expect(key in DEFAULT_SETTINGS).toBe(true);
		}
	});

	it('白名单 - 每个白名单 key 的默认值都通过校验 - 约束表全覆盖无遗漏', () => {
		// 关键路径:默认值天然是合法值;若有 key 不在任何约束表中,说明实现有漏网
		for (const key of CONFIG_UPDATE_WHITELIST) {
			// 关键路径:interface 含方法签名,需经 unknown 中转才能 Record 索引(与 settings-apply 同模式)
			const verdict = validateConfigValue(key, (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key]);
			expect(verdict.ok, `key=${key}`).toBe(true);
		}
	});
});

describe('validateConfigValue', () => {
	it('非白名单 key - 任意值 - 拒绝且 reason 为中文', () => {
		const verdict = validateConfigValue('toolPermissionLevel', 'danger');
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.reason).toContain('白名单');
	});

	it('嵌套提权 key - toolPermissions.delete_note - 拒绝', () => {
		expect(validateConfigValue('toolPermissions.delete_note', 'allow').ok).toBe(false);
	});

	it('原型链污染 key - __proto__ / constructor - 拒绝', () => {
		// 关键路径:回归守卫 — 白名单基于 Set.has 精确匹配,原型属性天然不在集合内,
		// 防未来重构改成对象属性查找时把原型链 key 放进来
		expect(validateConfigValue('__proto__', { polluted: true }).ok).toBe(false);
		expect(validateConfigValue('constructor', { polluted: true }).ok).toBe(false);
	});

	it('枚举 - contextLengthPreset 真实值 1M - 通过', () => {
		expect(validateConfigValue('contextLengthPreset', '1M').ok).toBe(true);
	});

	it('枚举 - contextLengthPreset 非法值 3M - 拒绝并列出合法值', () => {
		const verdict = validateConfigValue('contextLengthPreset', '3M');
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.reason).toContain('128k');
	});

	it('枚举 - embedProvider 非法值 remote - 拒绝', () => {
		expect(validateConfigValue('embedProvider', 'remote').ok).toBe(false);
	});

	it('枚举 - embedProvider 合法值 api - 通过', () => {
		expect(validateConfigValue('embedProvider', 'api').ok).toBe(true);
	});

	it('枚举 - uiAccent 真实预设 teal - 通过', () => {
		expect(validateConfigValue('uiAccent', 'teal').ok).toBe(true);
	});

	it('枚举 - uiAccent 非法值 magenta - 拒绝', () => {
		expect(validateConfigValue('uiAccent', 'magenta').ok).toBe(false);
	});

	it('枚举 - language / uiColorScheme / chatNavRailSide 真实值 - 通过', () => {
		expect(validateConfigValue('language', 'en').ok).toBe(true);
		expect(validateConfigValue('uiColorScheme', 'dark').ok).toBe(true);
		expect(validateConfigValue('chatNavRailSide', 'left').ok).toBe(true);
	});

	it('枚举 - 非字符串类型(number)- 拒绝', () => {
		expect(validateConfigValue('embedProvider', 1).ok).toBe(false);
	});

	it('数值 - chunkSize 低于下界 50 - 拒绝', () => {
		expect(validateConfigValue('chunkSize', 50).ok).toBe(false);
	});

	it('数值 - chunkSize 边界 100 与 1000 - 通过', () => {
		expect(validateConfigValue('chunkSize', 100).ok).toBe(true);
		expect(validateConfigValue('chunkSize', 1000).ok).toBe(true);
	});

	it('数值 - chunkOverlap 边界 0 与越界 201 - 边界通过越界拒绝', () => {
		expect(validateConfigValue('chunkOverlap', 0).ok).toBe(true);
		expect(validateConfigValue('chunkOverlap', 201).ok).toBe(false);
	});

	it('数值 - chatModelMaxTokens 边界 4096 与越界 10485761 - 与 CUSTOM_TOKEN_MIN/MAX 对齐', () => {
		expect(validateConfigValue('chatModelMaxTokens', 4096).ok).toBe(true);
		expect(validateConfigValue('chatModelMaxTokens', 10_485_760).ok).toBe(true);
		expect(validateConfigValue('chatModelMaxTokens', 10_485_761).ok).toBe(false);
	});

	it('数值 - memory 系列 min/max 与设置面板一致 - 999 越界拒绝', () => {
		expect(validateConfigValue('memoryInjectLimitKB', 1).ok).toBe(true);
		expect(validateConfigValue('memoryInjectLimitKB', 500).ok).toBe(true);
		expect(validateConfigValue('memoryInjectLimitKB', 999).ok).toBe(false);
		expect(validateConfigValue('memoryStorageLimitMB', 1000).ok).toBe(true);
		expect(validateConfigValue('memoryStorageLimitMB', 1001).ok).toBe(false);
	});

	it('数值 - 字符串数字 "200000" - 拒绝(必须是 number 类型)', () => {
		expect(validateConfigValue('chatModelMaxTokens', '200000').ok).toBe(false);
	});

	it('数值 - NaN - 拒绝', () => {
		expect(validateConfigValue('chunkSize', Number.NaN).ok).toBe(false);
	});

	it('布尔 - 字符串 "true" - 拒绝', () => {
		expect(validateConfigValue('autoIndex', 'true').ok).toBe(false);
	});

	it('布尔 - 真布尔 false - 通过', () => {
		expect(validateConfigValue('memoryEnabled', false).ok).toBe(true);
	});

	it('布尔 - 数字 1 - 拒绝', () => {
		expect(validateConfigValue('indexPaused', 1).ok).toBe(false);
	});

	it('字符串 - 空字符串 chatModel - 拒绝', () => {
		expect(validateConfigValue('chatModel', '').ok).toBe(false);
	});

	it('字符串 - 纯空白 chatApiBase - 拒绝', () => {
		expect(validateConfigValue('chatApiBase', '   ').ok).toBe(false);
	});

	it('字符串 - dailyNoteFolder 空字符串 - 通过(vault 根是合法值)', () => {
		expect(validateConfigValue('dailyNoteFolder', '').ok).toBe(true);
	});

	it('字符串 - 非字符串类型 123 - 拒绝', () => {
		expect(validateConfigValue('chatModel', 123).ok).toBe(false);
	});

	it('字符串 - rerankerApiBase 正常 URL - 通过', () => {
		expect(validateConfigValue('rerankerApiBase', 'https://dashscope.aliyuncs.com/compatible-api/v1').ok).toBe(true);
	});
});
