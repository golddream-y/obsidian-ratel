/**
 * @file src/adapters/embedding-local.ts
 * @description 本地 Embedding 适配器占位 — 模型下载完成前抛未就绪错误,下载完成后代理到 EmbeddingOnnx
 * @module adapters/embedding-local
 * @depends ports/embedding, adapters/embedding-onnx
 *
 * 关键路径:
 * - 插件 onload 时本地模型尚未下载,search-vault 等工具需要一个已就绪的 EmbeddingPort 实例。
 * - 本类作为占位:未注入真实模型时抛 IndexNotReadyError,注入后直接代理到 EmbeddingOnnx。
 */

import type { EmbeddingPort } from '../ports/embedding';

/** 索引未就绪错误(可被工具层识别为 `INDEX_NOT_READY`)。 */
export class IndexNotReadyError extends Error {
    readonly code = 'INDEX_NOT_READY';
    constructor(message = '本地 Embedding 模型未就绪,请先在设置面板触发下载') {
        super(message);
        this.name = 'IndexNotReadyError';
    }
}

/**
 * 本地 Embedding 占位适配器。
 *
 * 设计要点:
 * - 固定模型:bge-small-zh-v1.5,512 维。
 * - 由 ModelManager 在模型下载完成后调用 setEmbedding 注入真实 ONNX 适配器。
 */
export class EmbeddingLocal implements EmbeddingPort {
    readonly modelId = 'local:bge-small-zh-v1.5';
    readonly dimensions = 512;
    private inner: EmbeddingPort | null = null;

    /** 本地模型是否已加载就绪。 */
    get isReady(): boolean {
        return this.inner !== null;
    }

    /**
     * 注入已初始化的真实本地 Embedding 适配器(当前为 EmbeddingOnnx)。
     */
    setEmbedding(embedding: EmbeddingPort): void {
        this.inner = embedding;
    }

    /**
     * 批量生成文本向量。
     *
     * @param texts - 待编码文本数组。
     * @returns 与 texts 等长的向量数组。
     * @throws IndexNotReadyError 模型未就绪。
     */
    async embed(texts: string[]): Promise<number[][]> {
        if (!this.inner) {
            throw new IndexNotReadyError();
        }
        return this.inner.embed(texts);
    }
}
