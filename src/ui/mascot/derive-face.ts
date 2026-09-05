/**
 * @file src/ui/mascot/derive-face.ts
 * @description 由 ChatView 已有信号派生捣蛋鬼脸(S-MASCOT 4.2)
 * @module ui/mascot/derive-face
 */
import type { MessageSegment } from '../chat/message-stream/types';
import type { MascotFace } from './types';

export interface MascotFaceInput {
	isRunning: boolean;
	cancelled: boolean;
	errorHoldActive: boolean;
	segments: MessageSegment[];
	/** 输入框有内容且用户正在写（Agent 未跑时切 listening） */
	userTyping: boolean;
}

/**
 * 同帧只返回一档;errorHold 最高,跑起来走忙态,停下才看用户是否在打字。
 *
 * @param input - ChatView 已有运行/取消/报错保持、segments 与输入框打字
 * @returns 当前帧应展示的捣蛋鬼脸档
 */
export function deriveMascotFace(input: MascotFaceInput): MascotFace {
	if (input.errorHoldActive) return 'error';
	if (!input.isRunning) {
		if (input.cancelled) return 'stopped';
		if (input.userTyping) return 'listening';
		return 'idle';
	}
	const last = input.segments[input.segments.length - 1];
	if (!last) return 'waiting';
	if (last.type === 'tool' && last.toolCall.status === 'calling') return 'working';
	if (last.type === 'think') return 'thinking';
	if (last.type === 'text' && last.text.length > 0) return 'speaking';
	if (last.type === 'tool') return 'working';
	return 'waiting';
}
