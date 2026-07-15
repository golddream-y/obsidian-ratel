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
	const base = settings.chatApiBase.replace(/\/$/, '');
	const deepseekBase = DEEPSEEK_CHAT_API_BASE.replace(/\/$/, '');
	const ollamaBase = OLLAMA_CHAT_API_BASE.replace(/\/$/, '');
	const ollamaBaseAlt = 'http://localhost:11434';
	if (base === deepseekBase && settings.chatModel === DEEPSEEK_CHAT_MODEL) {
		settings.chatPreset = 'deepseek';
		return;
	}
	if (
		(base === ollamaBase || base === ollamaBaseAlt) &&
		settings.chatModel === OLLAMA_CHAT_MODEL
	) {
		settings.chatPreset = 'ollama';
		return;
	}
	// 关键路径:旧装可能仍是 deepseek-chat 等,标 custom 避免误显示 DeepSeek 预设已对齐
	settings.chatPreset = 'custom';
}
