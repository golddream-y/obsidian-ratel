/**
 * @file tests/adapters/reranker-llm.test.ts
 * @description 对话模型精排适配器单元测试(输出解析 + 条目过滤 + 候选截断)
 * @module tests/adapters/reranker-llm
 * @depends src/adapters/reranker-llm, src/ports/llm
 */

import { describe, it, expect } from 'vitest';
import type { ChatDelta, ChatRequest, LLMClient } from '../../src/ports/llm';
import { LlmReranker } from '../../src/adapters/reranker-llm';

/**
 * 假 LLM：按给定文本分片流式吐出，并记录最近一次请求供断言。
 */
function fakeLlm(text: string): LLMClient & { calls: number; lastRequest: ChatRequest | null } {
	const client = {
		calls: 0,
		lastRequest: null as ChatRequest | null,
		supportsImages: false,
		countTokens(t: string): number {
			return t.length;
		},
		async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
			client.calls += 1;
			client.lastRequest = req;
			// 关键路径:分片吐出，模拟真实流式增量。
			for (const piece of text.match(/.{1,7}/gs) ?? []) {
				yield { text: piece };
			}
		},
	};
	return client;
}

describe('LlmReranker', () => {
	it('rerank - 解析模型返回的 JSON 数组', async () => {
		const llm = fakeLlm('[{"id":"a","score":0.9},{"id":"b","score":0.4}]');
		const r = new LlmReranker({ llm, maxCandidates: 12, maxCharsPerDoc: 400 });
		const out = await r.rerank('q', [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], 2);
		expect(out.map((x) => x.id)).toEqual(['a', 'b']);
		expect(out[0]!.score).toBe(0.9);
	});

	it('rerank - 输出带代码块与解释 - 只取最外层数组', async () => {
		const llm = fakeLlm('好的，结果如下：\n```json\n[{"id":"a","score":0.7}]\n```');
		const r = new LlmReranker({ llm, maxCandidates: 12, maxCharsPerDoc: 400 });
		const out = await r.rerank('q', [{ id: 'a', text: 'A' }], 1);
		expect(out).toEqual([{ id: 'a', score: 0.7 }]);
	});

	it('rerank - 解释里含方括号 - 仍能取到末尾的 JSON 数组', async () => {
		// 关键路径:解释里出现 [1] 这类方括号时,取首个 [ 会截出残片导致解析失败。
		const llm = fakeLlm('候选[1] 最相关，下面是排序：\n[{"id":"a","score":0.9}]');
		const r = new LlmReranker({ llm, maxCandidates: 12, maxCharsPerDoc: 400 });
		const out = await r.rerank('q', [{ id: 'a', text: 'A' }], 1);
		expect(out).toEqual([{ id: 'a', score: 0.9 }]);
	});

	it('rerank - 非法 JSON - 抛错交由调用方降级', async () => {
		const llm = fakeLlm('不是 json');
		const r = new LlmReranker({ llm, maxCandidates: 12, maxCharsPerDoc: 400 });
		await expect(r.rerank('q', [{ id: 'a', text: 'A' }], 1)).rejects.toThrow();
	});

	it('rerank - 输出不是数组 - 抛错', async () => {
		const llm = fakeLlm('{"id":"a","score":0.5}');
		const r = new LlmReranker({ llm, maxCandidates: 12, maxCharsPerDoc: 400 });
		await expect(r.rerank('q', [{ id: 'a', text: 'A' }], 1)).rejects.toThrow();
	});

	it('rerank - 条目字段类型不对 - 全部过滤后无有效条目抛错', async () => {
		const llm = fakeLlm('[{"id":"a","score":"高"}]');
		const r = new LlmReranker({ llm, maxCandidates: 12, maxCharsPerDoc: 400 });
		await expect(r.rerank('q', [{ id: 'a', text: 'A' }], 1)).rejects.toThrow();
	});

	it('rerank - 未知 id 被过滤 - 不进入结果', async () => {
		const llm = fakeLlm('[{"id":"a","score":0.9},{"id":"zzz","score":0.99}]');
		const r = new LlmReranker({ llm, maxCandidates: 12, maxCharsPerDoc: 400 });
		const out = await r.rerank('q', [{ id: 'a', text: 'A' }], 5);
		expect(out).toEqual([{ id: 'a', score: 0.9 }]);
	});

	it('rerank - 空候选 - 直接返回空数组且不调用模型', async () => {
		const llm = fakeLlm('[]');
		const r = new LlmReranker({ llm, maxCandidates: 12, maxCharsPerDoc: 400 });
		const out = await r.rerank('q', [], 3);
		expect(out).toEqual([]);
		expect(llm.calls).toBe(0);
	});

	it('rerank - 候选超过上限 - 只送前 maxCandidates 条', async () => {
		const llm = fakeLlm('[{"id":"a","score":0.9}]');
		const r = new LlmReranker({ llm, maxCandidates: 2, maxCharsPerDoc: 400 });
		await r.rerank(
			'q',
			[
				{ id: 'a', text: 'A' },
				{ id: 'b', text: 'B' },
				{ id: 'c', text: 'C' },
			],
			3,
		);
		const sent = llm.lastRequest?.messages.at(-1)?.content ?? '';
		expect(sent).toContain('id=a');
		expect(sent).toContain('id=b');
		expect(sent).not.toContain('id=c');
	});

	it('rerank - 正文超长 - 截断到 maxCharsPerDoc', async () => {
		const llm = fakeLlm('[{"id":"a","score":0.9}]');
		const r = new LlmReranker({ llm, maxCandidates: 12, maxCharsPerDoc: 5 });
		await r.rerank('q', [{ id: 'a', text: '0123456789' }], 1);
		const sent = llm.lastRequest?.messages.at(-1)?.content ?? '';
		expect(sent).toContain('01234');
		expect(sent).not.toContain('0123456789');
	});

	it('rerank - 结果多于 topK - 按分数降序取前 topK', async () => {
		const llm = fakeLlm('[{"id":"a","score":0.1},{"id":"b","score":0.8},{"id":"c","score":0.5}]');
		const r = new LlmReranker({ llm, maxCandidates: 12, maxCharsPerDoc: 400 });
		const out = await r.rerank(
			'q',
			[
				{ id: 'a', text: 'A' },
				{ id: 'b', text: 'B' },
				{ id: 'c', text: 'C' },
			],
			2,
		);
		expect(out.map((x) => x.id)).toEqual(['b', 'c']);
	});

	it('rerank - 请求带提示词 - 要求只输出 JSON 数组', async () => {
		const llm = fakeLlm('[{"id":"a","score":0.9}]');
		const r = new LlmReranker({ llm, maxCandidates: 12, maxCharsPerDoc: 400 });
		await r.rerank('q', [{ id: 'a', text: 'A' }], 1);
		const messages = llm.lastRequest?.messages ?? [];
		expect(messages[0]?.role).toBe('system');
		expect(messages[0]?.content).toContain('JSON');
		expect(messages.at(-1)?.content).toContain('q');
		expect(llm.lastRequest?.options?.maxTokens).toBe(400);
	});
});
