/**
 * @file src/ui/chat-send-gate.ts
 * @description Chat 发送硬拦/软拦判定 — 端点感知 Key 硬拦,检索未就绪软拦
 * @module ui/chat-send-gate
 * @depends user-feedback/user-status, secrets/ratel-secrets
 */

import type { UserStatusSnapshot } from '../user-feedback/user-status';
import { requiresChatApiKey, type ChatSecretSettings } from '../secrets/ratel-secrets';

/** evaluateChatSendGate 的返回结构 */
export interface ChatSendGateResult {
	canSend: boolean;
	hardBlockReason?: string;
	softHint?: string;
}

/**
 * 根据端点类型、钥匙串状态与 UserStatus 快照判定 Chat 发送是否允许,以及硬拦/软拦提示文案。
 *
 * 设计要点:
 * - 端点感知:本地 Ollama(localhost)免 Key 可发送;openai-compatible 缺钥匙串密钥时硬拦。
 * - 检索子系统未就绪时软拦,仍可纯对话发送。
 *
 * @param settings - 含 chatApiBase 的设置片段(用于端点分类)
 * @param status - StatusBar 当前快照
 * @param opts - hasChatApiKey: 钥匙串是否已配置 Chat 密钥(由调用方解析后传入)
 * @returns 是否可发送及可选的硬拦/软拦文案
 */
export function evaluateChatSendGate(
	settings: ChatSecretSettings,
	status: UserStatusSnapshot,
	opts: { hasChatApiKey: boolean },
): ChatSendGateResult {
	// 关键路径:仅 openai-compatible 端点需要钥匙串密钥;本地 Ollama 直接放行。
	if (requiresChatApiKey(settings) && !opts.hasChatApiKey) {
		return { canSend: false, hardBlockReason: '请先在 Obsidian 钥匙串配置 Chat API 密钥' };
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
