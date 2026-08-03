/**
 * @file src/ui/settings-revision.ts
 * @description 设置变更版本号 — Chat 等视图订阅后重读 plugin.settings
 * @module ui/settings-revision
 * @depends svelte/store
 */

import { writable, type Writable } from 'svelte/store';

/**
 * 设置 revision — `saveSettings` 成功后 bump。
 *
 * 设计要点:
 * - settings 是可变普通对象,Svelte 看不到 `chatModel` 等字段赋值;
 * - 用版本号通知侧栏芯片 / embed 类型等 UI 重读 plugin.settings。
 */
export const settingsRevision: Writable<number> = writable(0);

/**
 * 递增设置版本号,通知订阅方重读 settings。
 */
export function bumpSettingsRevision(): void {
	settingsRevision.update((n) => n + 1);
}
