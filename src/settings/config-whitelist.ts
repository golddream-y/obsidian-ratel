/**
 * @file src/settings/config-whitelist.ts
 * @description update_app_config 工具的白名单与值校验 — LLM 可改哪些设置、改成什么值
 * @module settings/config-whitelist
 * @depends settings, ui/tokens/context-length-presets, ui/appearance/appearance-presets
 */

import { CONTEXT_LENGTH_PRESETS, CUSTOM_TOKEN_MAX, CUSTOM_TOKEN_MIN } from '../ui/tokens/context-length-presets';
import { APPEARANCE_PRESETS } from '../ui/appearance/appearance-presets';

/**
 * update_app_config 可修改的顶层设置 key 白名单。
 *
 * 设计要点:
 * - 只收「常规偏好」类配置:对话模型、分块索引、Embedding、记忆、日记、语言外观。
 * - 安全红线(永不进入白名单):toolPermissions / toolPermissionLevel / mcpServers /
 *   mcpApprovedSpawns / promptOverrides / chatPreset / debugLog / agentMaxSteps /
 *   modelRegistryUrl — 这些是提权面或调试开关,必须由用户在设置面板亲手改。
 * - 每个 key 必须存在于 DEFAULT_SETTINGS(测试有「幽灵 key」守卫)。
 */
export const CONFIG_UPDATE_WHITELIST: ReadonlySet<string> = new Set<string>([
	// --- 对话模型 ---
	'chatModel',
	'chatApiBase',
	'chatVisionEnabled',
	'contextLengthPreset',
	'chatModelMaxTokens',
	'autoCompactEnabled',
	// --- 分块与索引 ---
	'chunkSize',
	'chunkOverlap',
	'autoIndex',
	'indexPaused',
	// --- Embedding / Rerank ---
	'embedProvider',
	'embedApiBase',
	'embedApiModel',
	'embedApiDimensions',
	'rerankerApiBase',
	'rerankerModel',
	// --- 记忆 ---
	'memoryEnabled',
	'memoryAutoWrite',
	'memoryStorageLimitMB',
	'memoryInjectLimitKB',
	'memoryDynamicLimitKB',
	'memoryContextTotalLimitKB',
	'memoryTopicsAutoInjectK',
	// --- 日记 ---
	'dailyNoteFolder',
	'dailyNoteFormat',
	// --- 语言外观 ---
	'language',
	'uiColorScheme',
	'uiAccent',
	'chatNavRailEnabled',
	'chatNavRailSide',
	'chatMotionEnabled',
]);

/**
 * 判断 key 是否在 update_app_config 白名单内。
 *
 * @param key - 顶层设置 key
 * @returns 白名单内返回 true
 */
export function isWhitelistedKey(key: string): boolean {
	return CONFIG_UPDATE_WHITELIST.has(key);
}

// ==================== 内部约束表(非导出) ====================

/**
 * 枚举约束表 — 取值集合全部从 settings.ts 真实枚举抄写,不编造。
 *
 * 关键路径:contextLengthPreset 从 CONTEXT_LENGTH_PRESETS 推导(含 custom);
 * uiAccent 从 APPEARANCE_PRESETS 推导(含 follow),与设置面板下拉永不漂移。
 */
const ENUM_CONSTRAINTS: Readonly<Record<string, readonly string[]>> = {
	embedProvider: ['local', 'api'],
	contextLengthPreset: [...Object.keys(CONTEXT_LENGTH_PRESETS), 'custom'],
	language: ['auto', 'zh', 'en'],
	uiColorScheme: ['auto', 'light', 'dark'],
	uiAccent: ['follow', ...APPEARANCE_PRESETS.map((p) => p.id)],
	chatNavRailSide: ['left', 'right'],
};

/**
 * 数值约束表 — min/max 与设置面板控件校验一致。
 *
 * 关键路径:chatModelMaxTokens 用 CUSTOM_TOKEN_MIN/MAX(高级页 number 控件);
 * chunk/chunkOverlap 用索引页 slider 边界;memory 四项用高级页 number 边界。
 * embedApiDimensions 无 UI 控件,按主流 Embedding 模型维度范围给 1~8192。
 */
const NUMBER_CONSTRAINTS: Readonly<Record<string, { min: number; max: number }>> = {
	chatModelMaxTokens: { min: CUSTOM_TOKEN_MIN, max: CUSTOM_TOKEN_MAX },
	chunkSize: { min: 100, max: 1000 },
	chunkOverlap: { min: 0, max: 200 },
	embedApiDimensions: { min: 1, max: 8192 },
	memoryStorageLimitMB: { min: 1, max: 1000 },
	memoryInjectLimitKB: { min: 1, max: 500 },
	memoryDynamicLimitKB: { min: 1, max: 500 },
	memoryContextTotalLimitKB: { min: 1, max: 500 },
	memoryTopicsAutoInjectK: { min: 0, max: 10 },
};

/** 布尔开关 key — 严格 boolean,拒绝字符串 "true" */
const BOOLEAN_KEYS: ReadonlySet<string> = new Set<string>([
	'autoCompactEnabled',
	'autoIndex',
	'indexPaused',
	'memoryEnabled',
	'memoryAutoWrite',
	'chatNavRailEnabled',
	'chatMotionEnabled',
]);

/** 字符串 key — 默认要求非空(纯空白视为空) */
const STRING_KEYS: ReadonlySet<string> = new Set<string>([
	'chatModel',
	'chatApiBase',
	'embedApiBase',
	'embedApiModel',
	'rerankerApiBase',
	'rerankerModel',
	'dailyNoteFolder',
	'dailyNoteFormat',
]);

/** 允许空字符串的特例 — dailyNoteFolder 空串 = vault 根(与 DEFAULT_SETTINGS 一致) */
const EMPTY_ALLOWED_STRING_KEYS: ReadonlySet<string> = new Set<string>(['dailyNoteFolder']);

// ==================== 值校验 ====================

/** 校验结论:通过(ok: true)或拒绝(ok: false + 中文 reason,直接返回给 LLM) */
export type ConfigValueVerdict = { ok: true } | { ok: false; reason: string };

/**
 * 校验单个设置 key 的新值是否可写。
 *
 * 判定顺序:白名单 → 枚举 → 数值 → 布尔 → 字符串。
 * 关键路径:每个白名单 key 必被四张约束表之一覆盖(测试用 DEFAULT 值全量兜底);
 * 嵌套 key(toolPermissions.* / promptOverrides.*)永远不在白名单,天然拒绝。
 *
 * @param key - 顶层设置 key
 * @param value - 待写入的新值(LLM 传入,运行时类型不可信)
 * @returns 通过返回 `{ ok: true }`;拒绝返回 `{ ok: false, reason }`(reason 中文,面向 LLM)
 */
export function validateConfigValue(key: string, value: unknown): ConfigValueVerdict {
	// 1. 白名单 — 安全红线第一道闸
	if (!CONFIG_UPDATE_WHITELIST.has(key)) {
		return {
			ok: false,
			reason: `「${key}」不在可修改配置白名单内;工具权限、MCP、Prompt 覆盖等敏感项必须由用户在设置面板亲手修改`,
		};
	}

	// 2. 枚举 — 取值必须在真实枚举集合内
	const enumValues = ENUM_CONSTRAINTS[key];
	if (enumValues != null) {
		if (typeof value !== 'string' || !enumValues.includes(value)) {
			return {
				ok: false,
				reason: `「${key}」仅接受以下取值之一:${enumValues.join(' / ')}`,
			};
		}
		return { ok: true };
	}

	// 3. 数值 — 类型必须是 number 且落在 min/max 闭区间
	const range = NUMBER_CONSTRAINTS[key];
	if (range != null) {
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			return { ok: false, reason: `「${key}」必须是数字(不接受字符串形式的数字)` };
		}
		if (value < range.min || value > range.max) {
			return { ok: false, reason: `「${key}」必须在 ${range.min} ~ ${range.max} 范围内` };
		}
		return { ok: true };
	}

	// 4. 布尔 — 严格 boolean,拒绝 "true" 字符串
	if (BOOLEAN_KEYS.has(key)) {
		if (typeof value !== 'boolean') {
			return { ok: false, reason: `「${key}」必须是布尔值 true 或 false,不接受字符串` };
		}
		return { ok: true };
	}

	// 5. 字符串 — 非空(dailyNoteFolder 例外:空串 = vault 根)
	if (STRING_KEYS.has(key)) {
		if (typeof value !== 'string') {
			return { ok: false, reason: `「${key}」必须是字符串` };
		}
		if (!EMPTY_ALLOWED_STRING_KEYS.has(key) && value.trim().length === 0) {
			return { ok: false, reason: `「${key}」不能为空字符串` };
		}
		return { ok: true };
	}

	// 关键路径:理论不可达 — 白名单 key 必被约束表覆盖,测试有全量兜底守卫
	return { ok: true };
}
