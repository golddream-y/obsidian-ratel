/**
 * @file src/core/agent-loop-vision.test.ts
 * @description VISION_UNSUPPORTED 探测测试 — 含图且模型不支持时轮次终止(S-VISION)
 * @module core/agent-loop-vision.test
 */
import { describe, it, expect } from 'vitest';
import { agentLoop } from './agent-loop';
import { ContextManager } from './context-manager';
import type { Persistence } from '../ports/persistence';
import type { LLMClient, ChatRequest, ChatDelta } from '../ports/llm';

function makeLlm(opts: { supportsImages: boolean; chatCalls?: number[] }): LLMClient {
	return {
		supportsImages: opts.supportsImages,
		async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
			opts.chatCalls?.push(req.messages.length);
			yield { text: 'ok' };
		},
		countTokens: (t: string) => Math.ceil(t.length / 4),
	};
}

const emptyRegistry = { definitions: () => [], execute: async () => ({}) } as never;
const emptyHooks = { runPre: async () => {}, runPost: async () => {} } as never;

async function collect(iter: AsyncIterable<{ type: string; payload?: unknown }>) {
	const out = [];
	for await (const ev of iter) out.push(ev);
	return out;
}

describe('agent-loop vision 探测', () => {
	it('含图 + 模型不支持 - yield VISION_UNSUPPORTED - 不调 LLM', async () => {
		const chatCalls: number[] = [];
		const llm = makeLlm({ supportsImages: false, chatCalls });
		const events = await collect(
			agentLoop(
				{ sessionId: 's', message: '看图', attachments: [{ id: 'h1', mimeType: 'image/png', base64: 'aGk=' }] },
				makeCtx(),
				llm,
				emptyRegistry,
				emptyHooks,
			),
		);
		expect(chatCalls).toEqual([]);
		expect(events.some((e) => e.type === 'error' && (e.payload as { code: string }).code === 'VISION_UNSUPPORTED')).toBe(true);
	});

	it('含图 + 模型支持 - 正常进 LLM - 无 VISION_UNSUPPORTED', async () => {
		const chatCalls: number[] = [];
		const llm = makeLlm({ supportsImages: true, chatCalls });
		const events = await collect(
			agentLoop(
				{ sessionId: 's', message: '看图', attachments: [{ id: 'h1', mimeType: 'image/png', base64: 'aGk=' }] },
				makeCtx(),
				llm,
				emptyRegistry,
				emptyHooks,
			),
		);
		expect(chatCalls.length).toBeGreaterThan(0);
		expect(events.some((e) => e.type === 'error' && (e.payload as { code: string }).code === 'VISION_UNSUPPORTED')).toBe(false);
	});

	it('无图 + 模型不支持 - 正常进 LLM', async () => {
		const chatCalls: number[] = [];
		const llm = makeLlm({ supportsImages: false, chatCalls });
		await collect(
			agentLoop(
				{ sessionId: 's', message: '纯文本' },
				makeCtx(),
				llm,
				emptyRegistry,
				emptyHooks,
			),
		);
		expect(chatCalls.length).toBeGreaterThan(0);
	});
});

// 与 Task 2 同款 fake Persistence + ContextManager 构造
function makeCtx(): ContextManager {
	const empty: Persistence = {
		sessions: {
			get: async () => ({ id: 's', title: '', messages: [], createdAt: 0, updatedAt: 0 }),
			upsert: async () => {},
			list: async () => [],
			delete: async () => {},
		},
		notes: { get: async () => null, upsert: async () => {}, listByPath: async () => [], delete: async () => {} },
		hooks: { append: async () => {}, list: async () => [] },
		getLastSessionId: async () => null,
		setLastSessionId: async () => {},
		listSessionIndex: async () => [],
	};
	return new ContextManager(empty, undefined, 8000);
}
