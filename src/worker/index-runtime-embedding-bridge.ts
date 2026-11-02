/**
 * @file src/worker/index-runtime-embedding-bridge.ts
 * @description 把既有嵌入端口接成索引线程的模型通道 — 统一批次与取消语义
 * @module src/worker/index-runtime-embedding-bridge
 *
 * 关键路径:
 * - 索引线程只发「一批文本 + 工作类型」,不关心模型是本地 ONNX 还是远端 API。
 * - 取消信号由宿主侧端口负责;桥接层不吞掉取消错误,也不把它翻译成空结果。
 * - 返回维度必须与端口声明的维度一致,否则直接失败 —— 维度不符会让检索静默错乱。
 */

import type { EmbeddingPort } from '../ports/embedding';
import type { EmbedWorkload } from '../core/index-embedding-arbiter';

/** 桥接选项。 */
export interface EmbeddingBridgeOptions {
	/** 每批最多文本条数;仲裁器与端口都按这个上界切。 */
	maxBatchSize?: number;
	/** 查询工作是否需要优先通道(仅用于观测,不影响端口语义)。 */
	onCall?: (workload: EmbedWorkload, texts: readonly string[]) => void;
}

/**
 * 构造索引线程可用的嵌入函数。
 * @param port 既有嵌入端口
 * @param options 批次与观测
 */
export function createEmbeddingBridge(
	port: EmbeddingPort,
	options: EmbeddingBridgeOptions = {},
): (texts: readonly string[], workload: EmbedWorkload) => Promise<number[][]> {
	const maxBatchSize = options.maxBatchSize ?? 8;

	return async (texts, workload) => {
		if (texts.length === 0) return [];
		const vectors: number[][] = [];
		for (let offset = 0; offset < texts.length; offset += maxBatchSize) {
			const slice = [...texts.slice(offset, offset + maxBatchSize)];
			options.onCall?.(workload, slice);
			const result = await port.embed(slice);
			if (result.length !== slice.length) {
				throw new Error(`嵌入端口返回 ${result.length} 条,与请求 ${slice.length} 条不一致`);
			}
			for (const vector of result) {
				if (!Array.isArray(vector) || vector.length !== port.dimensions) {
					throw new Error(`向量维度与端口声明不一致(期望 ${port.dimensions})`);
				}
			}
			vectors.push(...result);
		}
		return vectors;
	};
}
