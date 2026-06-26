/**
 * @file src/core/feedback-controller.ts
 * @description 订阅 Model/Index status$ 驱动 UserStatus 与 UserNotice — 用户反馈集中接线
 * @module core/feedback-controller
 * @depends core/model-manager, core/index-manager, user-feedback/user-notice, user-feedback/user-status, logging/dev-logger
 */

import type { Readable } from 'svelte/store';
import type { Unsubscriber } from 'svelte/store';
import type { ModelStatus } from './model-manager';
import type { IndexStatus } from './index-manager';
import { devLogger } from '../logging/dev-logger';
import type { UserNotice } from '../user-feedback/user-notice';
import { UserStatus, type UserStatusSnapshot } from '../user-feedback/user-status';

/** FeedbackController 构造依赖 — 注入 status$ 与快照读取函数,便于单测 */
export interface FeedbackControllerDeps {
	modelStatus$: Readable<ModelStatus>;
	indexStatus$: Readable<IndexStatus>;
	userNotice: UserNotice;
	userStatus: UserStatus;
	getEmbeddingReady: () => boolean;
	getWorkerMode: () => 'thread' | 'inline';
	// 关键路径:Key 已迁至钥匙串,这里只暴露端点分类所需的最小字段(不传明文 Key)。
	getSettings: () => { embedProvider: 'local' | 'api'; embedApiBase: string; chatApiBase: string };
	onFullIndexComplete?: (indexed: number, errors: number) => void;
}

type ProgressHandle = ReturnType<UserNotice['toastProgress']>;

/**
 * 将 ModelManager / IndexManager 状态机翻译为使用者可见的 StatusBar 与 Notice。
 *
 * 设计要点:
 * - 里程碑才弹 Notice;增量索引只更新 statusBar$
 * - 独占管理模型下载 progress Notice 的生命周期
 * - 订阅回调内 try/catch,自身失败仅 devLogger,不抛给用户
 *
 * @example
 * const ctl = new FeedbackController(deps);
 * ctl.start();
 * // onunload:
 * ctl.destroy();
 */
export class FeedbackController {
	private readonly deps: FeedbackControllerDeps;
	private unsubscribers: Unsubscriber[] = [];
	private modelProgress: ProgressHandle | null = null;
	private inlineWorkerNotified = false;
	private apiModeNotified = false;

	constructor(deps: FeedbackControllerDeps) {
		this.deps = deps;
	}

	/**
	 * 注册 status$ 订阅,并执行启动期一次性检查(Worker 降级、API 模式、Embedding 就绪)。
	 */
	start(): void {
		this.applyStartupChecks();
		this.unsubscribers.push(
			this.deps.modelStatus$.subscribe((status) => this.safeRun(() => this.handleModelStatus(status))),
			this.deps.indexStatus$.subscribe((status) => this.safeRun(() => this.handleIndexStatus(status))),
		);
	}

	/**
	 * 退订所有 status$ 订阅,并关闭进行中的 progress Notice。
	 */
	destroy(): void {
		for (const unsub of this.unsubscribers) {
			unsub();
		}
		this.unsubscribers = [];
		this.hideModelProgress();
	}

	/**
	 * 全量索引完成时由 main.onLayoutReady 调用 — 优先走外部回调,否则更新 statusBar$。
	 *
	 * 关键路径:迁移到 StatusLine — 不再弹 toast,只更新 statusBar$ 让 StatusLine 恢复"就绪"。
	 * 严重失败仍由 IndexManager 的 Failed 状态走 toastError 路径。
	 *
	 * @param indexed - 成功索引文档数
	 * @param errors - 失败文档数
	 */
	notifyFullIndexComplete(indexed: number, errors: number): void {
		if (this.deps.onFullIndexComplete) {
			this.deps.onFullIndexComplete(indexed, errors);
			return;
		}
		this.safeRun(() => {
			this.deps.userStatus.patch({
				index: 'ready',
				indexDocCount: indexed,
				indexDetail: undefined,
			});
		});
	}

	/**
	 * 本地 Embedding 模型注入完成时由 main.onLayoutReady 调用。
	 *
	 * 关键路径:ModelManager.download() 内 status$.set(Ready) 触发 handleModelStatus 时,
	 * EmbeddingLocal.setEmbedding() 尚未执行,isReady 仍为 false,patchEmbeddingReady 得到 loading。
	 * 注入真实 ONNX 适配器后需再次 patch,把 embedding 状态推进到 ready。
	 */
	notifyEmbeddingReady(): void {
		this.safeRun(() => {
			this.deps.userStatus.patch({ embedding: 'ready' });
		});
	}

	/**
	 * 重新评估 Embedding 就绪状态 — embedProvider 切换或适配器重建后调用。
	 *
	 * 关键路径:settings 面板切 embedProvider 会调 rebuildEmbeddingAdapter(),
	 * 新 EmbeddingApi 立即可用(ready)、新 EmbeddingLocal 占位需等模型下载(loading),
	 * 需让 FeedbackController 重新读 getEmbeddingReady() 同步状态。
	 */
	refreshEmbeddingStatus(): void {
		this.safeRun(() => this.patchEmbeddingReady());
	}

	private applyStartupChecks(): void {
		this.safeRun(() => {
			this.patchEmbeddingReady();

			// 关键路径:内联模式降级提示迁移到 StatusDrawer 降级区,不再弹 toast。
			if (this.deps.getWorkerMode() === 'inline' && !this.inlineWorkerNotified) {
				this.inlineWorkerNotified = true;
				this.deps.userStatus.patch({
					worker: 'inline',
					degraded: '主线程内联模式,大库索引较慢,可在设置启用 Worker 线程',
				});
			}

			// 关键路径:API Embedding 降级提示迁移到 StatusDrawer,不再弹 toast。
			const settings = this.deps.getSettings();
			if (settings.embedProvider === 'api' && !this.apiModeNotified) {
				this.apiModeNotified = true;
				this.deps.userStatus.patch({
					degraded: 'API Embedding 模式暂不支持自动索引,请切换到本地模型',
				});
			}
		});
	}

	private patchEmbeddingReady(): void {
		this.deps.userStatus.patch({
			embedding: this.deps.getEmbeddingReady() ? 'ready' : 'loading',
		});
	}

	private handleModelStatus(status: ModelStatus): void {
		switch (status.state) {
			case 'NotStarted':
				this.deps.userStatus.patch({ model: 'idle', modelDetail: undefined });
				break;
			case 'Checking':
				this.deps.userStatus.patch({ model: 'checking', modelDetail: undefined });
				break;
			case 'Downloading': {
				const percent = Math.round(status.progress * 100);
				const detail = `${percent}%`;
				const message = `Ratel: 正在下载 bge-small-zh-v1.5 模型... ${detail}`;
				this.deps.userStatus.patch({ model: 'downloading', modelDetail: detail });
				if (!this.modelProgress) {
					this.modelProgress = this.deps.userNotice.toastProgress(message);
				} else {
					this.modelProgress.update(message);
				}
				break;
			}
			case 'Initializing':
				this.deps.userStatus.patch({ model: 'initializing', modelDetail: undefined });
				if (this.modelProgress) {
					this.modelProgress.update('Ratel: 正在初始化本地推理模型(首次较慢,请稍候)...');
				} else {
					this.modelProgress = this.deps.userNotice.toastProgress(
						'Ratel: 正在初始化本地推理模型(首次较慢,请稍候)...',
					);
				}
				break;
			case 'Ready':
				this.hideModelProgress();
				this.deps.userStatus.patch({ model: 'ready', modelDetail: undefined });
				this.patchEmbeddingReady();
				break;
			case 'Failed':
				this.hideModelProgress();
				this.deps.userStatus.patch({ model: 'failed', modelDetail: status.reason });
				this.deps.userNotice.toastError(`Ratel: 模型加载失败 — ${status.reason}`);
				break;
			case 'Switching':
				this.deps.userStatus.patch({
					model: 'checking',
					modelDetail: `${status.from} → ${status.to}`,
				});
				break;
		}
	}

	private handleIndexStatus(status: IndexStatus): void {
		const patch = mapIndexStatus(status);
		if (Object.keys(patch).length > 0) {
			this.deps.userStatus.patch(patch);
		}

		if (status.state === 'Failed') {
			this.deps.userNotice.toastError(`Ratel: 索引失败 — ${status.reason}`);
		}
	}

	private hideModelProgress(): void {
		this.modelProgress?.hide();
		this.modelProgress = null;
	}

	private safeRun(fn: () => void): void {
		try {
			fn();
		} catch (err) {
			devLogger.error('main', 'FeedbackController 回调失败', err);
		}
	}
}

/**
 * 将 IndexManager 状态映射为 UserStatus 字段增量。
 *
 * @param status - IndexManager 当前状态
 * @returns 供 userStatus.patch 使用的部分快照
 */
function mapIndexStatus(status: IndexStatus): Partial<UserStatusSnapshot> {
	switch (status.state) {
		case 'Idle':
			return { index: 'idle', indexDetail: undefined };
		case 'Init':
			return { index: 'init', indexDetail: undefined };
		case 'Scanning':
			return { index: 'scanning', indexDetail: `${status.scanned}/${status.total}` };
		case 'Queueing':
			return { index: 'queueing', indexDetail: `${status.pending} 待索引` };
		case 'Processing':
			return {
				index: 'processing',
				indexDetail: status.currentBatch[0] ?? undefined,
			};
		case 'Ready':
			return { index: 'ready', indexDocCount: status.totalDocs, indexDetail: undefined };
		case 'Paused':
			return { index: 'paused', indexDetail: `${status.pending} 待处理` };
		case 'Failed':
			return { index: 'failed', indexDetail: status.reason };
		case 'Unloaded':
			return { index: 'idle', indexDetail: undefined };
		default:
			return {};
	}
}
