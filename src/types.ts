/**
 * Ratel — cross-cutting type definitions
 *
 * Port-specific types live in their respective port files:
 *   - ports/persistence.ts  → Session, ChatMessage, NoteMeta, HookLogEntry
 *   - ports/vector.ts       → VectorSearchResult, SearchFilter, IndexStatus
 *   - ports/llm.ts          → ChatRequest, ChatDelta, ToolCall, ToolDefinition, ChatMessage
 */

// Re-export commonly used port types for convenience
export type { ChatMessage, ChatDelta, ToolCall, ToolDefinition } from './ports/llm';
export type { VectorSearchResult, SearchFilter } from './ports/vector';
export type { Session, NoteMeta, HookLogEntry } from './ports/persistence';

// Agent events (main thread → UI)
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

// Worker requests (main thread → Worker)
export type WorkerRequest =
	| { type: 'index.full'; payload: { vaultPath: string } }
	| { type: 'index.incremental'; payload: { filePath: string; content: string } }
	| { type: 'index.delete'; payload: { filePath: string } }
	| { type: 'vector.search'; payload: { queryVector: number[]; topK: number; filter?: import('./ports/vector').SearchFilter } }
	| { type: 'vector.upsert'; payload: { docId: string; text: string; metadata: Record<string, unknown> } }
	| { type: 'vector.delete'; payload: { docIds: string[] } }
	| { type: 'index.status'; payload: {} };

// Worker responses (Worker → main thread)
export type WorkerResponse =
	| { type: 'index.progress'; payload: { done: number; total: number } }
	| { type: 'index.done'; payload: { indexed: number; errors: number } }
	| { type: 'vector.search.result'; payload: Array<import('./ports/vector').VectorSearchResult> }
	| { type: 'vector.upsert.done'; payload: { docId: string } }
	| { type: 'vector.delete.done'; payload: { count: number } }
	| { type: 'index.status.result'; payload: { totalDocs: number; lastIndexTime: number } }
	| { type: 'error'; payload: { code: string; message: string } };

// User-facing chat request (sidebar → agent loop)
export interface UserChatRequest {
	sessionId: string;
	message: string;
}
