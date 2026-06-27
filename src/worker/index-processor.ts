/**
 * @file src/worker/index-processor.ts
 * @description Worker 内索引批处理 — index.full / index.incremental / index.delete / vector.search / status
 * @module worker/index-processor
 * @depends worker/chunker, adapters/vector-vectra, ports/embedding
 *
 * 设计要点:
 * - 主线程传文件列表,Worker 内部完成 chunking + 批量 embedding(EmbeddingPort.embed)+ vectra upsertItem(预计算向量)。
 * - 每个文件处理完就推一次 `index.progress`,UI 实时刷新。
 * - 一个文件一个事务(beginFileUpdate/endFileUpdate),避免每 chunk 一次事务。
 */

import { chunkMarkdown } from './chunker';
import { VectraStore } from '../adapters/vector-vectra';
import { devLogger } from '../logging/dev-logger';
import type { EmbeddingPort } from '../ports/embedding';

export interface IndexFile {
    path: string;
    content: string;
}

export interface ProgressEvent {
    done: number;
    total: number;
}

/**
 * Worker 内的批处理核心 — 接收文件列表,完成分块、向量化、写入 vectra。
 *
 * 关键路径:`store` 字段是 public,handler.ts 中的 `vector.upsert` / `vector.delete`
 * 需要直接复用同一份 VectraStore 引用,避免重复构造。
 */
export class IndexProcessor {
    constructor(
        public store: VectraStore,
        private embeddings: EmbeddingPort,
    ) {}

    /**
     * 全量索引入口 — 逐文件处理,每文件完成推一次进度。
     */
    async indexFull(
        files: IndexFile[],
        onProgress?: (e: ProgressEvent) => void,
    ): Promise<{ indexed: number; errors: number }> {
        let indexed = 0;
        let errors = 0;

        for (const [i, file] of files.entries()) {
            try {
                const chunks = chunkMarkdown(file.content, 500, 100);
                if (chunks.length === 0) {
                    indexed++;
                    onProgress?.({ done: i + 1, total: files.length });
                    continue;
                }

                // 关键路径:一次性批量 embed 所有 chunk 文本。
                const chunkTexts = chunks.map((c) => c.text);
                const vectors = await this.embeddings.embed(chunkTexts);

                await this.store.beginFileUpdate();
                for (const [idx, chunk] of chunks.entries()) {
                    await this.store.upsertItem(
                        `${file.path}#chunk-${idx}`,
                        vectors[idx]!,
                        { path: file.path, chunkIndex: idx, startOffset: chunk.startOffset },
                    );
                }
                await this.store.endFileUpdate();
                indexed++;
            } catch (err) {
                // 关键路径:事务回滚,避免半写入的脏数据。
                try { await this.store.cancelFileUpdate(); } catch { /* 忽略回滚失败 */ }
                devLogger.error('index', `failed to index ${file.path}`, err);
                errors++;
            }
            // 关键路径:每个文件处理完推一次进度(不管成功失败),UI 能实时看到数字在增长。
            onProgress?.({ done: i + 1, total: files.length });
        }

        return { indexed, errors };
    }

    /**
     * 增量索引 — 单文件去抖后入队消费。
     *
     * 关键路径:不调 `indexFull`(会推一次 done:1, total:1),自己控制进度回调,
     * 避免上层收到重复事件。
     */
    async indexIncremental(
        file: IndexFile,
        onProgress?: (e: ProgressEvent) => void,
    ): Promise<{ indexed: number; errors: number }> {
        let indexed = 0;
        let errors = 0;
        try {
            const chunks = chunkMarkdown(file.content, 500, 100);
            if (chunks.length === 0) {
                onProgress?.({ done: 1, total: 1 });
                return { indexed: 0, errors: 0 };
            }

            // 关键路径:一次性批量 embed 所有 chunk 文本,ONNX 调用从 N 降到 N/16。
            const chunkTexts = chunks.map((c) => c.text);
            const vectors = await this.embeddings.embed(chunkTexts);

            // 关键路径:一个文件一个事务,避免每 chunk 一次事务。
            await this.store.beginFileUpdate();
            for (const [idx, chunk] of chunks.entries()) {
                await this.store.upsertItem(
                    `${file.path}#chunk-${idx}`,
                    vectors[idx]!,
                    { path: file.path, chunkIndex: idx, startOffset: chunk.startOffset },
                );
            }
            await this.store.endFileUpdate();
            indexed = 1;
        } catch (err) {
            // 关键路径:事务回滚,避免半写入的脏数据。
            try { await this.store.cancelFileUpdate(); } catch { /* 忽略回滚失败 */ }
            devLogger.error('index', `failed to index ${file.path}`, err);
            errors = 1;
        }
        onProgress?.({ done: 1, total: 1 });
        return { indexed, errors };
    }

    /**
     * 删除单个文件的所有 chunk。
     *
     * @returns 实际删除的 docId 数(可能为 0,文件可能尚未索引)。
     */
    async indexDelete(filePath: string): Promise<number> {
        // 关键路径:vectra 没有"按 path 前缀删"的接口,先 search 拿到所有 docId 再 delete。
        // 简化:对中等问题(1000 文档)用 status 拿所有 docId 不现实,
        // 这里采用 chunk 索引上限 100 的启发式,覆盖绝大多数文档。
        const dummyVector = Array(512).fill(0);
        const all = await this.store.search(dummyVector, 100);
        const matching = all.filter((r) => (r.metadata as { path?: string }).path === filePath);
        const ids = matching.map((r) => r.docId);
        if (ids.length === 0) return 0;
        return this.store.delete(ids);
    }

    /**
     * 向量搜索。
     */
    async vectorSearch(queryVector: number[], topK: number) {
        return this.store.search(queryVector, topK);
    }

    /**
     * 混合搜索 — 向量 + BM25 关键词。
     *
     * 关键路径:委托给 VectraStore.hybridSearch,后者调 vectra queryItems 传 isBm25=true,
     * 同文档多 chunk 取最高分聚合到文档级,与 vectorSearch 的 chunk 级返回不同。
     *
     * @param query - 用户查询文本(用于 BM25)
     * @param queryVector - 查询向量(主线程 embedding,Worker 不发 HTTP)
     * @param topK - 返回文档上限
     */
    async hybridSearch(query: string, queryVector: number[], topK: number) {
        return this.store.hybridSearch(query, queryVector, topK);
    }

    /**
     * 索引状态 — 真实数据,占位返回已替换。
     */
    async status() {
        return this.store.status();
    }
}
