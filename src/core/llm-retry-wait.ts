/**
 * @file src/core/llm-retry-wait.ts
 * @description 重试打字行 — 把等待态折成 i18n key（不含翻译表）
 * @module core/llm-retry-wait
 * @depends ports/llm
 */

import type { LlmRetryWait } from '../ports/llm';

export type RetryWaitLabel = {
	key: 'chat.retry.soon' | 'chat.retry.after' | 'chat.retry.now';
	params: { attempt: number; max: number; seconds?: number };
};

/**
 * 打字行文案。退避剩余落到 0 时先显示「正在重试」，即使 request 回调晚一帧。
 *
 * @param wait - 包装器回调
 * @param remainingMs - ChatView 本地倒计时；request 相位忽略
 * @returns i18n key 与插值参数（不含翻译表）
 */
export function retryWaitLabel(wait: LlmRetryWait, remainingMs: number): RetryWaitLabel {
	const params = { attempt: wait.attempt, max: wait.maxAttempts };
	if (wait.phase === 'request' || remainingMs <= 0) {
		return { key: 'chat.retry.now', params };
	}
	if (remainingMs < 1000) {
		return { key: 'chat.retry.soon', params };
	}
	return {
		key: 'chat.retry.after',
		params: { ...params, seconds: Math.floor(remainingMs / 1000) },
	};
}
