/**
 * @file src/core/memory-revision.ts
 * @description 记忆变更版本号 — MemoryPanel 订阅后重新 loadMemories
 * @module core/memory-revision
 * @depends svelte/store
 */

import { writable, type Writable } from 'svelte/store';

/**
 * 记忆 revision — MemoryStore 写盘成功后 bump,面板订阅后重读磁盘。
 *
 * 设计要点:
 * - 用数字版本号,避免 store 持有 MemoryStore / 条目引用与循环依赖。
 * - agent remember / forget 与面板自写共用同一信号,无需 fs.watch。
 */
export const memoryRevision: Writable<number> = writable(0);

/**
 * 递增记忆版本号,通知 MemoryPanel 等订阅方重新加载。
 */
export function bumpMemory(): void {
	memoryRevision.update((n) => n + 1);
}
