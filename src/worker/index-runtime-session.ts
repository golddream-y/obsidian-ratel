/**
 * @file src/worker/index-runtime-session.ts
 * @description 索引会话 — 在索引线程内完成分块、向量写盘与状态查询
 * @module src/worker/index-runtime-session
 *
 * 关键路径:
 * - 分块与 Vectra 写入都在本线程执行,主线程不再承担序列化与整库重写。
 * - 嵌入不在本线程做:通过 `callHost('embed')` 借宿主的模型通道,避免在索引线程里再加载模型。
 * - 单文件提交沿用「先推理、后替换」:推理失败时旧版本块完整保留。
 * - 会话生命周期由 `open`/`close` 控制;关闭后任何写请求都必须失败,不能静默成功。
 */

import { randomUUID } from 'node:crypto';
import { VectraStore, type PreparedBlock } from '../adapters/vector-vectra';
import { chunkMarkdown, type ChunkOptions } from './chunker';
import type { RuntimeHandlers, RuntimeHandlerContext } from './index-runtime-worker';

/** 会话依赖。 */
export interface IndexSessionOptions {
	/** 索引根(代际目录)。 */
	root: string;
	/** 分块参数。 */
	chunkOptions: ChunkOptions;
	/** 存储工厂;缺省用真实 Vectra。 */
	createStore?: (root: string) => VectraStore;
}

/** 会话内部状态。 */
interface SessionState {
	store: VectraStore | null;
	chunkOptions: ChunkOptions;
	written: number;
}

/** 只做向量写入的嵌入占位 — 真实向量由宿主通道提供,Vectra 内部不会调用它。 */
const NO_EMBEDDINGS = {
	maxTokens: 8192,
	async createEmbeddings(): Promise<never> {
		throw new Error('索引线程不直接推理:向量由宿主嵌入通道提供');
	},
};

/** 读取字符串字段。 */
function stringField(payload: unknown, key: string): string {
	const value = (payload as Record<string, unknown> | null)?.[key];
	if (typeof value !== 'string' || value.length === 0) throw new Error(`缺少字段 ${key}`);
	return value;
}

/**
 * 构造索引会话处理器。
 * @param options 索引根与分块参数
 */
export function createIndexSessionHandlers(options: IndexSessionOptions): RuntimeHandlers {
	const state: SessionState = { store: null, chunkOptions: options.chunkOptions, written: 0 };
	const createStore = options.createStore ?? ((root: string) => new VectraStore(root, { embeddings: NO_EMBEDDINGS, autoInit: true }));

	/** 取已打开的存储;未打开时明确失败,不隐式创建。 */
	const requireStore = (): VectraStore => {
		if (state.store === null) throw new Error('索引会话尚未打开');
		return state.store;
	};

	return {
		'session.open': async () => {
			if (state.store !== null) return { alreadyOpen: true };
			const store = createStore(options.root);
			await store.init();
			state.store = store;
			return { alreadyOpen: false };
		},

		'session.status': async () => {
			const store = requireStore();
			const status = await store.status();
			return { totalDocs: status.totalDocs, written: state.written };
		},

		'session.setChunkOptions': async (payload) => {
			const next = payload as ChunkOptions | null;
			if (!next || typeof next !== 'object' || typeof next.maxTokens !== 'number') throw new Error('分块参数不合法');
			state.chunkOptions = next;
			return { ok: true };
		},

		'session.upsertFile': async (payload, ctx) => {
			const store = requireStore();
			const filePath = stringField(payload, 'path');
			const content = (payload as { content?: unknown }).content;
			if (typeof content !== 'string') throw new Error('缺少字段 content');

			const chunks = chunkMarkdown(content, state.chunkOptions);
			// 关键路径:先拿到全部向量再动磁盘,推理失败时旧版本块保持不变。
			const vectors = chunks.length === 0
				? []
				: await callEmbed(ctx, chunks.map((chunk) => chunk.embedText));
			if (vectors.length !== chunks.length) {
				throw new Error(`嵌入返回 ${vectors.length} 条,与块数 ${chunks.length} 不一致`);
			}

			const commitId = randomUUID();
			const blocks: PreparedBlock[] = chunks.map((chunk, index) => ({
				id: `${filePath}#chunk-${index}`,
				vector: vectors[index]!,
				metadata: {
					path: filePath,
					chunkIndex: index,
					startOffset: chunk.startOffset,
					prefix: chunk.prefix,
					headingPath: chunk.headingPath,
					commitId,
				},
			}));
			await store.replaceFile({ path: filePath, commitId, blocks });
			state.written += 1;
			return { chunkCount: blocks.length, commitId };
		},

		'session.search': async (payload, ctx) => {
			const store = requireStore();
			const query = stringField(payload, 'query');
			const rawTopK = (payload as { topK?: unknown }).topK;
			const topK = rawTopK === undefined ? 10 : rawTopK;
			if (typeof topK !== 'number' || !Number.isSafeInteger(topK) || topK <= 0 || topK > 100) {
				throw new Error('topK 必须是 1~100 的整数');
			}
			// 关键路径:查询向量同样借宿主通道,不在索引线程里再加载一次模型。
			const vectors = await callEmbed(ctx, [query]);
			const queryVector = vectors[0];
			if (!Array.isArray(queryVector) || queryVector.length === 0) throw new Error('查询向量不可用');
			const hits = await store.search(queryVector, topK);
			return {
				hits: hits.map((hit) => ({
					path: typeof hit.metadata['path'] === 'string' ? hit.metadata['path'] : '',
					score: hit.score,
					chunkIndex: typeof hit.metadata['chunkIndex'] === 'number' ? hit.metadata['chunkIndex'] : null,
				})),
			};
		},

		'session.deleteFile': async (payload) => {
			const store = requireStore();
			const removed = await store.deleteByPath(stringField(payload, 'path'));
			return { removed };
		},

		'session.close': async () => {
			state.store = null;
			return { closed: true };
		},
	};
}

/**
 * 借宿主通道取嵌入向量。
 * @param ctx 处理器上下文
 * @param texts 待嵌入文本
 */
async function callEmbed(ctx: RuntimeHandlerContext | undefined, texts: readonly string[]): Promise<number[][]> {
	if (ctx === undefined) throw new Error('缺少宿主调用通道,无法取得向量');
	const result = await ctx.callHost('embed', { texts }, 120_000);
	if (!Array.isArray(result)) throw new Error('宿主嵌入通道返回了非数组结果');
	return result as number[][];
}
