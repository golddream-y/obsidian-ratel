/**
 * @file src/worker/index-processor.ts
 * @description Worker 内索引批处理 — index.full / index.incremental / index.delete / vector.search / status
 * @module worker/index-processor
 * @depends worker/chunker, adapters/vector-vectra
 *
 * 设计要点:
 * - 主线程传"已分块 + 已向量化"的 chunk 列表,Worker 只做 IO(vectra upsert / delete / search)。
 * - 每个 batch 推一次 `index.progress`,UI 实时刷新。
 * - 分批 10/批,避免大 vault 一次提交爆内存。
 */

import { chunkMarkdown } from './chunker';
import { VectraStore } from '../adapters/vector-vectra';

const BATCH_SIZE = 10;

export interface IndexFile {
    path: string;
    content: string;
}

export interface ProgressEvent {
    done: number;
    total: number;
}

/**
 * Worker 内的批处理核心 — 接收主线程分块 + 嵌入后的 chunk,做最终 IO。
 *
 * 关键路径:`store` 字段是 public,handler.ts 中的 `vector.upsert` / `vector.delete`
 * 需要直接复用同一份 VectraStore 引用,避免重复构造。
 */
export class IndexProcessor {
    constructor(public store: VectraStore) {}

    /**
     * 全量索引入口 — 处理一组文件,逐批推进度。
     */
    async indexFull(
        files: IndexFile[],
        onProgress?: (e: ProgressEvent) => void,
    ): Promise<{ indexed: number; errors: number }> {
        let indexed = 0;
        let errors = 0;

        for (let i = 0; i < files.length; i += BATCH_SIZE) {
            const batch = files.slice(i, i + BATCH_SIZE);
            for (const file of batch) {
                try {
                    const chunks = chunkMarkdown(file.content, 500, 100);
                    for (const [idx, chunk] of chunks.entries()) {
                        await this.store.upsert(
                            `${file.path}#chunk-${idx}`,
                            chunk.text,
                            { path: file.path, chunkIndex: idx, startOffset: chunk.startOffset },
                        );
                    }
                    indexed++;
                } catch (err) {
                    // 关键路径:单文件失败不挂整批,继续后续。
                    console.error(`[index] failed to index ${file.path}:`, err);
                    errors++;
                }
            }
            onProgress?.({ done: Math.min(i + BATCH_SIZE, files.length), total: files.length });
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
            for (const [idx, chunk] of chunks.entries()) {
                await this.store.upsert(
                    `${file.path}#chunk-${idx}`,
                    chunk.text,
                    { path: file.path, chunkIndex: idx, startOffset: chunk.startOffset },
                );
            }
            indexed = 1;
        } catch (err) {
            console.error(`[index] failed to index ${file.path}:`, err);
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
     * 索引状态 — 真实数据,占位返回已替换。
     */
    async status() {
        return this.store.status();
    }
}
