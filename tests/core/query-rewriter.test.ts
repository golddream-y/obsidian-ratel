/**
 * @file tests/core/query-rewriter.test.ts
 * @description 查询改写器单元测试
 * @module tests/core/query-rewriter
 */

import { describe, it, expect, vi } from 'vitest';
import { rewriteQuery } from '../../src/core/query-rewriter';
import type { LLMClient, ChatRequest, ChatDelta } from '../../src/ports/llm';

function createMockLLM(streamOutput: string): LLMClient {
	return {
		async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
			yield { text: streamOutput };
		},
		countTokens: () => 10,
	};
}

function createMockLLMThrowing(): LLMClient {
	return {
		async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
			// 关键路径:产出空帧后抛错 — 空帧被实现的 if(delta.text) 跳过,
			// 抛错触发 catch 降级;空帧仅为满足 require-yield,不改变可观察行为
			yield { text: '' };
			throw new Error('LLM unavailable');
		},
		countTokens: () => 10,
	};
}

describe('rewriteQuery', () => {
	it('rewriteQuery - LLM 返回两个变体 - 返回 original + 2 个改写', async () => {
		// 关键路径:LLM 流式返回两行改写,每行一个变体
		const llm = createMockLLM('使用什么技术栈\n项目用了哪些框架\n');
		const result = await rewriteQuery('项目技术栈是什么', { llm });

		// 关键路径:原始查询始终保留在首位,variant='original'
		expect(result).toHaveLength(3);
		expect(result[0]!.text).toBe('项目技术栈是什么');
		expect(result[0]!.variant).toBe('original');
		expect(result[1]!.text).toBe('使用什么技术栈');
		expect(result[1]!.variant).toBe('rewrite-1');
		expect(result[2]!.text).toBe('项目用了哪些框架');
		expect(result[2]!.variant).toBe('rewrite-2');
	});

	it('rewriteQuery - LLM 返回空 - 降级为只返回原始查询', async () => {
		// 关键路径:LLM 返回空字符串,无法解析出改写,降级
		const llm = createMockLLM('');
		const result = await rewriteQuery('问题', { llm });

		expect(result).toHaveLength(1);
		expect(result[0]!.text).toBe('问题');
		expect(result[0]!.variant).toBe('original');
	});

	it('rewriteQuery - LLM 抛错 - 降级为只返回原始查询', async () => {
		// 关键路径:LLM 异常不阻断主流程,降级为原始查询
		const llm = createMockLLMThrowing();
		const result = await rewriteQuery('问题', { llm });

		expect(result).toHaveLength(1);
		expect(result[0]!.variant).toBe('original');
	});

	it('rewriteQuery - 调用 LLM 时 maxTokens=100', async () => {
		// 关键路径:验证 maxTokens 限制,2 个改写 * ~50 tokens = 100
		const chatSpy = vi.fn();
		const llm: LLMClient = {
			async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
				chatSpy(req);
				yield { text: '变体1\n变体2\n' };
			},
			countTokens: () => 10,
		};
		await rewriteQuery('问题', { llm });
		expect(chatSpy).toHaveBeenCalledWith(expect.objectContaining({
			options: expect.objectContaining({ maxTokens: 100 }),
		}));
	});

	it('rewriteQuery - LLM 返回带编号 - 去除编号前缀', async () => {
		// 关键路径:LLM 可能返回 "1. 变体1\n2. 变体2",需去除编号前缀
		const llm = createMockLLM('1. 使用什么技术栈\n2. 项目用了哪些框架\n');
		const result = await rewriteQuery('技术栈', { llm });

		expect(result).toHaveLength(3);
		expect(result[1]!.text).toBe('使用什么技术栈');
		expect(result[2]!.text).toBe('项目用了哪些框架');
	});
});
