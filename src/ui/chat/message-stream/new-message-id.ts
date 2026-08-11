/**
 * @file src/ui/chat/message-stream/new-message-id.ts
 * @description UI Message 稳定 id（会话内锚点，不必落盘）
 * @module ui/chat/message-stream/new-message-id
 */

/** 生成会话内消息 id；优先 crypto.randomUUID。 */
export function newMessageId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return `m-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
