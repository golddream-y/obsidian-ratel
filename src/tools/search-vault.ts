/**
 * @file src/tools/search-vault.ts
 * @description `search_vault` 工具 — 在知识库中做向量搜索,返回 docId + score + metadata
 * @module tools/search-vault
 * @depends core/tool-registry, ports/embedding, worker/manager
 */

import type { Tool } from '../core/tool-registry';
import type { EmbeddingPort } from '../ports/embedding';
import type { WorkerManager } from '../worker/manager';

// 默认返回结果数,与 JSON schema 中的 default 保持一致。
const DEFAULT_TOP_K = 5;

/**
 * 构造 `search_vault` 工具实例。
 *
 * 设计要点:
 * - 只读工具(`readOnly: true`),不触发写钩子。
 * - 查询 embedding 在主线程执行(ms 级,不卡 UI);向量检索走 Worker(读索引文件)。
 * - 只返回 docId + score + metadata,不返回 chunk 原文,让模型自主用 read_note 读取。
 *
 * @param embedding - Embedding 端口,用于把 query 编码为向量。
 * @param workerManager - Worker 管理器,用于向 Worker 发起 vector.search 请求。
 * @param getSearchReady - 检索就绪检查;未就绪时抛 INDEX_NOT_READY。
 * @returns 符合 `Tool` 接口的工具定义。
 */
export function createSearchVaultTool(
	embedding: EmbeddingPort,
	workerManager: WorkerManager,
	getSearchReady: () => boolean,
): Tool {
	return {
		definition: {
			name: 'search_vault',
			description: 'Search the vault for notes relevant to a query. Returns document paths and relevance scores; use read_note to fetch the actual content.',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'The search query (e.g. "project tech stack")',
					},
					topK: {
						type: 'number',
						description: `Maximum number of results to return (default: ${DEFAULT_TOP_K})`,
						default: DEFAULT_TOP_K,
					},
				},
				required: ['query'],
			},
		},
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			if (!getSearchReady()) {
				const err = new Error('索引或 Embedding 尚未就绪,请稍候或在设置 → 诊断测试中检查');
				(err as Error & { code?: string }).code = 'INDEX_NOT_READY';
				throw err;
			}
			if (typeof args.query !== 'string' || args.query.length === 0) {
				throw new Error('search_vault 参数 query 必须是有效字符串');
			}
			const query = args.query;
			const topK = typeof args.topK === 'number' ? args.topK : DEFAULT_TOP_K;

			// 关键路径:查询向量化在主线程完成,单条 ms 级,不阻塞 UI。
			const [queryVector] = await embedding.embed([query]);
			// EmbeddingPort 契约保证返回与输入等长的向量,单条查询必然有值;用 ! 关闭 noUncheckedIndexedAccess。

			const response = await workerManager.request({
				type: 'vector.search',
				payload: { queryVector: queryVector!, topK },
			});

			if (response.type !== 'vector.search.result') {
				throw new Error(`Unexpected worker response type: ${response.type}`);
			}

			return response.payload;
		},
	};
}
