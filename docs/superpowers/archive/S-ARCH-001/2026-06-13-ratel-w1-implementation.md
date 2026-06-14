# W1 Implementation Plan: Minimum Agent Loop

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** User can ask "X 是啥" in the chat sidebar and get a streamed answer from the LLM, with `read_note` tool support for reading vault notes.

**Architecture:** Hexagonal (Ports & Adapters). Agent Loop orchestrates LLM calls and tool execution via ToolRegistry. Worker runs in separate thread (skeleton only — full vectra in W2). All Obsidian API access through ObsidianVault facade. Persistence via JSON (Obsidian loadData/saveData).

**Tech Stack:** TypeScript (strict), vitest, Svelte 5, esbuild, DeepSeek API (OpenAI-compatible streaming)

---

## File Structure

### New files

| File | Responsibility |
|---|---|
| `vitest.config.ts` | Test configuration |
| `src/utils/hash.ts` | SHA-256 content hash |
| `src/core/tool-registry.ts` | Tool registration and execution |
| `src/tools/read-note.ts` | Read note tool implementation |
| `src/ui/ChatView.ts` | Obsidian ItemView wrapper for Svelte |
| `src/ui/ChatView.svelte` | Chat sidebar UI component |
| `tests/utils/hash.test.ts` | Hash utility tests |
| `tests/core/tool-registry.test.ts` | ToolRegistry tests |
| `tests/core/context-manager.test.ts` | ContextManager tests |
| `tests/core/agent-loop.test.ts` | Agent Loop tests |
| `tests/adapters/persistence-json.test.ts` | Persistence adapter tests |
| `tests/adapters/llm-deepseek.test.ts` | DeepSeek adapter tests |
| `tests/tools/read-note.test.ts` | read_note tool tests |
| `tests/worker/worker-bridge.test.ts` | WorkerManager tests |
| `tests/helpers/mock-obsidian.ts` | Shared Obsidian API mocks |

### Modified files

| File | Change |
|---|---|
| `src/types.ts` | Remove duplicates, keep AgentEvent + WorkerRequest/Response only |
| `src/core/agent-loop.ts` | Full implementation (currently placeholder) |
| `src/core/context-manager.ts` | Full implementation (currently placeholder) |
| `src/core/hooks.ts` | Update ToolCall import to ports/llm |
| `src/adapters/persistence-json.ts` | Full implementation (currently placeholder) |
| `src/adapters/llm-deepseek.ts` | Full implementation (currently placeholder) |
| `src/worker/index.ts` | Basic message dispatch skeleton |
| `src/main.ts` | Wire all components, register ChatView |
| `package.json` | Add vitest + test script |

---

## Task 1: Test Infrastructure (vitest)

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Install vitest**

Run: `npm install -D vitest`

- [ ] **Step 2: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['tests/**/*.test.ts'],
		environment: 'node',
	},
});
```

- [ ] **Step 3: Add test script to package.json**

Add to `scripts` in `package.json`:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: Create test helpers directory**

Run: `mkdir -p tests/helpers tests/utils tests/core tests/adapters tests/tools tests/worker`

- [ ] **Step 5: Create shared mock helpers**

Create `tests/helpers/mock-obsidian.ts`:

```typescript
import type { App } from 'obsidian';

/**
 * Minimal mock of Obsidian App for testing adapters.
 * Only includes methods used by ObsidianVault facade.
 */
export function createMockApp(overrides?: Partial<App>): App {
	const files = new Map<string, { content: string; mtime: number }>();

	const mockVault = {
		getAbstractFileByPath: (path: string) => {
			if (files.has(path)) {
				return { path, stat: { mtime: files.get(path)!.mtime } };
			}
			return null;
		},
		read: async (file: { path: string }) => {
			const entry = files.get(file.path);
			if (!entry) throw new Error(`File not found: ${file.path}`);
			return entry.content;
		},
		modify: async (file: { path: string }, content: string) => {
			files.set(file.path, { content, mtime: Date.now() });
		},
		create: async (path: string, content: string) => {
			files.set(path, { content, mtime: Date.now() });
		},
		createFolder: async (_path: string) => {},
		getMarkdownFiles: () => {
			return Array.from(files.keys())
				.filter((p) => p.endsWith('.md'))
				.map((p) => ({ path: p, stat: { mtime: files.get(p)!.mtime } }));
		},
		on: (_event: string, _callback: Function) => ({}),
		offref: (_ref: unknown) => {},
	};

	const mockMetadataCache = {
		resolvedLinks: {} as Record<string, Record<string, number>>,
		getFileCache: (_file: unknown) => null,
		getBacklinksForFile: (_file: unknown) => ({ data: new Map() }),
	};

	return {
		vault: mockVault,
		metadataCache: mockMetadataCache,
		...overrides,
	} as unknown as App;
}

/**
 * Add a file to the mock vault's file map.
 */
export function addMockFile(
	mockApp: App,
	path: string,
	content: string,
	mtime = Date.now(),
): void {
	// Access internal files map through vault mock
	const vault = mockApp.vault as ReturnType<typeof createMockApp>['vault'];
	// Re-cast to access internal state
	(vault as { getAbstractFileByPath: unknown }).getAbstractFileByPath;
	// Use create to add file
	(mockApp.vault as { create: (p: string, c: string) => Promise<void> }).create(path, content);
}
```

- [ ] **Step 6: Verify test infrastructure**

Run: `npm test`
Expected: PASS (no tests found, exit 0)

- [ ] **Step 7: Commit**

```bash
git add vitest.config.ts package.json package-lock.json tests/
git commit -m "chore: add vitest test infrastructure"
```

---

## Task 2: Type Cleanup

**Files:**
- Modify: `src/types.ts`
- Modify: `src/core/hooks.ts`

`types.ts` currently duplicates types from `ports/`. After cleanup, `types.ts` only keeps cross-cutting types (`AgentEvent`, `WorkerRequest`, `WorkerResponse`). Port-specific types live in their port files.

- [ ] **Step 1: Update types.ts — remove duplicates, import from ports**

Replace entire content of `src/types.ts`:

```typescript
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
```

- [ ] **Step 2: Update hooks.ts — import ToolCall from ports/llm**

Replace entire content of `src/core/hooks.ts`:

```typescript
// Hooks registry — knowledge governance hooks

import type { ToolCall } from '../ports/llm';

export class HookRegistry {
	private handlers = new Map<string, Array<(toolCall: ToolCall) => Promise<void>>>();

	register(phase: string, handler: (toolCall: ToolCall) => Promise<void>): void {
		const list = this.handlers.get(phase) ?? [];
		list.push(handler);
		this.handlers.set(phase, list);
	}

	async run(phase: string, toolCall: ToolCall): Promise<void> {
		const list = this.handlers.get(phase) ?? [];
		for (const handler of list) {
			await handler(toolCall);
		}
	}
}
```

- [ ] **Step 3: Verify build passes**

Run: `npm run build`
Expected: Build succeeds with no type errors

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/core/hooks.ts
git commit -m "refactor: deduplicate types, import from ports"
```

---

## Task 3: utils/hash.ts

**Files:**
- Create: `src/utils/hash.ts`
- Create: `tests/utils/hash.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/utils/hash.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { sha256 } from '../../src/utils/hash';

describe('sha256', () => {
	it('produces correct SHA-256 hex digest for "hello"', async () => {
		const result = await sha256('hello');
		// Known SHA-256 of "hello"
		expect(result).toBe(
			'2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
		);
	});

	it('produces different digests for different inputs', async () => {
		const a = await sha256('foo');
		const b = await sha256('bar');
		expect(a).not.toBe(b);
	});

	it('produces same digest for same input (idempotent)', async () => {
		const a = await sha256('test content');
		const b = await sha256('test content');
		expect(a).toBe(b);
	});

	it('handles empty string', async () => {
		const result = await sha256('');
		expect(result).toBe(
			'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		);
	});

	it('produces 64-character hex string', async () => {
		const result = await sha256('any input');
		expect(result).toHaveLength(64);
		expect(result).toMatch(/^[0-9a-f]{64}$/);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/utils/hash.test.ts`
Expected: FAIL — `Cannot find module '../../src/utils/hash'`

- [ ] **Step 3: Write implementation**

Create `src/utils/hash.ts`:

```typescript
/**
 * Compute SHA-256 hex digest of a string.
 * Uses Web Crypto API (available in Obsidian / Electron / Node 18+).
 */
export async function sha256(content: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(content);
	const hash = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/utils/hash.test.ts`
Expected: PASS (all 5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/utils/hash.ts tests/utils/hash.test.ts
git commit -m "feat: add SHA-256 hash utility"
```

---

## Task 4: ToolRegistry

**Files:**
- Create: `src/core/tool-registry.ts`
- Create: `tests/core/tool-registry.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/core/tool-registry.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ToolRegistry, type Tool } from '../../src/core/tool-registry';
import type { ToolDefinition } from '../../src/ports/llm';

const dummyDef: ToolDefinition = {
	name: 'test_tool',
	description: 'A test tool',
	parameters: {
		type: 'object',
		properties: {
			input: { type: 'string', description: 'Test input' },
		},
		required: ['input'],
	},
};

const dummyTool: Tool = {
	definition: dummyDef,
	execute: async (args) => `result: ${args.input as string}`,
};

describe('ToolRegistry', () => {
	it('registers a tool and lists its definition', () => {
		const registry = new ToolRegistry();
		registry.register(dummyTool);
		expect(registry.definitions()).toEqual([dummyDef]);
	});

	it('executes a registered tool by ToolCall', async () => {
		const registry = new ToolRegistry();
		registry.register(dummyTool);
		const result = await registry.execute({
			id: 'call_1',
			name: 'test_tool',
			args: { input: 'hello' },
		});
		expect(result).toBe('result: hello');
	});

	it('throws on unknown tool', async () => {
		const registry = new ToolRegistry();
		await expect(
			registry.execute({ id: 'call_1', name: 'unknown', args: {} }),
		).rejects.toThrow('Tool not found: unknown');
	});

	it('returns empty definitions when no tools registered', () => {
		const registry = new ToolRegistry();
		expect(registry.definitions()).toEqual([]);
	});

	it('registers multiple tools', () => {
		const registry = new ToolRegistry();
		const tool2: Tool = {
			definition: { name: 'tool2', description: 'Second tool', parameters: {} },
			execute: async () => 'tool2 result',
		};
		registry.register(dummyTool);
		registry.register(tool2);
		expect(registry.definitions()).toHaveLength(2);
		expect(registry.definitions().map((d) => d.name)).toEqual(['test_tool', 'tool2']);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/core/tool-registry.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/tool-registry'`

- [ ] **Step 3: Write implementation**

Create `src/core/tool-registry.ts`:

```typescript
import type { ToolDefinition, ToolCall } from '../ports/llm';

export interface Tool {
	definition: ToolDefinition;
	execute(args: Record<string, unknown>): Promise<unknown>;
}

export class ToolRegistry {
	private tools = new Map<string, Tool>();

	register(tool: Tool): void {
		this.tools.set(tool.definition.name, tool);
	}

	definitions(): ToolDefinition[] {
		return Array.from(this.tools.values()).map((t) => t.definition);
	}

	async execute(toolCall: ToolCall): Promise<unknown> {
		const tool = this.tools.get(toolCall.name);
		if (!tool) throw new Error(`Tool not found: ${toolCall.name}`);
		return tool.execute(toolCall.args);
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/core/tool-registry.test.ts`
Expected: PASS (all 5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/tool-registry.ts tests/core/tool-registry.test.ts
git commit -m "feat: add ToolRegistry for tool registration and execution"
```

---

## Task 5: ContextManager

**Files:**
- Create: `tests/core/context-manager.test.ts`
- Modify: `src/core/context-manager.ts`

- [ ] **Step 1: Write failing test**

Create `tests/core/context-manager.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ContextManager } from '../../src/core/context-manager';
import type { Persistence, Session } from '../../src/ports/persistence';
import type { ToolCall } from '../../src/ports/llm';

function createMockPersistence(sessions: Map<string, Session> = new Map()): Persistence {
	return {
		sessions: {
			get: async (id: string) => sessions.get(id) ?? null,
			upsert: async (session: Session) => { sessions.set(session.id, session); },
			list: async () => Array.from(sessions.values()),
			delete: async (id: string) => { sessions.delete(id); },
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

describe('ContextManager', () => {
	it('creates a new session when none exists', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		await ctx.load('session-1');
		expect(ctx.toMessages()).toHaveLength(1); // system prompt only
		expect(ctx.toMessages()[0]!.role).toBe('system');
	});

	it('loads existing session with history', async () => {
		const sessions = new Map<string, Session>();
		sessions.set('session-1', {
			id: 'session-1',
			title: 'Test',
			messages: [
				{ role: 'user', content: 'Hello' },
				{ role: 'assistant', content: 'Hi there' },
			],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		const persistence = createMockPersistence(sessions);
		const ctx = new ContextManager(persistence);
		await ctx.load('session-1');
		const msgs = ctx.toMessages();
		// system + 2 history messages
		expect(msgs).toHaveLength(3);
		expect(msgs[1]!.content).toBe('Hello');
	});

	it('adds user message and includes it in toMessages', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		await ctx.load('session-1');
		ctx.addUserMessage('What is X?');
		const msgs = ctx.toMessages();
		// system + user
		expect(msgs).toHaveLength(2);
		expect(msgs[1]!.role).toBe('user');
		expect(msgs[1]!.content).toBe('What is X?');
	});

	it('adds tool result to context', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		await ctx.load('session-1');
		ctx.addUserMessage('Read foo.md');

		const toolCall: ToolCall = {
			id: 'call_1',
			name: 'read_note',
			args: { path: 'foo.md' },
		};
		ctx.addAssistantToolCall(toolCall, '');
		ctx.addToolResult('call_1', 'Content of foo.md');

		const msgs = ctx.toMessages();
		// system + user + assistant(tool_call) + tool(result)
		expect(msgs).toHaveLength(4);
		expect(msgs[2]!.role).toBe('assistant');
		expect(msgs[2]!.toolName).toBe('read_note');
		expect(msgs[3]!.role).toBe('tool');
		expect(msgs[3]!.content).toBe('Content of foo.md');
	});

	it('saves session via persistence', async () => {
		const sessions = new Map<string, Session>();
		const persistence = createMockPersistence(sessions);
		const ctx = new ContextManager(persistence);
		await ctx.load('session-1');
		ctx.addUserMessage('Hello');
		await ctx.save();
		expect(sessions.has('session-1')).toBe(true);
		const saved = sessions.get('session-1')!;
		expect(saved.messages).toHaveLength(1);
	});

	it('tokenCount returns positive number', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		await ctx.load('session-1');
		ctx.addUserMessage('Hello world');
		expect(ctx.tokenCount()).toBeGreaterThan(0);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/core/context-manager.test.ts`
Expected: FAIL — ContextManager not implemented

- [ ] **Step 3: Write implementation**

Replace entire content of `src/core/context-manager.ts`:

```typescript
import type { Persistence, Session, ChatMessage } from '../ports/persistence';
import type { ToolCall } from '../ports/llm';

const SYSTEM_PROMPT = `You are Ratel, an AI assistant that helps users explore and manage their Obsidian vault. You can read notes and answer questions about their content. Always respond in the same language the user uses.`;

export class ContextManager {
	private session: Session | null = null;

	constructor(private persistence: Persistence) {}

	async load(sessionId: string): Promise<void> {
		this.session = await this.persistence.sessions.get(sessionId);
		if (!this.session) {
			this.session = {
				id: sessionId,
				title: '',
				messages: [],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
		}
	}

	addUserMessage(content: string): void {
		this.requireSession();
		this.session.messages.push({ role: 'user', content });
		this.session.updatedAt = Date.now();
	}

	addAssistantMessage(content: string): void {
		this.requireSession();
		this.session.messages.push({ role: 'assistant', content });
		this.session.updatedAt = Date.now();
	}

	addAssistantToolCall(toolCall: ToolCall, text: string): void {
		this.requireSession();
		this.session.messages.push({
			role: 'assistant',
			content: text,
			toolCallId: toolCall.id,
			toolName: toolCall.name,
		});
		this.session.updatedAt = Date.now();
	}

	addToolResult(toolCallId: string, result: string): void {
		this.requireSession();
		this.session.messages.push({
			role: 'tool',
			content: result,
			toolCallId,
		});
		this.session.updatedAt = Date.now();
	}

	toMessages(): ChatMessage[] {
		return [
			{ role: 'system', content: SYSTEM_PROMPT },
			...(this.session?.messages ?? []),
		];
	}

	tokenCount(): number {
		// Rough estimation: ~4 chars per token for mixed CJK/Latin
		const text = this.toMessages().map((m) => m.content).join('');
		return Math.ceil(text.length / 4);
	}

	async save(): Promise<void> {
		this.requireSession();
		await this.persistence.sessions.upsert(this.session!);
	}

	get sessionId(): string {
		return this.session?.id ?? '';
	}

	private requireSession(): asserts this is { session: Session } {
		if (!this.session) throw new Error('Session not loaded. Call load() first.');
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/core/context-manager.test.ts`
Expected: PASS (all 6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/context-manager.ts tests/core/context-manager.test.ts
git commit -m "feat: implement ContextManager for message assembly"
```

---

## Task 6: read_note Tool

**Files:**
- Create: `src/tools/read-note.ts`
- Create: `tests/tools/read-note.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/tools/read-note.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createReadNoteTool } from '../../src/tools/read-note';
import type { ObsidianVault } from '../../src/adapters/obsidian-vault';

function createMockVault(files: Record<string, string> = {}): ObsidianVault {
	return {
		readFile: async (path: string) => {
			if (path in files) return files[path]!;
			throw new Error(`File not found: ${path}`);
		},
		getMetadata: (_path: string) => null,
		getBacklinks: (_path: string) => new Map(),
		writeFile: async () => {},
		onFileModify: () => () => {},
		onFileCreate: () => () => {},
		onFileDelete: () => () => {},
		onFileRename: () => () => {},
		listMarkdownFiles: () => Object.keys(files),
	} as unknown as ObsidianVault;
}

describe('read_note tool', () => {
	it('has correct definition', () => {
		const vault = createMockVault();
		const tool = createReadNoteTool(vault);
		expect(tool.definition.name).toBe('read_note');
		expect(tool.definition.description).toContain('note');
	});

	it('reads file content from vault', async () => {
		const vault = createMockVault({ 'notes/test.md': '# Test\nHello world' });
		const tool = createReadNoteTool(vault);
		const result = await tool.execute({ path: 'notes/test.md' });
		expect(result).toContain('Hello world');
	});

	it('throws on missing file', async () => {
		const vault = createMockVault();
		const tool = createReadNoteTool(vault);
		await expect(tool.execute({ path: 'missing.md' })).rejects.toThrow();
	});

	it('includes metadata in result when available', async () => {
		const vault = createMockVault({ 'notes/test.md': '# Test\nContent' });
		// Override getMetadata to return frontmatter
		const mockVault = {
			...vault,
			getMetadata: (_path: string) => ({
				frontmatter: { tags: ['test'], status: 'draft' },
				tags: [{ tag: '#test', position: { start: { line: 0, col: 0 }, end: { line: 0, col: 0 } } }],
			}),
		} as unknown as ObsidianVault;
		const tool = createReadNoteTool(mockVault);
		const result = await tool.execute({ path: 'notes/test.md' }) as Record<string, unknown>;
		expect(result.content).toContain('Content');
		expect(result.metadata).toBeDefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/tools/read-note.test.ts`
Expected: FAIL — `Cannot find module '../../src/tools/read-note'`

- [ ] **Step 3: Write implementation**

Create `src/tools/read-note.ts`:

```typescript
import type { Tool } from '../core/tool-registry';
import type { ObsidianVault } from '../adapters/obsidian-vault';

export function createReadNoteTool(vault: ObsidianVault): Tool {
	return {
		definition: {
			name: 'read_note',
			description: 'Read the content and metadata of a note in the vault. Use this to look up information the user asks about.',
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'Path to the note file (e.g. "notes/LangChain.md")',
					},
				},
				required: ['path'],
			},
		},
		async execute(args: Record<string, unknown>) {
			const path = args.path as string;
			const content = await vault.readFile(path);
			const metadata = vault.getMetadata(path);
			const backlinks = vault.getBacklinks(path);

			const result: Record<string, unknown> = { content, path };

			if (metadata) {
				result.metadata = {
					frontmatter: metadata.frontmatter,
					tags: metadata.tags?.map((t) => t.tag),
					links: metadata.links?.map((l) => l.link),
				};
			}

			if (backlinks.size > 0) {
				result.backlinks = Array.from(backlinks.keys());
			}

			return result;
		},
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/tools/read-note.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/tools/read-note.ts tests/tools/read-note.test.ts
git commit -m "feat: add read_note tool for reading vault notes"
```

---

## Task 7: Persistence JSON Adapter

**Files:**
- Create: `tests/adapters/persistence-json.test.ts`
- Modify: `src/adapters/persistence-json.ts`

- [ ] **Step 1: Write failing test**

Create `tests/adapters/persistence-json.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { PersistenceJson } from '../../src/adapters/persistence-json';
import type { Session, NoteMeta, HookLogEntry } from '../../src/ports/persistence';

describe('PersistenceJson', () => {
	let storage: Record<string, unknown>;
	let loadData: () => Promise<unknown>;
	let saveData: (data: unknown) => Promise<void>;
	let persistence: PersistenceJson;

	beforeEach(() => {
		storage = {};
		loadData = async () => storage['data'] ?? null;
		saveData = async (data: unknown) => { storage['data'] = data; };
		persistence = new PersistenceJson(loadData, saveData);
	});

	describe('sessions', () => {
		it('returns null for non-existent session', async () => {
			const session = await persistence.sessions.get('non-existent');
			expect(session).toBeNull();
		});

		it('upserts and retrieves a session', async () => {
			const session: Session = {
				id: 's1',
				title: 'Test Session',
				messages: [{ role: 'user', content: 'Hello' }],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			await persistence.sessions.upsert(session);
			const retrieved = await persistence.sessions.get('s1');
			expect(retrieved).toEqual(session);
		});

		it('updates existing session on upsert', async () => {
			const session: Session = {
				id: 's1',
				title: 'Original',
				messages: [],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			await persistence.sessions.upsert(session);
			session.title = 'Updated';
			await persistence.sessions.upsert(session);
			const retrieved = await persistence.sessions.get('s1');
			expect(retrieved?.title).toBe('Updated');
		});

		it('lists sessions', async () => {
			await persistence.sessions.upsert({
				id: 's1', title: 'A', messages: [],
				createdAt: 1, updatedAt: 1,
			});
			await persistence.sessions.upsert({
				id: 's2', title: 'B', messages: [],
				createdAt: 2, updatedAt: 2,
			});
			const list = await persistence.sessions.list();
			expect(list).toHaveLength(2);
		});

		it('deletes a session', async () => {
			await persistence.sessions.upsert({
				id: 's1', title: 'A', messages: [],
				createdAt: 1, updatedAt: 1,
			});
			await persistence.sessions.delete('s1');
			const retrieved = await persistence.sessions.get('s1');
			expect(retrieved).toBeNull();
		});
	});

	describe('notes', () => {
		it('upserts and retrieves note metadata', async () => {
			const meta: NoteMeta = {
				path: 'notes/test.md',
				hash: 'abc123',
				mtime: Date.now(),
				tags: ['test'],
			};
			await persistence.notes.upsert(meta);
			const retrieved = await persistence.notes.get('notes/test.md');
			expect(retrieved).toEqual(meta);
		});

		it('lists notes by path prefix', async () => {
			await persistence.notes.upsert({
				path: 'notes/a.md', hash: 'a', mtime: 1,
			});
			await persistence.notes.upsert({
				path: 'notes/b.md', hash: 'b', mtime: 2,
			});
			await persistence.notes.upsert({
				path: 'daily/c.md', hash: 'c', mtime: 3,
			});
			const list = await persistence.notes.listByPath('notes/');
			expect(list).toHaveLength(2);
		});

		it('deletes note metadata', async () => {
			await persistence.notes.upsert({
				path: 'notes/test.md', hash: 'abc', mtime: 1,
			});
			await persistence.notes.delete('notes/test.md');
			expect(await persistence.notes.get('notes/test.md')).toBeNull();
		});
	});

	describe('hooks', () => {
		it('appends and lists hook log entries', async () => {
			const entry: HookLogEntry = {
				phase: 'pre-write',
				tool: 'create_note',
				timestamp: Date.now(),
				result: 'pass',
			};
			await persistence.hooks.append(entry);
			const list = await persistence.hooks.list();
			expect(list).toHaveLength(1);
			expect(list[0]).toEqual(entry);
		});

		it('respects limit when listing hooks', async () => {
			for (let i = 0; i < 5; i++) {
				await persistence.hooks.append({
					phase: 'pre-write',
					tool: `tool_${i}`,
					timestamp: Date.now(),
					result: 'pass',
				});
			}
			const list = await persistence.hooks.list(3);
			expect(list).toHaveLength(3);
		});
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/adapters/persistence-json.test.ts`
Expected: FAIL — PersistenceJson not implemented

- [ ] **Step 3: Write implementation**

Replace entire content of `src/adapters/persistence-json.ts`:

```typescript
import type { Persistence, Session, NoteMeta, HookLogEntry } from '../ports/persistence';

interface DataStore {
	sessions: Record<string, Session>;
	notes: Record<string, NoteMeta>;
	hookLog: HookLogEntry[];
}

export class PersistenceJson implements Persistence {
	public readonly sessions: PersistenceJson['sessions'];
	public readonly notes: PersistenceJson['notes'];
	public readonly hooks: PersistenceJson['hooks'];

	private data: DataStore = { sessions: {}, notes: {}, hookLog: [] };

	constructor(
		private loadData: () => Promise<unknown>,
		private saveData: (data: unknown) => Promise<void>,
	) {
		this.sessions = {
			get: async (id: string) => {
				await this.ensureLoaded();
				const session = this.data.sessions[id] ?? null;
				return session ? { ...session } : null;
			},
			upsert: async (session: Session) => {
				await this.ensureLoaded();
				this.data.sessions[session.id] = { ...session };
				await this.persist();
			},
			list: async (limit?: number) => {
				await this.ensureLoaded();
				const all = Object.values(this.data.sessions)
					.sort((a, b) => b.updatedAt - a.updatedAt);
				return limit ? all.slice(0, limit) : all;
			},
			delete: async (id: string) => {
				await this.ensureLoaded();
				delete this.data.sessions[id];
				await this.persist();
			},
		};

		this.notes = {
			get: async (path: string) => {
				await this.ensureLoaded();
				const meta = this.data.notes[path] ?? null;
				return meta ? { ...meta } : null;
			},
			upsert: async (meta: NoteMeta) => {
				await this.ensureLoaded();
				this.data.notes[meta.path] = { ...meta };
				await this.persist();
			},
			listByPath: async (prefix: string) => {
				await this.ensureLoaded();
				return Object.values(this.data.notes)
					.filter((n) => n.path.startsWith(prefix));
			},
			delete: async (path: string) => {
				await this.ensureLoaded();
				delete this.data.notes[path];
				await this.persist();
			},
		};

		this.hooks = {
			append: async (log: HookLogEntry) => {
				await this.ensureLoaded();
				this.data.hookLog.push({ ...log });
				await this.persist();
			},
			list: async (limit?: number) => {
				await this.ensureLoaded();
				const all = [...this.data.hookLog].reverse();
				return limit ? all.slice(0, limit) : all;
			},
		};
	}

	private loaded = false;

	private async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		const raw = await this.loadData();
		if (raw && typeof raw === 'object') {
			const stored = raw as Partial<DataStore>;
			this.data = {
				sessions: (stored.sessions as Record<string, Session>) ?? {},
				notes: (stored.notes as Record<string, NoteMeta>) ?? {},
				hookLog: (stored.hookLog as HookLogEntry[]) ?? [],
			};
		}
		this.loaded = true;
	}

	private async persist(): Promise<void> {
		await this.saveData(this.data);
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/adapters/persistence-json.test.ts`
Expected: PASS (all 9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/adapters/persistence-json.ts tests/adapters/persistence-json.test.ts
git commit -m "feat: implement PersistenceJson adapter with loadData/saveData"
```

---

## Task 8: DeepSeek LLM Adapter

**Files:**
- Create: `tests/adapters/llm-deepseek.test.ts`
- Modify: `src/adapters/llm-deepseek.ts`

This adapter implements the `LLMClient` port using the OpenAI-compatible API (works with DeepSeek, Ollama, and any OpenAI-compatible endpoint).

- [ ] **Step 1: Write failing test**

Create `tests/adapters/llm-deepseek.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeepSeekLLM } from '../../src/adapters/llm-deepseek';
import type { ChatRequest } from '../../src/ports/llm';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('DeepSeekLLM', () => {
	beforeEach(() => {
		mockFetch.mockReset();
	});

	it('sends chat request and yields text deltas', async () => {
		// Simulate SSE stream with two text chunks
		const sseChunks = [
			'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
			'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
			'data: [DONE]\n\n',
		];
		const encoder = new TextEncoder();
		const stream = new ReadableStream({
			start(controller) {
				for (const chunk of sseChunks) {
					controller.enqueue(encoder.encode(chunk));
				}
				controller.close();
			},
		});

		mockFetch.mockResolvedValueOnce({
			ok: true,
			body: stream,
		});

		const llm = new DeepSeekLLM({
			apiBase: 'https://api.deepseek.com',
			apiKey: 'sk-test',
			model: 'deepseek-chat',
		});

		const req: ChatRequest = {
			messages: [{ role: 'user', content: 'Hi' }],
		};

		const deltas: string[] = [];
		for await (const delta of llm.chat(req)) {
			if (delta.text) deltas.push(delta.text);
		}

		expect(deltas).toEqual(['Hello', ' world']);
		expect(mockFetch).toHaveBeenCalledOnce();
		const [url, options] = mockFetch.mock.calls[0]!;
		expect(url).toBe('https://api.deepseek.com/chat/completions');
		expect((options as RequestInit).method).toBe('POST');
	});

	it('handles tool calls in stream', async () => {
		const sseChunks = [
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_note","arguments":""}}]}}]}\n\n',
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}\n\n',
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"test.md\\"}"}}]}}]}\n\n',
			'data: [DONE]\n\n',
		];
		const encoder = new TextEncoder();
		const stream = new ReadableStream({
			start(controller) {
				for (const chunk of sseChunks) {
					controller.enqueue(encoder.encode(chunk));
				}
				controller.close();
			},
		});

		mockFetch.mockResolvedValueOnce({
			ok: true,
			body: stream,
		});

		const llm = new DeepSeekLLM({
			apiBase: 'https://api.deepseek.com',
			apiKey: 'sk-test',
			model: 'deepseek-chat',
		});

		const req: ChatRequest = {
			messages: [{ role: 'user', content: 'Read test.md' }],
			tools: [{
				name: 'read_note',
				description: 'Read a note',
				parameters: { type: 'object', properties: { path: { type: 'string' } } },
			}],
		};

		let toolCallFound = false;
		for await (const delta of llm.chat(req)) {
			if (delta.toolCall) {
				toolCallFound = true;
				expect(delta.toolCall.name).toBe('read_note');
				expect(delta.toolCall.args).toEqual({ path: 'test.md' });
			}
		}
		expect(toolCallFound).toBe(true);
	});

	it('throws on API error', async () => {
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 401,
			statusText: 'Unauthorized',
			body: null,
		});

		const llm = new DeepSeekLLM({
			apiBase: 'https://api.deepseek.com',
			apiKey: 'sk-bad',
			model: 'deepseek-chat',
		});

		await expect(async () => {
			const stream = llm.chat({ messages: [{ role: 'user', content: 'Hi' }] });
			for await (const _ of stream) { /* consume */ }
		}).rejects.toThrow('LLM API error: 401 Unauthorized');
	});

	it('countTokens returns rough estimate', () => {
		const llm = new DeepSeekLLM({
			apiBase: 'https://api.deepseek.com',
			apiKey: 'sk-test',
			model: 'deepseek-chat',
		});
		const count = llm.countTokens('Hello world');
		expect(count).toBeGreaterThan(0);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/adapters/llm-deepseek.test.ts`
Expected: FAIL — DeepSeekLLM not implemented

- [ ] **Step 3: Write implementation**

Replace entire content of `src/adapters/llm-deepseek.ts`:

```typescript
import type { LLMClient, ChatRequest, ChatDelta, ToolCall, ChatMessage } from '../ports/llm';

interface DeepSeekConfig {
	apiBase: string;
	apiKey: string;
	model: string;
}

interface OpenAIToolCallChunk {
	index: number;
	id?: string;
	type?: string;
	function?: {
		name?: string;
		arguments?: string;
	};
}

export class DeepSeekLLM implements LLMClient {
	constructor(private config: DeepSeekConfig) {}

	async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
		const body = this.buildRequestBody(req);

		const response = await fetch(`${this.config.apiBase}/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.config.apiKey}`,
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			throw new Error(`LLM API error: ${response.status} ${response.statusText}`);
		}

		if (!response.body) {
			throw new Error('LLM API returned no body');
		}

		const toolCallAccumulators = new Map<number, { id: string; name: string; arguments: string }>();

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed || !trimmed.startsWith('data: ')) continue;

					const data = trimmed.slice(6);
					if (data === '[DONE]') return;

					try {
						const parsed = JSON.parse(data) as {
							choices?: Array<{
								delta?: {
									content?: string;
									tool_calls?: OpenAIToolCallChunk[];
								};
							}>;
						};

						const choice = parsed.choices?.[0];
						if (!choice?.delta) continue;

						// Text content
						if (choice.delta.content) {
							yield { text: choice.delta.content };
						}

						// Tool calls — accumulate across chunks
						if (choice.delta.tool_calls) {
							for (const tc of choice.delta.tool_calls) {
								const existing = toolCallAccumulators.get(tc.index);
								if (existing) {
									if (tc.function?.arguments) {
										existing.arguments += tc.function.arguments;
									}
								} else {
									toolCallAccumulators.set(tc.index, {
										id: tc.id ?? '',
										name: tc.function?.name ?? '',
										arguments: tc.function?.arguments ?? '',
									});
								}
							}
						}
					} catch {
						// Skip malformed JSON chunks
					}
				}
			}
		} finally {
			reader.releaseLock();
		}

		// Yield accumulated tool calls
		for (const [, tc] of toolCallAccumulators) {
			let args: Record<string, unknown> = {};
			try {
				args = JSON.parse(tc.arguments) as Record<string, unknown>;
			} catch {
				args = { raw: tc.arguments };
			}
			const toolCall: ToolCall = { id: tc.id, name: tc.name, args };
			yield { text: '', toolCall };
		}
	}

	async embed(_texts: string[]): Promise<number[][]> {
		throw new Error('embed() not implemented in W1 — use W2 vector search instead');
	}

	countTokens(text: string): number {
		// Rough estimation: ~4 chars per token for mixed CJK/Latin
		return Math.ceil(text.length / 4);
	}

	private buildRequestBody(req: ChatRequest): Record<string, unknown> {
		const messages: Record<string, unknown>[] = req.messages.map((m) => {
			const msg: Record<string, unknown> = { role: m.role, content: m.content };
			if (m.role === 'tool' && m.toolCallId) {
				msg.tool_call_id = m.toolCallId;
			}
			return msg;
		});

		const body: Record<string, unknown> = {
			model: this.config.model,
			messages,
			stream: true,
		};

		if (req.tools && req.tools.length > 0) {
			body.tools = req.tools.map((t) => ({
				type: 'function',
				function: {
					name: t.name,
					description: t.description,
					parameters: t.parameters,
				},
			}));
		}

		return body;
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/adapters/llm-deepseek.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/adapters/llm-deepseek.ts tests/adapters/llm-deepseek.test.ts
git commit -m "feat: implement DeepSeek LLM adapter with streaming and tool calls"
```

---

## Task 9: Worker Bridge (WorkerManager + Worker Dispatch)

**Files:**
- Create: `tests/worker/worker-bridge.test.ts`
- Modify: `src/worker/index.ts`

The WorkerManager wraps the Worker thread with typed request/response. The Worker dispatch handles incoming messages and routes to handlers.

- [ ] **Step 1: Write failing test**

Create `tests/worker/worker-bridge.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { WorkerManager } from '../../src/worker/manager';

describe('WorkerManager', () => {
	it('sends index.status request and receives response', async () => {
		// Create a mock Worker that echoes back a response
		const mockWorker = {
			postMessage: vi.fn(),
			onmessage: null as ((e: MessageEvent) => void) | null,
			terminate: vi.fn(),
		};

		const manager = new WorkerManager(mockWorker as unknown as Worker);

		// Simulate the worker responding
		const responsePromise = manager.request({
			type: 'index.status',
			payload: {},
		});

		// Simulate worker sending back a response
		expect(mockWorker.postMessage).toHaveBeenCalledWith({
			type: 'index.status',
			payload: {},
			_requestId: expect.any(String),
		});

		// Get the request ID from the postMessage call
		const sentMessage = mockWorker.postMessage.mock.calls[0]![0] as Record<string, unknown>;
		const requestId = sentMessage._requestId as string;

		// Simulate worker response
		mockWorker.onmessage!({
			data: {
				type: 'index.status.result',
				payload: { totalDocs: 42, lastIndexTime: 1000 },
				_requestId: requestId,
			},
		} as MessageEvent);

		const response = await responsePromise;
		expect(response).toEqual({
			type: 'index.status.result',
			payload: { totalDocs: 42, lastIndexTime: 1000 },
		});
	});

	it('handles worker errors', async () => {
		const mockWorker = {
			postMessage: vi.fn(),
			onmessage: null as ((e: MessageEvent) => void) | null,
			onerror: null as ((e: ErrorEvent) => void) | null,
			terminate: vi.fn(),
		};

		const manager = new WorkerManager(mockWorker as unknown as Worker);

		const responsePromise = manager.request({
			type: 'index.full',
			payload: { vaultPath: '/test' },
		});

		// Simulate worker error
		mockWorker.onerror!(new ErrorEvent('error', { message: 'Worker crashed' }));

		await expect(responsePromise).rejects.toThrow('Worker error: Worker crashed');
	});

	it('terminates worker on destroy', () => {
		const mockWorker = {
			postMessage: vi.fn(),
			onmessage: null as ((e: MessageEvent) => void) | null,
			terminate: vi.fn(),
		};

		const manager = new WorkerManager(mockWorker as unknown as Worker);
		manager.destroy();
		expect(mockWorker.terminate).toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/worker/worker-bridge.test.ts`
Expected: FAIL — `Cannot find module '../../src/worker/manager'`

- [ ] **Step 3: Write WorkerManager implementation**

Create `src/worker/manager.ts`:

```typescript
import type { WorkerRequest, WorkerResponse } from '../types';

interface PendingRequest {
	resolve: (response: WorkerResponse) => void;
	reject: (error: Error) => void;
}

/**
 * Manages communication with the Worker thread.
 * Wraps postMessage with typed request/response and Promise-based API.
 */
export class WorkerManager {
	private pending = new Map<string, PendingRequest>();
	private requestCounter = 0;

	constructor(private worker: Worker) {
		this.worker.onmessage = (e: MessageEvent) => {
			const data = e.data as WorkerResponse & { _requestId?: string };
			if (data._requestId) {
				const pending = this.pending.get(data._requestId);
				if (pending) {
					this.pending.delete(data._requestId);
					pending.resolve(data);
				}
			}
		};

		this.worker.onerror = (e: ErrorEvent) => {
			// Reject all pending requests on worker error
			for (const [id, pending] of this.pending) {
				this.pending.delete(id);
				pending.reject(new Error(`Worker error: ${e.message}`));
			}
		};
	}

	/**
	 * Send a typed request to the Worker and return a Promise that resolves
	 * with the typed response.
	 */
	request(req: WorkerRequest): Promise<WorkerResponse> {
		return new Promise<WorkerResponse>((resolve, reject) => {
			const requestId = `req_${++this.requestCounter}_${Date.now()}`;
			this.pending.set(requestId, { resolve, reject });
			this.worker.postMessage({ ...req, _requestId: requestId });
		});
	}

	/**
	 * Terminate the Worker thread.
	 */
	destroy(): void {
		this.worker.terminate();
		this.pending.clear();
	}
}
```

- [ ] **Step 4: Write Worker dispatch skeleton**

Replace entire content of `src/worker/index.ts`:

```typescript
/**
 * Worker thread entry point — W1 skeleton
 *
 * Handles message dispatch for CPU-intensive tasks.
 * Full vectra integration comes in W2.
 * Worker does NOT make HTTP requests and does NOT import Obsidian API.
 */

import type { WorkerRequest, WorkerResponse } from '../types';

self.onmessage = async (e: MessageEvent) => {
	const msg = e.data as WorkerRequest & { _requestId?: string };
	const requestId = msg._requestId;

	try {
		const response = await handleMessage(msg);
		if (requestId) {
			(response as Record<string, unknown>)._requestId = requestId;
		}
		self.postMessage(response);
	} catch (err) {
		const errorResponse: WorkerResponse = {
			type: 'error',
			payload: {
				code: 'WORKER_ERROR',
				message: err instanceof Error ? err.message : String(err),
			},
		};
		if (requestId) {
			(errorResponse as Record<string, unknown>)._requestId = requestId;
		}
		self.postMessage(errorResponse);
	}
};

async function handleMessage(msg: WorkerRequest & { _requestId?: string }): Promise<WorkerResponse> {
	switch (msg.type) {
		case 'index.status': {
			// W1 skeleton: return stub status
			return {
				type: 'index.status.result',
				payload: { totalDocs: 0, lastIndexTime: 0 },
			};
		}

		case 'index.full':
		case 'index.incremental':
		case 'index.delete':
		case 'vector.search':
		case 'vector.upsert':
		case 'vector.delete': {
			// W2: implement with vectra
			return {
				type: 'error',
				payload: {
					code: 'NOT_IMPLEMENTED',
					message: `${msg.type} will be implemented in W2`,
				},
			};
		}

		default: {
			return {
				type: 'error',
				payload: {
					code: 'UNKNOWN_REQUEST',
					message: `Unknown request type: ${(msg as WorkerRequest).type}`,
				},
			};
		}
	}
}
```

- [ ] **Step 5: Add vi import to worker bridge test**

Update `tests/worker/worker-bridge.test.ts` — add `vi` import:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { WorkerManager } from '../../src/worker/manager';
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- tests/worker/worker-bridge.test.ts`
Expected: PASS (all 3 tests)

- [ ] **Step 7: Commit**

```bash
git add src/worker/manager.ts src/worker/index.ts tests/worker/worker-bridge.test.ts
git commit -m "feat: add WorkerManager and Worker dispatch skeleton"
```

---

## Task 10: Agent Loop

**Files:**
- Create: `tests/core/agent-loop.test.ts`
- Modify: `src/core/agent-loop.ts`

- [ ] **Step 1: Write failing test**

Create `tests/core/agent-loop.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { agentLoop } from '../../src/core/agent-loop';
import { ContextManager } from '../../src/core/context-manager';
import { ToolRegistry } from '../../src/core/tool-registry';
import { HookRegistry } from '../../src/core/hooks';
import type { LLMClient, ChatRequest, ChatDelta } from '../../src/ports/llm';
import type { Persistence, Session } from '../../src/ports/persistence';
import type { ToolCall } from '../../src/ports/llm';
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

		// Should have: message.start, message.delta(x2), message.end
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

		// First LLM response: tool call
		// Second LLM response: final answer
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

		// Should have tool.call and tool.result events
		expect(events.some((e) => e.type === 'tool.call')).toBe(true);
		expect(events.some((e) => e.type === 'tool.result')).toBe(true);
		// Should have final message.end
		expect(events.some((e) => e.type === 'message.end')).toBe(true);
	});

	it('respects MAX_STEPS limit', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);

		// LLM always returns a tool call (infinite loop scenario)
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

		// Should stop after MAX_STEPS (10) tool calls, not infinite
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/core/agent-loop.test.ts`
Expected: FAIL — agentLoop not implemented

- [ ] **Step 3: Write implementation**

Replace entire content of `src/core/agent-loop.ts`:

```typescript
import type { UserChatRequest, AgentEvent } from '../types';
import type { LLMClient, ToolCall } from '../ports/llm';
import type { ContextManager } from './context-manager';
import type { ToolRegistry } from './tool-registry';
import type { HookRegistry } from './hooks';

const MAX_STEPS = 10;

export async function* agentLoop(
	req: UserChatRequest,
	ctx: ContextManager,
	llm: LLMClient,
	tools: ToolRegistry,
	hooks: HookRegistry,
): AsyncIterable<AgentEvent> {
	await ctx.load(req.sessionId);
	ctx.addUserMessage(req.message);

	for (let step = 0; step < MAX_STEPS; step++) {
		yield { type: 'message.start', payload: { role: 'assistant' as const } };

		const stream = llm.chat({
			messages: ctx.toMessages(),
			tools: tools.definitions(),
		});

		let accumulatedText = '';
		let toolCall: ToolCall | null = null;

		for await (const delta of stream) {
			if (delta.text) {
				accumulatedText += delta.text;
				yield { type: 'message.delta', payload: { text: delta.text } };
			}
			if (delta.toolCall) {
				toolCall = delta.toolCall;
			}
		}

		if (!toolCall) {
			// No tool call — final answer
			ctx.addAssistantMessage(accumulatedText);
			break;
		}

		// Tool call
		yield { type: 'tool.call', payload: { name: toolCall.name, args: toolCall.args } };

		// Pre-hook
		await hooks.run('pre-write', toolCall);

		// Execute tool
		const result = await tools.execute(toolCall);
		yield { type: 'tool.result', payload: { name: toolCall.name, result } };

		// Post-hook
		await hooks.run('post-write', toolCall);

		// Add to context
		ctx.addAssistantToolCall(toolCall, accumulatedText);
		ctx.addToolResult(toolCall.id, JSON.stringify(result));
	}

	yield { type: 'message.end', payload: { tokens: ctx.tokenCount() } };
	await ctx.save();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/core/agent-loop.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/agent-loop.ts tests/core/agent-loop.test.ts
git commit -m "feat: implement Agent Loop with tool call orchestration"
```

---

## Task 11: Chat Sidebar + Plugin Wiring

**Files:**
- Create: `src/ui/ChatView.ts`
- Create: `src/ui/ChatView.svelte`
- Modify: `src/main.ts`

- [ ] **Step 1: Create ChatView ItemView wrapper**

Create `src/ui/ChatView.ts`:

```typescript
import { ItemView, type WorkspaceLeaf } from 'obsidian';
import type { SvelteComponent } from 'svelte';
import ChatViewComponent from './ChatView.svelte';
import type RatelVaultPlugin from '../main';

export const VIEW_TYPE_CHAT = 'ratel-chat';

export class ChatView extends ItemView {
	component: (SvelteComponent & { $destroy: () => void }) | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: RatelVaultPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_CHAT;
	}

	getDisplayText(): string {
		return 'Ratel Chat';
	}

	getIcon(): string {
		return 'brain';
	}

	onOpen(): void {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();

		this.component = new ChatViewComponent({
			target: container,
			props: {
				plugin: this.plugin,
			},
		}) as SvelteComponent & { $destroy: () => void };
	}

	onClose(): void {
		this.component?.$destroy();
		this.component = null;
	}
}
```

- [ ] **Step 2: Create ChatView Svelte component**

Create `src/ui/ChatView.svelte`:

```svelte
<script lang="ts">
	import type RatelVaultPlugin from '../main';
	import type { AgentEvent } from '../types';

	interface Message {
		role: 'user' | 'assistant';
		content: string;
	}

	let plugin: RatelVaultPlugin;
	let messages: Message[] = [];
	let input = '';
	let isRunning = false;

	async function sendMessage() {
		const text = input.trim();
		if (!text || isRunning) return;

		messages = [...messages, { role: 'user', content: text }];
		input = '';
		isRunning = true;

		const assistantMsg: Message = { role: 'assistant', content: '' };
		messages = [...messages, assistantMsg];

		try {
			const sessionId = 'session-' + Date.now();
			const events = plugin.ask(sessionId, text);

			for await (const event of events) {
				switch (event.type) {
					case 'message.delta':
						assistantMsg.content += event.payload.text;
						messages = [...messages]; // trigger reactivity
						break;
					case 'message.end':
						break;
					case 'error':
						assistantMsg.content += `\n\n⚠ Error: ${event.payload.message}`;
						messages = [...messages];
						break;
				}
			}
		} catch (err) {
			assistantMsg.content += `\n\n⚠ Error: ${err instanceof Error ? err.message : String(err)}`;
			messages = [...messages];
		} finally {
			isRunning = false;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			sendMessage();
		}
	}
</script>

<div class="ratel-chat">
	<div class="ratel-messages">
		{#each messages as msg}
			<div class="ratel-message ratel-{msg.role}">
				<div class="ratel-role">{msg.role === 'user' ? 'You' : 'Ratel'}</div>
				<div class="ratel-content">{msg.content}</div>
			</div>
		{/each}
		{#if isRunning && messages[messages.length - 1]?.content === ''}
			<div class="ratel-typing">Thinking...</div>
		{/if}
	</div>

	<div class="ratel-input-area">
		<textarea
			bind:value={input}
			on:keydown={handleKeydown}
			placeholder="Ask about your vault..."
			disabled={isRunning}
			rows="2"
		></textarea>
		<button on:click={sendMessage} disabled={isRunning || !input.trim()}>
			Send
		</button>
	</div>
</div>

<style>
	.ratel-chat {
		display: flex;
		flex-direction: column;
		height: 100%;
		padding: 8px;
	}

	.ratel-messages {
		flex: 1;
		overflow-y: auto;
		padding-bottom: 8px;
	}

	.ratel-message {
		margin-bottom: 12px;
		padding: 8px 12px;
		border-radius: 8px;
	}

	.ratel-user {
		background: var(--interactive-accent);
		color: var(--text-on-accent);
		margin-left: 20%;
	}

	.ratel-assistant {
		background: var(--background-secondary);
		color: var(--text-normal);
		margin-right: 10%;
	}

	.ratel-role {
		font-size: 0.75em;
		font-weight: 600;
		margin-bottom: 4px;
		opacity: 0.7;
	}

	.ratel-content {
		white-space: pre-wrap;
		word-break: break-word;
	}

	.ratel-typing {
		color: var(--text-muted);
		font-style: italic;
		padding: 4px 12px;
	}

	.ratel-input-area {
		display: flex;
		gap: 8px;
		align-items: flex-end;
		border-top: 1px solid var(--background-modifier-border);
		padding-top: 8px;
	}

	.ratel-input-area textarea {
		flex: 1;
		resize: none;
		padding: 8px;
		border-radius: 6px;
		border: 1px solid var(--background-modifier-border);
		background: var(--background-primary);
		color: var(--text-normal);
		font-family: inherit;
		font-size: 14px;
	}

	.ratel-input-area textarea:focus {
		outline: none;
		border-color: var(--interactive-accent);
	}

	.ratel-input-area button {
		padding: 8px 16px;
		border-radius: 6px;
		border: none;
		background: var(--interactive-accent);
		color: var(--text-on-accent);
		cursor: pointer;
		font-size: 14px;
	}

	.ratel-input-area button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
```

- [ ] **Step 3: Update main.ts to wire all components**

Replace entire content of `src/main.ts`:

```typescript
import { Notice, Plugin } from 'obsidian';
import { type RatelVaultSettings, DEFAULT_SETTINGS, RatelVaultSettingTab } from './settings';
import { type AgentEvent, type UserChatRequest } from './types';
import { agentLoop } from './core/agent-loop';
import { ContextManager } from './core/context-manager';
import { HookRegistry } from './core/hooks';
import { ToolRegistry } from './core/tool-registry';
import { ObsidianVault } from './adapters/obsidian-vault';
import { PersistenceJson } from './adapters/persistence-json';
import { DeepSeekLLM } from './adapters/llm-deepseek';
import { WorkerManager } from './worker/manager';
import { createReadNoteTool } from './tools/read-note';
import { ChatView, VIEW_TYPE_CHAT } from './ui/ChatView';
import path from 'path';

export default class RatelVaultPlugin extends Plugin {
	settings!: RatelVaultSettings;
	vault!: ObsidianVault;
	persistence!: PersistenceJson;
	llm!: DeepSeekLLM;
	tools!: ToolRegistry;
	hooks!: HookRegistry;
	workerManager!: WorkerManager;

	async onload() {
		await this.loadSettings();

		// Initialize adapters
		this.vault = new ObsidianVault(this.app);
		this.persistence = new PersistenceJson(
			() => this.loadData(),
			(data) => this.saveData(data),
		);
		this.llm = new DeepSeekLLM({
			apiBase: this.settings.chatApiBase,
			apiKey: this.settings.chatApiKey,
			model: this.settings.chatModel,
		});

		// Initialize Worker
		const workerPath = path.join(__dirname, 'worker.js');
		const worker = new Worker(workerPath);
		this.workerManager = new WorkerManager(worker);

		// Initialize tools
		this.tools = new ToolRegistry();
		this.tools.register(createReadNoteTool(this.vault));

		// Initialize hooks
		this.hooks = new HookRegistry();

		// Register ChatView
		this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this));

		// Ribbon icon — opens chat sidebar
		this.addRibbonIcon('brain', 'Ratel', () => {
			this.activateChatView();
		});

		// Command: ask vault
		this.addCommand({
			id: 'ask-vault',
			name: 'Ask vault',
			callback: () => {
				this.activateChatView();
			},
		});

		// Command: index status
		this.addCommand({
			id: 'index-status',
			name: 'Show index status',
			callback: async () => {
				const response = await this.workerManager.request({
					type: 'index.status',
					payload: {},
				});
				if (response.type === 'index.status.result') {
					new Notice(`Index: ${response.payload.totalDocs} docs, last: ${new Date(response.payload.lastIndexTime).toLocaleString()}`);
				} else {
					new Notice('Index not available yet');
				}
			},
		});

		// Settings tab
		this.addSettingTab(new RatelVaultSettingTab(this.app, this));

		console.log('Ratel loaded');
	}

	onunload() {
		this.workerManager.destroy();
		console.log('Ratel unloaded');
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<RatelVaultSettings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * Main entry point for chat — called by ChatView.svelte.
	 * Returns an async iterable of AgentEvents for streaming UI updates.
	 */
	async *ask(sessionId: string, message: string): AsyncIterable<AgentEvent> {
		const ctx = new ContextManager(this.persistence);

		yield* agentLoop(
			{ sessionId, message },
			ctx,
			this.llm,
			this.tools,
			this.hooks,
		);
	}

	private async activateChatView() {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
		if (!leaf) {
			const rightLeaf = workspace.getRightLeaf(false);
			if (rightLeaf) {
				leaf = rightLeaf;
				await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
			}
		} else {
			workspace.revealLeaf(leaf);
		}
	}
}
```

- [ ] **Step 4: Verify build passes**

Run: `npm run build`
Expected: Build succeeds (main.js + worker.js generated)

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/ui/ChatView.ts src/ui/ChatView.svelte src/main.ts
git commit -m "feat: add Chat sidebar and wire all W1 components in main.ts"
```

---

## Task 12: Remove Placeholder Files

**Files:**
- Delete: `src/tools/index.ts`
- Delete: `src/subagents/index.ts`
- Delete: `src/ui/index.ts`
- Delete: `src/utils/index.ts`

These placeholder files are no longer needed — real implementations now live in their own files.

- [ ] **Step 1: Delete placeholder files**

```bash
rm src/tools/index.ts src/subagents/index.ts src/ui/index.ts src/utils/index.ts
```

- [ ] **Step 2: Verify build still passes**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove placeholder index files replaced by real implementations"
```

---

## Self-Review

### 1. Spec Coverage

| Spec Requirement | Task |
|---|---|
| 最小 Agent Loop | Task 10 |
| read_note tool | Task 6 |
| Worker 骨架 | Task 9 |
| ObsidianVault facade | Pre-existing (no task needed) |
| 侧边栏能问「X 是啥」 | Task 11 |
| vitest 测试框架 (S2) | Task 1 |
| JSON 持久化 (H1 修正) | Task 7 |
| Worker 不做 HTTP (H2 修正) | Task 9 (Worker has no fetch) |
| 1 包 + 目录模块 (S1 修正) | All tasks follow this pattern |
| ObsidianVault facade (额外决策) | Pre-existing |
| SHA-256 content hash (7.3) | Task 3 |
| WorkerManager typed bridge | Task 9 |
| DeepSeek streaming adapter | Task 8 |
| ContextManager | Task 5 |
| ToolRegistry | Task 4 |
| Type deduplication | Task 2 |

**Gaps:** None. All W1 spec requirements are covered.

### 2. Placeholder Scan

- No "TBD", "TODO", "implement later", "fill in details" found
- No "add appropriate error handling" without code
- No "write tests for the above" without actual test code
- No "similar to Task N" without repeating code
- `embed()` in DeepSeekLLM throws with clear message — this is intentional W2 deferral, not a placeholder

### 3. Type Consistency

| Type | Defined In | Used In | Consistent |
|---|---|---|---|
| `ToolCall` | `ports/llm.ts` | `hooks.ts`, `tool-registry.ts`, `agent-loop.ts`, `context-manager.ts` | Yes — `{ id, name, args }` |
| `ChatMessage` | `ports/persistence.ts` | `context-manager.ts`, `persistence-json.ts` | Yes |
| `ChatDelta` | `ports/llm.ts` | `llm-deepseek.ts` | Yes — `{ text, toolCall? }` |
| `ChatRequest` | `ports/llm.ts` | `llm-deepseek.ts` | Yes — `{ messages, tools? }` |
| `UserChatRequest` | `types.ts` | `agent-loop.ts` | Yes — `{ sessionId, message }` |
| `AgentEvent` | `types.ts` | `agent-loop.ts`, `ChatView.svelte` | Yes |
| `WorkerRequest/Response` | `types.ts` | `worker/index.ts`, `worker/manager.ts` | Yes |
| `Tool` | `core/tool-registry.ts` | `read-note.ts`, `agent-loop.test.ts` | Yes — `{ definition, execute }` |
| `ToolDefinition` | `ports/llm.ts` | `tool-registry.ts`, `read-note.ts` | Yes |
| `Persistence` | `ports/persistence.ts` | `persistence-json.ts`, `context-manager.ts` | Yes |
| `Session` | `ports/persistence.ts` | `persistence-json.ts`, `context-manager.ts` | Yes |
| `VectorSearchResult` | `ports/vector.ts` | `types.ts` (re-export) | Yes |

All types are consistent across tasks.
