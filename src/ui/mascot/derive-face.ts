/**
 * @file src/ui/mascot/derive-face.ts
 * @description 由 ChatView 已有信号派生吉祥物脸(S-MASCOT 4.2)
 * @module ui/mascot/derive-face
 */
import type { MessageSegment } from '../chat/message-stream/types';
import type { MascotFace } from './types';

export interface MascotFaceInput {
	isRunning: boolean;
	cancelled: boolean;
	errorHoldActive: boolean;
	segments: MessageSegment[];
}

/**
 * 同帧只返回一档;errorHold 最高,其余按末段判别忙碌子态。
 *
 * @param input - ChatView 已有运行/取消/报错保持与 segments 快照
 * @returns 当前帧应展示的吉祥物脸档
 */
export function deriveMascotFace(input: MascotFaceInput): MascotFace {
	if (input.errorHoldActive) return 'error';
	if (!input.isRunning) return input.cancelled ? 'stopped' : 'idle';
	const last = input.segments[input.segments.length - 1];
	if (!last) return 'waiting';
	if (last.type === 'tool' && last.toolCall.status === 'calling') return 'working';
	if (last.type === 'think') return 'thinking';
	if (last.type === 'text' && last.text.length > 0) return 'speaking';
	if (last.type === 'tool') return 'working';
	return 'waiting';
}
