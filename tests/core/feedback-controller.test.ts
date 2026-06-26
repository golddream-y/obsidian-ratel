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

	it('applyStartupChecks - 内联模式 - 不弹 toast,只 patch degraded', () => {
		const ctl = createController({ getWorkerMode: () => 'inline' });
		ctl.start();
		// 关键路径:迁移后内联模式不再弹 toast,改由 StatusDrawer 降级区显示
		expect((userNotice.toast as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
		expect(get(userStatus.statusBar$).worker).toBe('inline');
		ctl.destroy();
	});

	it('applyStartupChecks - API Embedding 模式 - 不弹 toast,只 patch degraded', () => {
		const ctl = createController({
			getSettings: () => ({
				embedProvider: 'api',
				embedApiBase: 'http://localhost:11434/v1',
				chatApiBase: 'https://api.deepseek.com',
			}),
		});
		ctl.start();
		// 关键路径:API Embedding 降级提示迁移到 StatusDrawer,不再弹 toast
		expect((userNotice.toast as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
		expect(get(userStatus.statusBar$).degraded).toContain('API Embedding');
		ctl.destroy();
	});

	it('Model Downloading - 仍创建 toastProgress(下载进度条保留)', () => {
		const ctl = createController();
		ctl.start();
		modelStatus$.set({ state: 'Downloading', progress: 0.5, speed: 0, eta: 0 });
		// 关键路径:下载进度条是 duration=0 长驻 Notice,迁移后仍保留
		expect(toastProgress).toHaveBeenCalled();
		expect(get(userStatus.statusBar$).model).toBe('downloading');
		ctl.destroy();
	});

	it('Model Failed - 仍弹 toastError(严重错误保留)', () => {
		const ctl = createController();
		ctl.start();
		modelStatus$.set({ state: 'Failed', reason: '网络超时' });
		// 关键路径:严重错误仍弹原生 Notice,确保用户可见
		expect((userNotice.toastError as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(expect.stringContaining('网络超时'));
		ctl.destroy();
	});

	it('Index Failed - 仍弹 toastError(严重错误保留)', () => {
		const ctl = createController();
		ctl.start();
		indexStatus$.set({ state: 'Failed', reason: 'vault 路径无效', totalDocs: 0 });
		expect((userNotice.toastError as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(expect.stringContaining('vault 路径无效'));
		ctl.destroy();
	});

	it('notifyFullIndexComplete - 无外部回调时不弹 toast,只更新 statusBar$', () => {
		const ctl = createController({ onFullIndexComplete: undefined });
		ctl.start();
		ctl.notifyFullIndexComplete(128, 0);
		// 关键路径:索引完成迁移到 StatusLine 状态恢复,不再弹 toast
		expect((userNotice.toast as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
		ctl.destroy();
	});
});
