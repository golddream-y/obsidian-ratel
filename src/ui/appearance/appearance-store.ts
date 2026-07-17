/**
 * @file src/ui/appearance/appearance-store.ts
 * @description 外观变更版本号 — 视图订阅后重跑 applyRatelAppearance
 * @module ui/appearance/appearance-store
 * @depends svelte/store
 */

import { writable, type Writable } from 'svelte/store';

/**
 * 外观 revision — 每次设置保存成功后 bump,Chat / Memory 等视图订阅后重跑 apply。
 *
 * 设计要点:
 * - 用数字版本号而非 settings 对象,避免 store 持有 settings 引用与循环依赖。
 * - 订阅方自行从 plugin.settings 读最新 uiColorScheme / uiAccent。
 */
export const appearanceRevision: Writable<number> = writable(0);

/**
 * 递增外观版本号,通知所有订阅视图重跑 applyRatelAppearance。
 */
export function bumpAppearance(): void {
	appearanceRevision.update((n) => n + 1);
}
