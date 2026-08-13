/**
 * @file src/ui/chat/session-context-usage.ts
 * @description 会话上下文占用估算 — 优先 ContextManager 投影,失败降级 UI 估算
 * @module ui/chat/session-context-usage
 * @depends core/context-manager
 */

import type { ContextManager } from '../../core/context-manager';

/** patchContextUsage 用的占用快照 */
export interface SessionContextUsagePatch {
	usedTokens: number;
	maxTokens: number;
	source: 'estimate';
}

/**
 * 从已加载的 ContextManager 读取上下文占用(与预发送自动压同源)。
 *
 * @param ctx - 已 load(sessionId) 的 ContextManager
 * @param maxTokens - 模型窗口上限
 * @param fallbackUsed - ctx 失败时的降级 token 数
 * @returns 供 userStatus.patchContextUsage 使用的字段
 */
export function contextUsageFromManager(
	ctx: ContextManager,
	maxTokens: number,
	fallbackUsed: number,
): SessionContextUsagePatch {
	try {
		const usage = ctx.getContextUsage(maxTokens);
		return { usedTokens: usage.usedTokens, maxTokens, source: 'estimate' };
	} catch {
		return { usedTokens: fallbackUsed, maxTokens, source: 'estimate' };
	}
}

/**
 * 加载会话后估算上下文占用;load 失败则降级 fallback。
 *
 * @param createContext - 与 Plugin.createContext 同签名
 * @param sessionId - 目标会话
 * @param maxTokens - 模型窗口上限
 * @param fallbackUsed - 降级 token 数(通常为 hydrate 后 UI 估算)
 */
export async function loadSessionContextUsage(
	createContext: () => ContextManager,
	sessionId: string,
	maxTokens: number,
	fallbackUsed: number,
): Promise<SessionContextUsagePatch> {
	try {
		const ctx = createContext();
		await ctx.load(sessionId);
		return contextUsageFromManager(ctx, maxTokens, fallbackUsed);
	} catch {
		return { usedTokens: fallbackUsed, maxTokens, source: 'estimate' };
	}
}
