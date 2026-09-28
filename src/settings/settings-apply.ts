/**
 * @file src/settings/settings-apply.ts
 * @description 共享的设置写入与副作用分发 — SettingTab 与 update_app_config 工具的唯一入口
 * @module settings/settings-apply
 * @depends settings, settings/chat-preset, settings/chat-profiles, ui/tokens/context-length-presets, ui/tokens/model-context-registry, i18n, logging/dev-logger, core/tool-permissions
 */

import type { RatelVaultSettings } from '../settings';
import type { ToolPermission } from '../core/tool-permissions';
import { applyChatPreset, type ChatPresetId } from './chat-preset';
import {
	applyContextLengthPreset,
	applyContextRecommendation,
	type ContextLengthPresetId,
} from '../ui/tokens/context-length-presets';
import { DEFAULT_MODEL_REGISTRY_URL } from '../ui/tokens/model-context-registry';
import { inferChatProvider, lookupModelContext, syncChatWindow } from './chat-profiles';
import { applyLangPreference, type LangPreference } from '../i18n';
import { devLogger } from '../logging/dev-logger';
import type { ChatProfile, ModelContextLookup } from './chat-profiles';

/** 当前四字段写入 settings 后,需同步回活跃套的 profile 字段名 */
const ACTIVE_PROFILE_FIELD_BY_SETTING_KEY: Partial<
	Record<'chatApiBase' | 'chatModel' | 'contextLengthPreset' | 'chatModelMaxTokens', keyof ChatProfile>
> = {
	chatApiBase: 'apiBase',
	chatModel: 'model',
	contextLengthPreset: 'contextLengthPreset',
	chatModelMaxTokens: 'chatModelMaxTokens',
};

/**
 * 手改当前四字段时,把新值写回 `chatProfiles` 里活跃那一套,避免切换配置时用旧快照覆盖。
 *
 * @param settings - 插件设置(已写入新值)
 * @param key - 刚写入的 setting key
 */
function mirrorChatFieldToActiveProfile(
	settings: RatelVaultSettings,
	key: 'chatApiBase' | 'chatModel' | 'contextLengthPreset' | 'chatModelMaxTokens',
): void {
	const activeId = settings.activeChatProfileId;
	if (!activeId) return;
	const profile = settings.chatProfiles.find((p) => p.id === activeId);
	if (!profile) return;

	const profileField = ACTIVE_PROFILE_FIELD_BY_SETTING_KEY[key];
	if (!profileField) return;

	if (key === 'chatApiBase') {
		profile.apiBase = settings.chatApiBase;
	} else if (key === 'chatModel') {
		profile.model = settings.chatModel;
	} else if (key === 'contextLengthPreset') {
		profile.contextLengthPreset = settings.contextLengthPreset;
		// 关键路径:applyContextLengthPreset 会同步 chatModelMaxTokens,活跃套须一并更新
		profile.chatModelMaxTokens = settings.chatModelMaxTokens;
	} else if (key === 'chatModelMaxTokens') {
		profile.chatModelMaxTokens = settings.chatModelMaxTokens;
	}
}

/**
 * 设置应用的最小宿主接口 — RatelVaultPlugin 结构兼容,测试用 mock。
 *
 * 设计要点:
 * - 不直接依赖 RatelVaultPlugin 类型,避免 settings-apply ↔ main 循环 import。
 * - 副作用回调(rebuildLLM 等)由宿主注入,本模块只负责「写哪个 key + 触发哪个副作用」的映射。
 */
export interface SettingApplier {
	settings: RatelVaultSettings;
	rebuildLLM(): void;
	rebuildEmbeddingAdapter(): void;
	syncToolDefinitions(): void;
	syncCrashBreadcrumbs?(enabled: boolean): void;
	/** 映射表注册中心 — 缺省时窗口查表逻辑整体跳过(测试 mock 常用) */
	modelContextRegistry?: ModelContextLookup;
}

/**
 * 解析映射表 URL — 用户留空时回落 LiteLLM 默认地址。
 *
 * 关键路径:设置页展开区、切换套、窗口钳制三处共用,
 * 保证「modelRegistryUrl || 默认地址」的查表口径只有这一份。
 *
 * @param settings - 插件设置
 * @returns 有效的映射表 URL
 */
export function resolveRegistryUrl(settings: RatelVaultSettings): string {
	return settings.modelRegistryUrl || DEFAULT_MODEL_REGISTRY_URL;
}

/** 取活跃套 profile(无 activeChatProfileId 或未命中时返回 undefined) */
function findActiveProfile(settings: RatelVaultSettings) {
	return settings.chatProfiles.find((p) => p.id === settings.activeChatProfileId);
}

/**
 * 写入一个设置 key 并分发副作用(不落盘、不刷新 UI — 由调用方收尾)。
 *
 * 关键路径:SettingTab.setControlValue 与 update_app_config 工具共用本函数,
 * 两处副作用行为永不漂移(这正是「改 preset 抽屉长度不变」类 bug 的根源预防)。
 *
 * @param plugin - 宿主(settings + 副作用回调)
 * @param key - control key,可为嵌套 key 如 "toolPermissions.search_vault"
 * @param value - 新值(调用方保证类型;枚举非法值静默忽略,与旧行为一致)
 */
export async function applySettingValue(plugin: SettingApplier, key: string, value: unknown): Promise<void> {
	// 嵌套 key 分发
	if (key.startsWith('toolPermissions.')) {
		const toolName = key.slice('toolPermissions.'.length);
		plugin.settings.toolPermissions[toolName] = value as ToolPermission;
	} else if (key.startsWith('promptOverrides.')) {
		const sectionId = key.slice('promptOverrides.'.length);
		// 关键路径:OverrideMap 是 Partial<Record<PromptSectionId, string>>,
		// sectionId 是运行时 string,需 cast 为 Record<string,...> 才能用任意 string 索引。
		(plugin.settings.promptOverrides as Record<string, string | undefined>)[sectionId] = value as string;
		plugin.syncToolDefinitions();
	} else if (key === 'chatPreset') {
		// S-CHAT-SETUP:提供商变更走现有预设写入(DeepSeek/Ollama 覆盖 Base+模型),
		// 写入后镜像四字段回活跃套、清 windowUserSet,再按映射表查窗口
		applyChatPreset(plugin.settings, value as ChatPresetId);
		if (value === 'custom' && inferChatProvider(plugin.settings.chatApiBase) !== 'custom') {
			// 关键路径:切「自定义」= 清空地址由用户填写(提供商由地址推断,不清则跳回官方);
			// 已是自定义地址则保留,避免重复写入丢掉用户地址。模型名保留。
			plugin.settings.chatApiBase = '';
		}
		const active = findActiveProfile(plugin.settings);
		if (active) {
			active.apiBase = plugin.settings.chatApiBase;
			active.model = plugin.settings.chatModel;
			active.contextLengthPreset = plugin.settings.contextLengthPreset;
			active.chatModelMaxTokens = plugin.settings.chatModelMaxTokens;
			active.windowUserSet = false;
		}
		plugin.rebuildLLM();
		if (plugin.modelContextRegistry) {
			await syncChatWindow(plugin.settings, {
				registry: plugin.modelContextRegistry,
				registryUrl: resolveRegistryUrl(plugin.settings),
				clearOnMiss: true,
			});
		}
	} else if (key === 'contextLengthPreset') {
		// 修复:下拉只写 preset 时 chatModelMaxTokens 仍是旧值,抽屉上限不跟着变
		applyContextLengthPreset(plugin.settings, value as ContextLengthPresetId);
	} else if (key === 'chatModelMaxTokens') {
		// S-CHAT-SETUP:窗口一行数字框。非法值(非正数/NaN)静默忽略;
		// 大于查到的窗口时钳到查到的值(钳定值即表值,不标 windowUserSet)
		const n = Number(value);
		if (!Number.isFinite(n) || n <= 0) return;
		let tokens = n;
		let userSet = true;
		if (plugin.modelContextRegistry) {
			// 共享查表辅助(与 syncChatWindow 同口径):大于查到的窗口时钳到表值
			const found = await lookupModelContext(
				plugin.modelContextRegistry,
				resolveRegistryUrl(plugin.settings),
				plugin.settings.chatModel,
			);
			if (found != null && n > found) {
				tokens = found;
				userSet = false;
			}
		}
		const applied = applyContextRecommendation(tokens);
		plugin.settings.contextLengthPreset = applied.preset;
		plugin.settings.chatModelMaxTokens = applied.chatModelMaxTokens;
		const active = findActiveProfile(plugin.settings);
		if (active) {
			active.contextLengthPreset = applied.preset;
			active.chatModelMaxTokens = applied.chatModelMaxTokens;
			active.windowUserSet = userSet;
		}
	} else if (key === 'toolPermissionLevel') {
		// 关键路径:仅接受三档枚举,防止写入非法字符串
		if (value === 'safe' || value === 'auto' || value === 'danger') {
			plugin.settings.toolPermissionLevel = value;
		}
	} else if (key === 'chatNavRailSide') {
		// 关键路径:仅接受 left|right,防止写入非法字符串
		if (value === 'left' || value === 'right') {
			plugin.settings.chatNavRailSide = value;
		}
	} else {
		(plugin.settings as unknown as Record<string, unknown>)[key] = value;
	}

	// 副作用分发
	if (key === 'chatModel' || key === 'chatApiBase') {
		plugin.rebuildLLM();
	}
	if (key === 'chatApiBase') {
		// S-CHAT-SETUP:提供商不另存字段,由地址推断 — 官方 DeepSeek/Ollama 地址保持对应预设,其余视为自定义
		plugin.settings.chatPreset = inferChatProvider(String(value));
	}
	if (key === 'chatModel' && plugin.modelContextRegistry) {
		// S-CHAT-SETUP:改模型名清掉 windowUserSet 重查窗口;查不到清空旧上限,不静默沿用
		const active = findActiveProfile(plugin.settings);
		if (active) {
			active.windowUserSet = false;
		}
		await syncChatWindow(plugin.settings, {
			registry: plugin.modelContextRegistry,
			registryUrl: resolveRegistryUrl(plugin.settings),
			clearOnMiss: true,
		});
	}
	// 关键路径:embedLocalModel 当前是只读字段(内置模型),不会触发 setControlValue,
	// 但保险起见排除,避免未来误触发 rebuild。
	if (key.startsWith('embed') && key !== 'embedLocalModel') {
		plugin.rebuildEmbeddingAdapter();
	}
	if (key === 'debugLog') {
		devLogger.setDebugEnabled(value as boolean);
	}
	if (key === 'crashBreadcrumbs') {
		plugin.syncCrashBreadcrumbs?.(value as boolean);
	}
	// 关键路径:language 切换后立即应用,触发 langStore 更新,Svelte 组件自动重渲染
	if (key === 'language') {
		applyLangPreference(value as LangPreference);
	}
	// 关键路径:四字段与活跃套双向一致,否则 switchChatProfile 会用 profile 旧值覆盖用户刚改的 settings
	if (
		key === 'chatModel' ||
		key === 'chatApiBase' ||
		key === 'contextLengthPreset' ||
		key === 'chatModelMaxTokens'
	) {
		mirrorChatFieldToActiveProfile(plugin.settings, key);
	}
}
