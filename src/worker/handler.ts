/**
 * @file src/worker/handler.ts
 * @description Worker 消息处理器 — 6 个 case 真实现 + 状态机 (M-1)
 * @module worker/handler
 * @depends worker/index-processor, adapters/vector-vectra
 *
 * 关键路径:
 * - Worker 启动期需先调用 `initProcessor(indexDir)` 初始化 processor,之后所有消息才有效
 * - processor 内部持有 VectraStore 引用,vector.upsert / vector.delete 直接复用该引用
 * - index.full 协议:payload 为 `{ files: Array<{ path: string; content: string }> }`,主线程传已分块 + 已向量化的 chunk 列表
 */

import type { WorkerRequest, WorkerResponse, IndexRequestIdentityPayload, SearchFilter } from '../types';
import { isWorkerIndexRequest } from '../types';
import { IndexProcessor } from './index-processor';
import { VectraStore, type FileReplacement } from '../adapters/vector-vectra';
import type { IndexVectorStore } from '../adapters/vector-vectra-sharded';
import { AtomicIndexStorage } from '../adapters/atomic-index-storage';
import type { EmbeddingsModel } from 'vectra';
import type { EmbeddingPort } from '../ports/embedding';
import { throwIfEmbeddingAborted } from '../ports/embedding';
import type { EmbedOptions, IndexActivity, IndexActivityStage } from '../core/index-persistence-types';
import { createTokenCounter, TOKEN_BUDGET_RESERVE, type TokenCounter } from '../core/token-counter';
import { DEFAULT_CHUNK_OVERLAP } from './chunker';
import { devLogger } from '../logging/dev-logger';

let processor: IndexProcessor | null = null;

/**
 * 默认块间重叠 — 消息未带 chunkOptions 时的兜底值,与设置默认值一致。
 */

/**
 * 词表内容 — 模型就绪后由主线程注入一次(约 109KB)。
 *
 * 关键路径:词表不进 postMessage 载荷(每条索引消息传一遍太浪费),
 * 改为初始化时传一次,Worker 内部据此构造 token 计数器。
 */
let vocabContent: string | null = null;

/**
 * 当前 token 计数器 — 无词表时按字符上界估算(高估方向,宁可块小也不许截断)。
 */
let counter: TokenCounter = createTokenCounter(null);

/**
 * 设置词表 — 主线程在本地模型就绪、索引开始前调用一次。
 *
 * 关键路径:重建计数器后,已存在的 IndexProcessor 通过闭包读到新计数器,
 * 不需要重新初始化 processor。
 *
 * @param content - vocab.txt 文本;null 表示无本地词表(走估算)
 */
export function setVocabContent(content: string | null): void {
    vocabContent = content;
    counter = createTokenCounter(content);
}

/**
 * 读取当前词表 — 诊断用(未设置时为 null,表示走字符上界估算)。
 */
export function getVocabContent(): string | null {
    return vocabContent;
}

/**
 * 应用消息携带的分块参数 — 主线程把设置项换算成 token 预算后随消息下发。
 *
 * 关键路径:每条 index.* 消息都带最新的分块参数,用户在设置里改了值后
 * 下一次索引即生效,不需要重启 Worker。
 *
 * @param chunkOptions - 消息携带的分块参数;缺失时用默认值兜底
 */
function applyChunkOptions(chunkOptions?: { maxTokens: number; overlapTokens: number }): void {
    if (!processor) return;
    // 关键路径:兜底预算跟着模型输入上限走(与主线程 buildChunkOptions 同一算法),
    // 不用写死数字,免得两处各算一套导致块长不一致。
    const maxTokens = chunkOptions?.maxTokens ?? counter.maxInputTokens - TOKEN_BUDGET_RESERVE;
    const overlapTokens = chunkOptions?.overlapTokens ?? DEFAULT_CHUNK_OVERLAP;
    processor.setChunkOptions(buildChunkOptions(maxTokens, overlapTokens));
}

/**
 * 构造分块参数 — count 是函数,不能过 postMessage,因此在 Worker 内部构造。
 *
 * @param maxTokens - 单块 token 预算
 * @param overlapTokens - 块间重叠 token 数
 * @returns 传给 IndexProcessor 的分块参数
 */
function buildChunkOptions(maxTokens: number, overlapTokens: number) {
    // 关键路径:闭包读模块级 counter,词表更新后无需重建 processor。
    return {
        maxTokens,
        overlapTokens,
        count: (text: string) => counter.count(text),
    };
}

// ==================== 索引运行、活动与访问门(T5)====================

/**
 * 一次索引运行的上下文 — 任务身份、活动序号与取消句柄。
 *
 * 关键路径:活动序号只由真实完成的步骤递增;取消只中止这一次运行,
 * 绝不终止共享 Worker 的其他使用者。
 */
interface IndexRun {
	requestId: string;
	taskId: string;
	epoch: number;
	sequence: number;
	/** 各阶段已完成单位数:块 / 文本 / 文件。 */
	units: { chunk: number; embed: number; persist: number };
	controller: AbortController;
	postEvent?: PostEvent;
}

/**
 * 当前正在处理的索引运行。
 *
 * 关键路径:同一 Worker 内索引请求串行(入口按索引队列调度),因此模块级「当前运行」
 * 足以把存储/嵌入步骤归属到正确的任务;若将来并发索引请求,这里必须改为按实例分派。
 */
let currentIndexRun: IndexRun | null = null;

/** 在途索引运行 — 请求标识 → 上下文。 */
const activeIndexRuns = new Map<string, IndexRun>();

/**
 * 提交与查询的共享访问门。
 *
 * 关键路径(T5 §4):提交阶段持有写保护的时间不得覆盖模型推理,因此门只在真实持久化
 * 步骤上互斥 —— 查询可在长推理期间并行,但不得读到 Vectra 文件事务的中间状态;
 * 提交之间串行(禁止为了支持查询让两个提交重叠);提交开始前等待在途查询读完。
 */
class StoreAccessGate {
	private commitChain: Promise<void> = Promise.resolve();
	private activeReads = 0;
	private commitActive = false;
	private readonly readDrainWaiters: Array<() => void> = [];
	private readonly readAllowWaiters: Array<() => void> = [];

	/** 当前是否处于提交窗口 — 供诊断与入口分道使用。 */
	isCommitActive(): boolean {
		return this.commitActive;
	}

	/** 执行一次查询 — 提交窗口内先等待,窗口关闭后进入。 */
	async runRead<T>(operation: () => Promise<T>): Promise<T> {
		while (this.commitActive) {
			await new Promise<void>((resolve) => { this.readAllowWaiters.push(resolve); });
		}
		this.activeReads += 1;
		try {
			return await operation();
		}
		finally {
			this.activeReads -= 1;
			if (this.activeReads === 0) {
				for (const resolve of this.readDrainWaiters.splice(0)) resolve();
			}
		}
	}

	/** 执行一次提交 — 与其它提交串行,并等待在途查询读完。 */
	async runCommit<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.commitChain;
		let releaseTurn: () => void = () => undefined;
		this.commitChain = new Promise<void>((resolve) => { releaseTurn = resolve; });
		await previous;
		this.commitActive = true;
		try {
			await this.waitForReadDrain();
			return await operation();
		}
		finally {
			this.commitActive = false;
			for (const resolve of this.readAllowWaiters.splice(0)) resolve();
			releaseTurn();
		}
	}

	/** 等待在途查询结束。 */
	private waitForReadDrain(): Promise<void> {
		if (this.activeReads === 0) return Promise.resolve();
		return new Promise<void>((resolve) => { this.readDrainWaiters.push(resolve); });
	}
}

/** 当前处理器的共享访问门 — 与 `processor` 同生命周期。 */
let storeGate = new StoreAccessGate();

/**
 * Worker 侧消息分道策略 — 索引请求串行、只读请求并行、提交窗口内不派发只读。
 *
 * 关键路径:分道规则只依赖协议层信号(真实 `persist` 活动与请求类型),
 * 主线程与 Worker 两端共用同一份清单(`WORKER_*_REQUEST_TYPES`)。
 */
export class WorkerMessageLane {
	private indexTail: Promise<void> = Promise.resolve();
	private readTail: Promise<void> = Promise.resolve();
	private commitWindowOpen = false;
	private deferredReads: Array<() => void> = [];
	/** 当前提交窗口归属的请求。 */
	private persistRequestId: string | null = null;
	/** 该请求已上报的完成提交数。 */
	private persistUnits = 0;

	/** 提交窗口是否打开。 */
	isCommitWindowOpen(): boolean {
		return this.commitWindowOpen;
	}

	/** 显式打开提交窗口 — 供整个请求就是一次存储事务的写请求使用(见 `isWorkerStoreWriteRequest`)。 */
	openCommitWindow(): void {
		this.commitWindowOpen = true;
	}

	/**
	 * 观察一条将要转发的事件 — 只用真实 `persist` 活动维护提交窗口。
	 *
	 * 关键路径(建议 2):完成数**未增长**的 persist 活动表示「本次提交开始」(开窗),
	 * 完成数**增长**的 persist 活动表示「本次提交已落盘」(关窗)。窗口因此由提交完成本身关闭,
	 * 不再等到下一条非 persist 活动或请求终态。
	 */
	observeEvent(message: WorkerResponse): void {
		if (message.type !== 'index.activity') return;
		const activity = message.payload;
		if (activity.stage !== 'persist') {
			this.persistRequestId = null;
			this.persistUnits = 0;
			this.closeCommitWindow();
			return;
		}
		if (activity.requestId !== this.persistRequestId) {
			// 新请求的完成数从 0 起算,首条 persist 活动必然是「提交开始」。
			this.persistRequestId = activity.requestId;
			this.persistUnits = 0;
		}
		if (activity.completedUnits > this.persistUnits) {
			this.persistUnits = activity.completedUnits;
			this.closeCommitWindow();
			return;
		}
		this.commitWindowOpen = true;
	}

	/** 关闭提交窗口并放行等待中的只读请求。 */
	closeCommitWindow(): void {
		if (!this.commitWindowOpen) return;
		this.commitWindowOpen = false;
		for (const dispatch of this.deferredReads.splice(0)) dispatch();
	}

	/** 索引请求(写)串行入队。 */
	scheduleIndex(task: () => Promise<void>): void {
		this.indexTail = this.indexTail.then(task).catch(() => undefined);
	}

	/** 只读请求:提交窗口内延后,窗口关闭后立即派发;只读之间串行,不与索引队列串行。 */
	scheduleRead(task: () => Promise<void>): void {
		const dispatch = (): void => {
			this.readTail = this.readTail.then(task).catch(() => undefined);
		};
		if (this.commitWindowOpen) this.deferredReads.push(dispatch);
		else dispatch();
	}

	/** 终止时清空等待。 */
	clear(): void {
		this.deferredReads.length = 0;
		this.commitWindowOpen = false;
		this.persistRequestId = null;
		this.persistUnits = 0;
	}
}

/**
 * 上报一条活动 — 只允许真实完成的步骤调用。
 *
 * 关键路径:运行已结束(或已换到下一次运行)时不再上报,避免旧运行的活动影响新状态;
 * 活动包只带阶段与数量,不含正文、向量、路径或密钥。
 *
 * @param run - 产生活动的运行。
 * @param stage - 阶段。
 * @param completedUnits - 该阶段已完成单位数。
 */
function emitActivity(run: IndexRun, stage: IndexActivityStage, completedUnits: number): void {
	if (run !== currentIndexRun) return;
	run.sequence += 1;
	const activity: IndexActivity = {
		taskId: run.taskId,
		requestId: run.requestId,
		epoch: run.epoch,
		sequence: run.sequence,
		stage,
		completedUnits,
	};
	run.postEvent?.({ type: 'index.activity', payload: activity });
}

/**
 * 为处理器持有的存储加上「提交窗口 + 查询互斥」。
 *
 * 关键路径:活动与门的观察点必须在**真实 IO 步骤**上(替换向量、删除、写入、重载、查询),
 * 这样不必改动 `IndexProcessor`(T2 文件)就能同时满足:
 * 长推理不阻塞查询、查询不读事务中间状态、两个提交不重叠。
 *
 * 关键路径(B1):`replaceFile` 之外的写路径(`deleteByPath` / `upsert` / `delete` / `reload`)
 * 同样是多步存储事务,必须一并落在门内 —— 只包 `replaceFile` 会让只读车道穿过它们。
 *
 * @param store - 真实存储实例。
 * @param gate - 访问门。
 * @returns 带门与活动上报的存储视图。
 */
function decorateStore(store: IndexVectorStore, gate: StoreAccessGate): IndexVectorStore {
	/**
	 * 统一包装一次真实提交:提交开始上报活动(窗口打开),完成后上报完成数(窗口关闭)。
	 *
	 * 关键路径:窗口开启由真实 IO 步骤产生(提交真的开始了);完成数增长的 persist 活动
	 * 就是「本次提交已落盘」,主线程据此由提交完成本身关闭窗口(建议 2)。
	 */
	const runCommit = async <T>(operation: () => Promise<T>): Promise<T> => {
		const run = currentIndexRun;
		if (run !== null) emitActivity(run, 'persist', run.units.persist);
		const result = await gate.runCommit(async () => {
			// 关键路径:步骤边界检查取消 —— 已撤销的运行不再开始新的磁盘提交。
			if (run !== null) throwIfEmbeddingAborted(run.controller.signal);
			return operation();
		});
		if (run !== null) {
			run.units.persist += 1;
			emitActivity(run, 'persist', run.units.persist);
		}
		return result;
	};
	const replaceFile = (input: FileReplacement) => runCommit(() => store.replaceFile(input));
	// 关键路径(B1):`deleteByPath` 是 beginTransaction → deleteItems → endUpdate 的多步事务,
	// 不经 `replaceFile`;查询穿过它就会读到事务中间状态。
	const deleteByPath = (filePath: string) => runCommit(() => store.deleteByPath(filePath));
	// 关键路径:文档级 upsert/delete 只有单份布局提供;分片布局按文件路径路由,
	// 不承诺文档语义,因此这里按能力包装,缺失时把原始值(undefined)透给调用方。
	const upsert = 'upsert' in store
		? (docId: string, text: string, metadata?: Record<string, unknown>) =>
			runCommit(() => store.upsert(docId, text, metadata))
		: undefined;
	const remove = 'delete' in store
		? (docIds: string[]) => runCommit(() => store.delete(docIds))
		: undefined;
	// 关键路径(B1):`recoverStore` 用的 `reload` 会重建整个内存视图,查询不得与其重叠。
	const reload = () => runCommit(() => store.reload());
	const search = (queryVector: number[], topK: number, filter?: SearchFilter) =>
		gate.runRead(() => store.search(queryVector, topK, filter));
	const status = () => gate.runRead(() => store.status());
	return new Proxy(store, {
		get(target, prop) {
			if (prop === 'replaceFile') return replaceFile;
			if (prop === 'deleteByPath') return deleteByPath;
			if (prop === 'upsert' && upsert !== undefined) return upsert;
			if (prop === 'delete' && remove !== undefined) return remove;
			if (prop === 'reload') return reload;
			if (prop === 'search') return search;
			if (prop === 'status') return status;
			const value: unknown = Reflect.get(target, prop, target);
			if (typeof value !== 'function') return value;
			// 关键路径:其余方法绑定真实存储,避免经代理调用时把 `this` 的写入留在代理对象上。
			const method = value as (...args: unknown[]) => unknown;
			return method.bind(target) as unknown;
		},
	});
}

/**
 * 为嵌入端口加上批次活动与取消信号。
 *
 * 关键路径:分块产出、每个真实完成的嵌入批次都上报活动;取消信号来自当前运行,
 * 只跨主线程侧端口传递,不跨 Worker。
 *
 * @param port - 真实嵌入端口。
 * @returns 带活动上报的端口。
 */
function decorateEmbeddingPort(port: EmbeddingPort): EmbeddingPort {
	return {
		dimensions: port.dimensions,
		modelId: port.modelId,
		embed: async (texts: string[], options?: EmbedOptions): Promise<number[][]> => {
			const run = currentIndexRun;
			if (run === null) return port.embed(texts, options);
			if (texts.length > 0) {
				// 关键路径:chunk 阶段在分块完成、进入嵌入前上报,单位数就是本次产出的块数。
				run.units.chunk += texts.length;
				emitActivity(run, 'chunk', run.units.chunk);
			}
			throwIfEmbeddingAborted(run.controller.signal);
			let lastDone = 0;
			const vectors = await port.embed(texts, {
				...options,
				signal: run.controller.signal,
				onBatchComplete: (done, total) => {
					options?.onBatchComplete?.(done, total);
					if (done <= lastDone) return;
					// 关键路径:只有真实完成的批次才推进 embed 单位数。
					run.units.embed += done - lastDone;
					lastDone = done;
					emitActivity(run, 'embed', run.units.embed);
				},
			});
			return vectors;
		},
	};
}

/** 开始一次索引运行 — 非索引请求返回 null。 */
function beginIndexRun(msg: WorkerRequest & { _requestId?: string }, postEvent?: PostEvent): IndexRun | null {
	if (!isWorkerIndexRequest(msg.type)) return null;
	const payload = msg.payload as IndexRequestIdentityPayload;
	const payloadTaskId = typeof payload.taskId === 'string' && payload.taskId.length > 0 ? payload.taskId : undefined;
	const taskId = payloadTaskId ?? msg._requestId;
	const requestId = msg._requestId ?? taskId;
	if (taskId === undefined || requestId === undefined) return null;
	const epoch = typeof payload.epoch === 'number' && Number.isInteger(payload.epoch) && payload.epoch >= 0 ? payload.epoch : 0;
	const run: IndexRun = {
		requestId,
		taskId,
		epoch,
		sequence: 0,
		units: { chunk: 0, embed: 0, persist: 0 },
		controller: new AbortController(),
		postEvent,
	};
	currentIndexRun = run;
	activeIndexRuns.set(run.requestId, run);
	return run;
}

/** 结束一次索引运行 — 活动序号与取消句柄随之失效。 */
function endIndexRun(run: IndexRun | null): void {
	if (run === null) return;
	if (currentIndexRun === run) currentIndexRun = null;
	activeIndexRuns.delete(run.requestId);
}

/**
 * 取消在途索引运行 — 在批次边界中止,不终止共享 Worker。
 *
 * @param target - 按请求 ID / 任务 ID / epoch 定位;全为 undefined 时不做任何事。
 * @returns 是否命中至少一个在途运行。
 */
export function cancelIndexRun(target: { requestId?: string; taskId?: string; epoch?: number }): boolean {
	if (target.requestId === undefined && target.taskId === undefined && target.epoch === undefined) return false;
	let cancelled = false;
	for (const run of [...activeIndexRuns.values()]) {
		if (target.requestId !== undefined && run.requestId !== target.requestId) continue;
		if (target.taskId !== undefined && run.taskId !== target.taskId) continue;
		if (target.epoch !== undefined && run.epoch !== target.epoch) continue;
		run.controller.abort();
		cancelled = true;
	}
	return cancelled;
}

/**
 * 初始化 Worker 内的 IndexProcessor。
 *
 * 关键路径:`embeddings`(EmbeddingsModel)注入 VectraStore 供 vectra 内部使用;
 * `embeddingPort`(EmbeddingPort)注入 IndexProcessor 供批量 embed chunk 文本使用。
 * Worker 启动期拿不到(没 HTTP、没 import 顶层),所以走主线程传入。
 *
 * @param indexDir - 向量索引目录
 * @param embeddings - vectra 内部使用的嵌入模型
 * @param embeddingPort - 批量 embed 端口
 * @param vocab - 本地词表文本(可选);不给则沿用当前已设置的词表
 *
 * 目录契约:本函数要求 `indexDir` 是**代际目录**(`<索引根>/generations/<generationId>`)。
 * 当前生产装配走 InlineWorker,主线程用 `initProcessorWithStore(generationRoot 上的 store)`,
 * 本函数只由 `src/worker/index.ts` 的 workerData 分支调用 —— 而该分支当前显式不可达
 * (Obsidian 渲染进程不支持 Worker Threads)。若将来启用,主线程必须传代际目录,
 * 不能传 `.index` 根:根上承载 `control.json` / `owner.lock` / `generations/`,清库会误删它们。
 */
export function initProcessor(
    indexDir: string,
    embeddings: EmbeddingsModel,
    embeddingPort: EmbeddingPort,
    vocab?: string | null,
): void {
    // 关键路径(B3):Worker 自建 store 的生产构造点同样注入原子存储 ——
    // 不注入时 `endUpdate` 提交失败只能报「磁盘状态不明」,重载决策失去依据。
    // 代际根就是本 Worker 的索引目录,读写路径都限定在其内。
    const store = new VectraStore(indexDir, {
        embeddings,
        autoInit: true,
        storage: new AtomicIndexStorage({ generationRoot: indexDir }),
    });
    if (vocab !== undefined) setVocabContent(vocab);
    storeGate = new StoreAccessGate();
    processor = new IndexProcessor(
        decorateStore(store, storeGate),
        decorateEmbeddingPort(embeddingPort),
        buildChunkOptions(counter.maxInputTokens - TOKEN_BUDGET_RESERVE, DEFAULT_CHUNK_OVERLAP),
    );
}

/**
 * 用已构造好的 VectraStore 初始化 IndexProcessor。
 *
 * 关键路径:InlineWorker 在主线程运行时复用主线程的 vectraStore,
 * 避免主线程与 Worker 各持一个 VectraStore 同时写同一个 indexDir。
 * `embeddingPort`(EmbeddingPort)由主线程注入,IndexProcessor 用它批量 embed chunk 文本。
 *
 * @param store - 已构造好的 VectraStore
 * @param embeddingPort - 批量 embed 端口
 * @param vocab - 本地词表文本(可选);不给则沿用当前已设置的词表
 */
export function initProcessorWithStore(
    store: IndexVectorStore,
    embeddingPort: EmbeddingPort,
    vocab?: string | null,
): void {
    if (vocab !== undefined) setVocabContent(vocab);
    storeGate = new StoreAccessGate();
    processor = new IndexProcessor(
        decorateStore(store, storeGate),
        decorateEmbeddingPort(embeddingPort),
        buildChunkOptions(counter.maxInputTokens - TOKEN_BUDGET_RESERVE, DEFAULT_CHUNK_OVERLAP),
    );
}

/**
 * 当前处理器持有的存储视图(已加访问门与活动上报)。
 *
 * 关键路径:装配层需要把 T3 日志绑到**同一个**带门的存储上 —— 协调器驱动的
 * `replaceFile` 若绕开访问门,查询就可能读到文件事务的中间状态(T5/B1)。
 * 未初始化处理器时返回 null,调用方回落到主线程自己的存储实例。
 *
 * 说明:该入口只在「主线程内模拟 Worker」(InlineWorker)下有意义;真实 Worker 线程
 * 属于另一个执行环境,主线程拿不到它的存储,此时日志不应由主线程构造。
 *
 * @returns 带门的存储视图;尚未初始化时为 null。
 */
export function currentProcessorStore(): IndexVectorStore | null {
    return processor?.store ?? null;
}

/**
 * Worker 事件推送回调。
 *
 * 关键路径:处理长任务(如全量索引)时,processor 通过此回调主动向主线程推送进度事件,
 * 由入口附上所属请求的 _requestId，进度不作为最终响应。
 *
 * - 真实 Worker Threads: 实现为 `(msg) => parentPort.postMessage(msg)`
 * - InlineWorker: 实现为直接通知 messageListeners(异步)
 */
export type PostEvent = (msg: WorkerResponse) => void;

export async function handleMessage(
    msg: WorkerRequest & { _requestId?: string },
    postEvent?: PostEvent,
): Promise<WorkerResponse> {
    if (!processor) {
        return {
            type: 'error',
            payload: { code: 'NULL_PROCESSOR', message: 'Worker not initialized; call initProcessor(indexDir) first' },
        };
    }

    // 关键路径:索引请求建立运行上下文(任务身份 + 活动序号 + 取消句柄),
    // 存储与嵌入步骤据此把活动盖章到正确的任务;运行结束必须注销,旧活动不得影响新状态。
    const run = beginIndexRun(msg, postEvent);
    // 关键路径:取消信号随请求进入处理器;丢弃它会让「停止索引」只能等整批结束。
    const embedOptions = run === null ? undefined : { signal: run.controller.signal };
    try {
        switch (msg.type) {
            case 'index.status': {
                const status = await processor.status();
                return { type: 'index.status.result', payload: status };
            }

            case 'index.full': {
                const req = msg as Extract<WorkerRequest, { type: 'index.full' }>;
                applyChunkOptions(req.payload.chunkOptions);
                const result = await processor.indexFull(req.payload.files, (progress) => {
                    // 关键路径:每处理完一批文件推送进度，由入口附上所属请求 ID。
                    postEvent?.({ type: 'index.progress', payload: progress });
                }, embedOptions);
                return { type: 'index.done', payload: result };
            }

            case 'index.incremental': {
                const req = msg as Extract<WorkerRequest, { type: 'index.incremental' }>;
                applyChunkOptions(req.payload.chunkOptions);
                const result = await processor.indexIncremental(req.payload.file, (progress) => {
                    postEvent?.({ type: 'index.progress', payload: progress });
                }, embedOptions);
                return { type: 'index.done', payload: result };
            }

            case 'index.batch': {
                const req = msg as Extract<WorkerRequest, { type: 'index.batch' }>;
                applyChunkOptions(req.payload.chunkOptions);
                const result = await processor.indexBatch(req.payload.files, (progress) => {
                    postEvent?.({ type: 'index.progress', payload: progress });
                }, embedOptions);
                return { type: 'index.batch.done', payload: result };
            }

            case 'index.delete': {
                const req = msg as WorkerRequest & { payload: { filePath: string } };
                const count = await processor.indexDelete(req.payload.filePath);
                return { type: 'vector.delete.done', payload: { count } };
            }

            case 'index.cancel': {
                // 关键路径:取消是单项任务语义 —— 只中止对应运行,不终止 Worker,
                // 其他查询与索引请求继续可用;回执仅作诊断。
                const req = msg as Extract<WorkerRequest, { type: 'index.cancel' }>;
                return { type: 'index.cancel.done', payload: { cancelled: cancelIndexRun(req.payload) } };
            }

            case 'vector.search': {
                const req = msg as WorkerRequest & { payload: { queryVector: number[]; topK: number } };
                const results = await processor.vectorSearch(req.payload.queryVector, req.payload.topK);
                return { type: 'vector.search.result', payload: results };
            }

            case 'vector.upsert': {
                const req = msg as WorkerRequest & { payload: { docId: string; text: string; metadata: Record<string, unknown> } };
                // 关键路径:复用 processor 内部已初始化的 store,不走 await import() 临时构造。
                // 分片布局按文件路径路由,没有文档级 upsert;显式失败而不是静默丢写。
                const store = processor.store;
                if (!('upsert' in store)) throw new Error('分片布局不支持按文档 upsert,请改走文件级索引入口');
                await store.upsert(req.payload.docId, req.payload.text, req.payload.metadata);
                return { type: 'vector.upsert.done', payload: { docId: req.payload.docId } };
            }

            case 'vector.delete': {
                const req = msg as WorkerRequest & { payload: { docIds: string[] } };
                // 同上:复用 processor.store;分片布局只提供按路径删除。
                const store = processor.store;
                if (!('delete' in store)) throw new Error('分片布局不支持按文档 delete,请改走 deleteByPath');
                const count = await store.delete(req.payload.docIds);
                return { type: 'vector.delete.done', payload: { count } };
            }

            default: {
                return {
                    type: 'error',
                    payload: { code: 'UNKNOWN_REQUEST', message: `Unknown request type: ${(msg as WorkerRequest).type}` },
                };
            }
        }
    } catch (err) {
        // 修复:单条消息处理异常不应触发 Worker 级 error 事件(那会 reject ALL pending requests)。
        // 捕获后作为 error 响应返回,让调用方自行决定降级策略。
        const message = err instanceof Error ? err.message : String(err);
        devLogger.error('worker', `Handler error for ${msg.type}: ${message}`, err);
        return {
            type: 'error',
            payload: { code: 'HANDLER_ERROR', message },
        };
    }
    finally {
        endIndexRun(run);
    }
}

/**
 * 仅供测试 — 替换全局 processor。
 *
 * 关键路径:测试需要 mock processor.vectorSearch,但 initProcessor/initProcessorWithStore
 * 会重建 VectraStore,不适合纯函数测试。此 helper 让测试直接注入 mock processor,
 * 测试结束传 null 清理,避免污染后续用例。
 */
export function setProcessorForTest(p: IndexProcessor | null): void {
    processor = p;
}
