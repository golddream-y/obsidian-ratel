/**
 * @file src/settings/chat-profiles.ts
 * @description 多套对话配置 — 类型、默认合成、当前套解析、提供商推断与窗口查表
 * @module settings/chat-profiles
 * @depends ui/tokens/context-length-presets, settings/chat-preset
 */

import type { ContextLengthPresetId } from '../ui/tokens/context-length-presets';
import { applyContextRecommendation } from '../ui/tokens/context-length-presets';
import {
	DEEPSEEK_CHAT_API_BASE,
	OLLAMA_LOCAL_BASES,
	normalizeChatApiBase,
	type ChatPresetId,
} from './chat-preset';
import type { RatelVaultSettings } from '../settings';

/**
 * 映射表最小查询接口 — 与 ModelContextRegistry 结构兼容,测试用 mock。
 * 关键路径:原居 ui/tokens/apply-model-context;该模块随死代码清理删除后,
 * 类型移到引用最集中的本模块(syncChatWindow / lookupModelContext / SettingApplier 共用)。
 */
export type ModelContextLookup = {
	ensureRegistry(url: string): Promise<unknown>;
	lookupContextLength(model: string, map: unknown): number | undefined;
};

/**
 * 按模型名查映射表 — `ensureRegistry + lookupContextLength + null 守卫` 的共享入口。
 *
 * 设计要点:syncChatWindow 与 settings-apply 的窗口钳制共用,保证两处查表口径一致;
 * registryUrl 由调用方解析(`resolveRegistryUrl`),本函数不读 settings,
 * 以兼容 ChatWindowSyncDeps「URL 由调用方注入」的既有契约。
 *
 * @param registry - 映射表注册中心
 * @param registryUrl - 已解析的映射表 URL(空串回落默认由调用方处理)
 * @param model - 模型标识
 * @returns 命中的窗口 token 数;映射表不可用或未命中时 undefined
 */
export async function lookupModelContext(
	registry: ModelContextLookup,
	registryUrl: string,
	model: string,
): Promise<number | undefined> {
	const map = await registry.ensureRegistry(registryUrl);
	return map != null ? registry.lookupContextLength(model, map) : undefined;
}

/** 一套对话配置。id 稳定,改名不改 id。 */
export interface ChatProfile {
	id: string;
	name: string;
	apiBase: string;
	model: string;
	contextLengthPreset: ContextLengthPresetId;
	chatModelMaxTokens: number;
	/**
	 * 用户在展开区改小过窗口数字(S-CHAT-SETUP)。
	 * true = 同模型不再被查表覆盖;改模型名或提供商会清掉重查。
	 * 旧 data.json 无此字段,undefined 视为未锁定。
	 */
	windowUserSet?: boolean;
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

/** 把当前四字段另存为新一套,active 指向新套。windowUserSet 随源套继承。 */
export function saveCurrentAsProfile(settings: RatelVaultSettings, name: string): ChatProfile {
	// 关键路径:saveCurrentAsProfile 会把 active 切到新套,先取源套(调用方读密钥同序)
	const source = settings.chatProfiles.find((p) => p.id === settings.activeChatProfileId);
	const profile: ChatProfile = {
		id: newChatProfileId(),
		name,
		apiBase: settings.chatApiBase,
		model: settings.chatModel,
		contextLengthPreset: settings.contextLengthPreset,
		chatModelMaxTokens: settings.chatModelMaxTokens,
	};
	if (source?.windowUserSet) {
		profile.windowUserSet = true;
	}
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

/**
 * 由地址推断提供商(S-CHAT-SETUP)。提供商不另存 profile 字段:
 * 官方 DeepSeek 地址 → deepseek;本地 Ollama(带或不带 /v1)→ ollama;其余 → custom。
 *
 * 关键路径:与 normalizeChatPreset(迁移判定)口径不同 — 实时推断只看地址不看模型名,
 * 用户在官方地址上改模型仍算该提供商;迁移判定保守,要求默认模型名同时匹配。
 *
 * @param apiBase - 对话 API 地址
 * @returns 推断出的提供商 id
 */
export function inferChatProvider(apiBase: string): ChatPresetId {
	const base = normalizeChatApiBase(apiBase.trim());
	if (base === DEEPSEEK_CHAT_API_BASE) return 'deepseek';
	if (OLLAMA_LOCAL_BASES.includes(base)) return 'ollama';
	return 'custom';
}

/** syncChatWindow 的查表依赖 */
export interface ChatWindowSyncDeps {
	registry: ModelContextLookup;
	registryUrl: string;
	/** 查不到时是否清空旧上限(改模型/换提供商/切换套时 true,仅打开设置展示时 false) */
	clearOnMiss: boolean;
}

/** syncChatWindow 返回值 */
export interface ChatWindowSyncResult {
	/** true = 查表命中并写入 */
	applied: boolean;
	/** true = 活跃套 windowUserSet 为真,同模型跳过查表不覆盖 */
	skipped: boolean;
	/** true = settings 实际发生变化(调用方据此决定是否 saveSettings,防重渲染循环) */
	changed: boolean;
	/** 查表命中的窗口 token 数 */
	tokens?: number;
}

/**
 * 按当前模型名查映射表,把窗口写进当前四字段并镜像活跃套 — 设置页展开区与切换套共用。
 *
 * 设计要点:
 * - 活跃套 `windowUserSet` 为真时直接跳过:用户改小过的窗口不被查表盖掉;
 * - 命中 → `applyContextRecommendation` 写 preset + tokens(非档位整数落 custom);
 * - 未命中且 `clearOnMiss` → 写 custom/0 清空旧上限,不静默沿用上一个模型的上限;
 * - `changed` 按值是否实际变化计算,调用方只在 changed 时 saveSettings。
 *
 * @param settings - 插件设置(按 settings.chatModel 查表)
 * @param deps.registry - 映射表注册中心
 * @param deps.registryUrl - 映射表 URL(调用方已并入默认值)
 * @param deps.clearOnMiss - 查不到时是否清空旧上限
 * @returns applied/skipped/changed 与命中 tokens
 */
export async function syncChatWindow(
	settings: RatelVaultSettings,
	deps: ChatWindowSyncDeps,
): Promise<ChatWindowSyncResult> {
	const active = settings.chatProfiles.find((p) => p.id === settings.activeChatProfileId);
	// 关键路径:用户改小过的窗口不被查表盖掉 — 同模型跳过
	if (active?.windowUserSet) {
		return { applied: false, skipped: true, changed: false };
	}

	const tokens = await lookupModelContext(deps.registry, deps.registryUrl, settings.chatModel);

	if (tokens != null) {
		const applied = applyContextRecommendation(tokens);
		const changed =
			settings.contextLengthPreset !== applied.preset ||
			settings.chatModelMaxTokens !== applied.chatModelMaxTokens;
		settings.contextLengthPreset = applied.preset;
		settings.chatModelMaxTokens = applied.chatModelMaxTokens;
		if (active) {
			active.contextLengthPreset = applied.preset;
			active.chatModelMaxTokens = applied.chatModelMaxTokens;
		}
		return { applied: true, skipped: false, changed, tokens };
	}

	if (deps.clearOnMiss) {
		const changed = settings.contextLengthPreset !== 'custom' || settings.chatModelMaxTokens !== 0;
		settings.contextLengthPreset = 'custom';
		settings.chatModelMaxTokens = 0;
		if (active) {
			active.contextLengthPreset = 'custom';
			active.chatModelMaxTokens = 0;
		}
		return { applied: false, skipped: false, changed };
	}
	return { applied: false, skipped: false, changed: false };
}
