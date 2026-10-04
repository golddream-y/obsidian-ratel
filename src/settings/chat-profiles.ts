/**
 * @file src/settings/chat-profiles.ts
 * @description 多套对话配置 — 类型、默认合成、当前套解析、提供商推断与窗口查表
 * @module settings/chat-profiles
 * @depends ui/tokens/context-length-presets, settings/chat-preset
 */

import type { ContextLengthPresetId } from '../ui/tokens/context-length-presets';
import { applyContextRecommendation, CUSTOM_TOKEN_MIN } from '../ui/tokens/context-length-presets';
import {
	DEEPSEEK_CHAT_API_BASE,
	OLLAMA_CHAT_API_BASE,
	OLLAMA_CHAT_MODEL,
	OLLAMA_LOCAL_BASES,
	normalizeChatApiBase,
	type ChatPresetId,
} from './chat-preset';
import {
	LOCAL_PROVIDER_CUSTOM,
	LOCAL_PROVIDER_OLLAMA,
	listCatalogModels,
	lookupCatalogLimits,
	type ModelsDevCatalog,
} from './model-catalog';
import type { RatelVaultSettings } from '../settings';
import { providerSecretSlug } from '../secrets/ratel-secrets';

/**
 * 映射表最小查询接口 — 与 ModelContextRegistry 结构兼容,测试用 mock。
 * 对话窗口不再走这张表,高级映射表页仍用 ModelContextRegistry。
 */
export type ModelContextLookup = {
	ensureRegistry(url: string): Promise<unknown>;
	lookupContextLength(model: string, map: unknown): number | undefined;
};

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
	/**
	 * 供应商 id。名单内用 models.dev 的 id；本地为 ollama；其余为 custom。
	 * 旧 data.json 无此字段，由 migrateChatProviderIds 补上。
	 */
	providerId?: string;
	/**
	 * 同一供应商下的密钥序号，创建后不变。钥匙串名是 ratel-chat-供应商-序号。
	 */
	keySerial?: number;
	/** 新建和复制配置只使用自己的密钥；旧配置未设置时保留历史槽位回退。 */
	allowLegacyKeyFallback?: boolean;
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
	// 关键路径:已有数组时函数会立刻返回，迁移必须在 return 之前
	if (raw?.chatProfiles != null && Array.isArray(raw.chatProfiles)) {
		migrateChatProviderIds(settings);
		assignChatKeySerials(settings.chatProfiles ?? []);
		return;
	}
	const profile: ChatProfile = {
		id: newChatProfileId(),
		name: settings.chatPreset === 'ollama' ? 'Ollama' : settings.chatPreset === 'custom' ? '自定义' : 'DeepSeek',
		apiBase: settings.chatApiBase,
		model: settings.chatModel,
		contextLengthPreset: settings.contextLengthPreset,
		chatModelMaxTokens: settings.chatModelMaxTokens,
		providerId: inferChatProvider(settings.chatApiBase),
		keySerial: 1,
	};
	settings.chatProfiles = [profile];
	settings.activeChatProfileId = profile.id;
}

/**
 * 给没有 providerId 的旧套补上供应商。只按地址分成 deepseek / ollama / custom。
 *
 * @param settings - 已与磁盘合并的设置
 */
export function migrateChatProviderIds(settings: RatelVaultSettings): void {
	for (const profile of settings.chatProfiles ?? []) {
		if (profile.providerId) continue;
		profile.providerId = inferChatProvider(profile.apiBase);
	}
}

/**
 * 同一供应商下下一个没用过的序号。
 *
 * @param profiles - 已有配置
 * @param providerId - 供应商 id
 * @returns 从 1 起的序号
 */
export function nextChatKeySerial(
	profiles: Array<{ providerId?: string; keySerial?: number }>,
	providerId: string,
): number {
	const slug = providerSecretSlug(providerId);
	const used = new Set(
		profiles
			.filter((profile) => providerSecretSlug(profile.providerId || 'custom') === slug)
			.map((profile) => profile.keySerial)
			.filter((serial): serial is number => typeof serial === 'number' && serial > 0),
	);
	let n = 1;
	while (used.has(n)) n += 1;
	return n;
}

/**
 * 给没有序号、或序号和同一供应商撞车的配置补一个稳定序号。已有且不重复的不改。
 *
 * @param profiles - 全部对话配置
 */
export function assignChatKeySerials(
	profiles: Array<{ providerId?: string; keySerial?: number }>,
): void {
	const taken = new Map<string, Set<number>>();
	for (const profile of profiles) {
		const slug = providerSecretSlug(profile.providerId || 'custom');
		const used = taken.get(slug) ?? new Set<number>();
		if (profile.keySerial && profile.keySerial > 0 && !used.has(profile.keySerial)) {
			used.add(profile.keySerial);
		} else {
			let n = 1;
			while (used.has(n)) n += 1;
			profile.keySerial = n;
			used.add(n);
		}
		taken.set(slug, used);
	}
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

/**
 * 创建空配置，不继承当前模型、窗口或密钥，也不切换当前配置。
 *
 * @param settings - 可变插件设置
 * @param name - 新配置名称
 * @returns 新增的配置
 */
export function createChatProfile(settings: RatelVaultSettings, name: string): ChatProfile {
	const profile: ChatProfile = {
		id: newChatProfileId(), name, apiBase: '', model: '',
		providerId: LOCAL_PROVIDER_CUSTOM,
		// 未选模型时只给最小手动窗口，选模型后再按名单填写。
		contextLengthPreset: 'custom', chatModelMaxTokens: CUSTOM_TOKEN_MIN,
		keySerial: nextChatKeySerial(settings.chatProfiles, LOCAL_PROVIDER_CUSTOM),
		allowLegacyKeyFallback: false,
	};
	settings.chatProfiles = [...settings.chatProfiles, profile];
	return profile;
}

/**
 * 复制指定配置的字段，分配独立 id 和密钥槽位，不切换当前配置。
 * 密钥由调用方从来源配置读取并写入副本，不进入设置数据。
 *
 * @param settings - 可变插件设置
 * @param sourceId - 要复制的配置 id
 * @param name - 副本名称
 * @returns 新副本；来源已不存在时返回 undefined
 */
export function copyChatProfile(settings: RatelVaultSettings, sourceId: string, name: string): ChatProfile | undefined {
	const source = settings.chatProfiles.find((profile) => profile.id === sourceId);
	if (!source) return undefined;
	const profile: ChatProfile = {
		...source, id: newChatProfileId(), name,
		keySerial: nextChatKeySerial(settings.chatProfiles, source.providerId || LOCAL_PROVIDER_CUSTOM),
		allowLegacyKeyFallback: false,
	};
	settings.chatProfiles = [...settings.chatProfiles, profile];
	return profile;
}

/** 删除一套。当前这套拒绝删除。 */
export function deleteChatProfile(settings: RatelVaultSettings, id: string): void {
	if (settings.activeChatProfileId === id) {
		throw new Error('不能删除正在使用的配置，请先切换到另一个');
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
	/** 已加载的 models.dev 名单；没有缓存时为 null */
	catalog: ModelsDevCatalog | null;
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
	/** 查表命中的单次输出上限；只用于展示，不写入设置 */
	output?: number;
}

/**
 * 按供应商 id + 模型 id 查名单，把窗口写进当前四字段并镜像活跃套。
 *
 * 设计要点:
 * - 活跃套 `windowUserSet` 为真时不覆盖窗口；若名单命中，仍返回 output 供界面显示
 * - 命中 → `applyContextRecommendation` 写 preset + tokens
 * - 未命中且 `clearOnMiss` → 写 custom/0，不沿用上一个模型的上限
 *
 * @param settings - 插件设置
 * @param deps.catalog - 已加载名单，没有时传 null
 * @param deps.clearOnMiss - 查不到时是否清空旧上限
 * @returns applied/skipped/changed，以及命中的 tokens / output
 */
export async function syncChatWindow(
	settings: RatelVaultSettings,
	deps: ChatWindowSyncDeps,
): Promise<ChatWindowSyncResult> {
	const active = settings.chatProfiles.find((p) => p.id === settings.activeChatProfileId);
	const providerId = active?.providerId || LOCAL_PROVIDER_CUSTOM;
	const limits = deps.catalog
		? lookupCatalogLimits(deps.catalog, providerId, settings.chatModel)
		: undefined;
	const output = limits && limits.output > 0 ? limits.output : undefined;

	if (active?.windowUserSet) {
		return { applied: false, skipped: true, changed: false, output };
	}

	if (limits) {
		const applied = applyContextRecommendation(limits.context);
		const changed =
			settings.contextLengthPreset !== applied.preset ||
			settings.chatModelMaxTokens !== applied.chatModelMaxTokens;
		settings.contextLengthPreset = applied.preset;
		settings.chatModelMaxTokens = applied.chatModelMaxTokens;
		if (active) {
			active.contextLengthPreset = applied.preset;
			active.chatModelMaxTokens = applied.chatModelMaxTokens;
		}
		return { applied: true, skipped: false, changed, tokens: limits.context, output };
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

/**
 * 顶栏应显示的模型。当前套有自己的模型名时用它，否则用全局 chatModel。
 *
 * @param settings - 含当前套 id、配置列表和全局模型名
 * @returns 顶栏和菜单高亮行应对齐的模型名
 */
export function resolveHeaderChatModel(settings: {
	chatModel: string;
	activeChatProfileId: string;
	chatProfiles?: ReadonlyArray<{ id: string; model: string }>;
}): string {
	const active = settings.chatProfiles?.find((profile) => profile.id === settings.activeChatProfileId);
	return active?.model || settings.chatModel;
}

/**
 * 点菜单里的某一套时，是否还要把该套写回当前四字段。
 * 已经是当前套且模型、地址、窗口都一致时不必再切。
 *
 * @param settings - 当前设置
 * @param profileId - 点中的套 id
 * @returns true 表示需要 switchChatProfile
 */
export function profileSelectNeedsSwitch(settings: RatelVaultSettings, profileId: string): boolean {
	const profile = settings.chatProfiles?.find((item) => item.id === profileId);
	if (!profile) return false;
	if (profileId !== settings.activeChatProfileId) return true;
	return settings.chatModel !== profile.model
		|| settings.chatApiBase !== profile.apiBase
		|| settings.contextLengthPreset !== profile.contextLengthPreset
		|| settings.chatModelMaxTokens !== profile.chatModelMaxTokens;
}

/**
 * 把模型名写进指定套，不碰全局 chatModel。改模型后窗口锁定取消，下次切到这套再查表。
 *
 * @param profile - 正在编辑的那一套
 * @param model - 新模型名
 */
export function writeStoredProfileModel(profile: ChatProfile, model: string): void {
	profile.model = model;
	profile.windowUserSet = false;
}

/**
 * 把窗口数字写进指定套，不碰全局上限。
 *
 * @param profile - 正在编辑的那一套
 * @param tokens - 窗口 token 数
 * @param userSet - true 表示用户改过，同模型不再被查表覆盖
 */
export function writeStoredProfileWindow(profile: ChatProfile, tokens: number, userSet: boolean): void {
	const applied = applyContextRecommendation(tokens);
	profile.contextLengthPreset = applied.preset;
	profile.chatModelMaxTokens = applied.chatModelMaxTokens;
	profile.windowUserSet = userSet;
}

/**
 * 把供应商写进指定套，不碰当前对话的模型、地址和窗口。
 * 新供应商的名单里没有当前模型时，换成这一家的第一个可用模型。
 *
 * @param settings - 插件设置，只用来给这一套分配不重复的密钥序号
 * @param profile - 正在编辑的那一套
 * @param providerId - 供应商 id
 * @param catalog - 已加载名单；没有时不改模型，地址按供应商规则写
 */
export function assignStoredProfileProvider(
	settings: RatelVaultSettings,
	profile: ChatProfile,
	providerId: string,
	catalog: ModelsDevCatalog | null,
): void {
	profile.providerId = providerId;
	profile.windowUserSet = false;
	if (providerId === LOCAL_PROVIDER_OLLAMA) {
		profile.apiBase = OLLAMA_CHAT_API_BASE;
		profile.model = OLLAMA_CHAT_MODEL;
	} else if (providerId === LOCAL_PROVIDER_CUSTOM) {
		profile.apiBase = '';
	} else {
		const api = catalog?.[providerId]?.api;
		profile.apiBase = typeof api === 'string' ? api.trim() : '';
		if (catalog) {
			const models = listCatalogModels(catalog, providerId);
			if (models.length > 0 && !models.includes(profile.model)) {
				profile.model = models[0]!;
			}
		}
	}
	ensureOwnKeySerial(settings, profile);
}

/**
 * 只给这一套补密钥序号。序号还没被同一供应商的其他套占用时保持原值。
 *
 * @param settings - 插件设置
 * @param profile - 正在编辑的那一套
 */
export function ensureOwnKeySerial(settings: RatelVaultSettings, profile: ChatProfile): void {
	const providerId = profile.providerId || LOCAL_PROVIDER_CUSTOM;
	const others = (settings.chatProfiles ?? []).filter((item) => item.id !== profile.id);
	const slug = providerSecretSlug(providerId);
	const used = new Set(
		others
			.filter((item) => providerSecretSlug(item.providerId || LOCAL_PROVIDER_CUSTOM) === slug)
			.map((item) => item.keySerial)
			.filter((serial): serial is number => typeof serial === 'number' && serial > 0),
	);
	if (profile.keySerial && profile.keySerial > 0 && !used.has(profile.keySerial)) return;
	profile.keySerial = nextChatKeySerial(others, providerId);
}

/**
 * 当前套改完之后，把这一套的模型、地址和窗口抄到全局四字段。
 * 不读其他套，也不把全局值写回其他套。
 *
 * @param settings - 插件设置
 * @param profile - 刚刚改过的当前套
 */
export function projectProfileToSettings(settings: RatelVaultSettings, profile: ChatProfile): void {
	settings.chatApiBase = profile.apiBase;
	settings.chatModel = profile.model;
	settings.contextLengthPreset = profile.contextLengthPreset;
	settings.chatModelMaxTokens = profile.chatModelMaxTokens;
}
