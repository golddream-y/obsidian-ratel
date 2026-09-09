/**
 * @file src/ui/goal/goal-revision.ts
 * @description Goal UI 刷新令牌 — ChatView 订阅,插件普通字段 Svelte 看不到
 * @module ui/goal/goal-revision
 * @depends svelte/store
 */
import { writable, type Writable } from 'svelte/store';

/**
 * Goal 列表/状态变更版本号。
 *
 * 设计要点:
 * - `plugin.goalRevision++` 不是 Svelte 响应式源,ChatView `$effect` 订了也刷不了条和 chip
 * - bumpGoalUi 必须同时 `bumpGoalRevision()`,侧栏才能在 cancel/complete 后丢掉残留
 */
export const goalRevision: Writable<number> = writable(0);

/**
 * 通知 ChatView / 底栏重读 GoalStore。
 */
export function bumpGoalRevision(): void {
	goalRevision.update((n) => n + 1);
}
