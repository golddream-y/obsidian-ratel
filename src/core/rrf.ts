/**
 * @file src/core/rrf.ts
 * @description Reciprocal Rank Fusion — 合并多个排序列表的纯函数算法
 * @module core/rrf
 * @depends (无)
 */

/**
 * 待融合的单条排序项。
 * @param id - 文档唯一标识(本项目用 docId)。
 * @param score - 原始分数(来自向量搜索/BM25,RRF 不直接使用,仅记录到 sourceScores)。
 */
export interface RankedItem {
	id: string;
	score: number;
}

/**
 * 融合后的单条结果。
 * @param id - 文档唯一标识。
 * @param rrfScore - RRF 融合分数,值越大越相关。
 * @param sourceScores - 各来源列表的原始分数(未出现的列表对应 undefined)。
 */
export interface FusedItem {
	id: string;
	rrfScore: number;
	sourceScores: (number | undefined)[];
}

/**
 * 默认 RRF 参数 k(Cormack et al. 2009 推荐值 60)。
 * k 越大,排名差异对分数的影响越平滑;越小,头部排名优势越明显。
 */
const DEFAULT_K = 60;

/**
 * Reciprocal Rank Fusion — 合并多个排序列表。
 *
 * 关键路径:
 * - RRF score = Σ 1/(k + rank),rank 从 0 开始(排名第 1 的项 rank=0)。
 * - 同一文档在多个列表中出现 → RRF 分数累加。
 * - sourceScores 记录该文档在各列表中的原始分数(未出现为 undefined),供调试。
 * - 按 RRF 分数降序排列,取 topK(若指定)。
 * - 分数相同时,按首次出现顺序保留稳定排序。
 *
 * @param lists - 多个排序列表(每个变体查询的搜索结果)。
 * @param k - RRF 参数,默认 60。
 * @param topK - 返回结果上限;未指定时返回全部。
 * @returns 融合后的排序列表,按 rrfScore 降序。
 */
export function reciprocalRankFusion(
	lists: RankedItem[][],
	k: number = DEFAULT_K,
	topK?: number,
): FusedItem[] {
	// 关键路径:空输入直接返回,避免后续逻辑出错。
	if (lists.length === 0) return [];

	// 用 Map 累加 RRF 分数,同时记录各来源原始分数。
	const scoreMap = new Map<string, { rrfScore: number; sourceScores: (number | undefined)[] }>();
	// 关键路径:记录首次出现顺序,保证分数相同时稳定排序。
	const order: string[] = [];

	lists.forEach((list, listIndex) => {
		list.forEach((item, rank) => {
			// 关键路径:rank 从 0 开始,排名第 1 的项贡献 1/(k+0) = 1/k。
			const contribution = 1 / (k + rank);
			let entry = scoreMap.get(item.id);
			if (!entry) {
				// 关键路径:初始化 sourceScores,长度等于列表数,全部填 undefined。
				entry = {
					rrfScore: 0,
					sourceScores: new Array(lists.length).fill(undefined),
				};
				scoreMap.set(item.id, entry);
				order.push(item.id);
			}
			entry.rrfScore += contribution;
			// 关键路径:记录该列表的原始分数(可能被同一列表多次出现覆盖,取最后一次)。
			entry.sourceScores[listIndex] = item.score;
		});
	});

	// 转数组并按 rrfScore 降序;分数相同时按首次出现顺序(稳定排序)。
	const result: FusedItem[] = order.map((id) => {
		const entry = scoreMap.get(id)!;
		return { id, rrfScore: entry.rrfScore, sourceScores: entry.sourceScores };
	});

	result.sort((a, b) => {
		if (b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore;
		// 关键路径:分数相同,保留首次出现顺序(稳定排序)。
		return order.indexOf(a.id) - order.indexOf(b.id);
	});

	return topK !== undefined ? result.slice(0, topK) : result;
}
