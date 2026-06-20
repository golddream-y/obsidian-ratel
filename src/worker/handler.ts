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

let processor: IndexProcessor | null = null;

/**
 * 初始化 Worker 内的 IndexProcessor。
 *
 * 关键路径:`embeddings` 必须由调用方注入 ONNX FeatureExtractor(测试用 stub),
 * Worker 启动期拿不到(没 HTTP、没 import 顶层),所以走主线程传入。
 */
export function initProcessor(indexDir: string, embeddings: EmbeddingsModel): void {
    const store = new VectraStore(indexDir, { embeddings, autoInit: true });
    processor = new IndexProcessor(store);
}

/**
 * 用已构造好的 VectraStore 初始化 IndexProcessor。
 *
 * 关键路径:InlineWorker 在主线程运行时复用主线程的 vectraStore,
 * 避免主线程与 Worker 各持一个 VectraStore 同时写同一个 indexDir。
 */
export function initProcessorWithStore(store: VectraStore): void {
    processor = new IndexProcessor(store);
}

export async function handleMessage(msg: WorkerRequest & { _requestId?: string }): Promise<WorkerResponse> {
    if (!processor) {
        return {
            type: 'error',
            payload: { code: 'NULL_PROCESSOR', message: 'Worker not initialized; call initProcessor(indexDir) first' },
        };
    }

    switch (msg.type) {
        case 'index.status': {
            const status = await processor.status();
            return { type: 'index.status.result', payload: status };
        }

        case 'index.full': {
            const req = msg as WorkerRequest & { payload: { files: Array<{ path: string; content: string }> } };
            const result = await processor.indexFull(req.payload.files);
            return { type: 'index.done', payload: result };
        }

        case 'index.incremental': {
            const req = msg as WorkerRequest & { payload: { file: { path: string; content: string } } };
            const result = await processor.indexIncremental(req.payload.file);
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
}
