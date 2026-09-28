/**
 * @file src/settings/chat-preset.ts
 * @description 对话场景预设 — DeepSeek / Ollama / 自定义 写入字段
 * @module settings/chat-preset
 * @depends ../ui/tokens/context-length-presets
 */

import { presetToTokens } from '../ui/tokens/context-length-presets';
// 关键路径:仅类型,避免与 settings.ts 运行时循环依赖
import type { RatelVaultSettings } from '../settings';

/** 对话场景预设 ID */
export type ChatPresetId = 'deepseek' | 'ollama' | 'custom';

/** DeepSeek 官方 API Base */
export const DEEPSEEK_CHAT_API_BASE = 'https://api.deepseek.com';

/** DeepSeek 默认模型(与 DEFAULT_SETTINGS.chatModel 对齐) */
export const DEEPSEEK_CHAT_MODEL = 'deepseek-v4-flash';

/** 本地 Ollama OpenAI 兼容 Base(与钥匙串 localhost 判定一致) */
export const OLLAMA_CHAT_API_BASE = 'http://localhost:11434/v1';

/** 本地 Ollama 根地址(不带 /v1 的旧写法)— 与 OLLAMA_CHAT_API_BASE 同为 Ollama 判定地址 */
export const OLLAMA_LOCAL_ROOT = 'http://localhost:11434';

/**
 * 归一化 API Base:剥掉尾部斜杠,使任意输入可与常量地址清单直接比对。
 *
 * @param apiBase - 原始地址(前后空白由调用方按各自口径处理)
 * @returns 去尾斜杠后的地址
 */
export function normalizeChatApiBase(apiBase: string): string {
	return apiBase.replace(/\/$/, '');
}

/** 本地 Ollama 判定地址清单(带 /v1 与不带两种写法,已归一化)— normalizeChatPreset 与 inferChatProvider 共用单一真相 */
export const OLLAMA_LOCAL_BASES: readonly string[] = [
	normalizeChatApiBase(OLLAMA_CHAT_API_BASE),
	normalizeChatApiBase(OLLAMA_LOCAL_ROOT),
];

/** Ollama 预设占位模型名(用户可改) */
export const OLLAMA_CHAT_MODEL = 'llama3.2';

/**
 * 将场景预设写入 settings 对象(原地修改)。
 *
 * - deepseek / ollama:覆盖 Base、模型;(deepseek 另写 context 256k)
 * - custom:仅标记 chatPreset,不覆盖已有 Base/模型
 *
 * @param settings - 插件设置对象
 * @param preset - 目标预设
 */
export function applyChatPreset(
	settings: RatelVaultSettings,
	preset: ChatPresetId,
): void {
	settings.chatPreset = preset;
	switch (preset) {
		case 'custom':
			return;
		case 'deepseek':
			settings.chatApiBase = DEEPSEEK_CHAT_API_BASE;
			settings.chatModel = DEEPSEEK_CHAT_MODEL;
			settings.contextLengthPreset = '256k';
			settings.chatModelMaxTokens = presetToTokens('256k');
			return;
		case 'ollama':
			settings.chatApiBase = OLLAMA_CHAT_API_BASE;
			settings.chatModel = OLLAMA_CHAT_MODEL;
			return;
		default: {
			// 关键路径:穷尽检查,防止新增预设漏写分支
			const _exhaustive: never = preset;
			return _exhaustive;
		}
	}
}

/**
 * 旧版 data.json 无 chatPreset 时,按当前 Base/模型推断,避免误标为默认 deepseek。
 *
 * @param settings - 已与 DEFAULT 合并后的设置
 * @param raw - 磁盘原始片段;仅当缺少 chatPreset 时推断
 */
export function normalizeChatPreset(
	settings: RatelVaultSettings,
	raw?: Partial<RatelVaultSettings>,
): void {
	if (raw?.chatPreset != null) {
		return;
	}
	// 关键路径:与 inferChatProvider(实时推断)口径不同 — 迁移必须保守,
	// 地址之外还要求默认模型名匹配,避免把用户已改模型的老库误标成 ollama/deepseek 预设。
	const base = normalizeChatApiBase(settings.chatApiBase);
	const deepseekBase = normalizeChatApiBase(DEEPSEEK_CHAT_API_BASE);
	if (base === deepseekBase && settings.chatModel === DEEPSEEK_CHAT_MODEL) {
		settings.chatPreset = 'deepseek';
		return;
	}
	if (OLLAMA_LOCAL_BASES.includes(base) && settings.chatModel === OLLAMA_CHAT_MODEL) {
		settings.chatPreset = 'ollama';
		return;
	}
	// 关键路径:旧装可能仍是 deepseek-chat 等,标 custom 避免误显示 DeepSeek 预设已对齐
	settings.chatPreset = 'custom';
}
