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
