/**
 * @file tests/integration/rag-loop.test.ts
 * @description L3 集成测试 — RAG 对话闭环:用户提问 → search_vault → read_note → 最终回答
 * @module tests/integration/rag-loop
 * @depends src/core/agent-loop, src/core/context-manager, src/core/tool-registry, src/core/hooks, src/tools/search-vault, src/tools/read-note
 */

import { describe, it, expect, vi } from 'vitest';
import { agentLoop } from '../../src/core/agent-loop';
import { ContextManager } from '../../src/core/context-manager';
import { ToolRegistry } from '../../src/core/tool-registry';
import { HookRegistry } from '../../src/core/hooks';
import { createSearchVaultTool } from '../../src/tools/search-vault';
import { createReadNoteTool } from '../../src/tools/read-note';
import type { LLMClient, ToolCall, ChatRequest, ChatDelta } from '../../src/ports/llm';
import type { VectorSearchResult } from '../../src/ports/vector';
import type { Persistence, Session } from '../../src/ports/persistence';
import type { VaultPort } from '../../src/ports/vault';
import type { AgentEvent } from '../../src/types';

function createMockPersistence(sessions: Map<string, Session> = new Map()): Persistence {
	return {
		sessions: {
			get: async (id: string) => sessions.get(id) ?? null,
			upsert: async (session: Session) => { sessions.set(session.id, session); },
			list: async () => Array.from(sessions.values()),
			delete: async () => {},
		},
		notes: { get: async () => null, upsert: async () => {}, listByPath: async () => [], delete: async () => {} },
		hooks: { append: async () => {}, list: async () => [] },
	};
}

describe('RAG loop integration', () => {
	it('RAG 链路 - 用户提问 → search_vault → read_note → 回答', async () => {
		const sessions = new Map<string, Session>();
		const persistence = createMockPersistence(sessions);
		const ctx = new ContextManager(persistence);

		const vault: VaultPort = {
			readFile: vi.fn(async () => '项目使用 TypeScript + esbuild'),
			getMetadata: vi.fn(() => null),
			getBacklinks: vi.fn(() => new Map()),
			writeFile: vi.fn(),
			listMarkdownFiles: vi.fn(() => []),
		};

		// 关键路径:W4 — search_vault 内部改调 MultiQuerySearcher,这里用 mock searcher 返回固定结果
		const searcher = {
			search: vi.fn(async () => [
				{ docId: 'notes/project.md#chunk-0', score: 0.9, metadata: { path: 'notes/project.md', chunkIndex: 0 } },
			] as VectorSearchResult[]),
		};

		const tools = new ToolRegistry();
		tools.register(createSearchVaultTool(searcher as never, () => true));
		tools.register(createReadNoteTool(vault));

		const toolCalls: ToolCall[] = [
			{ id: 'call_1', name: 'search_vault', args: { query: '技术栈', topK: 3 } },
			{ id: 'call_2', name: 'read_note', args: { path: 'notes/project.md' } },
		];
		let callIndex = 0;

		const llm: LLMClient = {
			async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
				const tc = toolCalls[callIndex++];
				if (tc) {
					yield { text: '' };
					yield { text: '', toolCall: tc };
				} else {
					yield { text: '项目使用 TypeScript + esbuild' };
				}
			},
			countTokens: () => 10,
		};

		const hooks = new HookRegistry();
		const events: AgentEvent[] = [];
		for await (const e of agentLoop({ sessionId: 's1', message: '项目用什么技术栈?' }, ctx, llm, tools, hooks)) {
			events.push(e);
		}

		expect(events).toContainEqual(expect.objectContaining({ type: 'tool.call', payload: expect.objectContaining({ name: 'search_vault' }) }));
		expect(events).toContainEqual(expect.objectContaining({ type: 'tool.call', payload: expect.objectContaining({ name: 'read_note' }) }));
		expect(events).toContainEqual(expect.objectContaining({ type: 'tool.result', payload: expect.objectContaining({ name: 'read_note' }) }));
		expect(events.some((e) => e.type === 'message.end')).toBe(true);

		// 关键路径:验证最终 session 中同时保留了工具调用、工具结果与 assistant 最终回答。
		const session = sessions.get('s1');
		expect(session).toBeDefined();
		const messageRoles = session!.messages.map((m) => m.role);
		expect(messageRoles).toContain('user');
		expect(messageRoles).toContain('assistant');
		expect(messageRoles).toContain('tool');
	});
});
