/**
 * @file src/adapters/reranker-llm.ts
 * @description 用当前对话模型做精排 — 产出与专用 rerank 模型同构的 { id, score }
 * @module adapters/reranker-llm
 * @depends ports/llm, ports/reranker
 */

import type { ChatMessage, LLMClient } from '../ports/llm';
import type { RerankerPort } from '../ports/reranker';

/**
 * 对话模型精排器构造选项。
 *
 * @param llm - 当前对话模型客户端(复用已有供应商,不新增外发目的地)。
 * @param maxCandidates - 最多送多少条候选。
 * @param maxCharsPerDoc - 单条正文最多截取多少字符。
 */
export interface LlmRerankerOptions {
	llm: LLMClient;
	/** 最多送多少条候选。 */
	maxCandidates: number;
	/** 单条正文最多截取多少字符。 */
	maxCharsPerDoc: number;
}

/**
 * 用对话模型做精排的适配器。
 *
 * 设计要点:
 * - 产出与专用 rerank 模型同构的 `{ id, score }`,调用方无需区分来源。
 * - 提示词要求模型只输出 JSON 数组,解析失败一律抛错交由调用方降级,
 *   不用"猜一个顺序"冒充精排结果。
 *
 * @example
 *   const reranker = new LlmReranker({ llm, maxCandidates: 12, maxCharsPerDoc: 400 });
 *   const ranked = await reranker.rerank('query', [{ id: 'a', text: '...' }], 5);
 */
export class LlmReranker implements RerankerPort {
	constructor(private options: LlmRerankerOptions) {}

	/**
	 * 调用对话模型对候选文档做精排。
	 *
	 * 关键路径:
	 * - 空候选直接返回空数组,不发请求。
	 * - 候选截到 maxCandidates、单条正文截到 maxCharsPerDoc,控制 token 成本。
	 * - 从模型输出中截取最外层数组再 JSON.parse;解析失败 / 不是数组 / 无有效条目一律抛错,
	 *   由调用方决定降级策略,不用原始顺序冒充精排分数。
	 *
	 * @param query - 用户查询。
	 * @param documents - 候选文档(id + 全文)。
	 * @param topK - 返回数量上限。
	 * @returns 精排结果(id + score),按 score 降序,数量不超过 topK。
	 * @throws 模型输出无法解析为打分数组时抛错(内部诊断信息,非用户文案)。
	 */
	async rerank(
		query: string,
		documents: Array<{ id: string; text: string }>,
		topK: number,
	): Promise<Array<{ id: string; score: number }>> {
		// 关键路径:候选过多会让 prompt 超出上下文,先截断。
		const candidates = documents.slice(0, this.options.maxCandidates);
		if (candidates.length === 0) return [];

		const list = candidates
			.map(
				(d, i) =>
					`[${i + 1}] id=${d.id}\n${d.text.slice(0, this.options.maxCharsPerDoc)}`,
			)
			.join('\n\n');

		const messages: ChatMessage[] = [
			{
				role: 'system',
				content:
					'你是检索精排器。按与查询的相关性给候选打分，0 到 1，越高越相关。' +
					'只输出 JSON 数组，形如 [{"id":"…","score":0.87}]，不要解释，不要代码块。',
			},
			{ role: 'user', content: `查询：${query}\n\n候选：\n${list}` },
		];

		let output = '';
		// 关键路径:流式收集,只取文本增量(与 query-rewriter 的收集写法一致)。
		const stream = this.options.llm.chat({ messages, options: { maxTokens: 400 } });
		for await (const delta of stream) {
			if (delta.text) output += delta.text;
		}

		// 关键路径:模型可能裹代码块或加解释,只取最外层数组。
		// 解析顺序:整段 → 首个 [ 到末尾 ] → 末个 [ 到末尾 ]。
		// 首个 [ 的做法在解释里含方括号时会取错起点(取到 "[1] 说明 … [{…}]" 这种残片),
		// 整段与末个 [ 各补一种常见形态;都失败就抛错,交由调用方降级。
		const parsed = parseScoredArray(output);
		if (parsed === null) throw new Error('rerank: 模型输出不是合法 JSON');

		const known = new Set(candidates.map((d) => d.id));
		const scored = parsed
			.filter(
				(x): x is { id: string; score: number } =>
					typeof x === 'object' &&
					x !== null &&
					typeof (x as { id?: unknown }).id === 'string' &&
					typeof (x as { score?: unknown }).score === 'number',
			)
			.filter((x) => known.has(x.id))
			.map((x) => ({ id: x.id, score: x.score }));

		// 关键路径:一条有效打分都没有时抛错,不能拿候选原顺序假装精排成功。
		if (scored.length === 0) throw new Error('rerank: 没有可用的打分结果');

		return scored.sort((a, b) => b.score - a.score).slice(0, topK);
	}
}

/**
 * 从模型输出里取出打分数组。
 *
 * 关键路径:依次尝试三种常见形态,返回第一个能解析成数组的结果;
 * 都不是数组时返回 null,由调用方抛错。
 *
 * @param output - 模型原始输出。
 * @returns 解析出的数组,或 null。
 */
function parseScoredArray(output: string): unknown[] | null {
	const attempts: string[] = [];
	const first = output.indexOf('[');
	const last = output.lastIndexOf('[');
	const end = output.lastIndexOf(']');

	attempts.push(output.trim());
	if (first >= 0 && end > first) attempts.push(output.slice(first, end + 1));
	if (last >= 0 && end > last && last !== first) attempts.push(output.slice(last, end + 1));

	for (const text of attempts) {
		try {
			const parsed: unknown = JSON.parse(text);
			// 关键路径:Array.isArray 会把 unknown 收窄成 any[],显式转回 unknown[] 避免把 any 带出去。
			if (Array.isArray(parsed)) return parsed as unknown[];
		} catch {
			// 关键路径:换下一种形态再试。
		}
	}
	return null;
}
