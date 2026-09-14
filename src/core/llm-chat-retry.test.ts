/**
 * @file src/core/llm-chat-retry.test.ts
 * @description 对话模型网络重试 — 可恢复判定与包装器
 * @module core/llm-chat-retry.test
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { LLMClient, ChatDelta, ChatRequest } from '../ports/llm';
import { isRetryableLlmFailure, wrapLlmChatRetry } from './llm-chat-retry';

function err503(): Error & { status: number } {
	const e = new Error('LLM API error: 503 gateway') as Error & { status: number };
	e.status = 503;
	return e;
}

async function collect(iter: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
	const out: ChatDelta[] = [];
	for await (const d of iter) out.push(d);
	return out;
}

describe('isRetryableLlmFailure', () => {
	const retryable = { yielded: false, aborted: false };

	it('429 / 503 / ECONNRESET 且未 yield - 可重试', () => {
		expect(isRetryableLlmFailure({ status: 429, message: 'LLM API error: 429 x' }, retryable)).toBe(true);
		expect(isRetryableLlmFailure(err503(), retryable)).toBe(true);
		const net = new Error('read ECONNRESET') as Error & { code: string };
		net.code = 'ECONNRESET';
		expect(isRetryableLlmFailure(net, retryable)).toBe(true);
	});

	it('401 - 不可重试', () => {
		expect(isRetryableLlmFailure({ status: 401, message: 'LLM API error: 401 x' }, retryable)).toBe(false);
	});

	it('已 yield 后断流 - 不可重试', () => {
		expect(isRetryableLlmFailure(err503(), { yielded: true, aborted: false })).toBe(false);
	});

	it('用户取消 - 不可重试', () => {
		expect(isRetryableLlmFailure(new Error('请求已取消'), { yielded: false, aborted: true })).toBe(false);
		expect(isRetryableLlmFailure(new Error('请求已取消'), retryable)).toBe(false);
	});

	it('CONTEXT_OVERFLOW / prompt too long - 不可重试', () => {
		expect(isRetryableLlmFailure(new Error('CONTEXT_OVERFLOW'), retryable)).toBe(false);
		expect(isRetryableLlmFailure(new Error('prompt too long'), retryable)).toBe(false);
	});
});

describe('wrapLlmChatRetry', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	function fakeLlm(plan: Array<'503' | 'ok' | 'yield-then-fail'>): LLMClient & { calls: number } {
		const client = {
			calls: 0,
			supportsImages: false,
			countTokens(text: string) {
				return text.length;
			},
			async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
				client.calls += 1;
				const step = plan[client.calls - 1] ?? 'ok';
				if (step === '503') throw err503();
				if (step === 'yield-then-fail') {
					yield { text: 'hi' };
					throw new Error('socket hang up');
				}
				yield { text: 'ok' };
			},
		};
		return client;
	}

	it('前两次 503 第三次成功 - 调用方只看到成功流', async () => {
		vi.useFakeTimers();
		const inner = fakeLlm(['503', '503', 'ok']);
		const wrapped = wrapLlmChatRetry(inner);
		const pending = collect(wrapped.chat({ messages: [] }));
		await vi.runAllTimersAsync();
		await expect(pending).resolves.toEqual([{ text: 'ok' }]);
		expect(inner.calls).toBe(3);
	});

	it('第一次 yield 后抛错 - 不再第二次调用', async () => {
		const inner = fakeLlm(['yield-then-fail']);
		const wrapped = wrapLlmChatRetry(inner);
		await expect(collect(wrapped.chat({ messages: [] }))).rejects.toThrow(/socket hang up/);
		expect(inner.calls).toBe(1);
	});

	it('等待退避期间 abort - 不再发下一次请求', async () => {
		vi.useFakeTimers();
		const inner = fakeLlm(['503', 'ok']);
		const wrapped = wrapLlmChatRetry(inner);
		const ac = new AbortController();
		const pending = collect(wrapped.chat({ messages: [], signal: ac.signal }));
		await vi.advanceTimersByTimeAsync(0);
		ac.abort();
		await expect(pending).rejects.toThrow(/请求已取消/);
		expect(inner.calls).toBe(1);
	});

	it('onRetryWait - 第二次成功 yield - 序列 backoff request null', async () => {
		vi.useFakeTimers();
		const inner = fakeLlm(['503', 'ok']);
		const wrapped = wrapLlmChatRetry(inner);
		const seq: unknown[] = [];
		const pending = collect(
			wrapped.chat({
				messages: [],
				onRetryWait: (s) => {
					seq.push(s);
				},
			}),
		);
		await vi.runAllTimersAsync();
		await expect(pending).resolves.toEqual([{ text: 'ok' }]);
		expect(seq).toEqual([
			{ phase: 'backoff', attempt: 2, maxAttempts: 3, delayMs: 500 },
			{ phase: 'request', attempt: 2, maxAttempts: 3 },
			null,
		]);
	});

	it('onRetryWait - 退避中 abort - 收到 null 且不再请求', async () => {
		vi.useFakeTimers();
		const inner = fakeLlm(['503', 'ok']);
		const wrapped = wrapLlmChatRetry(inner);
		const seq: unknown[] = [];
		const ac = new AbortController();
		const pending = collect(
			wrapped.chat({
				messages: [],
				signal: ac.signal,
				onRetryWait: (s) => {
					seq.push(s);
				},
			}),
		);
		await vi.advanceTimersByTimeAsync(0);
		ac.abort();
		await expect(pending).rejects.toThrow(/请求已取消/);
		expect(inner.calls).toBe(1);
		expect(seq[seq.length - 1]).toBe(null);
		expect(seq.some((s) => s && typeof s === 'object' && (s as { phase: string }).phase === 'request')).toBe(false);
	});
});
