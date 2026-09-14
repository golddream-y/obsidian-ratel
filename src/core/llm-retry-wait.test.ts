/**
 * @file src/core/llm-retry-wait.test.ts
 * @description 重试打字行文案 key — 剩余毫秒到 i18n
 * @module core/llm-retry-wait.test
 */

import { describe, it, expect } from 'vitest';
import { retryWaitLabel } from './llm-retry-wait';

describe('retryWaitLabel', () => {
	const backoff = { phase: 'backoff' as const, attempt: 2, maxAttempts: 3, delayMs: 1500 };

	it('retryWaitLabel - 退避剩余不足 1 秒 - 即将重试', () => {
		expect(retryWaitLabel(backoff, 500)).toEqual({
			key: 'chat.retry.soon',
			params: { attempt: 2, max: 3 },
		});
	});

	it('retryWaitLabel - 退避刚开始 1500ms - 1 秒后重试', () => {
		expect(retryWaitLabel(backoff, 1500)).toEqual({
			key: 'chat.retry.after',
			params: { attempt: 2, max: 3, seconds: 1 },
		});
	});

	it('retryWaitLabel - request 相位 - 正在重试', () => {
		expect(
			retryWaitLabel({ phase: 'request', attempt: 2, maxAttempts: 3 }, 0),
		).toEqual({
			key: 'chat.retry.now',
			params: { attempt: 2, max: 3 },
		});
	});

	it('retryWaitLabel - 退避剩余落到 0 - 当作正在重试', () => {
		expect(retryWaitLabel(backoff, 0)).toEqual({
			key: 'chat.retry.now',
			params: { attempt: 2, max: 3 },
		});
	});
});
