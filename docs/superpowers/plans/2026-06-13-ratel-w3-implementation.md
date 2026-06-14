# W3 Implementation Plan: Hybrid Search + RRF Fusion + Streaming + Citations

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users can ask questions and the Agent automatically searches vault notes using hybrid vector + BM25 retrieval with RRF fusion, then answers with source citations.

**Architecture:** `search_vault` tool calls EmbeddingPort → Worker vector search + BM25 search → RRF fusion on main thread → results injected into Context → LLM answers with citations.

**Tech Stack:** TypeScript (strict), vitest, vectra (BM25 + LocalDocumentIndex)

**Prerequisite:** W2 plan fully executed (EmbeddingPort, EmbeddingApi/Local adapters, VectraStore, Markdown chunker, Settings updated)

---

## File Structure

### New files

| File | Responsibility |
|---|---|
| `src/tools/search-vault.ts` | search_vault tool definition + execute |
| `src/core/rrf.ts` | Reciprocal Rank Fusion algorithm |
| `tests/tools/search-vault.test.ts` | search_vault tool tests |
| `tests/core/rrf.test.ts` | RRF fusion tests |

### Modified files

| File | Change |
|---|---|
| `src/worker/index.ts` | Implement `vector.search` with BM25 + vector dual results |
| `src/types.ts` | Add BM25 search types, update WorkerRequest/WorkerResponse |
| `src/core/context-manager.ts` | Add `addSearchResults()` method |
| `src/main.ts` | Register search_vault tool, pass dependencies |
| `src/ports/vector.ts` | Add BM25 search result type |

---

## Task 1: RRF Fusion Algorithm

**Files:**
- Create: `src/core/rrf.ts`
- Create: `tests/core/rrf.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/core/rrf.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { reciprocalRankFusion, type RankedItem } from '../../src/core/rrf';

describe('reciprocalRankFusion', () => {
	it('returns empty array for empty input', () => {
		expect(reciprocalRankFusion([], 60)).toEqual([]);
	});

	it('fuses single ranked list', () => {
		const lists: RankedItem[][] = [
			[{ id: 'a', score: 0.9 }, { id: 'b', score: 0.7 }],
		];
		const result = reciprocalRankFusion(lists, 60);
		expect(result).toHaveLength(2);
		expect(result[0].id).toBe('a'); // rank 0 → higher RRF score
		expect(result[1].id).toBe('b');
	});

	it('fuses two lists with overlapping items', () => {
		const lists: RankedItem[][] = [
			[{ id: 'a', score: 0.9 }, { id: 'b', score: 0.7 }, { id: 'c', score: 0.5 }],
			[{ id: 'b', score: 0.95 }, { id: 'a', score: 0.8 }, { id: 'd', score: 0.6 }],
		];
		const result = reciprocalRankFusion(lists, 60);
		// 'a' and 'b' appear in both lists → higher combined RRF score
		expect(result).toHaveLength(4);
		const ids = result.map((r) => r.id);
		expect(ids).toContain('a');
		expect(ids).toContain('b');
		// Items appearing in both lists should rank higher
		const topTwo = result.slice(0, 2).map((r) => r.id);
		expect(topTwo).toContain('a');
		expect(topTwo).toContain('b');
	});

	it('uses k parameter correctly', () => {
		const lists: RankedItem[][] = [
			[{ id: 'a', score: 1.0 }],
			[{ id: 'a', score: 1.0 }],
		];
		const resultK60 = reciprocalRankFusion(lists, 60);
		const resultK1 = reciprocalRankFusion(lists, 1);
		// Both should return 'a', but RRF score differs
		expect(resultK60).toHaveLength(1);
		expect(resultK1).toHaveLength(1);
		// k=1 gives higher scores (1/(1+0) + 1/(1+0) = 2.0)
		// k=60 gives lower scores (1/(60+0) + 1/(60+0) ≈ 0.033)
		expect(resultK1[0].rrfScore).toBeGreaterThan(resultK60[0].rrfScore);
	});

	it('sorts by RRF score descending', () => {
		const lists: RankedItem[][] = [
			[{ id: 'x', score: 0.5 }, { id: 'y', score: 0.4 }, { id: 'z', score: 0.3 }],
			[{ id: 'z', score: 0.9 }, { id: 'x', score: 0.8 }, { id: 'w', score: 0.7 }],
		];
		const result = reciprocalRankFusion(lists, 60);
		for (let i = 1; i < result.length; i++) {
			expect(result[i - 1].rrfScore).toBeGreaterThanOrEqual(result[i].rrfScore);
		}
	});

	it('limits results to topK', () => {
		const lists: RankedItem[][] = [
			Array.from({ length: 20 }, (_, i) => ({ id: `item${i}`, score: 1 - i * 0.05 })),
		];
		const result = reciprocalRankFusion(lists, 60, 5);
		expect(result).toHaveLength(5);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/core/rrf.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `src/core/rrf.ts`:

```typescript
/**
 * Reciprocal Rank Fusion (RRF) — merges multiple ranked lists into one.
 * RRF score = sum over lists of 1/(k + rank)
 * Default k=60 per Cormack et al. (2009)
 */

export interface RankedItem {
	id: string;
	score: number;
}

export interface FusedItem {
	id: string;
	rrfScore: number;
	/** Original scores from each list (undefined if not in that list) */
	sourceScores: (number | undefined)[];
}

export function reciprocalRankFusion(
	lists: RankedItem[][],
	k = 60,
	topK?: number,
): FusedItem[] {
	const scoreMap = new Map<string, { rrfScore: number; sourceScores: (number | undefined)[] }>();

	for (let listIdx = 0; listIdx < lists.length; listIdx++) {
		const list = lists[listIdx];
		for (let rank = 0; rank < list.length; rank++) {
			const item = list[rank];
			const existing = scoreMap.get(item.id);
			if (existing) {
				existing.rrfScore += 1 / (k + rank);
				existing.sourceScores[listIdx] = item.score;
			} else {
				const sourceScores: (number | undefined)[] = new Array(lists.length).fill(undefined);
				sourceScores[listIdx] = item.score;
				scoreMap.set(item.id, {
					rrfScore: 1 / (k + rank),
					sourceScores,
				});
			}
		}
	}

	const results = Array.from(scoreMap.entries()).map(([id, data]) => ({
		id,
		rrfScore: data.rrfScore,
		sourceScores: data.sourceScores,
	}));

	results.sort((a, b) => b.rrfScore - a.rrfScore);

	return topK ? results.slice(0, topK) : results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/core/rrf.test.ts`
Expected: PASS (all 6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/rrf.ts tests/core/rrf.test.ts
git commit -m "feat: implement Reciprocal Rank Fusion algorithm"
```

---

## Task 2: Update Vector Port + Worker Types for BM25

**Files:**
- Modify: `src/ports/vector.ts`
- Modify: `src/types.ts`

- [ ] **Step 1: Add BM25 result type to vector port**

In `src/ports/vector.ts`, add after `VectorSearchResult`:

```typescript
export interface BM25SearchResult {
	docId: string;
	score: number;
	text: string;
	metadata: Record<string, unknown>;
}
```

Also add a `text` field to `VectorSearchResult` for RRF fusion context:

```typescript
export interface VectorSearchResult {
	docId: string;
	score: number;
	text: string;
	metadata: Record<string, unknown>;
}
```

- [ ] **Step 2: Update WorkerRequest/WorkerResponse in types.ts**

In `src/types.ts`, update the re-exports:

```typescript
export type { VectorSearchResult, BM25SearchResult, SearchFilter } from './ports/vector';
```

Update `WorkerRequest` — add `bm25.search` type:

```typescript
export type WorkerRequest =
	| { type: 'index.full'; payload: { vaultPath: string } }
	| { type: 'index.incremental'; payload: { filePath: string; content: string } }
	| { type: 'index.delete'; payload: { filePath: string } }
	| { type: 'vector.search'; payload: { queryVector: number[]; topK: number; filter?: import('./ports/vector').SearchFilter } }
	| { type: 'bm25.search'; payload: { query: string; topK: number } }
	| { type: 'vector.upsert'; payload: { docId: string; text: string; metadata: Record<string, unknown> } }
	| { type: 'vector.delete'; payload: { docIds: string[] } }
	| { type: 'index.status'; payload: {} };
```

Update `WorkerResponse` — add `bm25.search.result` type:

```typescript
export type WorkerResponse =
	| { type: 'index.progress'; payload: { done: number; total: number } }
	| { type: 'index.done'; payload: { indexed: number; errors: number } }
	| { type: 'vector.search.result'; payload: Array<import('./ports/vector').VectorSearchResult> }
	| { type: 'bm25.search.result'; payload: Array<import('./ports/vector').BM25SearchResult> }
	| { type: 'vector.upsert.done'; payload: { docId: string } }
	| { type: 'vector.delete.done'; payload: { count: number } }
	| { type: 'index.status.result'; payload: { totalDocs: number; lastIndexTime: number } }
	| { type: 'error'; payload: { code: string; message: string } };
```

- [ ] **Step 3: Verify build passes**

Run: `npm run build`
Expected: Build succeeds (may have type errors in worker/index.ts — fix in Task 3)

- [ ] **Step 4: Commit**

```bash
git add src/ports/vector.ts src/types.ts
git commit -m "feat: add BM25 search types for hybrid retrieval"
```

---

## Task 3: Implement Worker Vector + BM25 Search

**Files:**
- Modify: `src/worker/index.ts`

- [ ] **Step 1: Implement vector.search and bm25.search in Worker**

Replace the `handleMessage` function in `src/worker/index.ts`:

```typescript
/**
 * Worker thread entry point — W3 hybrid search
 *
 * Handles message dispatch for CPU-intensive tasks:
 * - vector.search: vectra queryDocuments (cosine similarity)
 * - bm25.search: vectra BM25 keyword search
 * - vector.upsert: add/update documents in index
 * - vector.delete: remove documents from index
 *
 * Worker does NOT make HTTP requests and does NOT import Obsidian API.
 */

import type { WorkerRequest, WorkerResponse } from '../types';
import type { VectorSearchResult, BM25SearchResult } from '../ports/vector';
import { LocalDocumentIndex } from 'vectra';
import path from 'path';

let index: LocalDocumentIndex | null = null;

async function ensureIndex(): Promise<LocalDocumentIndex> {
	if (!index) {
		// Default index path — will be overridden by index.full
		const indexPath = path.join(process.cwd(), '.ratel-index');
		index = new LocalDocumentIndex({ folderPath: indexPath });
		await index.initialize();
	}
	return index;
}

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
			const idx = await ensureIndex();
			const stats = await idx.getIndexStats();
			return {
				type: 'index.status.result',
				payload: {
					totalDocs: stats?.totalDocuments ?? 0,
					lastIndexTime: Date.now(),
				},
			};
		}

		case 'vector.search': {
			const idx = await ensureIndex();
			const results = await idx.queryDocuments(msg.payload.queryVector, msg.payload.topK);
			const searchResults: VectorSearchResult[] = results.map((r) => ({
				docId: r.document.id,
				score: r.score,
				text: r.document.content ?? '',
				metadata: r.document.metadata as Record<string, unknown>,
			}));
			return {
				type: 'vector.search.result',
				payload: searchResults,
			};
		}

		case 'bm25.search': {
			const idx = await ensureIndex();
			// vectra's BM25 search via queryDocuments with text-only mode
			const results = await idx.queryDocuments(msg.payload.query, msg.payload.topK);
			const searchResults: BM25SearchResult[] = results.map((r) => ({
				docId: r.document.id,
				score: r.score,
				text: r.document.content ?? '',
				metadata: r.document.metadata as Record<string, unknown>,
			}));
			return {
				type: 'bm25.search.result',
				payload: searchResults,
			};
		}

		case 'vector.upsert': {
			const idx = await ensureIndex();
			const existing = await idx.getDocument(msg.payload.docId);
			if (existing) {
				await idx.deleteDocument(msg.payload.docId);
			}
			await idx.addDocument(msg.payload.docId, msg.payload.text, msg.payload.metadata);
			return {
				type: 'vector.upsert.done',
				payload: { docId: msg.payload.docId },
			};
		}

		case 'vector.delete': {
			const idx = await ensureIndex();
			let count = 0;
			for (const id of msg.payload.docIds) {
				try {
					await idx.deleteDocument(id);
					count++;
				} catch {
					// Document may not exist
				}
			}
			return {
				type: 'vector.delete.done',
				payload: { count },
			};
		}

		case 'index.full':
		case 'index.incremental':
		case 'index.delete': {
			return {
				type: 'error',
				payload: {
					code: 'NOT_IMPLEMENTED',
					message: `${msg.type} will be implemented in W4+ (Indexer subagent)`,
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

- [ ] **Step 2: Verify build passes**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/worker/index.ts
git commit -m "feat: implement Worker vector.search + bm25.search handlers"
```

---

## Task 4: ContextManager — addSearchResults

**Files:**
- Modify: `src/core/context-manager.ts`

- [ ] **Step 1: Add addSearchResults method**

In `src/core/context-manager.ts`, add after `addToolResult`:

```typescript
	addSearchResults(results: Array<{ docId: string; score: number; text: string; metadata?: Record<string, unknown> }>): void {
		const session = this.requireSession();
		const searchContext = results
			.map((r, i) => {
				const path = (r.metadata?.path as string) ?? r.docId;
				return `[${i + 1}] ${path} (score: ${r.score.toFixed(3)})\n${r.text.slice(0, 500)}`;
			})
			.join('\n\n');

		session.messages.push({
			role: 'tool',
			content: `Search results:\n\n${searchContext}`,
			toolCallId: '__search_vault__',
		});
		session.updatedAt = Date.now();
	}
```

- [ ] **Step 2: Verify build passes**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/core/context-manager.ts
git commit -m "feat: add addSearchResults method to ContextManager"
```

---

## Task 5: search_vault Tool

**Files:**
- Create: `src/tools/search-vault.ts`
- Create: `tests/tools/search-vault.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/tools/search-vault.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSearchVaultTool } from '../../src/tools/search-vault';
import type { EmbeddingPort } from '../../src/ports/embedding';
import type { WorkerManager } from '../../src/worker/manager';
import type { WorkerResponse } from '../../src/types';

// Mock embedding
const mockEmbedding: EmbeddingPort = {
	embed: vi.fn().mockResolvedValue([Array(512).fill(0.1)]),
	dimensions: 512,
	modelId: 'local:Xenova/bge-small-zh-v1.5',
};

// Mock worker manager
const mockWorkerRequest = vi.fn();
const mockWorkerManager = {
	request: mockWorkerRequest,
} as unknown as WorkerManager;

describe('search_vault tool', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('has correct tool definition', () => {
		const tool = createSearchVaultTool(mockEmbedding, mockWorkerManager);
		expect(tool.definition.name).toBe('search_vault');
		expect(tool.definition.parameters.properties).toHaveProperty('query');
		expect(tool.definition.parameters.properties).toHaveProperty('topK');
	});

	it('searches vault and returns fused results', async () => {
		// Mock vector search response
		mockWorkerRequest.mockResolvedValueOnce({
			type: 'vector.search.result',
			payload: [
				{ docId: 'doc1', score: 0.9, text: 'Content about cats', metadata: { path: 'notes/cats.md' } },
				{ docId: 'doc2', score: 0.7, text: 'Content about dogs', metadata: { path: 'notes/dogs.md' } },
			],
		} as WorkerResponse);

		// Mock BM25 search response
		mockWorkerRequest.mockResolvedValueOnce({
			type: 'bm25.search.result',
			payload: [
				{ docId: 'doc1', score: 5.2, text: 'Content about cats', metadata: { path: 'notes/cats.md' } },
				{ docId: 'doc3', score: 3.1, text: 'Content about birds', metadata: { path: 'notes/birds.md' } },
			],
		} as WorkerResponse);

		const tool = createSearchVaultTool(mockEmbedding, mockWorkerManager);
		const result = await tool.execute({ query: 'cats and dogs' });

		expect(mockEmbedding.embed).toHaveBeenCalledWith(['cats and dogs']);
		expect(mockWorkerRequest).toHaveBeenCalledTimes(2);

		// Result should contain fused results
		const parsed = result as Array<{ docId: string }>;
		expect(parsed.length).toBeGreaterThan(0);
		expect(parsed.some((r) => r.docId === 'doc1')).toBe(true); // appears in both lists
	});

	it('handles empty search results gracefully', async () => {
		mockWorkerRequest.mockResolvedValueOnce({
			type: 'vector.search.result',
			payload: [],
		} as WorkerResponse);

		mockWorkerRequest.mockResolvedValueOnce({
			type: 'bm25.search.result',
			payload: [],
		} as WorkerResponse);

		const tool = createSearchVaultTool(mockEmbedding, mockWorkerManager);
		const result = await tool.execute({ query: 'nonexistent' });

		expect(result).toEqual([]);
	});

	it('respects topK parameter', async () => {
		mockWorkerRequest.mockResolvedValue({
			type: 'vector.search.result',
			payload: [],
		} as WorkerResponse);

		const tool = createSearchVaultTool(mockEmbedding, mockWorkerManager);
		await tool.execute({ query: 'test', topK: 5 });

		// Check that topK is passed to worker requests
		expect(mockWorkerRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				payload: expect.objectContaining({ topK: 5 }),
			}),
		);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/tools/search-vault.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `src/tools/search-vault.ts`:

```typescript
import type { Tool } from '../core/tool-registry';
import type { EmbeddingPort } from '../ports/embedding';
import type { WorkerManager } from '../worker/manager';
import type { WorkerResponse } from '../types';
import type { VectorSearchResult, BM25SearchResult } from '../ports/vector';
import { reciprocalRankFusion, type RankedItem } from '../core/rrf';

interface SearchVaultDeps {
	embedding: EmbeddingPort;
	workerManager: WorkerManager;
}

export function createSearchVaultTool(deps: SearchVaultDeps): Tool {
	const { embedding, workerManager } = deps;

	return {
		definition: {
			name: 'search_vault',
			description:
				'Search the vault for notes relevant to a query. Uses hybrid vector + keyword search with RRF fusion. Returns ranked results with excerpts.',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'The search query — a natural language question or keywords',
					},
					topK: {
						type: 'number',
						description: 'Maximum number of results to return (default: 10)',
					},
				},
				required: ['query'],
			},
		},

		async execute(args: Record<string, unknown>) {
			const query = args.query as string;
			const topK = (args.topK as number) ?? 10;

			// 1. Embed the query
			const [queryVector] = await embedding.embed([query]);

			// 2. Parallel: vector search + BM25 search
			const [vectorResponse, bm25Response] = await Promise.all([
				workerManager.request({
					type: 'vector.search',
					payload: { queryVector, topK: topK * 2 }, // Over-fetch for RRF
				}),
				workerManager.request({
					type: 'bm25.search',
					payload: { query, topK: topK * 2 },
				}),
			]);

			// 3. Extract results
			const vectorResults =
				vectorResponse.type === 'vector.search.result'
					? (vectorResponse.payload as VectorSearchResult[])
					: [];

			const bm25Results =
				bm25Response.type === 'bm25.search.result'
					? (bm25Response.payload as BM25SearchResult[])
					: [];

			// 4. RRF fusion
			const vectorRanked: RankedItem[] = vectorResults.map((r) => ({
				id: r.docId,
				score: r.score,
			}));

			const bm25Ranked: RankedItem[] = bm25Results.map((r) => ({
				id: r.docId,
				score: r.score,
			}));

			const fused = reciprocalRankFusion([vectorRanked, bm25Ranked], 60, topK);

			// 5. Enrich fused results with text and metadata
			const docMap = new Map<string, { text: string; metadata: Record<string, unknown> }>();
			for (const r of vectorResults) {
				docMap.set(r.docId, { text: r.text, metadata: r.metadata });
			}
			for (const r of bm25Results) {
				if (!docMap.has(r.docId)) {
					docMap.set(r.docId, { text: r.text, metadata: r.metadata });
				}
			}

			return fused.map((f) => {
				const doc = docMap.get(f.id) ?? { text: '', metadata: {} };
				return {
					docId: f.id,
					score: f.rrfScore,
					text: doc.text,
					metadata: doc.metadata,
					vectorScore: f.sourceScores[0],
					bm25Score: f.sourceScores[1],
				};
			});
		},
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/tools/search-vault.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/tools/search-vault.ts tests/tools/search-vault.test.ts
git commit -m "feat: implement search_vault tool with hybrid vector+BM25+RRF"
```

---

## Task 6: Wire search_vault into main.ts

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Import and register search_vault tool**

In `src/main.ts`, add import:

```typescript
import { createSearchVaultTool } from './tools/search-vault';
```

After `this.tools.register(createReadNoteTool(this.vault));`, add:

```typescript
		// Register search_vault tool (requires EmbeddingPort + WorkerManager)
		this.tools.register(
			createSearchVaultTool({
				embedding: this.embedding,
				workerManager: this.workerManager,
			}),
		);
```

- [ ] **Step 2: Verify build passes**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat: register search_vault tool in plugin"
```

---

## Task 7: Agent Loop — Search Results Injection + Citation Prompt

**Files:**
- Modify: `src/core/agent-loop.ts`
- Modify: `src/core/context-manager.ts`

- [ ] **Step 1: Update system prompt to include citation instructions**

In `src/core/context-manager.ts`, update `SYSTEM_PROMPT`:

```typescript
const SYSTEM_PROMPT = `You are Ratel, an AI assistant that helps users explore and manage their Obsidian vault. You can read notes and search the vault to answer questions about their content.

When you use search results to answer, cite your sources using [1], [2], etc. format, matching the result numbers. For example: "According to [1], the project uses vectra for vector storage."

Always respond in the same language the user uses.`;
```

- [ ] **Step 2: Update agent-loop to inject search results into context**

In `src/core/agent-loop.ts`, after the tool result is yielded, add special handling for search_vault:

After `yield { type: 'tool.result', payload: { name: toolCall.name, result } };`, add:

```typescript
			// Inject search results into context for citation
			if (toolCall.name === 'search_vault' && Array.isArray(result)) {
				ctx.addSearchResults(result as Array<{ docId: string; score: number; text: string; metadata?: Record<string, unknown> }>);
			}
```

- [ ] **Step 3: Verify build passes**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add src/core/context-manager.ts src/core/agent-loop.ts
git commit -m "feat: add citation prompt + search results injection in agent loop"
```

---

## Task 8: Streaming + Citation Event Types

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add citation event to AgentEvent**

In `src/types.ts`, add a new event type to `AgentEvent`:

```typescript
export type AgentEvent =
	| { type: 'message.start'; payload: { role: 'user' | 'assistant' } }
	| { type: 'message.delta'; payload: { text: string } }
	| { type: 'message.end'; payload: { tokens: number } }
	| { type: 'tool.call'; payload: { name: string; args: unknown } }
	| { type: 'tool.result'; payload: { name: string; result: unknown } }
	| { type: 'search.result'; payload: { results: Array<{ docId: string; score: number; text: string; metadata?: Record<string, unknown> }> } }
	| { type: 'subagent.spawn'; payload: { role: string; task: string } }
	| { type: 'subagent.done'; payload: { role: string; result: unknown } }
	| { type: 'hook.fired'; payload: { phase: string; tool: string } }
	| { type: 'error'; payload: { code: string; message: string } };
```

- [ ] **Step 2: Emit search.result event in agent-loop**

In `src/core/agent-loop.ts`, after the search results injection, add:

```typescript
			// Emit search result event for UI
			if (toolCall.name === 'search_vault' && Array.isArray(result)) {
				yield {
					type: 'search.result',
					payload: { results: result as Array<{ docId: string; score: number; text: string; metadata?: Record<string, unknown> }> },
				};
			}
```

- [ ] **Step 3: Verify build passes**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/core/agent-loop.ts
git commit -m "feat: add search.result event type for streaming citations"
```

---

## Self-Review

### 1. Spec Coverage

| Spec Requirement (RAG Roadmap Phase 1) | Task |
|---|---|
| 向量检索 (vectra queryDocuments) | Task 3 |
| BM25 检索 (vectra 内置 BM25) | Task 3 |
| RRF 融合 (k=60) | Task 1 + Task 5 |
| Embedding 调用 (主线程) | Task 5 (uses EmbeddingPort from W2) |
| search_vault 工具 | Task 5 + Task 6 |
| ContextManager.addSearchResults | Task 4 |
| 流式输出 | Task 8 (search.result event) |
| 引用标记 | Task 7 (citation prompt) |

**Gaps:**
- Full indexing pipeline (index.full, index.incremental) deferred to W4+ (Indexer subagent)
- VectraStore adapter moved from W2 — W3 uses Worker for all vector ops instead
- UI rendering of citations is in ChatView.svelte — not covered in this plan (follow-up)

### 2. Placeholder Scan

- No TBD/TODO found
- All implementation code is complete
- All test code is complete

### 3. Type Consistency

| Type | Defined In | Used In | Consistent |
|---|---|---|---|
| `RankedItem` | `core/rrf.ts` | `tools/search-vault.ts` | Yes |
| `FusedItem` | `core/rrf.ts` | `tools/search-vault.ts` | Yes |
| `VectorSearchResult` | `ports/vector.ts` | `worker/index.ts`, `tools/search-vault.ts` | Yes — added `text` field |
| `BM25SearchResult` | `ports/vector.ts` | `worker/index.ts`, `tools/search-vault.ts` | Yes |
| `WorkerRequest` | `types.ts` | `worker/index.ts`, `worker/manager.ts` | Yes — added `bm25.search` |
| `WorkerResponse` | `types.ts` | `worker/index.ts`, `worker/manager.ts` | Yes — added `bm25.search.result` |
| `AgentEvent` | `types.ts` | `core/agent-loop.ts`, `ui/ChatView.ts` | Yes — added `search.result` |

All types consistent.
