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
     * 批量索引 — smart reindex 的 toAdd + toUpdate 路径。
     *
     * 关键路径:
     * - 每个文件 reembed 前先 deleteByPath,防止文件变短时旧 chunk 残留
     * - 返回每文件的 chunkCount,供 manifest 记录
     * - 单文件失败不挂整批(记入 errors 继续)
     *
     * @param files - 待 embed 的文件列表(已由主线程读好 content)
     * @param onProgress - 进度回调(每文件一次)
     * @returns `{ indexed, errors, chunkCounts }` — 成功/失败文件数 + 每文件 chunk 数
     */
    async indexBatch(
        files: IndexFile[],
        onProgress?: (e: ProgressEvent) => void,
    ): Promise<{ indexed: number; errors: number; chunkCounts: Record<string, number> }> {
        let indexed = 0;
        let errors = 0;
        const chunkCounts: Record<string, number> = {};

        for (const [i, file] of files.entries()) {
            try {
                const count = await this.reembedFile(file.path, file.content);
                chunkCounts[file.path] = count;
                indexed++; // 空文件也算处理成功
            } catch (err) {
                devLogger.error('index', `failed to indexBatch ${file.path}`, err);
                errors++;
            }
            onProgress?.({ done: i + 1, total: files.length });
        }

        return { indexed, errors, chunkCounts };
    }

    /**
     * 单文件 reembed — 先删旧 chunk 再重插。
     *
     * 关键路径:deleteByPath 是 chunk 残留修复的根治手段。
     * 一个文件一个事务,失败时 cancelFileUpdate 回滚。
     *
     * @returns 该文件的 chunk 数(0 表示空文件)
     */
    private async reembedFile(filePath: string, content: string): Promise<number> {
        // 关键路径:先删旧 chunk,防止文件变短时残留。
        await this.store.deleteByPath(filePath);

        const chunks = chunkMarkdown(content, 500, 100);
        if (chunks.length === 0) return 0;

        const chunkTexts = chunks.map((c) => c.text);
        const vectors = await this.embeddings.embed(chunkTexts);

        await this.store.beginFileUpdate();
        try {
            for (const [idx, chunk] of chunks.entries()) {
                await this.store.upsertItem(
                    `${filePath}#chunk-${idx}`,
                    vectors[idx]!,
                    { path: filePath, chunkIndex: idx, startOffset: chunk.startOffset },
                );
            }
            await this.store.endFileUpdate();
            return chunks.length;
        } catch (err) {
            try { await this.store.cancelFileUpdate(); } catch { /* 忽略回滚失败 */ }
            throw err;
        }
    }

    /**
     * 删除单个文件的所有 chunk。
     *
     * @returns 实际删除的 chunk 数(可能为 0,文件可能尚未索引)。
     */
    async indexDelete(filePath: string): Promise<number> {
        // 关键路径:修复 ghost chunk bug — store.delete 走 vectra deleteDocument(uri),
        // 后者依赖 catalog(uriToId 映射);而 upsertItem 绕过 upsertDocument 不写 catalog,
        // deleteDocument 因查不到 URI 提前返回,实际不删任何 chunk,导致文件删除后残留幽灵 chunk。
        // 改用 deleteByPath:按 metadata.path 过滤后直接调 deleteItems(item.id),绕过 catalog 查找。
        return this.store.deleteByPath(filePath);
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
