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
import { FeedbackController, describeIndexError, isIndexDiskFailure } from '../../src/core/feedback-controller';
import { WorkerManagerError, WORKER_MANAGER_ERROR_CODES } from '../../src/worker/manager';
import { IndexDirectoryNotOwnedError } from '../../src/core/persistent-index-backend';
import { IndexValidationError, INDEX_VALIDATION_ERROR_CODES } from '../../src/core/index-persistence-types';
import { INDEX_JOURNAL_ERROR_CODES } from '../../src/core/index-file-journal';
import { INDEX_GENERATION_ERROR_CODES } from '../../src/core/index-generations';
import { UserStatus } from '../../src/user-feedback/user-status';
import type { UserNotice } from '../../src/user-feedback/user-notice';

describe('FeedbackController', () => {
	it('正在处理与部分失败 - 主状态和文件计数 - 不显示排队或过期零失败', () => {
		const controller = createController();
		controller.start();
		indexStatus$.set({ state: 'Queueing', phase: 'processing', total: 100, committed: 20, pending: 80, failed: 0 });
		expect(get(userStatus.statusBar$)).toMatchObject({ index: 'processing', indexTotalFiles: 100, indexCommittedFiles: 20, indexPendingFiles: 80 });
		indexStatus$.set({ state: 'Failed', reason: '部分文件失败', phase: 'partial-failure', total: 100, committed: 20, pending: 78, failed: 2 });
		expect(get(userStatus.statusBar$)).toMatchObject({ index: 'failed', indexPhase: 'partial-failure', indexTotalFiles: 100, indexCommittedFiles: 20, indexPendingFiles: 78, indexFailedFiles: 2 });
		controller.destroy();
	});
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
		expect(toastProgress).toHaveBeenCalledWith('Ratel: 正在下载模型与运行时... 50%');
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

	it('applyStartupChecks - 内联模式 - 不弹 toast,不写 degraded 红字', () => {
		const ctl = createController();
		ctl.start();
		// 关键路径:InlineWorker 是 Obsidian 常态(ADR-002),不再当作降级写红字。
		expect((userNotice.toast as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
		expect(get(userStatus.statusBar$).worker).toBe('inline');
		expect(get(userStatus.statusBar$).degraded).toBeUndefined();
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
		indexStatus$.set({ state: 'Failed', reason: 'vault 路径无效', total: 0 });
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
 it('完成通知 - 部分错误 - 不触发成功回调且状态为失败', () => {
  const complete = vi.fn();
  const ctl = createController({ onFullIndexComplete: complete });
  ctl.notifyFullIndexComplete(1, 1);
  expect(complete).not.toHaveBeenCalled();
  expect(get(userStatus.statusBar$).index).toBe('failed');
  ctl.destroy();
 });

    it('完成通知 - 外部回调存在 - 保留本次indexed和errors语义', () => {
        const complete = vi.fn();
        const ctl = createController({ onFullIndexComplete: complete });
        indexStatus$.set({ state: 'Ready', totalDocs: 10, lastIndexTime: 1 });
        ctl.notifyFullIndexComplete(2, 0);
        expect(complete).toHaveBeenCalledWith(2, 0);
        ctl.destroy();
    });

});

describe('FeedbackController 索引阶段与计数展示', () => {
	const modelStatus$ = writable<ModelStatus>({ state: 'NotStarted' });
	const indexStatus$ = writable<IndexStatus>({ state: 'Idle' });
	let userStatus: UserStatus;

	function createController(
		overrides: Partial<ConstructorParameters<typeof FeedbackController>[0]> = {},
	): FeedbackController {
		userStatus = new UserStatus();
		return new FeedbackController({
			modelStatus$,
			indexStatus$,
			userNotice: {
				toast: vi.fn(),
				toastError: vi.fn(),
				toastProgress: vi.fn().mockReturnValue({ update: vi.fn(), hide: vi.fn() }),
			} as unknown as UserNotice,
			userStatus,
			getEmbeddingReady: () => true,
			getSettings: () => ({ embedProvider: 'api', embedApiBase: '', chatApiBase: '' }),
			...overrides,
		});
	}

	beforeEach(() => {
		modelStatus$.set({ state: 'NotStarted' });
		indexStatus$.set({ state: 'Idle' });
	});

	it('Scanning + 协调器阶段 stalled - indexPhase=stalled 且说明停滞', () => {
		const ctl = createController();
		ctl.start();
		indexStatus$.set({ state: 'Scanning', scanned: 3, total: 10, committed: 3, pending: 7, failed: 0, phase: 'stalled' });

		const snap = get(userStatus.statusBar$);
		expect(snap.indexPhase).toBe('stalled');
		expect(snap.indexDetail).toContain('停滞');
		expect(snap.indexTotalFiles).toBe(10);
		expect(snap.indexCommittedFiles).toBe(3);
		expect(snap.indexPendingFiles).toBe(7);
		expect(snap.indexPartial).toBe(true);
		ctl.destroy();
	});

	it('停滞后恢复 - 说明重新开始核对', () => {
		const ctl = createController();
		ctl.start();
		indexStatus$.set({ state: 'Scanning', scanned: 3, total: 10, committed: 3, pending: 7, failed: 0, phase: 'stalled' });
		indexStatus$.set({ state: 'Scanning', scanned: 4, total: 10, committed: 4, pending: 6, failed: 0, phase: 'scanning' });

		expect(get(userStatus.statusBar$).indexNotice).toBe('resumed');
		expect(get(userStatus.statusBar$).indexDetail).toContain('恢复');
		ctl.destroy();
	});

	it('Queueing + 重新核对 - detail 说明重新核对而不是旧任务进度', () => {
		const ctl = createController();
		ctl.start();
		indexStatus$.set({ state: 'Queueing', pending: 4, reverifying: true, committed: 6, total: 10, failed: 0, phase: 'processing' });

		const snap = get(userStatus.statusBar$);
		expect(snap.indexDetail).toContain('重新核对');
		expect(snap.indexPartial).toBe(true);
		expect(snap.indexCommittedFiles).toBe(6);
		ctl.destroy();
	});

	it('索引速率 - Scanning 与 Queueing 都透传到快照 - 未提供时不伪造', () => {
		const controller = createController();
		controller.start();
		// 关键路径:速率必须原样透传;字段名写错会静默丢弃,抽屉就永远不显示速度。
		indexStatus$.set({ state: 'Scanning', scanned: 5, total: 100, committed: 5, pending: 95, failed: 0, phase: 'scanning', rate: 1.5 });
		expect(get(userStatus.statusBar$).indexRate).toBe(1.5);
		indexStatus$.set({ state: 'Queueing', phase: 'processing', total: 100, committed: 20, pending: 80, failed: 0, rate: 2.4 });
		expect(get(userStatus.statusBar$).indexRate).toBe(2.4);
		// 未提供速率时不得沿用上一轮的值。
		indexStatus$.set({ state: 'Queueing', phase: 'processing', total: 100, committed: 21, pending: 79, failed: 0 });
		expect(get(userStatus.statusBar$).indexRate).toBeUndefined();
		controller.destroy();
	});

	it('Scanning + 尚无已提交文件 - 不声称部分可用', () => {
		const ctl = createController();
		ctl.start();
		indexStatus$.set({ state: 'Scanning', scanned: 0, total: 10, committed: 0, pending: 10, failed: 0, phase: 'scanning' });

		expect(get(userStatus.statusBar$).indexPartial).toBe(false);
		expect(get(userStatus.statusBar$).indexDetail).toBe('0/10');
		ctl.destroy();
	});

	it('Ready - 清除部分可用与过期须知(仅真实完成才宣告)', () => {
		const ctl = createController();
		ctl.start();
		indexStatus$.set({ state: 'Scanning', scanned: 3, total: 10, committed: 3, pending: 7, failed: 0, phase: 'scanning' });
		// 先写入一条失败须知,再进入真实就绪 —— 就绪必须清掉它。
		userStatus.patch({ indexNotice: 'disk-failure' });
		indexStatus$.set({ state: 'Ready', totalDocs: 10, lastIndexTime: 1, committedDocs: 10, totalFiles: 10, pendingDocs: 0, failedDocs: 0, phase: 'ready' });

		const snap = get(userStatus.statusBar$);
		expect(snap.index).toBe('ready');
		expect(snap.indexPartial).toBe(false);
		expect(snap.indexNotice).toBeUndefined();
		expect(snap.indexDocCount).toBe(10);
		ctl.destroy();
	});

	it('getIndexSignals - epochSourceMissing - 如实呈现本轮缺少 epoch 保护', () => {
		const ctl = createController({ getIndexSignals: () => ({ epochSourceMissing: true }) });
		ctl.start();
		indexStatus$.set({ state: 'Scanning', scanned: 1, total: 10, committed: 1, pending: 9, failed: 0, phase: 'scanning' });

		expect(get(userStatus.statusBar$).indexNotice).toBe('epoch-missing');
		expect(get(userStatus.statusBar$).indexDetail).toContain('epoch');
		ctl.destroy();
	});

	it('getIndexSignals - 记录不可判定 - 提示索引状态未知而不是 0 篇可检索', () => {
		const ctl = createController({ getIndexSignals: () => ({ recordsKind: 'unjudgeable' }) });
		ctl.start();
		indexStatus$.set({ state: 'Ready', totalDocs: 3, lastIndexTime: 1, committedDocs: 3, totalFiles: 3, pendingDocs: 0, failedDocs: 0, phase: 'ready' });

		expect(get(userStatus.statusBar$).index).toBe('ready');
		expect(get(userStatus.statusBar$).indexNotice).toBe('records-unknown');
		expect(get(userStatus.statusBar$).indexDetail).toContain('未知');
		ctl.destroy();
	});

	it('getIndexSignals - 配置代际变化 - 提示需要重新核对', () => {
		const ctl = createController({ getIndexSignals: () => ({ recordsConfig: 'mismatch' }) });
		ctl.start();
		indexStatus$.set({ state: 'Ready', totalDocs: 3, lastIndexTime: 1, committedDocs: 3, totalFiles: 3, pendingDocs: 0, failedDocs: 0, phase: 'ready' });

		expect(get(userStatus.statusBar$).indexNotice).toBe('config-mismatch');
		expect(get(userStatus.statusBar$).indexDetail).toContain('配置');
		ctl.destroy();
	});

	it('getIndexSignals - 迁移中 - indexPhase 呈现迁移', () => {
		const ctl = createController({ getIndexSignals: () => ({ migrating: true }) });
		ctl.start();
		indexStatus$.set({ state: 'Scanning', scanned: 2, total: 10, committed: 2, pending: 8, failed: 0, phase: 'scanning' });

		expect(get(userStatus.statusBar$).indexPhase).toBe('migrating');
		expect(get(userStatus.statusBar$).indexNotice).toBe('migrating');
		ctl.destroy();
	});

	it('磁盘失败 - 由宿主写入的 indexNotice 在未就绪期间保留', () => {
		const ctl = createController();
		ctl.start();
		indexStatus$.set({ state: 'Failed', reason: '磁盘写入失败' });
		userStatus.patch({ indexNotice: 'disk-failure', indexDetail: '磁盘写入失败,已保留上一个完整版本' });

		// 状态再次发布(与失败无关)不得抹掉磁盘失败须知。
		indexStatus$.set({ state: 'Failed', reason: '磁盘写入失败' });
		expect(get(userStatus.statusBar$).indexNotice).toBe('disk-failure');
		expect(get(userStatus.statusBar$).indexDetail).toContain('磁盘');
		ctl.destroy();
	});
});

describe('索引错误码 → 用户文案映射', () => {
	it('WorkerManagerError - index-stalled - 给出用户可读的停滞说明', () => {
		const text = describeIndexError(new WorkerManagerError('index-stalled', 'dev message'));
		expect(text).toContain('停滞');
		expect(text).not.toContain('dev message');
	});

	it('WorkerManagerError - 取消/重置/阻塞/超时/销毁 - 各自有稳定文案', () => {
		const codes = ['index-cancelled', 'runtime-reset', 'request-blocked', 'request-timeout', 'worker-destroyed'] as const;
		const texts = codes.map((code) => describeIndexError(new WorkerManagerError(code, 'dev')));
		expect(new Set(texts).size).toBe(codes.length);
		expect(texts.every((text) => text.length > 0 && !text.includes('dev'))).toBe(true);
	});

	it('T6/T2 错误码 - index-directory-not-owned / drop-refused / owner-not-writable - 不直接上屏原始英文', () => {
		const owned = describeIndexError(new IndexDirectoryNotOwnedError('/x/.index', 'denied'));
		const drop = describeIndexError({ code: 'drop-refused', message: 'raw' });
		const owner = describeIndexError({ code: 'owner-not-writable', message: 'raw' });
		expect(owned).toContain('归属');
		expect(drop).toContain('代际');
		expect(owner).toContain('写所有权');
	});

	it('T1 校验错误码 - 可能上屏的四个码各有专门文案,其余码走带码兜底', () => {
		const codes = ['schema-version-unknown', 'generation-mismatch', 'config-fingerprint-mismatch', 'checksum-mismatch'] as const;
		const texts = codes.map((code) => describeIndexError(new IndexValidationError(code, 'dev raw')));
		expect(new Set(texts).size).toBe(codes.length);
		expect(texts.every((text) => text.length > 0)).toBe(true);

		const other = describeIndexError(new IndexValidationError('vector-dimension-mismatch', 'dev raw'));
		expect(other).toContain('vector-dimension-mismatch');
	});

	it('T3 日志错误码 - 未决路径/写所有权/隔离等 - 映射为用户文案', () => {
		const text = describeIndexError({ code: 'path-in-flight', message: 'raw' });
		expect(text).toContain('同一路径');
		const quarantined = describeIndexError({ code: 'generation-quarantined', message: 'raw' });
		expect(quarantined).toContain('隔离');
	});

	it('未知错误 - 兜底带上原始消息,不静默', () => {
		expect(describeIndexError(new Error('boom'))).toContain('boom');
		expect(describeIndexError('plain string')).toContain('plain string');
	});

	it('isIndexDiskFailure - 只在磁盘/IO 类错误码上为真', () => {
		expect(isIndexDiskFailure({ code: 'io-failure' })).toBe(true);
		expect(isIndexDiskFailure({ code: 'checksum-mismatch' })).toBe(true);
		expect(isIndexDiskFailure(new IndexValidationError('config-fingerprint-mismatch', 'dev'))).toBe(false);
		expect(isIndexDiskFailure(new Error('boom'))).toBe(false);
	});

	it('错误码清单全覆盖 - 管理器与日志的每个码都有专门文案,不落到带码兜底', () => {
		const covered = (code: string): boolean => {
			const text = describeIndexError({ code, message: 'dev' });
			// 兜底文案会带上码本身;专门文案不会。
			return !text.includes(code);
		};
		for (const code of WORKER_MANAGER_ERROR_CODES) {
			expect(covered(code), `worker code ${code}`).toBe(true);
		}
		for (const code of INDEX_JOURNAL_ERROR_CODES) {
			expect(covered(code), `journal code ${code}`).toBe(true);
		}
		// T6 代际错误码:迁移/控制指针/回收相关的码已进入码表(降级出口必须能区分原因),
		// 其余按带码兜底,不静默。两条分支都断言「不把开发向 message 上屏」。
		const GENERATION_CODES_WITH_TEXT = [
			'owner-not-writable',
			'migration-io-failed',
			'migration-space-insufficient',
			'migration-interrupted',
			'legacy-manifest-invalid',
			'legacy-index-missing',
			'control-invalid',
			'space-budget-exceeded',
			'generation-not-droppable',
			'all-generations-retained',
		] as const;
		for (const code of INDEX_GENERATION_ERROR_CODES) {
			const text = describeIndexError({ code, message: 'dev' });
			expect(text.includes('dev'), code).toBe(false);
			if ((GENERATION_CODES_WITH_TEXT as readonly string[]).includes(code)) {
				expect(text.includes(code), code).toBe(false);
			} else {
				expect(text, code).toContain(code);
			}
		}
		// T1 校验码:四个可能上屏的码有专门文案,其余走带码兜底。
		for (const code of INDEX_VALIDATION_ERROR_CODES) {
			const text = describeIndexError({ code, message: 'dev' });
			if (['schema-version-unknown', 'generation-mismatch', 'config-fingerprint-mismatch', 'checksum-mismatch'].includes(code)) {
				expect(text.includes(code), code).toBe(false);
			} else {
				expect(text, code).toContain(code);
			}
		}
	});
});

describe('失败态错误码保留与上屏映射(T7/I1)', () => {
	const modelStatus$ = writable<ModelStatus>({ state: 'NotStarted' });
	const indexStatus$ = writable<IndexStatus>({ state: 'Idle' });
	let userStatus: UserStatus;
	let userNotice: UserNotice;

	function createController(): FeedbackController {
		return new FeedbackController({
			modelStatus$,
			indexStatus$,
			userNotice,
			userStatus,
			getEmbeddingReady: () => true,
			getSettings: () => ({ embedProvider: 'api', embedApiBase: '', chatApiBase: '' }),
		});
	}

	beforeEach(() => {
		indexStatus$.set({ state: 'Idle' });
		userStatus = new UserStatus();
		userNotice = { toast: vi.fn(), toastError: vi.fn(), toastProgress: vi.fn() } as unknown as UserNotice;
	});

	it('Failed 带稳定码 - 上屏与详情都走对应键,而非 error.index.unknown + 开发向 message', () => {
		const ctl = createController();
		ctl.start();
		indexStatus$.set({ state: 'Failed', reason: '索引目录归属断言未通过,拒绝清库:目标是当前活动代际目录(/x)' , errorCode: 'index-directory-not-owned' });

		const expected = describeIndexError({ code: 'index-directory-not-owned' });
		expect(userNotice.toastError).toHaveBeenCalledWith(expect.stringContaining(expected));
		expect(get(userStatus.statusBar$).indexDetail).toBe(expected);
		expect(get(userStatus.statusBar$).indexDetail).not.toContain('拒绝清库');
		ctl.destroy();
	});

	it('Failed 无码 - 保留既有 reason(可能是宿主写入的本地化文案),不二次包装', () => {
		const ctl = createController();
		ctl.start();
		indexStatus$.set({ state: 'Failed', reason: '索引未完成:3 个文件处理失败' });

		expect(get(userStatus.statusBar$).indexDetail).toBe('索引未完成:3 个文件处理失败');
		expect(userNotice.toastError).toHaveBeenCalledWith(expect.stringContaining('索引未完成:3 个文件处理失败'));
		ctl.destroy();
	});

	it('rebindIndexStatus - 重建状态源后继续订阅新状态机,旧 store 不再驱动展示', () => {
		const ctl = createController();
		ctl.start();
		const next$ = writable<IndexStatus>({ state: 'Idle' });
		ctl.rebindIndexStatus(next$);

		// 旧 store 已退订。
		indexStatus$.set({ state: 'Failed', reason: '旧状态机' });
		expect(userNotice.toastError).not.toHaveBeenCalled();

		next$.set({ state: 'Failed', reason: '新状态机', errorCode: 'owner-not-writable' });
		expect(userNotice.toastError).toHaveBeenCalledWith(expect.stringContaining(describeIndexError({ code: 'owner-not-writable' })));
		ctl.destroy();
	});
});
