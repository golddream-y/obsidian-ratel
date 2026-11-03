/**
 * @file tests/core/index-failure-toast-dedupe.test.ts
 * @description 索引失败提示去重 — 协调器高频发布同一失败时只提示一次
 * @module tests/core/index-failure-toast-dedupe
 */

import { describe, expect, it, vi } from 'vitest';
import { writable } from 'svelte/store';
import { FeedbackController } from '../../src/core/feedback-controller';
import type { IndexStatus } from '../../src/core/index-manager';
import { UserStatus } from '../../src/user-feedback/user-status';
import type { UserNotice } from '../../src/user-feedback/user-notice';

describe('索引失败提示去重', () => {
	it('同一失败反复发布 - 只提示一次 - 失败数变化才再提示', () => {
		const indexStatus$ = writable<IndexStatus>({ state: 'Idle' });
		const modelStatus$ = writable({ state: 'NotStarted' as const });
		const userStatus = new UserStatus();
		const toastError = vi.fn();
		const userNotice = {
			toast: vi.fn(),
			toastError,
			toastProgress: vi.fn().mockReturnValue({ update: vi.fn(), hide: vi.fn() }),
		} as unknown as UserNotice;
		const controller = new FeedbackController({
			modelStatus$,
			indexStatus$,
			userNotice,
			userStatus,
			getEmbeddingReady: () => false,
			getSettings: () => ({ embedProvider: 'local', embedApiBase: '', chatApiBase: 'https://api.deepseek.com' }),
			onFullIndexComplete: vi.fn(),
		});
		controller.start();
		const failed: IndexStatus = { state: 'Failed', reason: '部分文件失败', phase: 'partial-failure', total: 2807, committed: 1187, pending: 1619, failed: 1 };
		// 协调器每 250ms 发布一次:相同失败连续 5 次只应产生 1 条提示。
		for (let index = 0; index < 5; index += 1) indexStatus$.set({ ...failed });
		expect(toastError).toHaveBeenCalledTimes(1);
		indexStatus$.set({ ...failed, failed: 2 });
		expect(toastError).toHaveBeenCalledTimes(2);
		controller.destroy();
	});
});
