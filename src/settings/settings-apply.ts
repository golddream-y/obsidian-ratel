/**
 * @file src/settings/settings-apply.ts
 * @description 共享的设置写入与副作用分发 — SettingTab 与 update_app_config 工具的唯一入口
 * @module settings/settings-apply
 * @depends settings, settings/chat-preset, ui/tokens/context-length-presets, i18n, logging/dev-logger, core/tool-permissions
 */

import type { RatelVaultSettings } from '../settings';
import type { ToolPermission } from '../core/tool-permissions';
import { applyChatPreset, type ChatPresetId } from './chat-preset';
import {
	applyContextLengthPreset,
	type ContextLengthPresetId,
} from '../ui/tokens/context-length-presets';
import { applyLangPreference, type LangPreference } from '../i18n';
import { devLogger } from '../logging/dev-logger';

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
export function applySettingValue(plugin: SettingApplier, key: string, value: unknown): void {
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
		// 关键路径:预设写入多字段,不能只赋 chatPreset 一个 key
		applyChatPreset(plugin.settings, value as ChatPresetId);
		plugin.rebuildLLM();
	} else if (key === 'contextLengthPreset') {
		// 修复:下拉只写 preset 时 chatModelMaxTokens 仍是旧值,抽屉上限不跟着变
		applyContextLengthPreset(plugin.settings, value as ContextLengthPresetId);
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
		// 关键路径:手改模型或 Base → 场景预设自动切到 custom
		plugin.settings.chatPreset = 'custom';
		plugin.rebuildLLM();
	}
	if (key === 'chatVisionEnabled') {
		// 修复(S-VISION v1.4):视觉开关即时生效 — LLM 实例捕获构造期 config,
		// 不重建则 supportsImages 一直是旧值,直到重启/改模型才生效
		plugin.rebuildLLM();
	}
	// 关键路径:embedLocalModel 当前是只读字段(内置模型),不会触发 setControlValue,
	// 但保险起见排除,避免未来误触发 rebuild。
	if (key.startsWith('embed') && key !== 'embedLocalModel') {
		plugin.rebuildEmbeddingAdapter();
	}
	if (key === 'debugLog') {
		devLogger.setDebugEnabled(value as boolean);
	}
	// 关键路径:language 切换后立即应用,触发 langStore 更新,Svelte 组件自动重渲染
	if (key === 'language') {
		applyLangPreference(value as LangPreference);
	}
}
