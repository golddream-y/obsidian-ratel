/**
 * @file src/core/multi-query-searcher.ts
 * @description 多查询搜索编排器 — 改写 + 多查询 + 统一可见性门 + RRF + 可选 Rerank 精排
 * @module core/multi-query-searcher
 * @depends ports/embedding, ports/vector, ports/reranker, worker/manager, adapters/obsidian-vault, core/rrf,
 *          core/index-search-visibility(仅类型:新鲜度词汇)
 */

import type { EmbeddingPort } from '../ports/embedding';
import type { VectorSearchResult } from '../ports/vector';
import type { RerankerPort } from '../ports/reranker';
import type { WorkerManager } from '../worker/manager';
import type { ObsidianVault } from '../adapters/obsidian-vault';
import type { FileFreshness } from './index-search-visibility';
import { reciprocalRankFusion, type RankedItem } from './rrf';
import { devLogger } from '../logging/dev-logger';

/**
 * 精排来源工厂 — 每次检索时解析一次。
 *
 * 关键路径:用工厂而不是固定实例,是为了让用户在设置里切换「启用精排 / 精排来源」
 * 后立即生效(无需重载插件);返回 undefined 表示当前不精排(开关关闭或来源不可用)。
 */
export type RerankerFactory = () => RerankerPort | undefined;

/**
 * 候选少于该数量就不精排 — 结果本来就少,全部能进上下文,排序收益接近零。
 *
 * 关键路径:判定必须排在读全文之前,候选不足时既不调精排也不读文件,
 * 省掉 N 次文件读取与一次模型调用。
 */
export const MIN_RERANK_CANDIDATES = 4;

/**
 * 过滤后可见候选不足 topK 时最多重取几次 — 每次把抓取量翻倍。
 *
 * 关键路径:重取的目的是「补足 topK」,不是无限扫描;超过上限按当前可见集返回,
 * 宁可结果少,也不把已拒绝的候选放进融合与重排。
 */
export const MAX_RECALL_ATTEMPTS = 3;

/** 每次补取把过度抓取量放大的倍数。 */
export const RECALL_GROWTH_FACTOR = 2;

/**
 * 单条候选的可见性结论 — 与 `SearchVisibilityGate.decide` / `ReadOnlySearchView.decide` 结构兼容。
 *
 * 关键路径:检索侧只消费「能不能进融合/重排」与「新鲜度」两件事,不复制判定规则本身;
 * 判定入口始终是装配层注入的同一个门。
 */
export interface SearchCandidateVerdict {
	/** 可进入融合/重排。 */
	visible: boolean;
	/** 候选路径。 */
	path: string;
	/** 新鲜度;`unknown` 表示未在本轮核对,不得承诺精确块定位。 */
	freshness: FileFreshness;
	/** 稳定拒绝原因;可见时省略。 */
	reason?: string;
}

/**
 * 统一可见性门 — 原始向量候选进入融合、重排与工具返回之前的唯一闸门。
 *
 * 关键路径(装配归属):
 * - 可写装配注入 `SearchVisibilityGate`(证据来自文件日志 + 运行期新鲜度);
 * - 关闭自动索引时注入 `ReadOnlySearchView`(只读可信完成记录,新鲜度 `unknown`);
 * - 未注入时本编排器不做过滤(向后兼容),但**生产装配必须注入**。
 */
export interface SearchCandidateGate {
	/** 每次检索开始前刷新判定依据;只读视图用它重读记录,可写门可省略。 */
	refresh?(): Promise<unknown>;
	/** 判定单个候选。 */
	decide(path: string): Promise<SearchCandidateVerdict>;
	/** 记录集是否可判定;`unjudgeable` 表示没有可信记录,调用方必须如实呈现而不是显示「0 篇可检索」。 */
	recordsKind?(): 'known' | 'unjudgeable';
}

/**
 * 带新鲜度的检索结果 — 上层据此决定是否承诺精确块定位。
 *
 * 关键路径:`freshness` 只有 `verified` 才表示本轮的磁盘内容与已提交版本一致;
 * `unknown`(关闭自动索引 / 尚未核对)与 `known-stale` 都不得承诺块偏移仍然准确。
 */
export interface SearchResultWithFreshness extends VectorSearchResult {
	/** 该候选的可见性新鲜度。 */
	freshness?: FileFreshness;
}

/** 一次检索的可见性诊断 — 供工具层如实呈现「不可判定」而不是静默返回空集。 */
export interface SearchVisibilityDiagnostics {
	/** 记录集是否可判定。 */
	recordsKind: 'known' | 'unjudgeable';
	/** 被门拒绝的候选路径数(按路径去重)。 */
	denied: number;
	/** 实际执行的召回轮数(>1 表示过滤后补取过候选)。 */
	recallAttempts: number;
}

/**
 * 多查询搜索器依赖。
 *
 * @param embedding - Embedding 端口,用于把每个查询变体编码为向量。
 * @param workerManager - Worker 管理器,用于发起 vector.search(W3 已实现)。
 * @param vault - Obsidian Vault 外观,供 Rerank 读取文档全文。
 * @param reranker - 可选 Reranker 端口或工厂;未注入 / 工厂返回 undefined 时跳过精排。
 * @param queryRewriter - 可选查询改写器;未注入时只用原始查询。
 * @param visibility - 可选统一可见性门;注入后原始向量候选先被过滤再融合与重排。
 */
export interface MultiQuerySearcherDeps {
	embedding: EmbeddingPort;
	workerManager: WorkerManager;
	vault: ObsidianVault;
	reranker?: RerankerPort | RerankerFactory;
	queryRewriter?: { rewrite: (q: string) => Promise<string[]> };
	visibility?: SearchCandidateGate;
}

/** 一次召回与过滤的中间结果。 */
interface FilteredRecall {
	/** 只保留可见候选的召回列表(保持原顺序)。 */
	lists: VectorSearchResult[][];
	/** 被拒绝的唯一路径数。 */
	denied: number;
	/** 可见候选路径 → 新鲜度。 */
	freshnessByPath: Map<string, FileFreshness>;
}

/**
 * 多查询搜索编排器。
 *
 * 设计要点:
 * - 对 search_vault 工具与 LLM 透明:外部只调 search(query, topK),内部自动编排。
 * - 不调 search_vault 工具(避免循环 — search_vault 反过来调用本类)。
 * - 直接调 Worker 的 vector.search,绕过 search_vault 工具层。
 * - Reranker 异常时降级返回 RRF 结果,不阻断主流程。
 * - QueryRewriter 异常时降级为单查询,不阻断主流程。
 * - **可见性门排在融合与重排之前**:被拒绝的路径既不参与 RRF,也不进入 Reranker 的输入,
 *   更不会被读全文 —— 不允许「先把片段交给模型再事后过滤」。
 *
 * 关键路径(数据流):
 * 1. 若 queryRewriter 可用:改写查询 → [original, rewrite-1, rewrite-2];否则只用 [original]
 * 2. 嵌入全部查询变体一次(补取时复用向量,不重复推理)
 * 3. 对每个变体:workerManager.request(vector.search, topK*2) → 统一可见性门过滤
 * 4. 可见候选不足 topK 且确实过滤掉了候选 → 翻倍抓取量重取,与已有候选累积后重新过滤融合
 * 5. RRF 融合多份结果,取 topK
 * 6. 若 reranker 可用且候选 ≥ MIN_RERANK_CANDIDATES:vault.readFile 读全文 → reranker.rerank
 *
 * @example
 *   const searcher = new MultiQuerySearcher({ embedding, workerManager, vault, visibility });
 *   const results = await searcher.search('技术栈', 5);
 */
export class MultiQuerySearcher {
	/** 最近一次检索的可见性诊断;未装配门时为 undefined。 */
	private lastDiagnostics: SearchVisibilityDiagnostics | undefined;

	constructor(private deps: MultiQuerySearcherDeps) {}

	/** 最近一次检索的可见性诊断 — 工具层据此区分「真的没命中」与「记录不可判定」。 */
	visibilityDiagnostics(): SearchVisibilityDiagnostics | undefined {
		return this.lastDiagnostics;
	}

	/**
	 * 多查询混合搜索 + 可见性门 + RRF 融合 + 可选 Rerank 精排。
	 *
	 * @param query - 用户原始查询(单条,内部决定是否改写)。
	 * @param topK - 返回文档上限。
	 * @returns 文档级结果(含 index 由 search_vault 工具层填,本方法不填)。
	 */
	async search(query: string, topK: number): Promise<SearchResultWithFreshness[]> {
		this.lastDiagnostics = undefined;
		const gate = this.deps.visibility;
		if (gate?.refresh !== undefined) {
			try {
				await gate.refresh();
			} catch (err) {
				// 关键路径:判定依据刷新失败 → 失败关闭。不能退回「不过滤」继续检索。
				devLogger.error('search', '可见性门刷新失败,本次检索按不可判定处理', err);
				this.lastDiagnostics = { recordsKind: 'unjudgeable', denied: 0, recallAttempts: 0 };
				return [];
			}
		}

		// --- Step 1: 查询改写(可选) ---
		let queryTexts: string[] = [query];
		if (this.deps.queryRewriter) {
			try {
				const variants = await this.deps.queryRewriter.rewrite(query);
				if (variants.length > 0) {
					// 关键路径:queryRewriter.rewrite 契约 — 返回值含原始查询(见 Task 9 接线:
					// rewriteQuery 已返回 [{text: query, variant: 'original'}, ...rewrites])。
					// 因此直接用 variants,避免重复前置 original 导致该查询执行两次、RRF 分数翻倍。
					queryTexts = variants;
				}
			} catch (err) {
				// 关键路径:改写失败降级为单查询,不阻断。
				devLogger.error('search', 'Query rewrite failed, falling back to single query', err);
			}
		}

		// --- Step 2: 查询向量只算一次(补取候选时复用,不重复推理) ---
		const queryVectors: number[][] = [];
		for (const queryText of queryTexts) {
			const [queryVector] = await this.deps.embedding.embed([queryText]);
			if (queryVector !== undefined) queryVectors.push(queryVector);
		}

		// --- Step 3: 多查询向量召回 + 可见性过滤(在融合之前)+ RRF,必要时补取 ---
		// 关键路径:传 topK*2 过度抓取,补偿 RRF 融合时丢弃部分结果;被门拒绝时再翻倍补取。
		// 关键词不由向量库提供:vectra 的 BM25 需按条目回读全文且中文分词不可用,已移除;
		// 精确词命中由 grep 工具承担。
		let overFetchTopK = topK * 2;
		// 每个查询变体累积的原始候选(跨补取轮次做并集去重),避免「大抓取返回更少」时丢掉已有候选。
		const accumulated: VectorSearchResult[][] = queryVectors.map(() => []);
		const seenDocIds: Array<Set<string>> = queryVectors.map(() => new Set<string>());
		const verdicts = new Map<string, SearchCandidateVerdict>();
		let finalResults: SearchResultWithFreshness[] = [];
		let deniedPaths = 0;
		let recallAttempts = 0;

		for (let attempt = 0; attempt < MAX_RECALL_ATTEMPTS; attempt += 1) {
			recallAttempts = attempt + 1;
			let addedCandidates = false;
			for (const [index, queryVector] of queryVectors.entries()) {
				const response = await this.deps.workerManager.request({
					type: 'vector.search',
					payload: { queryVector, topK: overFetchTopK },
				});
				if (response.type !== 'vector.search.result') {
					// 修复:Worker 返回 error 时打印 payload 详情,便于排查(如 HANDLER_ERROR / NULL_PROCESSOR)。
					const errMsg = response.type === 'error'
						? (response.payload as { message?: string })?.message ?? 'unknown error'
						: `unexpected type: ${response.type}`;
					devLogger.warn('search', `vector.search failed (attempt ${recallAttempts}): ${errMsg}`);
					continue;
				}
				const seen = seenDocIds[index]!;
				for (const result of response.payload) {
					if (seen.has(result.docId)) continue;
					seen.add(result.docId);
					accumulated[index]!.push(result);
					addedCandidates = true;
				}
			}

			// 关键路径:统一可见性门在 RRF 与精排之前 —— 被拒候选不会进入任何下游输入。
			const filtered = await this.filterBeforeFusion(accumulated, gate, verdicts);
			deniedPaths = filtered.denied;

			// 把可见候选的 docId 映射回原始结果(含 metadata),供 RRF 后还原。
			const docIdToResult = new Map<string, VectorSearchResult>();
			for (const list of filtered.lists) {
				for (const result of list) {
					if (!docIdToResult.has(result.docId)) docIdToResult.set(result.docId, result);
				}
			}
			const rankedLists: RankedItem[][] = filtered.lists.map((list) =>
				list.map((result) => ({ id: result.docId, score: result.score })),
			);
			const fused = reciprocalRankFusion(rankedLists, 60, topK);

			// 关键路径:把融合后的 docId 映射回 VectorSearchResult,用 rrfScore 替换原 score,
			// 并携带该候选的新鲜度(引用定位精度的唯一依据)。
			finalResults = fused.map((item) => {
				const original = docIdToResult.get(item.id);
				if (!original) {
					// 关键路径:理论上不会发生(docId 都来自 docIdToResult),兜底防御。
					return { docId: item.id, score: item.rrfScore, metadata: {} };
				}
				const path = typeof original.metadata.path === 'string' ? original.metadata.path : undefined;
				const freshness = path === undefined ? undefined : filtered.freshnessByPath.get(path);
				return { ...original, score: item.rrfScore, ...(freshness === undefined ? {} : { freshness }) };
			});

			if (finalResults.length >= topK) break;
			// 没有候选被拒绝时扩大抓取不会带来新的可见项;抓不到新候选时同理。
			if (filtered.denied === 0 || !addedCandidates) break;
			if (attempt === MAX_RECALL_ATTEMPTS - 1) break;
			overFetchTopK *= RECALL_GROWTH_FACTOR;
		}

		if (gate !== undefined) {
			this.lastDiagnostics = {
				recordsKind: gate.recordsKind?.() ?? 'known',
				denied: deniedPaths,
				recallAttempts,
			};
		}

		// --- Step 4: 可选 Rerank 精排(输入已经是过滤后的可见候选) ---
		// 关键路径:工厂在每次检索时解析一次 — 设置改了立即生效,关闭时返回 undefined。
		const reranker = typeof this.deps.reranker === 'function' ? this.deps.reranker() : this.deps.reranker;
		// 关键路径:短路判定排在读全文之前 — 候选不足时既不调精排也不读文件。
		if (reranker && finalResults.length >= MIN_RERANK_CANDIDATES) {
			try {
				// 关键路径:读取 topK 文档全文,传给 Reranker。
				// metadata.path 是 vault 相对路径(W3 VectraStore.search 保证)。
				const documents: Array<{ id: string; text: string }> = [];
				for (const r of finalResults) {
					const path = r.metadata?.path;
					if (typeof path === 'string') {
						const text = await this.deps.vault.readFile(path);
						documents.push({ id: r.docId, text });
					}
				}

				if (documents.length > 0) {
					const reranked = await reranker.rerank(query, documents, topK);
					// 关键路径:用 reranker 分数重新排序,丢弃 text(VectorSearchResult 不含 text)。
					const rerankedMap = new Map(reranked.map((r) => [r.id, r.score]));
					// 关键路径:reranked 标记与 score 同源 — 仅 Reranker 实际返回分数的文档标 true;
					// 送入但被 Reranker 丢弃(低于 top_n 截断)的文档保持 reranked=false,因其分数仍是 RRF。
					finalResults = finalResults
						.map((r) => ({
							...r,
							score: rerankedMap.get(r.docId) ?? r.score,
							reranked: rerankedMap.has(r.docId),
						}))
						.sort((a, b) => b.score - a.score)
						.slice(0, topK);
				} else {
					// 关键路径:reranker 存在但所有文档缺 metadata.path,无法精排,reranked=false。
					finalResults = finalResults.map((r) => ({ ...r, reranked: false }));
				}
			} catch (err) {
				// 关键路径:Reranker 失败降级返回 RRF 结果,reranked=false。
				devLogger.error('search', 'Rerank failed, falling back to RRF results', err);
				finalResults = finalResults.map((r) => ({ ...r, reranked: false }));
			}
		} else {
			// 关键路径:无 reranker,reranked=false。
			finalResults = finalResults.map((r) => ({ ...r, reranked: false }));
		}

		return finalResults;
	}

	/**
	 * 在融合与重排之前过滤召回列表 — 保留原顺序与原始对象。
	 *
	 * 关键路径:
	 * - 每个唯一路径只判定一次(`verdicts` 缓存),补取轮次不会重复判定同一候选;
	 * - 缺少 `metadata.path` 的候选**无法核验**,一律拒绝(规范要求「无法核验的候选过滤」);
	 * - 未装配门时原样返回,不做隐式收紧或放宽(向后兼容)。
	 *
	 * @param lists - 各查询变体的原始召回结果。
	 * @param gate - 统一可见性门;未装配时为 undefined。
	 * @param verdicts - 本次检索的判定缓存(跨补取轮次复用)。
	 * @returns 仅含可见候选的列表、被拒路径数与新鲜度视图。
	 */
	private async filterBeforeFusion(
		lists: readonly (readonly VectorSearchResult[])[],
		gate: SearchCandidateGate | undefined,
		verdicts: Map<string, SearchCandidateVerdict>,
	): Promise<FilteredRecall> {
		if (gate === undefined) {
			return {
				lists: lists.map((list) => [...list]),
				denied: 0,
				freshnessByPath: new Map(),
			};
		}
		const uniquePaths = new Set<string>();
		for (const list of lists) {
			for (const result of list) {
				const path = pathOf(result);
				if (path !== undefined) uniquePaths.add(path);
			}
		}
		// 关键路径:判定并发执行而不是逐个 await —— 门注入的存在性核对可能读盘,
		// 串行判定会让 N 个候选变成 N 次串行 IO;`decide` 本身只读快照与注入的视图。
		await Promise.all([...uniquePaths].filter((path) => !verdicts.has(path)).map(async (path) => {
			verdicts.set(path, await gate.decide(path));
		}));

		const deniedPaths = new Set<string>();
		let unverifiable = 0;
		const freshnessByPath = new Map<string, FileFreshness>();
		const visibleLists: VectorSearchResult[][] = [];
		for (const list of lists) {
			const kept: VectorSearchResult[] = [];
			for (const result of list) {
				const path = pathOf(result);
				const verdict = path === undefined ? undefined : verdicts.get(path);
				if (verdict?.visible === true) {
					kept.push(result);
					freshnessByPath.set(verdict.path, verdict.freshness);
					continue;
				}
				if (path === undefined) unverifiable += 1;
				else deniedPaths.add(path);
			}
			visibleLists.push(kept);
		}
		return {
			lists: visibleLists,
			denied: deniedPaths.size + (unverifiable > 0 ? 1 : 0),
			freshnessByPath,
		};
	}
}

/** 从检索结果里取 vault 相对路径;缺失或非字符串时为 undefined(无法核验)。 */
function pathOf(result: VectorSearchResult): string | undefined {
	const path = result.metadata?.path;
	return typeof path === 'string' && path.length > 0 ? path : undefined;
}