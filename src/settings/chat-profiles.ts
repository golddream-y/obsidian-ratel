/**
 * @file src/settings/chat-profiles.ts
 * @description 多套对话配置 — 类型、默认合成、当前套解析
 * @module settings/chat-profiles
 */

import type { ContextLengthPresetId } from '../ui/tokens/context-length-presets';
import type { RatelVaultSettings } from '../settings';

/** 一套对话配置。id 稳定,改名不改 id。 */
export interface ChatProfile {
	id: string;
	name: string;
	apiBase: string;
	model: string;
	contextLengthPreset: ContextLengthPresetId;
	chatModelMaxTokens: number;
}

/** 生成稳定 id(创建时一次,之后不变)。 */
export function newChatProfileId(): string {
	return `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 旧库无 chatProfiles 时,用当前四字段合成唯一一套。
 * 已有则不覆盖。密钥沿用旧槽位,见 ratel-secrets 回退。
 *
 * @param settings - 已与 DEFAULT 合并的设置
 * @param raw - 磁盘原始片段
 */
export function normalizeChatProfiles(
	settings: RatelVaultSettings,
	raw?: Partial<RatelVaultSettings>,
): void {
	if (raw?.chatProfiles != null && Array.isArray(raw.chatProfiles)) return;
	const profile: ChatProfile = {
		id: newChatProfileId(),
		name: settings.chatPreset === 'ollama' ? 'Ollama' : settings.chatPreset === 'custom' ? '自定义' : 'DeepSeek',
		apiBase: settings.chatApiBase,
		model: settings.chatModel,
		contextLengthPreset: settings.contextLengthPreset,
		chatModelMaxTokens: settings.chatModelMaxTokens,
	};
	settings.chatProfiles = [profile];
	settings.activeChatProfileId = profile.id;
}

/** 切到指定一套:把该套字段写入当前四字段。 */
export function switchChatProfile(settings: RatelVaultSettings, id: string): void {
	const target = settings.chatProfiles.find((p) => p.id === id);
	if (!target) return;
	settings.chatApiBase = target.apiBase;
	settings.chatModel = target.model;
	settings.contextLengthPreset = target.contextLengthPreset;
	settings.chatModelMaxTokens = target.chatModelMaxTokens;
	settings.activeChatProfileId = target.id;
}

/** 把当前四字段另存为新一套,active 指向新套。 */
export function saveCurrentAsProfile(settings: RatelVaultSettings, name: string): ChatProfile {
	const profile: ChatProfile = {
		id: newChatProfileId(),
		name,
		apiBase: settings.chatApiBase,
		model: settings.chatModel,
		contextLengthPreset: settings.contextLengthPreset,
		chatModelMaxTokens: settings.chatModelMaxTokens,
	};
	settings.chatProfiles = [...settings.chatProfiles, profile];
	settings.activeChatProfileId = profile.id;
	return profile;
}

/** 删除一套。当前这套拒绝删除。 */
export function deleteChatProfile(settings: RatelVaultSettings, id: string): void {
	if (settings.activeChatProfileId === id) {
		throw new Error('不能删除当前这套配置,请先切到另一套');
	}
	settings.chatProfiles = settings.chatProfiles.filter((p) => p.id !== id);
}
