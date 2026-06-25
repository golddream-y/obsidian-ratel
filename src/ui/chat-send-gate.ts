/**
 * @file src/ui/chat-send-gate.ts
 * @description Chat 发送硬拦/软拦判定 — API Key 硬拦,检索未就绪软拦
 * @module ui/chat-send-gate
 * @depends user-feedback/user-status
 */

import type { UserStatusSnapshot } from '../user-feedback/user-status';

/** evaluateChatSendGate 的返回结构 */
export interface ChatSendGateResult {
	canSend: boolean;
	hardBlockReason?: string;
	softHint?: string;
}

/**
 * 根据设置与 UserStatus 快照判定 Chat 发送是否允许,以及硬拦/软拦提示文案。
 *
 * 设计要点:
 * - 缺少 Chat API Key 时硬拦,禁止发送
 * - 检索子系统未就绪时软拦,仍可纯对话发送
 *
 * @param settings - 至少包含 chatApiKey
 * @param status - StatusBar 当前快照
 * @returns 是否可发送及可选的硬拦/软拦文案
 */
export function evaluateChatSendGate(
	settings: { chatApiKey: string },
	status: UserStatusSnapshot,
): ChatSendGateResult {
	if (!settings.chatApiKey?.trim()) {
		return { canSend: false, hardBlockReason: '请先在设置中配置 Chat API Key' };
	}
	const searchDegraded =
		status.embedding !== 'ready' ||
		status.index === 'failed' ||
		(status.index !== 'ready' && status.index !== 'idle');
	if (searchDegraded) {
		return {
			canSend: true,
			softHint: '检索暂不可用,纯对话仍可继续;涉及 vault 搜索时工具会提示失败',
		};
	}
	return { canSend: true };
}

/**
 * 判断 vault 向量检索是否就绪 — embedding 与索引均为 ready。
 *
 * @param status - StatusBar 当前快照
 * @returns 检索就绪时为 true
 */
export function isSearchReady(status: UserStatusSnapshot): boolean {
	return status.embedding === 'ready' && status.index === 'ready';
}
