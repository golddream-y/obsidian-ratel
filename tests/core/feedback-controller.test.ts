/**
 * @file tests/core/feedback-controller.test.ts
 * @description FeedbackController — status$ 订阅驱动 UserStatus / UserNotice
 * @module tests/core/feedback-controller
 * @depends core/feedback-controller
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writable, get } from 'svelte/store';
import type { ModelStatus } from '../../src/core/model-manager';
import type { IndexStatus } from '../../src/core/index-manager';
import { FeedbackController } from '../../src/core/feedback-controller';
import { UserStatus } from '../../src/user-feedback/user-status';
import type { UserNotice } from '../../src/user-feedback/user-notice';

describe('FeedbackController', () => {
	const modelStatus$ = writable<ModelStatus>({ state: 'NotStarted' });
	const indexStatus$ = writable<IndexStatus>({ state: 'Idle' });
	let userStatus: UserStatus;
	let userNotice: UserNotice;
	let toastProgress: ReturnType<typeof vi.fn>;
	let progressHide: ReturnType<typeof vi.fn>;
	let progressUpdate: ReturnType<typeof vi.fn>;

	function createController(
		overrides: Partial<ConstructorParameters<typeof FeedbackController>[0]> = {},
	): FeedbackController {
		return new FeedbackController({
			modelStatus$,
			indexStatus$,
			userNotice,
			userStatus,
			getEmbeddingReady: () => false,
			getWorkerMode: () => 'thread',
			// 关键路径:Key 已迁至钥匙串,getSettings 只暴露端点分类字段。
			getSettings: () => ({
				embedProvider: 'local',
				embedApiBase: '',
				chatApiBase: 'https://api.deepseek.com',
			}),
			onFullIndexComplete: vi.fn(),
			...overrides,
		});
	}

	beforeEach(() => {
		modelStatus$.set({ state: 'NotStarted' });
		indexStatus$.set({ state: 'Idle' });
		userStatus = new UserStatus();
		progressHide = vi.fn();
		progressUpdate = vi.fn();
		toastProgress = vi.fn().mockReturnValue({ update: progressUpdate, hide: progressHide });
		userNotice = {
			toast: vi.fn(),
			toastError: vi.fn(),
			toastProgress,
		} as unknown as UserNotice;
	});

	it('Model Downloading - patch model=downloading 并创建 progress', () => {
		const ctl = createController();
		ctl.start();
		modelStatus$.set({ state: 'Downloading', progress: 0.5, speed: 0, eta: 0 });
		expect(get(userStatus.statusBar$).model).toBe('downloading');
		expect(get(userStatus.statusBar$).modelDetail).toBe('50%');
		expect(toastProgress).toHaveBeenCalledWith('Ratel: 正在下载 bge-small-zh-v1.5 模型... 50%');
		ctl.destroy();
	});

	it('destroy - 退订并 hide 进行中的 progress', () => {
		const ctl = createController();
		ctl.start();
		modelStatus$.set({ state: 'Downloading', progress: 0.25, speed: 0, eta: 0 });
		expect(toastProgress).toHaveBeenCalled();
		ctl.destroy();
		expect(progressHide).toHaveBeenCalled();
		progressUpdate.mockClear();
		modelStatus$.set({ state: 'Downloading', progress: 0.75, speed: 0, eta: 0 });
		expect(progressUpdate).not.toHaveBeenCalled();
	});
});
