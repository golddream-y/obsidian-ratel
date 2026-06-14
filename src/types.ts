/**
 * @file src/types.ts
 * @description Ratel 跨切面类型定义 — Agent 事件、Worker 协议、用户请求
 * @module types
 * @depends ports/llm, ports/vector, ports/persistence
 *
 * 端口专属类型在各自的 port 文件中维护(本文件仅做 re-export 与跨模块聚合):
 *   - ports/persistence.ts  → Session, ChatMessage, NoteMeta, HookLogEntry
 *   - ports/vector.ts       → VectorSearchResult, SearchFilter, IndexStatus
 *   - ports/llm.ts          → ChatRequest, ChatDelta, ToolCall, ToolDefinition, ChatMessage
 */

// ==================== 端口类型 re-export ====================
export type { ChatMessage, ChatDelta, ToolCall, ToolDefinition } from './ports/llm';
export type { VectorSearchResult, SearchFilter } from './ports/vector';
export type { Session, NoteMeta, HookLogEntry } from './ports/persistence';

// ==================== Agent 事件(主线程 → UI) ====================

/**
 * Agent 实时事件流 — 喂给 Svelte 聊天面板,驱动流式渲染、工具调用展示、错误提示。
 *
 * 关键路径:
 * - `message.start` / `message.delta` / `message.end` 三件套标记一次助手消息生命周期。
 * - `tool.call` / `tool.result` 让 UI 能展示"正在调用 read_note"等中间状态。
 * - `error` 是结构化错误(带 code),UI 决定是否可恢复。
 */
export type AgentEvent =
	| { type: 'message.start'; payload: { role: 'user' | 'assistant' } }
	| { type: 'message.delta'; payload: { text: string } }
	| { type: 'message.end'; payload: { tokens: number } }
	| { type: 'tool.call'; payload: { name: string; args: unknown } }
	| { type: 'tool.result'; payload: { name: string; result: unknown } }
	| { type: 'subagent.spawn'; payload: { role: string; task: string } }
	| { type: 'subagent.done'; payload: { role: string; result: unknown } }
	| { type: 'hook.fired'; payload: { phase: string; tool: string } }
	| { type: 'error'; payload: { code: string; message: string } };

// ==================== Worker 请求(主线程 → Worker) ====================

/**
 * 主线程发给 Worker 的请求集合 — 含索引 / 向量 CRUD / 状态查询。
 *
 * 关键路径:类型用判别联合,Worker 端 switch 时 TypeScript 能自动收窄。
 */
export type WorkerRequest =
	| { type: 'index.full'; payload: { vaultPath: string } }
	| { type: 'index.incremental'; payload: { filePath: string; content: string } }
	| { type: 'index.delete'; payload: { filePath: string } }
	| { type: 'vector.search'; payload: { queryVector: number[]; topK: number; filter?: import('./ports/vector').SearchFilter } }
	| { type: 'vector.upsert'; payload: { docId: string; text: string; metadata: Record<string, unknown> } }
	| { type: 'vector.delete'; payload: { docIds: string[] } }
	| { type: 'index.status'; payload: Record<string, never> };

// ==================== Worker 响应(Worker → 主线程) ====================

/**
 * Worker 回给主线程的响应集合 — 索引进度、查询结果、错误。
 *
 * 关键路径:`error` 是通用兜底,各业务响应类型在协议层独立,方便扩展。
 */
export type WorkerResponse =
	| { type: 'index.progress'; payload: { done: number; total: number } }
	| { type: 'index.done'; payload: { indexed: number; errors: number } }
	| { type: 'vector.search.result'; payload: Array<import('./ports/vector').VectorSearchResult> }
	| { type: 'vector.upsert.done'; payload: { docId: string } }
	| { type: 'vector.delete.done'; payload: { count: number } }
	| { type: 'index.status.result'; payload: { totalDocs: number; lastIndexTime: number } }
	| { type: 'error'; payload: { code: string; message: string } };

// ==================== 用户聊天请求(侧栏 → 主循环) ====================

/**
 * 一次用户请求 — ChatView 调 `plugin.ask(req)` 时传入。
 *
 * 关键路径:`sessionId` 关联到 Persistence 存储,主循环据此加载历史消息。
 */
export interface UserChatRequest {
	sessionId: string;
	message: string;
}
