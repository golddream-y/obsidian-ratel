/**
 * @file src/ui/chat/compact-auto.ts
 * @description 自动压缩触发决策 — 从 ChatView 抽出的纯函数
 * @module ui/chat/compact-auto
 * @depends core/compact-project
 */

import { shouldAutoCompact } from '../../core/compact-project';

/** 发送前是否应自动压缩 */
export function decidePreSendCompact(input: {
	enabled: boolean;
	percentage: number;
	circuitOpen: boolean;
	isRunning: boolean;
	isCompacting: boolean;
}): boolean {
	if (input.isRunning || input.isCompacting) return false;
	return shouldAutoCompact(input.percentage, input.enabled, input.circuitOpen);
}

/** 一轮结束后是否应自动压缩 */
export function decidePostTurnCompact(input: {
	enabled: boolean;
	percentage: number;
	circuitOpen: boolean;
}): boolean {
	return shouldAutoCompact(input.percentage, input.enabled, input.circuitOpen);
}
