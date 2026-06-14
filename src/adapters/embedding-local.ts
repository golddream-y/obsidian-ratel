/**
 * @file src/adapters/embedding-local.ts
 * @description 本地 Embedding 适配器 — 基于 @huggingface/transformers 的 ONNX WASM 后端
 * @module adapters/embedding-local
 * @depends @huggingface/transformers, ports/embedding
 */

import type { EmbeddingPort } from '../ports/embedding';

/**
 * 本地 Embedding 端口实现 — 浏览器/Node 端 ONNX 推理。
 *
 * 设计要点:
 * - 模型首次调用时才动态 `import('@huggingface/transformers')`,保证不阻塞插件冷启动。
 * - 推断结果使用 `mean pooling` + `L2 normalize`,与大多数 sentence-transformers 模型训练设置一致。
 * - 业务层 `modelId` 形如 `local:Xenova/bge-small-zh-v1.5`,前缀 `local:` 用于多源路由。
 * - 默认 `dimensions=512` 对应 bge-small-zh 的实际输出维度,显式记录以供向量库做 schema 校验。
 */
export class EmbeddingLocal implements EmbeddingPort {
	private extractor: ((texts: string[], options: Record<string, unknown>) => Promise<{ tolist: () => number[][] }>) | null = null;
	readonly modelId: string;
	readonly dimensions: number;
	private readonly rawModelId: string;

	constructor(modelId = 'Xenova/bge-small-zh-v1.5', dimensions = 512) {
		this.rawModelId = modelId;
		this.modelId = `local:${modelId}`;
		this.dimensions = dimensions;
	}

	/**
	 * 懒加载 transformers pipeline — 首次调用触发模型下载,后续命中内存。
	 *
	 * 关键路径:动态 import 减小主包体积,首次加载在用户首次发起检索时再付代价。
	 * `dtype: 'q8'` 量化加载,模型体积减少约 75%,精度损失可接受。
	 */
	private async init(): Promise<void> {
		if (this.extractor) return;

		const { pipeline } = await import('@huggingface/transformers');
		this.extractor = await pipeline('feature-extraction', this.rawModelId, {
			dtype: 'q8',
			progress_callback: (progress: { status: string; progress?: number; file?: string }) => {
				// 关键路径:首次下载进度反馈,避免用户误以为插件卡死。
				if (progress.status === 'progress' && progress.progress !== undefined) {
					console.log(`Model download: ${progress.file} ${Math.round(progress.progress)}%`);
				}
			},
		}) as unknown as typeof this.extractor;
	}

	/**
	 * 批量生成文本向量。
	 *
	 * 关键路径:`mean pooling + L2 normalize` 与 bge 系列模型训练一致,
	 * 否则余弦相似度检索会显著失真。
	 *
	 * @param texts - 待编码文本数组。
	 * @returns 与 `texts` 等长的向量数组。
	 * @throws 底层 ONNX 推理失败时抛出。
	 */
	async embed(texts: string[]): Promise<number[][]> {
		await this.init();
		const output = await this.extractor!(texts, {
			pooling: 'mean',
			normalize: true,
		});
		return output.tolist();
	}
}
