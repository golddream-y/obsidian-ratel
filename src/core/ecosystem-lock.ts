/**
 * @file src/core/ecosystem-lock.ts
 * @description 同一 pluginId 的生态写操作串行
 * @module core/ecosystem-lock
 */

const tails = new Map<string, Promise<unknown>>();

/**
 * 对同一 pluginId 的写操作排队串行;不同 id 互不影响。
 *
 * @param pluginId - 社区插件 id
 * @param fn - 持锁期间执行的异步任务
 * @returns fn 的返回值
 */
export async function withPluginLock<T>(pluginId: string, fn: () => Promise<T>): Promise<T> {
	const prev = tails.get(pluginId);
	let release!: () => void;
	const gate = new Promise<void>((r) => { release = r; });
	tails.set(pluginId, (prev ?? Promise.resolve()).then(() => gate));
	// 关键路径:队首不 await 已 resolved 的占位 Promise,避免 vitest 多文件并行时单微任务竞态
	if (prev !== undefined) {
		await prev.catch(() => undefined);
	}
	try {
		return await fn();
	} finally {
		release();
	}
}
