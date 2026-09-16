/**
 * @file src/core/preloaded-context.ts
 * @description 判断 ask 能否复用 ChatView 预加载的 ContextManager
 * @module core/preloaded-context
 */

/**
 * 判断 ask 能否复用 ChatView 预发送时已 load 的 ContextManager。
 *
 * sessionId 为空或不匹配时必须 new,避免把别的会话状态带进本轮。
 *
 * @param preloaded - 预加载 ctx(只需 sessionId);未传入则为 undefined
 * @param sessionId - 本轮 ask 的会话 ID
 * @returns 同 session 且 id 非空时 true
 */
export function shouldReusePreloadedContext(
	preloaded: { sessionId: string } | undefined,
	sessionId: string,
): boolean {
	return Boolean(preloaded && preloaded.sessionId && preloaded.sessionId === sessionId);
}

/**
 * 预发送压缩写在另一份 ContextManager 上;同 id load 对旧实例是 no-op。
 * compact 路径走过则换新实例再 load,否则沿用 stale,让 ask 仍拿到带 marker 的预加载 ctx。
 *
 * @param compactPathTaken - 是否进入了预发送 compact 分支
 * @param stale - 压缩前已 load 的 ctx
 * @param createFresh - 工厂,对应 plugin.createContext
 * @param sessionId - 当前会话 id
 * @returns compact 未走则 stale;否则新实例且已 load
 */
export async function reloadPreloadedContextAfterCompact<T extends { load(sessionId: string): Promise<void> }>(
	compactPathTaken: boolean,
	stale: T,
	createFresh: () => T,
	sessionId: string,
): Promise<T> {
	if (!compactPathTaken) return stale;
	const fresh = createFresh();
	await fresh.load(sessionId);
	return fresh;
}
