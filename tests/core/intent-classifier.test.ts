/**
 * @file tests/core/intent-classifier.test.ts
 * @description 意图分类器单元测试
 * @module tests/core/intent-classifier
 */

import { describe, it, expect, vi } from 'vitest';
import { classifyIntent } from '../../src/core/intent-classifier';
import type { LLMClient, ChatRequest, ChatDelta } from '../../src/ports/llm';

function createMockLLM(streamOutput: string): LLMClient {
	return {
		async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
			// 关键路径:模拟 LLM 流式返回意图判断结果
			yield { text: streamOutput };
		},
		countTokens: () => 10,
	};
}

function createMockLLMThrowing(): LLMClient {
	return {
		async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
			// 关键路径:产出空帧后抛错 — 空帧被实现的 if(delta.text) 跳过,
			// 抛错触发 catch 降级为 rag;空帧仅为满足 require-yield,不改变可观察行为
			yield { text: '' };
			throw new Error('LLM unavailable');
		},
		countTokens: () => 10,
	};
}

describe('classifyIntent', () => {
	it('classifyIntent - LLM 返回 rag - 返回 rag', async () => {
		const llm = createMockLLM('rag');
		const intent = await classifyIntent('我的笔记里有什么关于 X 的内容?', { llm });
		expect(intent).toBe('rag');
	});

	it('classifyIntent - LLM 返回 direct - 返回 direct', async () => {
		const llm = createMockLLM('direct');
		const intent = await classifyIntent('帮我写一个模板', { llm });
		expect(intent).toBe('direct');
	});

	it('classifyIntent - LLM 返回带前后空白 - trim 后判断', async () => {
		const llm = createMockLLM('  rag\n');
		const intent = await classifyIntent('问题', { llm });
		expect(intent).toBe('rag');
	});

	it('classifyIntent - LLM 返回非预期值 - 降级为 rag', async () => {
		// 关键路径:LLM 输出不符合 rag/direct,降级为 rag(宁可多搜不漏)
		const llm = createMockLLM('我不确定');
		const intent = await classifyIntent('问题', { llm });
		expect(intent).toBe('rag');
	});

	it('classifyIntent - LLM 抛错 - 降级为 rag', async () => {
		// 关键路径:LLM 异常时降级为 rag,不阻断主流程
		const llm = createMockLLMThrowing();
		const intent = await classifyIntent('问题', { llm });
		expect(intent).toBe('rag');
	});

	it('classifyIntent - 调用 LLM 时 maxTokens=5', async () => {
		// 关键路径:验证 maxTokens 限制,降低 token 成本
		const chatSpy = vi.fn();
		const llm: LLMClient = {
			async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
				chatSpy(req);
				yield { text: 'rag' };
			},
			countTokens: () => 10,
		};
		await classifyIntent('问题', { llm });
		expect(chatSpy).toHaveBeenCalledWith(expect.objectContaining({
			options: expect.objectContaining({ maxTokens: 5 }),
		}));
	});
});
