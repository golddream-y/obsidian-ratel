import { describe, it, expect, vi } from 'vitest';
import { agentLoop } from '../../src/core/agent-loop';
import { ContextManager } from '../../src/core/context-manager';
import { ToolRegistry } from '../../src/core/tool-registry';
import { HookRegistry } from '../../src/core/hooks';
import type { LLMClient, ChatRequest, ChatDelta, ToolCall } from '../../src/ports/llm';
import type { Persistence, Session } from '../../src/ports/persistence';
import type { AgentEvent } from '../../src/types';

function createMockPersistence(sessions: Map<string, Session> = new Map()): Persistence {
	return {
		sessions: {
			get: async (id: string) => sessions.get(id) ?? null,
			upsert: async (session: Session) => { sessions.set(session.id, session); },
			list: async () => [],
			delete: async () => {},
		},
		notes: {
			get: async () => null,
			upsert: async () => {},
			listByPath: async () => [],
			delete: async () => {},
		},
		hooks: {
			append: async () => {},
			list: async () => [],
		},
	};
}

function createMockLLM(responses: ChatDelta[][]): LLMClient {
	let callIndex = 0;
	return {
		async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
			const response = responses[callIndex++] ?? [];
			for (const delta of response) {
				yield delta;
			}
		},
		embed: async () => [],
		countTokens: () => 10,
	};
}

describe('agentLoop', () => {
	it('yields message events for a simple response', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		const llm = createMockLLM([
			[
				{ text: 'Hello' },
				{ text: ' world' },
			],
		]);
		const tools = new ToolRegistry();
		const hooks = new HookRegistry();

		const events: AgentEvent[] = [];
		for await (const event of agentLoop(
			{ sessionId: 's1', message: 'Hi' },
			ctx,
			llm,
			tools,
			hooks,
		)) {
			events.push(event);
		}

		expect(events.some((e) => e.type === 'message.start')).toBe(true);
		expect(events.filter((e) => e.type === 'message.delta')).toHaveLength(2);
		expect(events.some((e) => e.type === 'message.end')).toBe(true);
	});

	it('handles tool call and continues loop', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);

		const toolCall: ToolCall = {
			id: 'call_1',
			name: 'read_note',
			args: { path: 'test.md' },
		};

		const llm = createMockLLM([
			[{ text: '', toolCall }],
			[{ text: 'The note says hello' }],
		]);

		const tools = new ToolRegistry();
		tools.register({
			definition: { name: 'read_note', description: 'Read a note', parameters: {} },
			execute: async () => 'Content of test.md',
		});

		const hooks = new HookRegistry();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(
			{ sessionId: 's1', message: 'Read test.md' },
			ctx,
			llm,
			tools,
			hooks,
		)) {
			events.push(event);
		}

		expect(events.some((e) => e.type === 'tool.call')).toBe(true);
		expect(events.some((e) => e.type === 'tool.result')).toBe(true);
		expect(events.some((e) => e.type === 'message.end')).toBe(true);
	});

	it('respects MAX_STEPS limit', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);

		const infiniteToolCall: ToolCall = {
			id: 'call_loop',
			name: 'read_note',
			args: { path: 'loop.md' },
		};

		const llm = createMockLLM(
			Array(20).fill([{ text: '', toolCall: infiniteToolCall }]),
		);

		const tools = new ToolRegistry();
		tools.register({
			definition: { name: 'read_note', description: 'Read', parameters: {} },
			execute: async () => 'content',
		});

		const hooks = new HookRegistry();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(
			{ sessionId: 's1', message: 'Loop test' },
			ctx,
			llm,
			tools,
			hooks,
		)) {
			events.push(event);
		}

		const toolCallCount = events.filter((e) => e.type === 'tool.call').length;
		expect(toolCallCount).toBeLessThanOrEqual(10);
	});

	it('saves session after completion', async () => {
		const sessions = new Map<string, Session>();
		const persistence = createMockPersistence(sessions);
		const ctx = new ContextManager(persistence);
		const llm = createMockLLM([[{ text: 'Done' }]]);
		const tools = new ToolRegistry();
		const hooks = new HookRegistry();

		for await (const _ of agentLoop(
			{ sessionId: 's1', message: 'Hi' },
			ctx,
			llm,
			tools,
			hooks,
		)) {
			// consume
		}

		expect(sessions.has('s1')).toBe(true);
	});

	it('fires pre-tool-use and post-tool-use for readOnly tools', async () => {
		const hooks = new HookRegistry();
		const hookCalls: string[] = [];
		hooks.register('pre-tool-use', async () => { hookCalls.push('pre-tool-use'); });
		hooks.register('post-tool-use', async () => { hookCalls.push('post-tool-use'); });

		const tools = new ToolRegistry();
		tools.register({
			definition: { name: 'read_only_tool', description: 'test', parameters: { type: 'object', properties: {} } },
			execute: async () => 'result',
			readOnly: true,
		});

		const llm = createMockLLM([
			[{ text: '', toolCall: { id: 'tc1', name: 'read_only_tool', args: {} } }],
			[{ text: 'Done' }],
		]);

		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		for await (const _ of agentLoop({ sessionId: 'test', message: 'hi' }, ctx, llm, tools, hooks)) {
			// consume
		}

		expect(hookCalls).toEqual(['pre-tool-use', 'post-tool-use']);
	});

	it('fires pre-tool-use and post-tool-use for write tools', async () => {
		const hooks = new HookRegistry();
		const hookCalls: string[] = [];
		hooks.register('pre-tool-use', async () => { hookCalls.push('pre-tool-use'); });
		hooks.register('post-tool-use', async () => { hookCalls.push('post-tool-use'); });

		const tools = new ToolRegistry();
		tools.register({
			definition: { name: 'write_tool', description: 'test', parameters: { type: 'object', properties: {} } },
			execute: async () => 'result',
			readOnly: false,
		});

		const llm = createMockLLM([
			[{ text: '', toolCall: { id: 'tc1', name: 'write_tool', args: {} } }],
			[{ text: 'Done' }],
		]);

		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		for await (const _ of agentLoop({ sessionId: 'test', message: 'hi' }, ctx, llm, tools, hooks)) {
			// consume
		}

		expect(hookCalls).toEqual(['pre-tool-use', 'post-tool-use']);
	});

	it('pre-tool-use deny - 写入 session 错误并继续循环', async () => {
		const hooks = new HookRegistry();
		hooks.register('pre-tool-use', async () => ({ allow: false, reason: 'blocked by policy' }));

		const tools = new ToolRegistry();
		tools.register({
			definition: { name: 'write_tool', description: 'test', parameters: {} },
			execute: async () => 'should not run',
			readOnly: false,
		});

		const llm = createMockLLM([
			[{ text: '', toolCall: { id: 'tc1', name: 'write_tool', args: { path: 'a.md' } } }],
			[{ text: 'Understood' }],
		]);

		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(
			{ sessionId: 'test', message: 'hi' },
			ctx,
			llm,
			tools,
			hooks,
		)) {
			events.push(event);
		}

		expect(events.some((e) => e.type === 'error' && e.payload.code === 'TOOL_DENIED')).toBe(true);
		expect(events.some((e) => e.type === 'tool.result')).toBe(false);
	});

	it('handles tool execution error gracefully', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);

		const toolCall: ToolCall = {
			id: 'call_1',
			name: 'read_note',
			args: { path: 'missing.md' },
		};

		// First LLM response: tool call, second: final answer
		const llm = createMockLLM([
			[{ text: '', toolCall }],
			[{ text: 'Sorry, I could not find that note.' }],
		]);

		const tools = new ToolRegistry();
		tools.register({
			definition: { name: 'read_note', description: 'Read a note', parameters: {} },
			execute: async () => { throw new Error('File not found: missing.md'); },
		});

		const hooks = new HookRegistry();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(
			{ sessionId: 's1', message: 'Read missing.md' },
			ctx,
			llm,
			tools,
			hooks,
		)) {
			events.push(event);
		}

		// Should have error event but continue the loop
		expect(events.some((e) => e.type === 'error')).toBe(true);
		// Should still have tool.call and tool.result
		expect(events.some((e) => e.type === 'tool.call')).toBe(true);
		expect(events.some((e) => e.type === 'tool.result')).toBe(true);
		// Should still end normally
		expect(events.some((e) => e.type === 'message.end')).toBe(true);
	});

	it('saves session when LLM stream errors mid-way', async () => {
		const saveSpy = vi.fn();
		const mockPersistence = {
			sessions: {
				get: vi.fn().mockResolvedValue(null),
				upsert: saveSpy,
			},
		} as unknown as Persistence;
		const ctx = new ContextManager(mockPersistence);

		const llm = {
			chat: vi.fn().mockImplementation(async function* () {
				yield { text: 'Partial ' };
				yield { text: 'response' };
				throw new Error('Network error');
			}),
			countTokens: vi.fn().mockReturnValue(0),
		};

		const tools = new ToolRegistry();
		const hooks = new HookRegistry();

		const events: string[] = [];
		for await (const e of agentLoop({ sessionId: 's1', message: 'hi' }, ctx, llm as unknown as LLMClient, tools, hooks)) {
			events.push(e.type);
		}

		// Should yield error event and still save session
		expect(events).toContain('error');
		expect(saveSpy).toHaveBeenCalled();
	});

	it('handles multiple rounds of tool calls (2+ steps)', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);

		const toolCallCount = { count: 0 };
		const tools = new ToolRegistry();
		tools.register({
			definition: { name: 'counter', description: '', parameters: { type: 'object', properties: {} } },
			execute: async () => {
				toolCallCount.count++;
				return `result-${toolCallCount.count}`;
			},
			readOnly: true,
		});

		let callCount = 0;
		const llm = {
			chat: vi.fn().mockImplementation(async function* () {
				callCount++;
				if (callCount <= 2) {
					yield { text: 'Calling tool', toolCall: { id: 'tc1', name: 'counter', args: {} } };
				} else {
					yield { text: 'Done' };
				}
			}),
			countTokens: vi.fn().mockReturnValue(0),
		};

		const hooks = new HookRegistry();
		for await (const _ of agentLoop({ sessionId: 's1', message: 'hi' }, ctx, llm as unknown as LLMClient, tools, hooks)) {
			// drain
			void _;
		}

		// Verify multiple tool calls happened (truly tests multi-round)
		expect(toolCallCount.count).toBeGreaterThanOrEqual(2);
	});

	// ==================== 取消机制 ====================

	it('取消 - signal 已 abort - 不调 LLM,直接 yield error + message.end', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		const llm = createMockLLM([[{ text: 'should not reach' }]]);
		const tools = new ToolRegistry();
		const hooks = new HookRegistry();

		const controller = new AbortController();
		controller.abort();

		const events: AgentEvent[] = [];
		for await (const event of agentLoop(
			{ sessionId: 's1', message: 'Hi' },
			ctx,
			llm,
			tools,
			hooks,
			controller.signal,
		)) {
			events.push(event);
		}

		// 关键路径:signal 已 abort,第一轮就退出,不产生 message.delta
		expect(events.filter((e) => e.type === 'message.delta')).toHaveLength(0);
		expect(events.some((e) => e.type === 'error' && e.payload.code === 'CANCELLED')).toBe(true);
		// finally 块仍执行
		expect(events.some((e) => e.type === 'message.end')).toBe(true);
	});

	it('取消 - 流式输出期间 abort - 保留已收到文本,yield error + message.end', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);

		const controller = new AbortController();
		const llm: LLMClient = {
			async *chat(): AsyncIterable<ChatDelta> {
				yield { text: 'Partial ' };
				// 关键路径:第二个 delta 前触发取消
				controller.abort();
				yield { text: 'response' };
			},
			embed: async () => [],
			countTokens: () => 10,
		};

		const tools = new ToolRegistry();
		const hooks = new HookRegistry();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(
			{ sessionId: 's1', message: 'Hi' },
			ctx,
			llm,
			tools,
			hooks,
			controller.signal,
		)) {
			events.push(event);
		}

		// 关键路径:至少收到第一个 delta,取消后不再有更多 delta
		const deltas = events.filter((e) => e.type === 'message.delta');
		expect(deltas.length).toBeGreaterThanOrEqual(1);
		expect(events.some((e) => e.type === 'error' && e.payload.code === 'CANCELLED')).toBe(true);
		expect(events.some((e) => e.type === 'message.end')).toBe(true);
	});

	it('取消 - 仍保存 session', async () => {
		const sessions = new Map<string, Session>();
		const persistence = createMockPersistence(sessions);
		const ctx = new ContextManager(persistence);

		const controller = new AbortController();
		const llm: LLMClient = {
			async *chat(): AsyncIterable<ChatDelta> {
				yield { text: 'Hello' };
				controller.abort();
			},
			embed: async () => [],
			countTokens: () => 10,
		};

		const tools = new ToolRegistry();
		const hooks = new HookRegistry();

		for await (const _ of agentLoop(
			{ sessionId: 's1', message: 'Hi' },
			ctx,
			llm,
			tools,
			hooks,
			controller.signal,
		)) {
			void _;
		}

		// 关键路径:取消后 finally 块仍执行 save()
		expect(sessions.has('s1')).toBe(true);
	});

	// ==================== W3: 意图分类 + search.result 事件 ====================

	it('agentLoop - 注入 intentClassifier - 调用分类器并按意图选提示词', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		// 关键路径:LLM 第二轮调用用于真实 chat,第一轮被意图分类器消费
		const chatSpy = vi.fn();
		const llm: LLMClient = {
			async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
				chatSpy(req);
				// 关键路径:第一次调用是意图分类(maxTokens=5),第二次是真实回复
				if (req.options?.maxTokens === 5) {
					yield { text: 'rag' };
					return;
				}
				yield { text: '回答' };
			},
			countTokens: () => 10,
		};
		const tools = new ToolRegistry();
		const hooks = new HookRegistry();
		const intentClassifier = vi.fn().mockResolvedValue('rag' as const);

		const events: AgentEvent[] = [];
		for await (const event of agentLoop(
			{ sessionId: 's1', message: '我的笔记有什么' },
			ctx,
			llm,
			tools,
			hooks,
			undefined,
			intentClassifier,
		)) {
			events.push(event);
		}

		// 关键路径:意图分类器被调用,参数是用户消息
		expect(intentClassifier).toHaveBeenCalledWith('我的笔记有什么');
		// 关键路径:第二次 chat 调用的 messages[0] 应是 RAG_PROMPT(含 search_vault)
		const realChatCall = chatSpy.mock.calls.find(([{ options }]) => !options?.maxTokens || options.maxTokens !== 5);
		const realMessages = realChatCall?.[0]?.messages;
		expect(realMessages?.[0]?.content).toContain('search_vault');
	});

	it('agentLoop - 无 intentClassifier - 不调分类,默认 direct 提示词', async () => {
		// 关键路径:向后兼容,老调用方不传 intentClassifier 仍能工作
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		const llm = createMockLLM([[{ text: 'hi' }]]);
		const tools = new ToolRegistry();
		const hooks = new HookRegistry();

		const events: AgentEvent[] = [];
		for await (const event of agentLoop(
			{ sessionId: 's1', message: 'Hi' },
			ctx,
			llm,
			tools,
			hooks,
		)) {
			events.push(event);
		}

		// 关键路径:无 search.result 事件(没有调 search_vault)
		expect(events.some((e) => e.type === 'search.result')).toBe(false);
	});

	it('agentLoop - search_vault 返回后发 search.result 事件', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);

		const toolCall: ToolCall = {
			id: 'call_1',
			name: 'search_vault',
			args: { query: '技术栈', topK: 3 },
		};

		const llm = createMockLLM([
			[{ text: '', toolCall }],
			[{ text: '根据 [1] 的内容...' }],
		]);

		const tools = new ToolRegistry();
		tools.register({
			definition: { name: 'search_vault', description: 'search', parameters: {} },
			readOnly: true,
			execute: async () => [
				{ docId: 'notes/a.md#chunk-0', score: 0.9, metadata: { path: 'notes/a.md', chunkIndex: 0 }, index: 1 },
				{ docId: 'notes/b.md#chunk-0', score: 0.8, metadata: { path: 'notes/b.md', chunkIndex: 0 }, index: 2 },
			],
		});

		const hooks = new HookRegistry();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(
			{ sessionId: 's1', message: '查技术栈' },
			ctx,
			llm,
			tools,
			hooks,
		)) {
			events.push(event);
		}

		// 关键路径:search.result 事件被发出
		const searchResultEvent = events.find((e) => e.type === 'search.result');
		expect(searchResultEvent).toBeDefined();
		if (searchResultEvent?.type === 'search.result') {
			expect(searchResultEvent.payload.results).toHaveLength(2);
			// 关键路径:path 从 metadata.path 提取,扁平结构(不嵌套 metadata)
			expect(searchResultEvent.payload.results[0]).toEqual({
				docId: 'notes/a.md#chunk-0',
				score: 0.9,
				path: 'notes/a.md',
				index: 1,
			});
		}
	});

	it('agentLoop - intentClassifier 抛错 - 静默降级 rag,主流程不中断', async () => {
		// 关键路径:自定义分类器抛错时,agentLoop 应降级 rag 且不向上抛(遵守 @throws 契约)
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		const llm = createMockLLM([[{ text: '回答' }]]);
		const tools = new ToolRegistry();
		const hooks = new HookRegistry();
		const throwingClassifier = vi.fn().mockRejectedValue(new Error('classifier down'));

		const events: AgentEvent[] = [];
		for await (const event of agentLoop(
			{ sessionId: 's1', message: 'hi' },
			ctx,
			llm,
			tools,
			hooks,
			undefined,
			throwingClassifier,
		)) {
			events.push(event);
		}

		// 关键路径:分类器被调用但抛错,主流程不中断
		expect(throwingClassifier).toHaveBeenCalledWith('hi');
		expect(events.some((e) => e.type === 'message.end')).toBe(true);
		// 关键路径:无 error 事件(降级是静默的,与 classifyIntent 自身行为一致)
		expect(events.some((e) => e.type === 'error')).toBe(false);
	});

	// ==================== W4: search.result reranked 字段 ====================

	it('agentLoop - search_vault 结果含 reranked=true - search.result 事件带 reranked=true', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);

		const toolCall: ToolCall = {
			id: 'call_1',
			name: 'search_vault',
			args: { query: '技术栈', topK: 3 },
		};

		const llm = createMockLLM([
			[{ text: '', toolCall }],
			[{ text: '根据 [1] 的内容...' }],
		]);

		const tools = new ToolRegistry();
		tools.register({
			definition: { name: 'search_vault', description: 'search', parameters: {} },
			readOnly: true,
			execute: async () => [
				{ docId: 'notes/a.md#chunk-0', score: 0.9, metadata: { path: 'notes/a.md', chunkIndex: 0 }, index: 1, reranked: true },
			],
		});

		const hooks = new HookRegistry();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(
			{ sessionId: 's1', message: '查技术栈' },
			ctx,
			llm,
			tools,
			hooks,
		)) {
			events.push(event);
		}

		// 关键路径:search.result 事件 payload 含 reranked=true
		const searchResultEvent = events.find((e) => e.type === 'search.result');
		expect(searchResultEvent).toBeDefined();
		if (searchResultEvent?.type === 'search.result') {
			expect(searchResultEvent.payload.reranked).toBe(true);
		}
	});

	it('agentLoop - search_vault 结果 reranked=false - search.result 事件带 reranked=false', async () => {
		// 关键路径:无 Reranker 时 reranked=false,ChatView 不显示精排标记
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);

		const toolCall: ToolCall = {
			id: 'call_1',
			name: 'search_vault',
			args: { query: '技术栈' },
		};

		const llm = createMockLLM([
			[{ text: '', toolCall }],
			[{ text: '结果' }],
		]);

		const tools = new ToolRegistry();
		tools.register({
			definition: { name: 'search_vault', description: 'search', parameters: {} },
			readOnly: true,
			execute: async () => [
				{ docId: 'notes/a.md#chunk-0', score: 0.9, metadata: { path: 'notes/a.md', chunkIndex: 0 }, index: 1, reranked: false },
			],
		});

		const hooks = new HookRegistry();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(
			{ sessionId: 's1', message: '查' },
			ctx,
			llm,
			tools,
			hooks,
		)) {
			events.push(event);
		}

		const searchResultEvent = events.find((e) => e.type === 'search.result');
		// 关键路径:先确认事件确实发射,避免 if 跳过导致空过测试
		expect(searchResultEvent).toBeDefined();
		if (searchResultEvent?.type === 'search.result') {
			expect(searchResultEvent.payload.reranked).toBe(false);
		}
	});

	it('agentLoop - search_vault 结果无 reranked 字段 - search.result 降级 reranked=false', async () => {
		// 关键路径:W3 旧 mock 不带 reranked 字段,W4 agent-loop 应降级为 false
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);

		const toolCall: ToolCall = {
			id: 'call_1',
			name: 'search_vault',
			args: { query: '技术栈' },
		};

		const llm = createMockLLM([
			[{ text: '', toolCall }],
			[{ text: '结果' }],
		]);

		const tools = new ToolRegistry();
		tools.register({
			definition: { name: 'search_vault', description: 'search', parameters: {} },
			readOnly: true,
			execute: async () => [
				{ docId: 'notes/a.md#chunk-0', score: 0.9, metadata: { path: 'notes/a.md', chunkIndex: 0 }, index: 1 },
			],
		});

		const hooks = new HookRegistry();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(
			{ sessionId: 's1', message: '查' },
			ctx,
			llm,
			tools,
			hooks,
		)) {
			events.push(event);
		}

		const searchResultEvent = events.find((e) => e.type === 'search.result');
		// 关键路径:先确认事件确实发射,避免 if 跳过导致空过测试
		expect(searchResultEvent).toBeDefined();
		if (searchResultEvent?.type === 'search.result') {
			// 关键路径:无 reranked 字段时降级为 false
			expect(searchResultEvent.payload.reranked).toBe(false);
		}
	});

	it('agentLoop - search_vault 结果混合 reranked - search.result 事件带 reranked=true', async () => {
		// 关键路径:部分结果 reranked=true、部分 false → 事件级 reranked=true(any 语义)
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);

		const toolCall: ToolCall = {
			id: 'call_1',
			name: 'search_vault',
			args: { query: '技术栈' },
		};

		const llm = createMockLLM([
			[{ text: '', toolCall }],
			[{ text: '结果' }],
		]);

		const tools = new ToolRegistry();
		tools.register({
			definition: { name: 'search_vault', description: 'search', parameters: {} },
			readOnly: true,
			execute: async () => [
				{ docId: 'notes/a.md#chunk-0', score: 0.9, metadata: { path: 'notes/a.md', chunkIndex: 0 }, index: 1, reranked: true },
				{ docId: 'notes/b.md#chunk-0', score: 0.8, metadata: { path: 'notes/b.md', chunkIndex: 0 }, index: 2, reranked: false },
			],
		});

		const hooks = new HookRegistry();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(
			{ sessionId: 's1', message: '查' },
			ctx,
			llm,
			tools,
			hooks,
		)) {
			events.push(event);
		}

		const searchResultEvent = events.find((e) => e.type === 'search.result');
		expect(searchResultEvent).toBeDefined();
		if (searchResultEvent?.type === 'search.result') {
			// 关键路径:任一结果 reranked=true 即事件级 reranked=true
			expect(searchResultEvent.payload.reranked).toBe(true);
		}
	});
});
