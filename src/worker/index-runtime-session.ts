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
import { AtomicIndexStorage } from '../adapters/atomic-index-storage';
import { devLogger } from '../logging/dev-logger';
import { chunkMarkdown, type ChunkOptions } from './chunker';
import { createWorkerJournal, WorkerJournalOwner } from './index-runtime-journal';
import type { IndexFileJournal } from '../core/index-file-journal';
import { sha256 } from '../utils/hash';
import { IndexManifest, resolveIndexManifestPath, type IndexManifestData } from '../core/index-manifest';
import type { RuntimeHandlers, RuntimeHandlerContext } from './index-runtime-worker';

/** 会话依赖。 */
export interface IndexSessionOptions {
	/** 索引根(代际目录)。 */
	root: string;
	/** 分块参数。 */
	chunkOptions: ChunkOptions;
	/** 存储工厂;缺省用真实 Vectra(必须注入同一份原子存储)。 */
	createStore?: (root: string, storage: AtomicIndexStorage) => VectraStore;
	/** 原子存储工厂;缺省按索引根新建。 */
	createStorage?: (root: string) => AtomicIndexStorage;
	/** 写权 epoch;提供日志装载时用于构造写所有权。 */
	epoch?: number;
}

/** 会话内部状态。 */
interface SessionState {
	store: VectraStore | null;
	journal: IndexFileJournal | null;
	owner: WorkerJournalOwner | null;
	manifest: IndexManifest | null;
	chunkOptions: ChunkOptions;
	written: number;
}

/** 只做向量写入的嵌入占位 — 真实向量由宿主通道提供,Vectra 内部不会调用它。 */
/** 单文件提交超过该耗时即记录分阶段明细。 */
const SLOW_FILE_MS = 5000;

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
	const state: SessionState = { store: null, journal: null, owner: null, manifest: null, chunkOptions: options.chunkOptions, written: 0 };
	const createStorage = options.createStorage ?? ((root: string) => new AtomicIndexStorage({ generationRoot: root }));
	// 关键路径:存储与日志必须共用同一份原子存储,否则写入结果记录与提交语义会分叉。
	const createStore = options.createStore
		?? ((root: string, storage: AtomicIndexStorage) => new VectraStore(root, { embeddings: NO_EMBEDDINGS, storage: storage, autoInit: true }));

	/** 取已打开的存储;未打开时明确失败,不隐式创建。 */
	const requireStore = (): VectraStore => {
		if (state.store === null) throw new Error('索引会话尚未打开');
		return state.store;
	};

	return {
		'session.open': async (payload) => {
			if (state.store !== null) return { alreadyOpen: true };
			const storage = createStorage(options.root);
			const store = createStore(options.root, storage);
			await store.init();
			state.store = store;
			// 关键路径:清单也由本线程读写;主线程不再序列化整份清单。
			state.manifest = new IndexManifest(resolveIndexManifestPath(options.root));

			// 关键路径:给了日志授权才启用「带完成记录」的提交;否则退回纯存储写入。
			const journalPayload = payload as { generationId?: unknown; configFingerprint?: unknown; expectedDimension?: unknown } | null;
			if (typeof journalPayload?.generationId === 'string' && typeof journalPayload.configFingerprint === 'string') {
				const owner = new WorkerJournalOwner(options.epoch ?? 1);
				state.owner = owner;
				state.journal = createWorkerJournal({
					generationRoot: options.root,
					generationId: journalPayload.generationId,
					configFingerprint: journalPayload.configFingerprint,
					store,
					owner,
					expectedDimension: typeof journalPayload.expectedDimension === 'number' ? journalPayload.expectedDimension : undefined,
					storage,
				});
			}
			return { alreadyOpen: false, journal: state.journal !== null };
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

			// 关键路径:内容未变就不重新分块与嵌入 —— 这是「未变文件零重复嵌入」的判据,
			// 也是重跑/reindex 不把整库重嵌一遍的唯一防线。
			const inputHash = await sha256(content);
			if (state.journal !== null) {
				const existing = await state.journal.readReceipt(filePath);
				if (existing !== null && existing.inputHash === inputHash) {
					return { chunkCount: existing.chunkCount, skipped: true };
				}
			}

			const startedAt = performance.now();
			const chunks = chunkMarkdown(content, state.chunkOptions);
			const chunkedAt = performance.now();
			// 关键路径:先拿到全部向量再动磁盘,推理失败时旧版本块保持不变。
			const vectors = chunks.length === 0
				? []
				: await callEmbed(ctx, chunks.map((chunk) => chunk.embedText), 'index');
			if (vectors.length !== chunks.length) {
				throw new Error(`嵌入返回 ${vectors.length} 条,与块数 ${chunks.length} 不一致`);
			}

			const embeddedAt = performance.now();
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
			// 关键路径:有日志时走「准备 → 提交」,完成记录与块替换同一次提交落盘;
			// 无日志时保持纯存储写入,供会话级测试与只读调试路径使用。
			if (state.journal !== null) {
				const receipt = await state.journal.readReceipt(filePath);
				const prepared = await state.journal.prepare({
					path: filePath,
					operation: 'replace',
					inputHash,
					revision: (receipt?.revision ?? 0) + 1,
					previousCommitId: receipt?.commitId ?? null,
					previousRevision: receipt?.revision ?? 0,
					blocks: blocks.map((block) => ({
						id: block.id,
						vector: block.vector,
						metadata: block.metadata,
					})),
				});
				await state.journal.commit(prepared.transactionId);
			} else {
				await store.replaceFile({ path: filePath, commitId, blocks });
			}
			// 关键路径:单文件提交变慢时给出分阶段耗时 —— 只有「分块/嵌入/提交」分别多慢,
			// 才能判断是模型慢还是整份索引重写慢(后者是写放大的直接症状)。
			const committedAt = performance.now();
			const totalMs = committedAt - startedAt;
			if (totalMs > SLOW_FILE_MS) {
				devLogger.warn(
					'index',
					`单文件提交偏慢(${Math.round(totalMs)}ms):${filePath} 分块=${Math.round(chunkedAt - startedAt)}ms 嵌入=${Math.round(embeddedAt - chunkedAt)}ms 提交=${Math.round(committedAt - embeddedAt)}ms 块数=${chunks.length}`,
				);
			}
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
			const vectors = await callEmbed(ctx, [query], 'query');
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

		'session.manifest.load': async () => {
			if (state.manifest === null) throw new Error('索引会话尚未打开');
			return { manifest: await state.manifest.load() };
		},

		'session.manifest.save': async (payload) => {
			if (state.manifest === null) throw new Error('索引会话尚未打开');
			const manifest = (payload as { manifest?: unknown } | null)?.manifest;
			if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
				throw new Error('清单载荷不合法');
			}
			await state.manifest.save(manifest as IndexManifestData);
			return { ok: true };
		},

		'session.listCommitted': async () => {
			if (state.journal === null) throw new Error('会话未启用日志,没有可信完成记录');
			const receipts = await state.journal.listReceipts();
			return {
				records: receipts.map((record) => ({
					path: record.path,
					state: record.state,
					revision: record.revision,
					inputHash: record.inputHash,
					chunkCount: record.chunkCount,
				})),
			};
		},

		'session.searchVector': async (payload) => {
			const store = requireStore();
			const vector = (payload as { vector?: unknown } | null)?.vector;
			if (!Array.isArray(vector) || vector.length === 0 || !vector.every((value) => typeof value === 'number')) {
				throw new Error('查询向量不合法');
			}
			const rawTopK = (payload as { topK?: unknown }).topK;
			const topK = rawTopK === undefined ? 10 : rawTopK;
			if (typeof topK !== 'number' || !Number.isSafeInteger(topK) || topK <= 0 || topK > 500) {
				throw new Error('topK 必须是 1~500 的整数');
			}
			const hits = await store.search(vector, topK);
			return {
				hits: hits.map((hit) => ({
					docId: typeof hit.metadata['path'] === 'string' ? hit.metadata['path'] : hit.docId,
					score: hit.score,
					path: typeof hit.metadata['path'] === 'string' ? hit.metadata['path'] : '',
					chunkIndex: typeof hit.metadata['chunkIndex'] === 'number' ? hit.metadata['chunkIndex'] : null,
				})),
			};
		},

		'session.recover': async (payload) => {
			if (state.journal === null) throw new Error('会话未启用日志,无法恢复');
			const inputs = (payload as { inputs?: unknown } | null)?.inputs;
			if (!Array.isArray(inputs)) throw new Error('恢复输入不合法');
			const currentInputs = new Map<string, string | null>();
			for (const item of inputs) {
				const record = item as { path?: unknown; hash?: unknown };
				if (typeof record.path !== 'string' || record.path.length === 0) throw new Error('恢复输入缺少 path');
				if (record.hash !== null && typeof record.hash !== 'string') throw new Error('恢复输入 hash 不合法');
				currentInputs.set(record.path, record.hash);
			}
			const pending = await state.journal.listPendingPaths();
			if (pending.length === 0) return { pending: 0, decisions: 0, failures: 0, cleanupPending: 0 };
			// 关键路径:恢复只重放「输入仍是当前内容」的事务;不匹配的一律不重放。
			const report = await state.journal.recover({ currentInputs });
			return {
				pending: pending.length,
				decisions: report.decisions.length,
				failures: report.failures.length,
				cleanupPending: report.cleanupPending.length,
			};
		},

		'session.close': async () => {
			// 关键路径:关会话即放弃写权,后续写入必须失败;在途提交未结算时如实报告。
			const inflight = state.owner?.inflightCommits ?? 0;
			state.owner?.revoke('会话关闭');
			state.journal = null;
			state.owner = null;
			state.manifest = null;
			state.store = null;
			return { closed: true, inflight };
		},
	};
}

/**
 * 借宿主通道取嵌入向量。
 * @param ctx 处理器上下文
 * @param texts 待嵌入文本
 */
async function callEmbed(
	ctx: RuntimeHandlerContext | undefined,
	texts: readonly string[],
	workload: 'query' | 'index',
): Promise<number[][]> {
	if (ctx === undefined) throw new Error('缺少宿主调用通道,无法取得向量');
	// 关键路径:把工作类型传出去,宿主据此让查询插到索引批次之间。
	const result = await ctx.callHost('embed', { texts, workload }, 120_000);
	if (!Array.isArray(result)) throw new Error('宿主嵌入通道返回了非数组结果');
	return result as number[][];
}
