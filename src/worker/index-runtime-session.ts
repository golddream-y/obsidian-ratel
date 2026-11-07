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
import { createShardedStore, type ShardedVectorStore } from '../adapters/vector-vectra-sharded';
import { AtomicIndexStorage } from '../adapters/atomic-index-storage';
import { ensureShardLayout, archiveLegacySingleFileIndex, readShardLayout } from '../core/index-shard-migration';
import { shardCountForBlocks } from '../core/index-shard-routing';
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
	/** 进度事件出口 — 批量写入时按篇推送,让状态计数不必等整批结束。 */
	emit?: (type: string, payload?: unknown) => void;
}

/** 会话使用的向量存储 — 单份 Vectra 与分片适配器对上层保持同一最小接口。 */
type SessionVectorStore = VectraStore | ShardedVectorStore;

/** 会话内部状态。 */
interface SessionState {
	store: SessionVectorStore | null;
	journal: IndexFileJournal | null;
	owner: WorkerJournalOwner | null;
	manifest: IndexManifest | null;
	chunkOptions: ChunkOptions;
	written: number;
	/** 本会话累计耗时（毫秒）— 用来定位「推理变快后」的剩余瓶颈。 */
	timing: { chunkMs: number; embedMs: number; commitMs: number };
}

/**
 * 会话存储访问门 — 分块与嵌入在门外并行,真实提交、批量事务与读取在门内协调。
 *
 * 关键路径:提交之间串行并等待在途读取;提交结束时先唤醒已排队读取,
 * 再让下一条提交进入,避免连续索引让查询一直排在队尾。
 */
class SessionStoreGate {
	private commitChain: Promise<void> = Promise.resolve();
	private activeReads = 0;
	private commitActive = false;
	private readonly readDrainWaiters: Array<() => void> = [];
	private readonly readAllowWaiters: Array<() => void> = [];

	/** 执行一次存储读取;原子提交期间排队,提交结束后优先进入。 */
	async runRead<T>(operation: () => Promise<T>): Promise<T> {
		while (this.commitActive) {
			await new Promise<void>((resolve) => { this.readAllowWaiters.push(resolve); });
		}
		this.activeReads += 1;
		try {
			return await operation();
		} finally {
			this.activeReads -= 1;
			if (this.activeReads === 0) {
				for (const resolve of this.readDrainWaiters.splice(0)) resolve();
			}
		}
	}

	/** 执行一次原子提交;与其它提交串行,并等待已在读取的查询结束。 */
	async runCommit<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.commitChain;
		let releaseTurn: () => void = () => undefined;
		this.commitChain = new Promise<void>((resolve) => { releaseTurn = resolve; });
		await previous;
		this.commitActive = true;
		try {
			await this.waitForReadDrain();
			return await operation();
		} finally {
			this.commitActive = false;
			// 关键路径:先放行排队查询,再释放下一次提交;后者会等这些查询读完。
			for (const resolve of this.readAllowWaiters.splice(0)) resolve();
			releaseTurn();
		}
	}

	/** 等待在途读取结束。 */
	private waitForReadDrain(): Promise<void> {
		if (this.activeReads === 0) return Promise.resolve();
		return new Promise<void>((resolve) => { this.readDrainWaiters.push(resolve); });
	}
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
	const state: SessionState = {
		store: null,
		journal: null,
		owner: null,
		manifest: null,
		chunkOptions: options.chunkOptions,
		written: 0,
		timing: { chunkMs: 0, embedMs: 0, commitMs: 0 },
	};
	// 修复:服务循环会并发派发会话请求,存储访问必须由会话自身保证提交互斥与查询优先级。
	const storeGate = new SessionStoreGate();
	const createStorage = options.createStorage ?? ((root: string) => new AtomicIndexStorage({ generationRoot: root }));
	// 关键路径:存储与日志必须共用同一份原子存储,否则写入结果记录与提交语义会分叉。
	const createStore = options.createStore
		?? ((root: string, storage: AtomicIndexStorage) => new VectraStore(root, { embeddings: NO_EMBEDDINGS, storage: storage, autoInit: true }));

	/** 取已打开的存储;未打开时明确失败,不隐式创建。 */
	const requireStore = (): SessionVectorStore => {
		if (state.store === null) throw new Error('索引会话尚未打开');
		return state.store;
	};

	/** 在存储门外完成单文件分块与嵌入,返回仅执行真实提交的闭包。 */
	const prepareUpsertFile = async (payload: unknown, ctx: RuntimeHandlerContext | undefined) => {
		const filePath = stringField(payload, 'path');
		const content = (payload as { content?: unknown }).content;
		if (typeof content !== 'string') throw new Error('缺少字段 content');

		// 关键路径:内容未变就不重新分块与嵌入 —— 这是「未变文件零重复嵌入」的判据,
		// 也是重跑/reindex 不把整库重嵌一遍的唯一防线。
		const inputHash = await sha256(content);
		if (state.journal !== null) {
			const existing = await state.journal.readReceipt(filePath);
			if (existing !== null && existing.inputHash === inputHash) {
				return { path: filePath, chunkCount: existing.chunkCount, skipped: true as const };
			}
		}
		// 关键路径:确定要真正写入时才取存储 —— 跳过路径不该为了一份向量库付出打开分片的代价。
		const store = requireStore();

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
		const completeCommit = () => {
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
			// 关键路径(GPU 之后):推理已降到每块几十毫秒,剩余时间花在分块与提交上。
			// 逐阶段累计并每 100 篇报一次,才能判断下一个该优化谁。
			state.timing.chunkMs += chunkedAt - startedAt;
			state.timing.embedMs += embeddedAt - chunkedAt;
			state.timing.commitMs += committedAt - embeddedAt;
			state.written += 1;
			// 关键路径:大文件可能先被扫描,按篇数等 20 篇会等很久;
			// 5 篇先给一次结论,之后每 25 篇复述,冷启动时尽快拿到分阶段占比。
			if (state.written === 5 || state.written % 25 === 0) {
				const { chunkMs, embedMs, commitMs } = state.timing;
				const sum = chunkMs + embedMs + commitMs;
				if (sum > 0) {
					const share = (value: number) => `${Math.round((value / sum) * 100)}%`;
					devLogger.info(
						'index',
						`索引耗时构成(前 ${state.written} 篇):分块 ${share(chunkMs)} / 嵌入 ${share(embedMs)} / 提交 ${share(commitMs)}`,
					);
				}
			}
			return { chunkCount: blocks.length, commitId };
		};
		const prepareJournal = async () => {
			const journal = state.journal;
			if (journal === null) return null;
			const receipt = await journal.readReceipt(filePath);
			const prepared = await journal.prepare({
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
			const next = prepared.prepared.next;
			return {
				journal,
				transactionId: prepared.transactionId,
				replacement: {
					path: next.path,
					commitId: next.commitId,
					// 关键路径:与日志 prepare 的分片元数据逐字段一致,commit 才能凭 diskDone 只补记录。
					blocks: blocks.map((block) => ({
						...block,
						metadata: {
							...block.metadata,
							path: next.path,
							commitId: next.commitId,
							revision: next.revision,
							docId: block.id,
							documentId: block.id,
						},
					})),
				},
			};
		};
		// 关键路径:prepare 会落盘并结算前驱,只能由门内的单文件 commit 或批量入口触发;
		// 缓存同一个 Promise,保证一次文件提交至多 prepare 一次,批量写块与收尾共享同一事务。
		let journalPreparation: ReturnType<typeof prepareJournal> | null = null;
		const prepare = () => {
			journalPreparation ??= prepareJournal();
			return journalPreparation;
		};
		const commit = async () => {
			const prepared = await prepare();
			if (prepared !== null) {
				await prepared.journal.commit(prepared.transactionId);
			} else {
				await store.replaceFile({ path: filePath, commitId, blocks });
			}
			return completeCommit();
		};
		// 关键路径(两阶段批量):块先落盘、完成记录后写。中断在两者之间时,
		// 恢复流程能按磁盘分片补写记录(既有决策 3/6),不会留下「有记录无块」的死路径。
		const writeBlocks = async (): Promise<void> => {
			const prepared = await prepare();
			if (prepared !== null) {
				await prepared.journal.applyBlocks(prepared.transactionId);
			} else {
				await store.replaceFile({ path: filePath, commitId, blocks });
			}
		};
		const finalize = async () => {
			const prepared = await prepare();
			if (prepared !== null) {
				await prepared.journal.finalizeCommit(prepared.transactionId);
			}
			return completeCommit();
		};
		return { path: filePath, skipped: false as const, prepare, commit, writeBlocks, finalize };
	};

	/** 单文件准备完成后进入独立提交窗口。 */
	const upsertFile = async (payload: unknown, ctx: RuntimeHandlerContext | undefined) => {
		const prepared = await prepareUpsertFile(payload, ctx);
		if (prepared.skipped) return { chunkCount: prepared.chunkCount, skipped: true };
		return storeGate.runCommit(prepared.commit);
	};

	const handlers: RuntimeHandlers = {
		'session.open': async (payload) => {
			if (state.store !== null) return { alreadyOpen: true };
			// 关键路径:启动先尝试一次旧单份布局迁移,再读 layout 决定片数。
			// 迁移失败直接上抛(fail-closed):不吞错、不退回写单份索引 ——
			// 退回会绕过迁移,让半拆分的旧文件与后续提交同时生效。
			await archiveLegacySingleFileIndex({ generationRoot: options.root });
			const layout = await readShardLayout(options.root);
			const storage = createStorage(options.root);
			// 关键路径:全新代际(无 layout、无旧 index.json)也走分片,片数取下限 8。
			// 这样新装用户从第一次索引起就是分片布局,不再有「单份 → 迁移」的二段式。
			const store = createShardedStore({
				root: options.root,
				shardCount: layout?.shardCount ?? shardCountForBlocks(0),
				createStorage: (shardRoot) => createStorage(shardRoot),
				createStore: (shardRoot, shardStorage) => createStore(shardRoot, shardStorage as AtomicIndexStorage),
			});
			await store.init();
			// 关键路径:layout 必须在存储装配成功之后才落盘,并保持幂等(已存在不覆盖)。
			// 装配失败时不会留下「有 layout 无存储」的假迁移标记,下次启动可安全重试。
			if (layout === null) await ensureShardLayout(options.root, store.shardCount);
			state.store = store;
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

		'session.upsertFile': (payload, ctx) => upsertFile(payload, ctx),

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
			const hits = await storeGate.runRead(() => store.search(queryVector, topK));
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
			const removed = await storeGate.runCommit(() => store.deleteByPath(stringField(payload, 'path')));
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
			const hits = await storeGate.runRead(() => store.search(vector, topK));
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

	// 关键路径:批量入口把 N 篇的向量写入合并成一次落盘 —— Vectra 没有增量追加,
	// 逐篇提交会让整份索引被重写 N 次,这正是大库上「每篇几十秒」的根因。
	handlers['session.upsertFiles'] = async (payload, ctx) => {
		const store = requireStore();
		const files = (payload as { files?: unknown } | null)?.files;
		if (!Array.isArray(files) || files.length === 0) throw new Error('批量写入缺少 files');
		const results: Array<{ path: string; chunkCount: number; skipped?: boolean }> = [];
		type BatchItem = { path: string; prepare: () => Promise<unknown>; writeBlocks: () => Promise<void>; finalize: () => Promise<{ chunkCount: number }> };
		const prepared: BatchItem[] = [];
		for (const item of files) {
			const record = item as { path?: unknown; content?: unknown } | null;
			const filePath = record?.path;
			const content = record?.content;
			if (typeof filePath !== 'string' || filePath.length === 0) throw new Error('批量写入缺少 path');
			if (typeof content !== 'string') throw new Error('批量写入缺少 content');
			const single = await prepareUpsertFile({ path: filePath, content }, ctx);
			if (single.skipped) {
				results.push({ path: filePath, chunkCount: single.chunkCount, skipped: true });
				// 关键路径:跳过也要按篇上报,否则重载后的快速核对阶段进度不动。
				options.emit?.('file-committed', { path: filePath, chunkCount: single.chunkCount, skipped: true });
				continue;
			}
			prepared.push(single);
		}
		if (prepared.length > 0) {
			// 关键路径:整批写入必须走同一把提交闸门,否则批内查询会插进提交中间,
			// 读到半批状态。
			await storeGate.runCommit(async () => {
				// 关键路径:全部日志 prepare 都在提交门内且先于向量批,查询不能穿过前驱结算或分片落盘。
				for (const item of prepared) await item.prepare();
				try {
					await store.beginWriteBatch();
					for (const item of prepared) await item.writeBlocks();
					await store.endWriteBatch();
				} catch (error) {
					// 关键路径:begin 失败时深度为 0,abort 无操作也必须 reload;写批中途失败则先丢弃半批再重载。
					store.abortWriteBatch();
					await store.reload();
					throw error;
				}
				for (const item of prepared) {
					const done = await item.finalize();
					results.push({ path: item.path, chunkCount: done.chunkCount });
					// 关键路径:按篇上报 —— 整批 8 篇一起结算会让进度从 8 直接跳到 16,
					// 6 小时量级的索引里这种跳变看起来像卡住。
					options.emit?.('file-committed', { path: item.path, chunkCount: done.chunkCount });
				}
			});
		}
		return { results };
	};

	return handlers;

}

/**
 * 单次宿主嵌入调用携带的文本上限 — 与宿主侧仲裁批大小(8)对齐。
 *
 * 关键路径(2026-11-06 线上超时):此前整篇笔记的块一次性发给宿主,超时预算固定 120 秒。
 * 大文件块多、机器忙时(实测系统负载 40+)单次推理远超预算,整个文件直接判失败。
 * 拆成有界小批后,每次调用预算只覆盖 8 段,超时影响面从「整篇」缩到「一小批」。
 */
const EMBED_CALL_TEXTS = 8;
/** 单次调用基础预算 — 覆盖排队与模型调度,不随文本量变化。 */
const EMBED_CALL_BASE_MS = 60_000;
/** 每段文本的预算 — 正常单段远低于此值,留足高负载余量。 */
const EMBED_CALL_PER_TEXT_MS = 10_000;

/**
 * 借宿主通道取嵌入向量。
 *
 * @param ctx 处理器上下文
 * @param texts 待嵌入文本
 * @param workload 工作类型 — 宿主据此让查询插到索引批次之间
 * @returns 与 `texts` 等长且顺序一致的向量
 */
async function callEmbed(
	ctx: RuntimeHandlerContext | undefined,
	texts: readonly string[],
	workload: 'query' | 'index',
): Promise<number[][]> {
	if (ctx === undefined) throw new Error('缺少宿主调用通道,无法取得向量');
	if (texts.length === 0) return [];
	const vectors: number[][] = [];
	for (let start = 0; start < texts.length; start += EMBED_CALL_TEXTS) {
		const slice = texts.slice(start, start + EMBED_CALL_TEXTS);
		const timeoutMs = EMBED_CALL_BASE_MS + slice.length * EMBED_CALL_PER_TEXT_MS;
		const result = await ctx.callHost('embed', { texts: slice, workload }, timeoutMs);
		if (!Array.isArray(result)) throw new Error('宿主嵌入通道返回了非数组结果');
		// 关键路径:按批核对条数,回退时能指出是哪一批不一致,而不是只报总数不符。
		if (result.length !== slice.length) {
			throw new Error(`嵌入返回 ${result.length} 条,与本批请求 ${slice.length} 条不一致`);
		}
		vectors.push(...(result as number[][]));
	}
	return vectors;
}
