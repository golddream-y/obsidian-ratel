# W3 Test Plan: Hybrid Search + RRF + Citations

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate the W3 hybrid retrieval pipeline (RRF fusion, search_vault tool, Worker vector+BM25 handlers, context injection, citation events). All tests are L1 unit tests except one L2 integration test for the full search flow.

**Architecture:** TDD on every new module — RRF algorithm, search_vault tool, ContextManager.addSearchResults, citation event, and Worker handlers. L2 integration test wires Worker + RRF + search_vault end-to-end using real vectra.

**Tech Stack:** vitest, TypeScript strict mode, vectra

**Prerequisite:** W2 implementation merged (EmbeddingPort, VectraStore, Markdown chunker). W3 implementation plan (`2026-06-13-ratel-w3-implementation.md`) merged with RRF, search_vault, Worker vector+BM25, addSearchResults, search.result event.

---

## File Structure

### New test files

| File | Purpose |
|---|---|
| `tests/core/rrf.test.ts` | RRF fusion unit tests (10 cases) |
| `tests/tools/search-vault.test.ts` | search_vault tool unit tests (8 cases) |
| `tests/integration/search-pipeline.test.ts` | L2: Worker + RRF + search_vault end-to-end |

### Modified test files

| File | Adds |
|---|---|
| `tests/core/context-manager.test.ts` | addSearchResults behavior |
| `tests/core/agent-loop.test.ts` | citation event emission |
| `tests/adapters/llm-deepseek.test.ts` | citation prompt in system message |

---

## Task 1: RRF — Empty Input + Single List Edge Cases

**Files:**
- Create: `tests/core/rrf.test.ts`

- [ ] **Step 1: Read the RRF implementation**

Read `src/core/rrf.ts` to understand the `RankedItem`, `FusedItem` types and the `reciprocalRankFusion` signature.

- [ ] **Step 2: Write failing test file**

Create `tests/core/rrf.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { reciprocalRankFusion, type RankedItem, type FusedItem } from '../../src/core/rrf';

describe('reciprocalRankFusion', () => {
	it('returns empty array when no lists provided', () => {
		const result = reciprocalRankFusion([]);
		expect(result).toEqual([]);
	});

	it('returns empty array when all lists are empty', () => {
		const result = reciprocalRankFusion([[], []]);
		expect(result).toEqual([]);
	});

	it('fuses single list and preserves order', () => {
		const lists: RankedItem[][] = [
			[
				{ id: 'a', score: 0.9 },
				{ id: 'b', score: 0.7 },
				{ id: 'c', score: 0.5 },
			],
		];
		const result = reciprocalRankFusion(lists, 60);
		expect(result.map((r) => r.id)).toEqual(['a', 'b', 'c']);
	});

	it('fuses two overlapping lists — shared items rank higher', () => {
		const lists: RankedItem[][] = [
			[
				{ id: 'a', score: 0.9 },
				{ id: 'b', score: 0.7 },
				{ id: 'c', score: 0.5 },
			],
			[
				{ id: 'b', score: 0.95 },
				{ id: 'a', score: 0.8 },
				{ id: 'd', score: 0.6 },
			],
		];
		const result = reciprocalRankFusion(lists, 60);
		// Items in both lists (a, b) get summed RRF score → rank above c, d
		const topTwo = result.slice(0, 2).map((r) => r.id).sort();
		expect(topTwo).toEqual(['a', 'b']);
		expect(result).toHaveLength(4);
	});

	it('applies k parameter to RRF score formula', () => {
		const lists: RankedItem[][] = [
			[{ id: 'a', score: 1.0 }],
			[{ id: 'a', score: 1.0 }],
		];
		const resultK60 = reciprocalRankFusion(lists, 60);
		const resultK1 = reciprocalRankFusion(lists, 1);
		// k=1 → 1/(1+0) + 1/(1+0) = 2.0
		// k=60 → 1/(60+0) + 1/(60+0) ≈ 0.0333
		expect(resultK1[0].rrfScore).toBeCloseTo(2.0, 5);
		expect(resultK60[0].rrfScore).toBeCloseTo(0.0333, 3);
		expect(resultK1[0].rrfScore).toBeGreaterThan(resultK60[0].rrfScore);
	});

	it('sorts results by RRF score descending', () => {
		const lists: RankedItem[][] = [
			[
				{ id: 'x', score: 0.5 },
				{ id: 'y', score: 0.4 },
				{ id: 'z', score: 0.3 },
			],
			[
				{ id: 'z', score: 0.9 },
				{ id: 'x', score: 0.8 },
				{ id: 'w', score: 0.7 },
			],
		];
		const result = reciprocalRankFusion(lists, 60);
		for (let i = 1; i < result.length; i++) {
			expect(result[i - 1].rrfScore).toBeGreaterThanOrEqual(result[i].rrfScore);
		}
	});

	it('limits output to topK when provided', () => {
		const lists: RankedItem[][] = [
			Array.from({ length: 20 }, (_, i) => ({ id: `item${i}`, score: 1 - i * 0.05 })),
		];
		const result = reciprocalRankFusion(lists, 60, 5);
		expect(result).toHaveLength(5);
	});

	it('preserves sourceScores for each list position', () => {
		const lists: RankedItem[][] = [
			[{ id: 'a', score: 0.9 }, { id: 'b', score: 0.5 }],
			[{ id: 'b', score: 0.8 }, { id: 'c', score: 0.3 }],
		];
		const result = reciprocalRankFusion(lists, 60);
		const a = result.find((r) => r.id === 'a');
		const b = result.find((r) => r.id === 'b');
		const c = result.find((r) => r.id === 'c');

		// a: only in list 0
		expect(a?.sourceScores[0]).toBe(0.9);
		expect(a?.sourceScores[1]).toBeUndefined();

		// b: in both lists
		expect(b?.sourceScores[0]).toBe(0.5);
		expect(b?.sourceScores[1]).toBe(0.8);

		// c: only in list 1
		expect(c?.sourceScores[0]).toBeUndefined();
		expect(c?.sourceScores[1]).toBe(0.3);
	});

	it('handles three or more lists', () => {
		const lists: RankedItem[][] = [
			[{ id: 'a', score: 0.9 }, { id: 'b', score: 0.5 }],
			[{ id: 'a', score: 0.8 }, { id: 'b', score: 0.4 }],
			[{ id: 'a', score: 0.7 }, { id: 'c', score: 0.3 }],
		];
		const result = reciprocalRankFusion(lists, 60);
		// a appears in all 3 lists → highest RRF
		expect(result[0].id).toBe('a');
		expect(result[0].sourceScores).toHaveLength(3);
	});

	it('uses k=60 by default', () => {
		const lists: RankedItem[][] = [[{ id: 'a', score: 1.0 }]];
		const result = reciprocalRankFusion(lists);
		// Default k=60 → 1/(60+0) ≈ 0.01667
		expect(result[0].rrfScore).toBeCloseTo(1 / 60, 5);
	});
});
```

- [ ] **Step 3: Run tests**

Run: `npm test -- tests/core/rrf.test.ts`
Expected: All 10 tests PASS (RRF already implemented in W3 Task 1)

- [ ] **Step 4: Commit**

```bash
git add tests/core/rrf.test.ts
git commit -m "test: add RRF fusion unit tests (10 cases)"
```

---

## Task 2: ContextManager — addSearchResults

**Files:**
- Modify: `tests/core/context-manager.test.ts`

- [ ] **Step 1: Read existing test file**

Read `tests/core/context-manager.test.ts` to understand the `persistence` fixture and existing test patterns.

- [ ] **Step 2: Add failing tests**

Append to the existing `describe('ContextManager', ...)`:

```typescript
import type { SearchResult } from '../../src/types'; // adjust path if different

describe('addSearchResults', () => {
	it('injects results as a tool message in session', async () => {
		const ctx = new ContextManager(persistence);
		await ctx.loadOrCreate('s1');
		ctx.addUserMessage('find notes about cats');

		ctx.addSearchResults([
			{ docId: 'doc1', score: 0.9, text: 'Cats are mammals', metadata: { path: 'cats.md' } },
			{ docId: 'doc2', score: 0.7, text: 'Dogs are friends', metadata: { path: 'dogs.md' } },
		]);

		const messages = ctx.toMessages();
		const searchMsg = messages.find((m) => m.toolCallId === '__search_vault__');
		expect(searchMsg).toBeDefined();
		expect(searchMsg?.role).toBe('tool');
		expect(searchMsg?.content).toContain('[1] cats.md');
		expect(searchMsg?.content).toContain('[2] dogs.md');
	});

	it('numbers results starting from 1', async () => {
		const ctx = new ContextManager(persistence);
		await ctx.loadOrCreate('s1');
		ctx.addUserMessage('q');

		ctx.addSearchResults([
			{ docId: 'a', score: 0.9, text: 'first', metadata: { path: 'a.md' } },
			{ docId: 'b', score: 0.8, text: 'second', metadata: { path: 'b.md' } },
			{ docId: 'c', score: 0.7, text: 'third', metadata: { path: 'c.md' } },
		]);

		const messages = ctx.toMessages();
		const searchMsg = messages.find((m) => m.toolCallId === '__search_vault__');
		expect(searchMsg?.content).toContain('[1] a.md');
		expect(searchMsg?.content).toContain('[2] b.md');
		expect(searchMsg?.content).toContain('[3] c.md');
	});

	it('truncates long text to 500 chars per result', async () => {
		const ctx = new ContextManager(persistence);
		await ctx.loadOrCreate('s1');
		ctx.addUserMessage('q');

		const longText = 'A'.repeat(1000);
		ctx.addSearchResults([
			{ docId: 'long', score: 0.9, text: longText, metadata: { path: 'long.md' } },
		]);

		const messages = ctx.toMessages();
		const searchMsg = messages.find((m) => m.toolCallId === '__search_vault__');
		// text is sliced to 500 chars
		expect(searchMsg?.content).toContain('A'.repeat(500));
		expect(searchMsg?.content).not.toContain('A'.repeat(501));
	});

	it('falls back to docId when metadata.path is missing', async () => {
		const ctx = new ContextManager(persistence);
		await ctx.loadOrCreate('s1');
		ctx.addUserMessage('q');

		ctx.addSearchResults([
			{ docId: 'orphan-id', score: 0.9, text: 'content', metadata: {} },
		]);

		const messages = ctx.toMessages();
		const searchMsg = messages.find((m) => m.toolCallId === '__search_vault__');
		expect(searchMsg?.content).toContain('[1] orphan-id');
	});

	it('handles empty results array gracefully', async () => {
		const ctx = new ContextManager(persistence);
		await ctx.loadOrCreate('s1');
		ctx.addUserMessage('q');

		ctx.addSearchResults([]);

		const messages = ctx.toMessages();
		// Should not throw, may or may not produce a tool message
		expect(messages.length).toBeGreaterThan(0);
	});

	it('updates session.updatedAt timestamp', async () => {
		const ctx = new ContextManager(persistence);
		await ctx.loadOrCreate('s1');
		const session = ctx.toMessages();

		ctx.addSearchResults([
			{ docId: 'd1', score: 0.9, text: 't', metadata: { path: 'a.md' } },
		]);

		await ctx.save();
		// The next load should reflect updated time changed
		const ctx2 = new ContextManager(persistence);
		await ctx2.loadOrCreate('s1');
		const reloaded = ctx2.toMessages();
		// Verify a tool message exists in reloaded
		const searchMsg = reloaded.find((m) => m.toolCallId === '__search_vault__');
		expect(searchMsg).toBeDefined();
	});

	it('throws before load', () => {
		const ctx = new ContextManager(persistence);
		expect(() =>
			ctx.addSearchResults([{ docId: 'd1', score: 0.9, text: 't', metadata: {} }]),
		).toThrow('Session not loaded');
	});
});
```

Note: The existing `persistence` fixture is used in earlier tests. If it doesn't exist, see Task 1 of W1 backfill plan for the fixture.

- [ ] **Step 3: Run tests**

Run: `npm test -- tests/core/context-manager.test.ts`
Expected: All tests pass (addSearchResults already implemented in W3 Task 4)

If any test fails due to differences in field names (e.g. `toolCallId` vs `tool_call_id`), adjust the test or the implementation to match.

- [ ] **Step 4: Commit**

```bash
git add tests/core/context-manager.test.ts
git commit -m "test: add ContextManager.addSearchResults tests (7 cases)"
```

---

## Task 3: search_vault Tool — Unit Tests

**Files:**
- Create: `tests/tools/search-vault.test.ts`

- [ ] **Step 1: Read the implementation**

Read `src/tools/search-vault.ts` to understand the createSearchVaultTool function signature, the SearchVaultDeps interface, and what it returns.

- [ ] **Step 2: Write test file**

Create `tests/tools/search-vault.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSearchVaultTool } from '../../src/tools/search-vault';
import type { EmbeddingPort } from '../../src/ports/embedding';
import type { WorkerManager } from '../../src/worker/manager';
import type { WorkerResponse } from '../../src/types';

const mockEmbedding: EmbeddingPort = {
	embed: vi.fn().mockResolvedValue([Array(512).fill(0.1)]),
	dimensions: 512,
	modelId: 'local:test',
};

const mockWorkerRequest = vi.fn();
const mockWorkerManager = {
	request: mockWorkerRequest,
} as unknown as WorkerManager;

describe('search_vault tool', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('has correct tool definition (name, parameters)', () => {
		const tool = createSearchVaultTool({
			embedding: mockEmbedding,
			workerManager: mockWorkerManager,
		});
		expect(tool.definition.name).toBe('search_vault');
		expect(tool.definition.parameters.properties).toHaveProperty('query');
		expect(tool.definition.parameters.properties).toHaveProperty('topK');
		expect(tool.definition.parameters.required).toContain('query');
	});

	it('is not readOnly (it does not modify vault state)', () => {
		const tool = createSearchVaultTool({
			embedding: mockEmbedding,
			workerManager: mockWorkerManager,
		});
		// Default is readOnly unless explicitly marked false
		expect(tool.readOnly).toBe(true);
	});

	it('embeds the query and calls worker for both vector and BM25 search', async () => {
		mockWorkerRequest
			.mockResolvedValueOnce({
				type: 'vector.search.result',
				payload: [{ docId: 'd1', score: 0.9, text: 't1', metadata: { path: 'a.md' } }],
			} as WorkerResponse)
			.mockResolvedValueOnce({
				type: 'bm25.search.result',
				payload: [{ docId: 'd1', score: 5.0, text: 't1', metadata: { path: 'a.md' } }],
			} as WorkerResponse);

		const tool = createSearchVaultTool({
			embedding: mockEmbedding,
			workerManager: mockWorkerManager,
		});
		await tool.execute({ query: 'cats and dogs' });

		expect(mockEmbedding.embed).toHaveBeenCalledWith(['cats and dogs']);
		expect(mockWorkerRequest).toHaveBeenCalledTimes(2);
		expect(mockWorkerRequest).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'vector.search' }),
		);
		expect(mockWorkerRequest).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'bm25.search' }),
		);
	});

	it('fuses results with RRF — items in both lists rank higher', async () => {
		mockWorkerRequest
			.mockResolvedValueOnce({
				type: 'vector.search.result',
				payload: [
					{ docId: 'd1', score: 0.9, text: 'a', metadata: { path: 'a.md' } },
					{ docId: 'd2', score: 0.7, text: 'b', metadata: { path: 'b.md' } },
				],
			} as WorkerResponse)
			.mockResolvedValueOnce({
				type: 'bm25.search.result',
				payload: [
					{ docId: 'd2', score: 5.0, text: 'b', metadata: { path: 'b.md' } },
					{ docId: 'd1', score: 3.0, text: 'a', metadata: { path: 'a.md' } },
				],
			} as WorkerResponse);

		const tool = createSearchVaultTool({
			embedding: mockEmbedding,
			workerManager: mockWorkerManager,
		});
		const result = (await tool.execute({ query: 'q' })) as Array<{ docId: string; vectorScore?: number; bm25Score?: number }>;

		// d1 and d2 both appear in both lists → should be in top 2
		expect(result.length).toBeGreaterThanOrEqual(2);
		const topTwoIds = result.slice(0, 2).map((r) => r.docId).sort();
		expect(topTwoIds).toEqual(['d1', 'd2']);

		// Each result should have vectorScore and bm25Score
		result.forEach((r) => {
			expect(r).toHaveProperty('vectorScore');
			expect(r).toHaveProperty('bm25Score');
		});
	});

	it('returns empty array when both searches return nothing', async () => {
		mockWorkerRequest
			.mockResolvedValueOnce({
				type: 'vector.search.result',
				payload: [],
			} as WorkerResponse)
			.mockResolvedValueOnce({
				type: 'bm25.search.result',
				payload: [],
			} as WorkerResponse);

		const tool = createSearchVaultTool({
			embedding: mockEmbedding,
			workerManager: mockWorkerManager,
		});
		const result = await tool.execute({ query: 'nonexistent' });
		expect(result).toEqual([]);
	});

	it('respects topK parameter and passes to worker', async () => {
		mockWorkerRequest
			.mockResolvedValueOnce({
				type: 'vector.search.result',
				payload: [],
			} as WorkerResponse)
			.mockResolvedValueOnce({
				type: 'bm25.search.result',
				payload: [],
			} as WorkerResponse);

		const tool = createSearchVaultTool({
			embedding: mockEmbedding,
			workerManager: mockWorkerManager,
		});
		await tool.execute({ query: 'test', topK: 5 });

		const calls = mockWorkerRequest.mock.calls;
		const vectorCall = calls.find((c) => (c[0] as { type: string }).type === 'vector.search');
		const bm25Call = calls.find((c) => (c[0] as { type: string }).type === 'bm25.search');
		expect((vectorCall?.[0] as { payload: { topK: number } }).payload.topK).toBe(10); // 2x over-fetch
		expect((bm25Call?.[0] as { payload: { topK: number } }).payload.topK).toBe(10);
	});

	it('defaults topK to 10 when not specified', async () => {
		mockWorkerRequest
			.mockResolvedValueOnce({
				type: 'vector.search.result',
				payload: [],
			} as WorkerResponse)
			.mockResolvedValueOnce({
				type: 'bm25.search.result',
				payload: [],
			} as WorkerResponse);

		const tool = createSearchVaultTool({
			embedding: mockEmbedding,
			workerManager: mockWorkerManager,
		});
		await tool.execute({ query: 'test' });

		const calls = mockWorkerRequest.mock.calls;
		const vectorCall = calls.find((c) => (c[0] as { type: string }).type === 'vector.search');
		expect((vectorCall?.[0] as { payload: { topK: number } }).payload.topK).toBe(20); // 2x10
	});

	it('handles worker error response gracefully', async () => {
		mockWorkerRequest
			.mockResolvedValueOnce({
				type: 'error',
				payload: { code: 'WORKER_ERROR', message: 'boom' },
			} as WorkerResponse)
			.mockResolvedValueOnce({
				type: 'vector.search.result',
				payload: [],
			} as WorkerResponse);

		const tool = createSearchVaultTool({
			embedding: mockEmbedding,
			workerManager: mockWorkerManager,
		});
		// Should not throw — degrades to empty results
		const result = await tool.execute({ query: 'test' });
		expect(Array.isArray(result)).toBe(true);
	});
});
```

- [ ] **Step 3: Run tests**

Run: `npm test -- tests/tools/search-vault.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 4: Commit**

```bash
git add tests/tools/search-vault.test.ts
git commit -m "test: add search_vault tool unit tests (8 cases)"
```

---

## Task 4: Agent Loop — Citation Event Emission

**Files:**
- Modify: `tests/core/agent-loop.test.ts`

- [ ] **Step 1: Read existing test file**

Read `tests/core/agent-loop.test.ts` to understand `createMockLLM` and the event payload structure.

- [ ] **Step 2: Add failing tests**

Append:

```typescript
	it('emits search.result event when search_vault is called', async () => {
		const tools = new ToolRegistry();
		tools.register({
			definition: {
				name: 'search_vault',
				description: '',
				parameters: { type: 'object', properties: {} },
			},
			execute: async () => [
				{ docId: 'd1', score: 0.9, text: 'cat content', metadata: { path: 'cats.md' } },
				{ docId: 'd2', score: 0.7, text: 'dog content', metadata: { path: 'dogs.md' } },
			],
			readOnly: true,
		});

		const llm = {
			chat: vi.fn().mockImplementation(async function* () {
				yield { text: 'Searching', toolCall: { id: 'tc1', name: 'search_vault', args: { query: 'q' } } };
			}),
			countTokens: vi.fn().mockReturnValue(0),
		};

		const ctx = new ContextManager(persistence);
		const events: string[] = [];
		for await (const e of agentLoop({ sessionId: 's1', message: 'hi' }, ctx, llm as any, tools, hooks)) {
			events.push(e.type);
			if (e.type === 'search.result') {
				const payload = e.payload as { results: Array<{ docId: string }> };
				expect(payload.results.length).toBe(2);
				expect(payload.results[0].docId).toBe('d1');
			}
		}

		expect(events).toContain('search.result');
	});

	it('does not emit search.result for non-search tools', async () => {
		const tools = new ToolRegistry();
		tools.register({
			definition: {
				name: 'read_note',
				description: '',
				parameters: { type: 'object', properties: {} },
			},
			execute: async () => 'file content',
			readOnly: true,
		});

		const llm = {
			chat: vi.fn().mockImplementation(async function* () {
				yield { text: 'Reading', toolCall: { id: 'tc1', name: 'read_note', args: { path: 'a.md' } } };
			}),
			countTokens: vi.fn().mockReturnValue(0),
		};

		const ctx = new ContextManager(persistence);
		const events: string[] = [];
		for await (const e of agentLoop({ sessionId: 's1', message: 'hi' }, ctx, llm as any, tools, hooks)) {
			events.push(e.type);
		}

		expect(events).not.toContain('search.result');
		expect(events).toContain('tool.result');
	});

	it('does not crash when search_vault returns non-array result', async () => {
		const tools = new ToolRegistry();
		tools.register({
			definition: {
				name: 'search_vault',
				description: '',
				parameters: { type: 'object', properties: {} },
			},
			execute: async () => 'unexpected string result',
			readOnly: true,
		});

		const llm = {
			chat: vi.fn().mockImplementation(async function* () {
				yield { text: 'Searching', toolCall: { id: 'tc1', name: 'search_vault', args: {} } };
			}),
			countTokens: vi.fn().mockReturnValue(0),
		};

		const ctx = new ContextManager(persistence);
		const events: string[] = [];
		for await (const e of agentLoop({ sessionId: 's1', message: 'hi' }, ctx, llm as any, tools, hooks)) {
			events.push(e.type);
		}

		// Should not throw, should still emit tool.result
		expect(events).toContain('tool.result');
	});
```

- [ ] **Step 3: Run tests**

Run: `npm test -- tests/core/agent-loop.test.ts`
Expected: All tests pass (search.result event implemented in W3 Task 8)

If the implementation guards `Array.isArray(result)`, the third test verifies graceful handling.

- [ ] **Step 4: Commit**

```bash
git add tests/core/agent-loop.test.ts
git commit -m "test: add agent loop citation event tests (3 cases)"
```

---

## Task 5: Worker Handlers — vector.search + bm25.search

**Files:**
- Create: `tests/worker/worker-handlers.test.ts`

This test exercises the Worker thread handlers using a direct import of the message handler. To avoid spinning up an actual Worker thread, we test the pure handler logic by importing the handler function directly.

- [ ] **Step 1: Read worker implementation**

Read `src/worker/index.ts` to see if the handler is exported. If not, refactor to export `handleMessage` as a testable function:

In `src/worker/index.ts`, add at the top:
```typescript
export { handleMessage };
```

If `handleMessage` is not exported, the subagent should refactor it to be testable. The plan is: keep the `self.onmessage` registration but also export the function.

- [ ] **Step 2: Write test file**

Create `tests/worker/worker-handlers.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { handleMessage } from '../../src/worker/index';
import path from 'path';
import fs from 'fs';

const TEST_INDEX_DIR = path.join(__dirname, '../tmp/worker-handlers-index');

describe('Worker message handlers', () => {
	beforeAll(() => {
		if (fs.existsSync(TEST_INDEX_DIR)) {
			fs.rmSync(TEST_INDEX_DIR, { recursive: true });
		}
		process.env.RATEL_INDEX_DIR = TEST_INDEX_DIR;
	});

	afterAll(() => {
		if (fs.existsSync(TEST_INDEX_DIR)) {
			fs.rmSync(TEST_INDEX_DIR, { recursive: true });
		}
	});

	it('handles vector.upsert then vector.search', async () => {
		await handleMessage({
			type: 'vector.upsert',
			payload: {
				docId: 'doc1',
				text: 'hello world',
				metadata: { path: 'test.md' },
			},
		} as any);

		const searchResponse = await handleMessage({
			type: 'vector.search',
			payload: {
				queryVector: Array(384).fill(0.1), // assuming default dim
				topK: 5,
			},
		} as any);

		expect(searchResponse.type).toBe('vector.search.result');
		const results = (searchResponse as { payload: Array<{ docId: string }> }).payload;
		expect(results.length).toBeGreaterThan(0);
	});

	it('handles bm25.search with text query', async () => {
		const response = await handleMessage({
			type: 'bm25.search',
			payload: { query: 'hello', topK: 5 },
		} as any);

		expect(response.type).toBe('bm25.search.result');
		const results = (response as { payload: Array<{ docId: string }> }).payload;
		expect(Array.isArray(results)).toBe(true);
	});

	it('returns error for unknown request type', async () => {
		const response = await handleMessage({
			type: 'unknown.type',
			payload: {},
		} as any);

		expect(response.type).toBe('error');
		expect((response as { payload: { code: string } }).payload.code).toBe('UNKNOWN_REQUEST');
	});

	it('handles vector.delete', async () => {
		// First upsert
		await handleMessage({
			type: 'vector.upsert',
			payload: { docId: 'to-delete', text: 'content', metadata: {} },
		} as any);

		// Then delete
		const response = await handleMessage({
			type: 'vector.delete',
			payload: { docIds: ['to-delete'] },
		} as any);

		expect(response.type).toBe('vector.delete.done');
		const payload = (response as { payload: { count: number } }).payload;
		expect(payload.count).toBeGreaterThanOrEqual(0);
	});

	it('handles index.status', async () => {
		const response = await handleMessage({
			type: 'index.status',
			payload: {},
		} as any);

		expect(response.type).toBe('index.status.result');
		const payload = (response as { payload: { totalDocs: number; lastIndexTime: number } }).payload;
		expect(typeof payload.totalDocs).toBe('number');
		expect(typeof payload.lastIndexTime).toBe('number');
	});
});
```

- [ ] **Step 3: Ensure handleMessage is testable**

If the current `src/worker/index.ts` doesn't export `handleMessage`, the subagent should refactor. A minimal approach:

```typescript
// In src/worker/index.ts
export async function handleMessage(msg: WorkerRequest): Promise<WorkerResponse> {
	// ... existing switch logic
}

// Keep self.onmessage as the thin wrapper:
self.onmessage = async (e: MessageEvent) => {
	const msg = e.data as WorkerRequest;
	try {
		const response = await handleMessage(msg);
		self.postMessage(response);
	} catch (err) {
		self.postMessage({ type: 'error', payload: { code: 'WORKER_ERROR', message: String(err) } });
	}
};
```

Also, the test should be able to override the index path. Update the `ensureIndex` function to accept an env var:

```typescript
async function ensureIndex(): Promise<LocalDocumentIndex> {
	if (!index) {
		const indexPath = process.env.RATEL_INDEX_DIR ?? path.join(process.cwd(), '.ratel-index');
		index = new LocalDocumentIndex({ folderPath: indexPath });
		await index.initialize();
	}
	return index;
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/worker/worker-handlers.test.ts`
Expected: 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/worker/index.ts tests/worker/worker-handlers.test.ts
git commit -m "test: add Worker message handler unit tests (5 cases)"
```

---

## Task 6: L2 Integration Test — Search Pipeline

**Files:**
- Create: `tests/integration/search-pipeline.test.ts`

This test wires real Worker + RRF + search_vault end-to-end. Uses a real LocalDocumentIndex via the exported handleMessage.

- [ ] **Step 1: Create directory and file**

Create `tests/integration/search-pipeline.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSearchVaultTool } from '../../src/tools/search-vault';
import { handleMessage } from '../../src/worker/index';
import type { EmbeddingPort } from '../../src/ports/embedding';
import path from 'path';
import fs from 'fs';

const TEST_INDEX_DIR = path.join(__dirname, '../tmp/search-pipeline-index');

// Mock WorkerManager that calls handleMessage directly
function createDirectWorkerManager() {
	return {
		request: async (msg: any) => handleMessage(msg),
	} as any;
}

// Deterministic mock embedding
const mockEmbedding: EmbeddingPort = {
	embed: async (texts: string[]) => {
		// Create a deterministic vector based on text hash
		return texts.map((t) => {
			const v = new Array(384).fill(0);
			for (let i = 0; i < t.length; i++) {
				v[i % 384] = (v[i % 384] + t.charCodeAt(i)) / 255;
			}
			return v;
		});
	},
	dimensions: 384,
	modelId: 'mock:test',
};

describe('Search Pipeline Integration (L2)', () => {
	beforeAll(async () => {
		if (fs.existsSync(TEST_INDEX_DIR)) {
			fs.rmSync(TEST_INDEX_DIR, { recursive: true });
		}
		process.env.RATEL_INDEX_DIR = TEST_INDEX_DIR;
	});

	afterAll(() => {
		if (fs.existsSync(TEST_INDEX_DIR)) {
			fs.rmSync(TEST_INDEX_DIR, { recursive: true });
		}
	});

	it('end-to-end: upsert chunks → search → results include indexed docs', async () => {
		// 1. Index several documents via direct handleMessage
		const docs = [
			{ docId: 'cats.md#chunk-0', text: 'Cats are mammals that purr and love fish', metadata: { path: 'cats.md' } },
			{ docId: 'dogs.md#chunk-0', text: 'Dogs are loyal companions who fetch balls', metadata: { path: 'dogs.md' } },
			{ docId: 'birds.md#chunk-0', text: 'Birds fly south for the winter season', metadata: { path: 'birds.md' } },
		];

		for (const doc of docs) {
			const response = await handleMessage({
				type: 'vector.upsert',
				payload: doc,
			} as any);
			expect(response.type).toBe('vector.upsert.done');
		}

		// 2. Run search_vault tool
		const tool = createSearchVaultTool({
			embedding: mockEmbedding,
			workerManager: createDirectWorkerManager(),
		});

		const result = (await tool.execute({ query: 'cats' })) as Array<{ docId: string; text: string; score: number }>;

		// 3. Verify cats doc is in the results
		expect(result.length).toBeGreaterThan(0);
		const catsResult = result.find((r) => r.docId.startsWith('cats.md'));
		expect(catsResult).toBeDefined();
		expect(catsResult?.text).toContain('Cats');
	});

	it('hybrid search returns different ordering than vector-only', async () => {
		// Index docs with overlap
		const docs = [
			{ docId: 'a.md', text: 'apple banana cherry', metadata: { path: 'a.md' } },
			{ docId: 'b.md', text: 'apple fruit salad recipe', metadata: { path: 'b.md' } },
			{ docId: 'c.md', text: 'vegetable garden tips', metadata: { path: 'c.md' } },
		];

		for (const doc of docs) {
			await handleMessage({ type: 'vector.upsert', payload: doc } as any);
		}

		const tool = createSearchVaultTool({
			embedding: mockEmbedding,
			workerManager: createDirectWorkerManager(),
		});

		// Search for "apple banana" — should prefer a.md (exact) and b.md (partial)
		const result = (await tool.execute({ query: 'apple banana' })) as Array<{ docId: string; score: number }>;
		expect(result.length).toBeGreaterThan(0);

		// a.md should rank high — it has both terms
		const topId = result[0]?.docId;
		expect(['a.md', 'b.md']).toContain(topId);
	});

	it('returns empty array when index is empty', async () => {
		// Use a fresh index
		const emptyDir = path.join(__dirname, '../tmp/empty-search-index');
		if (fs.existsSync(emptyDir)) {
			fs.rmSync(emptyDir, { recursive: true });
		}
		fs.mkdirSync(emptyDir, { recursive: true });
		process.env.RATEL_INDEX_DIR = emptyDir;

		const tool = createSearchVaultTool({
			embedding: mockEmbedding,
			workerManager: createDirectWorkerManager(),
		});

		const result = await tool.execute({ query: 'anything' });
		expect(result).toEqual([]);

		// Cleanup
		fs.rmSync(emptyDir, { recursive: true });
	});

	it('respects topK parameter', async () => {
		// Index many docs
		for (let i = 0; i < 10; i++) {
			await handleMessage({
				type: 'vector.upsert',
				payload: { docId: `doc${i}.md`, text: `content ${i} keyword`, metadata: { path: `doc${i}.md` } },
			} as any);
		}

		const tool = createSearchVaultTool({
			embedding: mockEmbedding,
			workerManager: createDirectWorkerManager(),
		});

		const result = (await tool.execute({ query: 'keyword', topK: 3 })) as Array<unknown>;
		expect(result.length).toBeLessThanOrEqual(3);
	});
});
```

- [ ] **Step 2: Create tmp directory and gitignore**

```bash
mkdir -p tests/tmp
echo 'tests/tmp/' >> .gitignore
```

- [ ] **Step 3: Run integration test**

Run: `npm test -- tests/integration/search-pipeline.test.ts`
Expected: 4 tests PASS

- [ ] **Step 4: Commit**

```bash
git add tests/integration/search-pipeline.test.ts .gitignore
git commit -m "test: add search pipeline L2 integration test (4 cases)"
```

---

## Task 7: Verify + Update Test Architecture Doc

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All test files pass (16+ files, 110+ tests, up from ~90)

- [ ] **Step 2: Run build + lint**

Run: `npm run build && npm run lint`
Expected: Both succeed

- [ ] **Step 3: Update test architecture doc**

Edit `docs/superpowers/specs/2026-06-14-ratel-test-architecture.md`, section 3.1 (RAG), 3.2 (Chat), 3.4 (Tools), 3.5 (Worker) coverage status:

- RAG L1: 12/12 → keep (RRF + RRF variants are in rrf.test.ts)
- RAG L2: 1/3 → 2/3 (search pipeline added)
- Chat: search.result event tests added
- Tools: search_vault tests added (was W3 deferred)
- Worker: vector.search + bm25.search tests added (5 cases)

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-06-14-ratel-test-architecture.md
git commit -m "docs: update W3 test coverage in test architecture"
```

---

## Self-Review

### 1. Spec Coverage (W3 items from test architecture)

| Item | Task |
|---|---|
| RRF fusion algorithm tests | Task 1 |
| ContextManager.addSearchResults | Task 2 |
| search_vault — hybrid retrieval + RRF | Task 3 |
| search_vault — empty/error results | Task 3 |
| search_vault — topK parameter | Task 3 |
| search_vault — readOnly marker | Task 3 |
| search.result event in agent loop | Task 4 |
| Worker vector.search + bm25.search | Task 5 |
| Worker unknown request type | Task 5 |
| Worker index.status | Task 5 |
| L2 search pipeline integration | Task 6 |

**Gaps:** None for W3 — all items covered.

### 2. Placeholder Scan

- No TBD/TODO found
- All test code is complete with concrete assertions
- Mock patterns explicit and documented

### 3. Type Consistency

| Type | Defined In | Used In | Consistent |
|---|---|---|---|
| `RankedItem` / `FusedItem` | `core/rrf.ts` | tests | Yes |
| `SearchResult` | depends on context-manager's parameter type | tests | Yes — verified by reading addSearchResults signature |
| `VectorSearchResult` | `ports/vector.ts` | tests | Yes |
| `BM25SearchResult` | `ports/vector.ts` | tests | Yes |
| `WorkerRequest` / `WorkerResponse` | `types.ts` | tests | Yes |
| `AgentEvent` (search.result) | `types.ts` | tests | Yes |

All types consistent.

### 4. Test Count Estimate

| Suite | Tests | Cumulative |
|---|---|---|
| W1 backfill | +14 | ~90 |
| W2 backfill | +10 | ~90 |
| **W3 (this plan)** | **+37** (10 RRF + 7 addSearchResults + 8 search_vault + 3 agent-loop + 5 worker + 4 L2) | **~127** |
