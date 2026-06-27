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

import type { WorkerRequest, WorkerResponse } from '../types';
import { IndexProcessor } from './index-processor';
import { VectraStore } from '../adapters/vector-vectra';
import type { EmbeddingsModel } from 'vectra';
import type { EmbeddingPort } from '../ports/embedding';
import { devLogger } from '../logging/dev-logger';

let processor: IndexProcessor | null = null;

/**
 * 初始化 Worker 内的 IndexProcessor。
 *
 * 关键路径:`embeddings`(EmbeddingsModel)注入 VectraStore 供 vectra 内部使用;
 * `embeddingPort`(EmbeddingPort)注入 IndexProcessor 供批量 embed chunk 文本使用。
 * Worker 启动期拿不到(没 HTTP、没 import 顶层),所以走主线程传入。
 */
export function initProcessor(indexDir: string, embeddings: EmbeddingsModel, embeddingPort: EmbeddingPort): void {
    const store = new VectraStore(indexDir, { embeddings, autoInit: true });
    processor = new IndexProcessor(store, embeddingPort);
}

/**
 * 用已构造好的 VectraStore 初始化 IndexProcessor。
 *
 * 关键路径:InlineWorker 在主线程运行时复用主线程的 vectraStore,
 * 避免主线程与 Worker 各持一个 VectraStore 同时写同一个 indexDir。
 * `embeddingPort`(EmbeddingPort)由主线程注入,IndexProcessor 用它批量 embed chunk 文本。
 */
export function initProcessorWithStore(store: VectraStore, embeddingPort: EmbeddingPort): void {
    processor = new IndexProcessor(store, embeddingPort);
}

/**
 * Worker 事件推送回调。
 *
 * 关键路径:处理长任务(如全量索引)时,processor 通过此回调主动向主线程推送进度事件,
 * 不走 request-response 链路(无 _requestId)。
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

    try {
        switch (msg.type) {
            case 'index.status': {
                const status = await processor.status();
                return { type: 'index.status.result', payload: status };
            }

            case 'index.full': {
                const req = msg as WorkerRequest & { payload: { files: Array<{ path: string; content: string }> } };
                const result = await processor.indexFull(req.payload.files, (progress) => {
                    // 关键路径:每处理完一批文件推送一次进度事件,不带 _requestId(广播式)。
                    postEvent?.({ type: 'index.progress', payload: progress });
                });
                return { type: 'index.done', payload: result };
            }

            case 'index.incremental': {
                const req = msg as WorkerRequest & { payload: { file: { path: string; content: string } } };
                const result = await processor.indexIncremental(req.payload.file, (progress) => {
                    postEvent?.({ type: 'index.progress', payload: progress });
                });
                return { type: 'index.done', payload: result };
            }

            case 'index.delete': {
                const req = msg as WorkerRequest & { payload: { filePath: string } };
                const count = await processor.indexDelete(req.payload.filePath);
                return { type: 'vector.delete.done', payload: { count } };
            }

            case 'vector.search': {
                const req = msg as WorkerRequest & { payload: { queryVector: number[]; topK: number } };
                const results = await processor.vectorSearch(req.payload.queryVector, req.payload.topK);
                return { type: 'vector.search.result', payload: results };
            }

            case 'hybrid.search': {
                // 关键路径:queryVector 由主线程 embedding 后传入(Worker 不发 HTTP),query 用于 BM25。
                const req = msg as WorkerRequest & { payload: { query: string; queryVector: number[]; topK: number } };
                const results = await processor.hybridSearch(req.payload.query, req.payload.queryVector, req.payload.topK);
                return { type: 'hybrid.search.result', payload: results };
            }

            case 'vector.upsert': {
                const req = msg as WorkerRequest & { payload: { docId: string; text: string; metadata: Record<string, unknown> } };
                // 关键路径:复用 processor 内部已初始化的 store,不走 await import() 临时构造。
                await processor.store.upsert(req.payload.docId, req.payload.text, req.payload.metadata);
                return { type: 'vector.upsert.done', payload: { docId: req.payload.docId } };
            }

            case 'vector.delete': {
                const req = msg as WorkerRequest & { payload: { docIds: string[] } };
                // 同上:复用 processor.store。
                const count = await processor.store.delete(req.payload.docIds);
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
}

/**
 * 仅供测试 — 替换全局 processor。
 *
 * 关键路径:测试需要 mock processor.hybridSearch,但 initProcessor/initProcessorWithStore
 * 会重建 VectraStore,不适合纯函数测试。此 helper 让测试直接注入 mock processor,
 * 测试结束传 null 清理,避免污染后续用例。
 */
export function setProcessorForTest(p: IndexProcessor | null): void {
    processor = p;
}
