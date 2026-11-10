/**
 * @file src/core/query-embedding.ts
 * @description 查询嵌入端口 — 主路径带超时，失败时本次降级到备用实现
 * @module core/query-embedding
 * @depends ports/embedding
 *
 * 关键路径:
 * - 查询是**交互路径**：工具层 60 秒就判超时，不能让用户干等。
 * - 因此主路径必须带一个远小于 60 秒的等待上限，到点即降级，
 *   而不是把整条检索链路拖到超时。
 * - 等待由本层**主动结束**：端口契约里 signal 是可选的协作信号，
 *   不响应取消的实现（崩溃的 Worker、卡住的会话）会让 await 永久挂起，
 *   只 abort 不 race 等于没有超时。
 * - 降级只影响**这一次调用**：备用实现按需构建，不预先常驻 ——
 *   常驻一份完整推理会话会和主执行路径争内存与 CPU，实测把纯推理拖慢十几倍。
 * - 用户主动取消不是故障信号，不得触发降级（否则一次取消就会把重资源建起来）。
 */

import { createEmbedAbortError, type EmbeddingPort } from '../ports/embedding';

/**
 * 后台计时器宿主 — 查询超时跟随本次调用,不绑定某个 popout 焦点窗口;
 * renderer 内 globalThis 即主窗口全局,Node 测试中同样可用。
 */
const backgroundTimers = globalThis;

/** 构造参数。 */
export interface QueryEmbeddingDeps {
	/** 向量维度。 */
	dimensions: number;
	/** 模型标识（用于日志与缓存键）。 */
	modelId: string;
	/**
	 * 主路径解析器 — **每次调用时求值**。
	 *
	 * 关键路径:Worker 代理在 `onLayoutReady` 才创建，而查询器在 `onload` 阶段装配。
	 * 若在构造时取值，代理此刻为 undefined，会永久绑定到备用实现。
	 * 返回 undefined 表示查询本来就跑在主线程，不需要超时与降级。
	 */
	primary?: () => EmbeddingPort | undefined;
	/** 降级目标 — 通常是主线程本地会话，按需构建。 */
	fallback: EmbeddingPort;
	/** 主路径等待上限(ms)。 */
	timeoutMs: number;
	/** 降级发生时的回调，用于记录诊断；不得用于用户可见提示。 */
	onFallback?: (error: unknown) => void;
}

/**
 * 构造查询专用嵌入端口。
 *
 * @param deps - 主/备实现与超时预算。
 * @returns 带超时降级的嵌入端口。
 */
export function createQueryEmbeddingPort(deps: QueryEmbeddingDeps): EmbeddingPort {
	return {
		dimensions: deps.dimensions,
		modelId: deps.modelId,
		embed: async (texts, options) => {
			// 空输入不值得建会话，也不该因为主路径缺失就去下载运行时。
			if (texts.length === 0) return [];
			const primary = deps.primary?.();
			if (primary === undefined) return deps.fallback.embed(texts, options);

			const outward = options?.signal;
			const controller = new AbortController();
			const forwardAbort = (): void => controller.abort();
			outward?.addEventListener('abort', forwardAbort, { once: true });

			let timer: ReturnType<typeof setTimeout> | undefined;
			let onOutwardAbort: (() => void) | undefined;
			/**
			 * 主动结束等待的信号源。
			 *
			 * 关键路径:只 abort 不 race 时，不响应取消的实现会让 await 永久挂起 ——
			 * 超时形同虚设，用户照样要等到工具层的 60 秒上限。
			 */
			const stopped = new Promise<never>((_, reject) => {
				timer = backgroundTimers.setTimeout(() => {
					controller.abort();
					reject(new Error(`查询嵌入等待超时(${deps.timeoutMs}ms)`));
				}, deps.timeoutMs);
				if (outward !== undefined) {
					onOutwardAbort = (): void => reject(createEmbedAbortError());
					outward.addEventListener('abort', onOutwardAbort, { once: true });
				}
			});

			try {
				return await Promise.race([primary.embed(texts, { ...options, signal: controller.signal }), stopped]);
			} catch (error) {
				// 关键路径:调用方自己取消时按取消返回，不能把降级目标一并叫醒。
				if (outward?.aborted === true) throw createEmbedAbortError();
				deps.onFallback?.(error);
				return await deps.fallback.embed(texts, options);
			} finally {
				if (timer !== undefined) backgroundTimers.clearTimeout(timer);
				if (onOutwardAbort !== undefined) outward?.removeEventListener('abort', onOutwardAbort);
				outward?.removeEventListener('abort', forwardAbort);
			}
		},
	};
}
