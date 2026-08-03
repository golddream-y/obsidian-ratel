/**
 * @file src/ui/settings-revision.ts
 * @description 设置变更版本号 — Chat 等视图订阅后重读 plugin.settings
 * @module ui/settings-revision
 * @depends svelte/store
 */

import { writable, type Writable } from 'svelte/store';

/**
 * 设置 revision — 过渡用；生产路径由 `publishSettingsSnapshot` 更新 `settings$`。
 *
 * 设计要点:
 * - settings 是可变普通对象,Svelte 看不到 `chatModel` 等字段赋值;
 * - 旧版用版本号通知侧栏芯片 / embed 类型等 UI 重读 plugin.settings。
 */
export const settingsRevision: Writable<number> = writable(0);

/**
 * 仅递增版本号，**不**更新 settings$。
 * 生产路径请用 `publishSettingsSnapshot`（saveSettings 已挂钩）。
 * 保留本函数供旧测试 / 过渡订阅。
 */
export function bumpSettingsRevision(): void {
	settingsRevision.update((n) => n + 1);
}
