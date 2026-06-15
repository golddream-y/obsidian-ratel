/**
 * @file src/adapters/embedding-local.ts
 * @description 本地 Embedding 适配器 — 接受 ModelManager 注入的 transformers pipeline
 * @module adapters/embedding-local
 * @depends ports/embedding
 *
 * 关键路径:
 * - 不再懒加载:由 ModelManager 负责下载 + 构造 pipeline,本类只接注入的 extractor
 * - 未就绪时返回 `INDEX_NOT_READY` 错误(抛结构化对象),不抛 Error,便于上层工具统一处理
 */

import type { EmbeddingPort } from '../ports/embedding';

type FeatureExtractor = (texts: string[], options: Record<string, unknown>) => Promise<{ tolist: () => number[][] }>;

/** 索引未就绪错误(可被工具层识别为 `INDEX_NOT_READY`)。 */
export class IndexNotReadyError extends Error {
    readonly code = 'INDEX_NOT_READY';
    constructor(message = '本地 Embedding 模型未就绪,请先在设置面板触发下载') {
        super(message);
        this.name = 'IndexNotReadyError';
    }
}

export class EmbeddingLocal implements EmbeddingPort {
    private extractor: FeatureExtractor | null = null;
    readonly modelId: string;
    readonly dimensions: number;
    private readonly rawModelId: string;

    constructor(modelId = 'Xenova/bge-small-zh-v1.5', dimensions = 512) {
        this.rawModelId = modelId;
        this.modelId = `local:${modelId}`;
        this.dimensions = dimensions;
    }

    /**
     * 由 ModelManager 在模型下载完成后调用,注入 transformers pipeline extractor。
     *
     * 关键路径:不在本类内自启动,所有加载逻辑在 ModelManager,
     * 保证状态机统一(Checking / Downloading / Ready)。
     */
    setExtractor(extractor: FeatureExtractor): void {
        this.extractor = extractor;
    }

    /**
     * 批量生成文本向量。
     *
     * @param texts - 待编码文本数组。
     * @returns 与 `texts` 等长的向量数组。
     * @throws IndexNotReadyError 模型未就绪。
     */
    async embed(texts: string[]): Promise<number[][]> {
        if (!this.extractor) {
            throw new IndexNotReadyError();
        }
        const output = await this.extractor(texts, {
            pooling: 'mean',
            normalize: true,
        });
        return output.tolist();
    }
}
