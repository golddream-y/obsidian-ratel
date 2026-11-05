/**
 * @file src/worker/index-processor.ts
 * @description Worker 内索引批处理 — index.full / index.incremental / index.delete / vector.search / status
 * @module worker/index-processor
 * @depends worker/chunker, adapters/vector-vectra, ports/embedding
 *
 * 设计要点:
 * - 主线程传文件列表,Worker 内部完成 chunking + 批量 embedding(EmbeddingPort.embed),
 *   再以 `replaceFile` 把预计算向量提交为「一个文件的完整事务」。
 * - 每个文件处理完就推一次 `index.progress`,UI 实时刷新。
 * - 三个索引入口(`indexFull` / `indexIncremental` / `indexBatch`)统一走 `reembedFile` →
 *   `replaceFile`:先推理、再在同一事务里删除旧块并写入新块,单文件只落盘一次。
 *   空内容同样提交「零块替换」,避免旧块残留成可检索的幽灵片段。
 * - 提交失败会让存储进入需重载状态;入口在失败分支自动 `reload()`,重载失败则中止本批并如实计数。
 */

import { randomUUID } from 'node:crypto';
import { chunkMarkdown, type Chunk, type ChunkOptions } from './chunker';
import type { PreparedBlock } from '../adapters/vector-vectra';
import type { IndexVectorStore } from '../adapters/vector-vectra-sharded';
import { devLogger } from '../logging/dev-logger';
import type { EmbeddingPort, EmbedOptions } from '../ports/embedding';

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
 * 需要直接复用同一份向量存储引用,避免重复构造。存储按代际布局可能是单份或分片,
 * 本类只依赖两者共有的方法语义。
 *
 * 关键路径:分块参数(`chunkOptions`)由构造时注入,三个索引入口统一走 `this.chunk()`,
 * 不再硬编码 500/100 —— 设置项才真正生效。
 */
export class IndexProcessor {
    constructor(
        public store: IndexVectorStore,
        private embeddings: EmbeddingPort,
        private chunkOptions: ChunkOptions,
    ) {}

    /**
     * 更新分块参数 — 每条 `index.*` 消息可携带最新设置(用户改设置后无需重载)。
     *
     * @param options - 新的分块参数(token 预算 + 重叠 + 计数函数)
     */
    setChunkOptions(options: ChunkOptions): void {
        this.chunkOptions = options;
    }

    /**
     * 按当前分块参数切块 — indexFull / indexIncremental / indexBatch 三处统一入口。
     *
     * @param content - 原始 Markdown 文本
     * @returns 块数组(空文档返回空数组)
     */
    private chunk(content: string): Chunk[] {
        return chunkMarkdown(content, this.chunkOptions);
    }

    /**
     * 全量索引入口 — 逐文件处理,每文件完成推一次进度。
     *
     * 关键路径(B1):每个文件都走 `reembedFile` 的「单事务替换」,不再逐块 upsert。
     * 旧实现只写新块、从不删除旧块,文件变短或变空后旧块仍可被检索;
     * 空内容也必须提交零块替换,否则清单已更新而索引仍留着旧块。
     */
    async indexFull(
        files: IndexFile[],
        onProgress?: (e: ProgressEvent) => void,
        options?: EmbedOptions,
    ): Promise<{ indexed: number; errors: number }> {
        let indexed = 0;
        let errors = 0;

        for (const [i, file] of files.entries()) {
            try {
                await this.reembedFile(file.path, file.content, options);
                indexed++;
            } catch (err) {
                devLogger.error('index', `failed to index ${file.path}`, err);
                errors++;
                // 关键路径(B3b):提交失败会把存储置为需重载状态;不重载则同批后续文件全抛 reload-required。
                if (!(await this.recoverStore())) {
                    // 重载失败:剩余文件无法处理,一并计入 errors,避免上层把未处理当成已索引。
                    errors += files.length - i - 1;
                    onProgress?.({ done: i + 1, total: files.length });
                    return { indexed, errors };
                }
            }
            // 关键路径:每个文件处理完推一次进度(不管成功失败),UI 能实时看到数字在增长。
            onProgress?.({ done: i + 1, total: files.length });
        }

        return { indexed, errors };
    }

    /**
     * 增量索引 — 单文件去抖后入队消费。
     *
     * 关键路径:
     * - 不调 `indexFull`(会推一次 done:1, total:1),自己控制进度回调,
     *   避免上层收到重复事件。
     * - 与 `indexFull` / `indexBatch` 共用 `reembedFile`:删除与插入在同一事务内,
     *   文件变短/变空都不会留下旧块,`chunkCount` 与真实块数一致。
     */
    async indexIncremental(
        file: IndexFile,
        onProgress?: (e: ProgressEvent) => void,
        options?: EmbedOptions,
    ): Promise<{ indexed: number; errors: number; chunkCount: number }> {
        let indexed = 0;
        let errors = 0;
        // 关键路径:chunkCount 在 try 外声明,失败路径也能返回(此时为 0,表示没有可用块数)。
        let chunkCount = 0;
        try {
            chunkCount = await this.reembedFile(file.path, file.content, options);
            indexed = 1;
        } catch (err) {
            devLogger.error('index', `failed to index ${file.path}`, err);
            errors = 1;
            chunkCount = 0;
            // 关键路径(B3b):单文件失败同样尝试恢复,否则下一次增量会被 reload-required 挡住。
            if (!(await this.recoverStore())) {
                onProgress?.({ done: 1, total: 1 });
                return { indexed: 0, errors, chunkCount };
            }
        }
        onProgress?.({ done: 1, total: 1 });
        return { indexed, errors, chunkCount };
    }

    /**
     * 批量索引 — smart reindex 的 toAdd + toUpdate 路径。
     *
     * 关键路径:
     * - 每个文件先分块与推理,再用 `replaceFile` 在同一个事务里删除旧块并写入新块;
     *   推理失败时旧版本完整保留,单文件提交只落盘一次。
     * - 返回每文件的 chunkCount,供 manifest 记录
     * - 单文件失败不挂整批(记入 errors 继续);存储进入需重载状态时先 `reload()`。
     *
     * @param files - 待 embed 的文件列表(已由主线程读好 content)
     * @param onProgress - 进度回调(每文件一次)
     * @returns `{ indexed, errors, chunkCounts }` — 成功/失败文件数 + 每文件 chunk 数
     */
    async indexBatch(
        files: IndexFile[],
        onProgress?: (e: ProgressEvent) => void,
        options?: EmbedOptions,
    ): Promise<{ indexed: number; errors: number; chunkCounts: Record<string, number> }> {
        let indexed = 0;
        let errors = 0;
        const chunkCounts: Record<string, number> = {};

        for (const [i, file] of files.entries()) {
            try {
                const count = await this.reembedFile(file.path, file.content, options);
                chunkCounts[file.path] = count;
                indexed++; // 空文件也算处理成功
            } catch (err) {
                devLogger.error('index', `failed to indexBatch ${file.path}`, err);
                errors++;
                // 关键路径(I4):首个失败会让存储进入需重载状态;不重载则同批后续文件全抛 reload-required。
                if (!(await this.recoverStore())) {
                    // 重载失败:中止本批,剩余文件计入 errors 并保留已完成的 chunkCounts,
                    // 由上层按「部分失败」处理,不静默当成全部成功。
                    errors += files.length - i - 1;
                    onProgress?.({ done: i + 1, total: files.length });
                    return { indexed, errors, chunkCounts };
                }
            }
            onProgress?.({ done: i + 1, total: files.length });
        }

        return { indexed, errors, chunkCounts };
    }

    /**
     * 单文件 reembed — 先分块与推理,再一次性替换该路径的全部块。
     *
     * 关键路径:
     * - 三个索引入口共用本方法:删除与插入在 `replaceFile` 的同一个事务内完成,
     *   单文件提交只落盘一次,文件变短/变空都不会残留旧块。
     * - 禁止先删后推理:推理失败时旧版本必须完整保留,否则会丢数据。
     * - 空文件也提交零块版本(完成删除)。
     * - 每个块带上本次提交的 `commitId`,供完成记录核对。
     *
     * @returns 该文件的 chunk 数(0 表示空文件)
     */
    private async reembedFile(filePath: string, content: string, options?: EmbedOptions): Promise<number> {
        const chunks = this.chunk(content);
        // 关键路径:推理完成前不触碰磁盘 —— 这是「推理失败不丢旧版本」的唯一保证。
        // 关键路径:取消信号与批次回调必须随请求进入嵌入端口,否则暂停要等整批跑完。
        const vectors = chunks.length === 0 ? [] : await this.embeddings.embed(chunks.map((c) => c.embedText), options);
        if (vectors.length !== chunks.length) {
            throw new Error(`嵌入端口返回 ${vectors.length} 个向量,与块数 ${chunks.length} 不一致:${filePath}`);
        }

        const commitId = randomUUID();
        const blocks: PreparedBlock[] = [];
        for (const [idx, chunk] of chunks.entries()) {
            const vector = vectors[idx];
            if (vector === undefined) {
                throw new Error(`缺少第 ${idx} 块的向量:${filePath}`);
            }
            blocks.push({
                id: `${filePath}#chunk-${idx}`,
                vector,
                metadata: {
                    path: filePath,
                    chunkIndex: idx,
                    startOffset: chunk.startOffset,
                    // 关键路径:结构信息随块落库,供上层扩展页号与表头。
                    prefix: chunk.prefix,
                    headingPath: chunk.headingPath,
                },
            });
        }

        await this.store.replaceFile({ path: filePath, commitId, blocks });
        return chunks.length;
    }

    /**
     * 失败后尝试自动恢复存储 — 提交失败会把存储置为需重载状态,不重载则后续写入全被拒绝。
     *
     * 关键路径(B3b):
     * - 只有存储确实处于需重载状态时才 `reload()`;普通推理/输入校验失败不触发重建。
     * - 重载失败返回 false,由调用方中止本批并如实计数,不静默继续。
     *
     * @returns 已恢复可继续写入为 true;无法恢复为 false。
     */
    private async recoverStore(): Promise<boolean> {
        if (!this.store.isReloadRequired()) return true;
        try {
            await this.store.reload();
            return true;
        } catch (err) {
            devLogger.error('index', '重载索引存储失败,中止本批', err);
            return false;
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
     * 索引状态 — 真实数据,占位返回已替换。
     */
    async status() {
        return this.store.status();
    }
}
