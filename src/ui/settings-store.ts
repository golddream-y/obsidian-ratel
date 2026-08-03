/**
 * @file src/ui/settings-store.ts
 * @description Settings 只读快照 store — 常驻 UI 订阅入口（S-SETTINGS-SYNC）
 * @module ui/settings-store
 * @depends svelte/store, settings(类型与 DEFAULT_SETTINGS)
 */

import { writable, type Readable } from 'svelte/store';
import { DEFAULT_SETTINGS, type RatelVaultSettings } from '../settings';
import { settingsRevision } from './settings-revision';

/**
 * 浅拷贝 settings 并隔离嵌套字段（toolPermissions / promptOverrides / MCP 数组）。
 *
 * @param settings - 源 settings 对象
 * @returns 只读快照，与源对象嵌套字段互不影响
 */
export function cloneSettingsSnapshot(settings: RatelVaultSettings): Readonly<RatelVaultSettings> {
	const base = { ...settings };
	base.toolPermissions = { ...settings.toolPermissions };
	base.promptOverrides = { ...settings.promptOverrides };
	// 关键路径:MCP 合入后若存在数组字段则拷贝；main 无这些键时跳过
	const ext = settings as RatelVaultSettings & {
		mcpServers?: unknown[];
		mcpApprovedSpawns?: unknown[];
	};
	if (Array.isArray(ext.mcpServers)) {
		(base as typeof ext).mcpServers = [...ext.mcpServers];
	}
	if (Array.isArray(ext.mcpApprovedSpawns)) {
		(base as typeof ext).mcpApprovedSpawns = [...ext.mcpApprovedSpawns];
	}
	return base;
}

const settingsStore = writable<Readonly<RatelVaultSettings>>(cloneSettingsSnapshot(DEFAULT_SETTINGS));

/** 常驻 UI 只读订阅；禁止把返回对象当可变 settings 写回 */
export const settings$: Readable<Readonly<RatelVaultSettings>> = {
	subscribe: settingsStore.subscribe,
};

/**
 * 发布 settings 快照并递增 settingsRevision。
 * saveSettings / loadSettings 成功路径唯一入口；禁止再并列 bumpSettingsRevision。
 *
 * @param settings - 当前 plugin.settings（可变对象，发布时会被克隆）
 */
export function publishSettingsSnapshot(settings: RatelVaultSettings): void {
	settingsStore.set(cloneSettingsSnapshot(settings));
	settingsRevision.update((n) => n + 1);
}

/**
 * 测试专用：恢复默认快照与 revision=0。
 */
export function resetSettingsStoreForTests(): void {
	settingsStore.set(cloneSettingsSnapshot(DEFAULT_SETTINGS));
	settingsRevision.set(0);
}
