/**
 * Ratel Vault type definitions
 */

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
// Updated per ARCHITECTURE.md section 2.4
export type WorkerRequest =
	| { type: 'index.full'; payload: { vaultPath: string } }
	| { type: 'index.incremental'; payload: { filePath: string; content: string } }
	| { type: 'index.delete'; payload: { filePath: string } }
	| { type: 'vector.search'; payload: { queryVector: number[]; topK: number; filter?: SearchFilter } }
	| { type: 'vector.upsert'; payload: { docId: string; text: string; metadata: Record<string, unknown> } }
	| { type: 'vector.delete'; payload: { docIds: string[] } }
	| { type: 'index.status'; payload: {} };

// Worker responses (Worker → main thread)
// Updated per ARCHITECTURE.md section 2.4
export type WorkerResponse =
	| { type: 'index.progress'; payload: { done: number; total: number } }
	| { type: 'index.done'; payload: { indexed: number; errors: number } }
	| { type: 'vector.search.result'; payload: VectorSearchResult[] }
	| { type: 'vector.upsert.done'; payload: { docId: string } }
	| { type: 'vector.delete.done'; payload: { count: number } }
	| { type: 'index.status.result'; payload: { totalDocs: number; lastIndexTime: number } }
	| { type: 'error'; payload: { code: string; message: string } };

// Vector search result (from ARCHITECTURE.md section 2.4)
export interface VectorSearchResult {
	docId: string;
	score: number;
	metadata: Record<string, unknown>;
}

// Search filter (from ARCHITECTURE.md section 2.4)
export interface SearchFilter {
	tags?: string[];
	pathPrefix?: string;
}

// Note metadata
export interface NoteMeta {
	path: string;
	hash: string;
	mtime: number;
	tags?: string[];
	links?: string[];
	backlinks?: string[];
	frontmatter?: Record<string, unknown>;
}

// Tool call
export interface ToolCall {
	name: string;
	args: unknown;
}

// Chat request
export interface ChatRequest {
	sessionId: string;
	message: string;
}

export interface ChatDelta {
	text: string;
	toolCall?: ToolCall;
}
