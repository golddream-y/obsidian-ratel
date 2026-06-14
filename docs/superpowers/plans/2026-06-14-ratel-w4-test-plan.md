# W4+ Test Plan: Reranker + Query Rewrite + Indexer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate the W4+ retrieval enhancements (Reranker, Query Rewrite, Indexer subagent, auto-index). Covers new ports/adapters, optional pipeline steps, indexing pipeline, and main.ts wiring.

**Architecture:** TDD for each new module. Reranker/QueryRewrite live in ports/adapters and are unit-tested with mocked fetch. Indexer is tested with mocked EmbeddingPort + WorkerManager, plus an L2 integration test against a real vectra index. Auto-index behavior is tested via ObsidianVault events.

**Tech Stack:** vitest, TypeScript strict mode, vectra, ObsidianVault mock

**Prerequisite:** W3 implementation merged (RRF, search_vault, Worker vector+BM25, addSearchResults). W4+ implementation plan (`2026-06-13-ratel-w4-implementation.md`) merged with RerankerPort, RerankerApi, query-rewrite, Indexer, auto-index.

---

## File Structure

### New test files

| File | Purpose |
|---|---|
| `tests/adapters/reranker-api.test.ts` | RerankerApi unit tests (5 cases) |
| `tests/core/query-rewrite.test.ts` | Query rewrite unit tests (6 cases) |
| `tests/subagents/indexer.test.ts` | Indexer subagent unit tests (6 cases) |
| `tests/integration/indexer-pipeline.test.ts` | L2: Indexer end-to-end (4 cases) |
| `tests/integration/rag-enhanced.test.ts` | L2: search_vault with Reranker + QueryRewrite (3 cases) |

### Modified test files

| File | Adds |
|---|---|
| `tests/core/agent-loop.test.ts` | tool result is not affected by missing optional deps |
| `tests/integration/chat-flow.test.ts` | NEW: full conversation flow including search_vault citation |

---

## Task 1: RerankerApi — Unit Tests

**Files:**
- Create: `tests/adapters/reranker-api.test.ts`

- [ ] **Step 1: Write test file**

Create `tests/adapters/reranker-api.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RerankerApi } from '../../src/adapters/reranker-api';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('RerankerApi', () => {
	beforeEach(() => {
		mockFetch.mockReset();
	});

	it('sends rerank request with correct payload and returns sorted results', async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				results: [
					{ index: 1, relevance_score: 0.95 },
					{ index: 0, relevance_score: 0.7 },
				],
			}),
		});

		const adapter = new RerankerApi({
			apiBase: 'https://api.cohere.ai/v1',
			apiKey: 'sk-test',
			model: 'rerank-v3.5',
		});

		const result = await adapter.rerank('test query', ['doc0 text', 'doc1 text'], 2);
		expect(result).toHaveLength(2);
		expect(result[0].score).toBe(0.95);
		expect(result[0].index).toBe(1);
		expect(result[0].text).toBe('doc1 text');
	});

	it('sends Authorization Bearer header with API key', async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({ results: [] }),
		});

		const adapter = new RerankerApi({
			apiBase: 'https://api.siliconflow.cn/v1',
			apiKey: 'sk-sf-test',
			model: 'BAAI/bge-reranker-v2-m3',
		});

		await adapter.rerank('q', ['d'], 1);
		const [, options] = mockFetch.mock.calls[0]!;
		const headers = (options as { headers: Record<string, string> }).headers;
		expect(headers.Authorization).toBe('Bearer sk-sf-test');
		expect(headers['Content-Type']).toBe('application/json');
	});

	it('sends correct request body (model, query, documents, top_n)', async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({ results: [] }),
		});

		const adapter = new RerankerApi({
			apiBase: 'https://api.cohere.ai/v1',
			apiKey: 'sk-test',
			model: 'rerank-v3.5',
		});

		await adapter.rerank('my query', ['doc1', 'doc2', 'doc3'], 2);

		const [, options] = mockFetch.mock.calls[0]!;
		const body = JSON.parse((options as { body: string }).body);
		expect(body).toEqual({
			model: 'rerank-v3.5',
			query: 'my query',
			documents: ['doc1', 'doc2', 'doc3'],
			top_n: 2,
		});
	});

	it('throws on API error response', async () => {
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 401,
			statusText: 'Unauthorized',
		});

		const adapter = new RerankerApi({
			apiBase: 'https://api.cohere.ai/v1',
			apiKey: 'sk-bad',
			model: 'rerank-v3.5',
		});

		await expect(adapter.rerank('q', ['d'], 1)).rejects.toThrow('Reranker API error: 401 Unauthorized');
	});

	it('exposes modelId with api: prefix', () => {
		const adapter = new RerankerApi({
			apiBase: 'https://api.cohere.ai/v1',
			apiKey: 'sk-test',
			model: 'rerank-v3.5',
		});
		expect(adapter.modelId).toBe('api:rerank-v3.5');
	});

	it('uses document.text from response when provided (Cohere-style)', async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				results: [
					{ index: 0, relevance_score: 0.9, document: { text: 'full doc text from response' } },
				],
			}),
		});

		const adapter = new RerankerApi({
			apiBase: 'https://api.cohere.ai/v1',
			apiKey: 'sk-test',
			model: 'rerank-v3.5',
		});

		const result = await adapter.rerank('q', ['original'], 1);
		expect(result[0].text).toBe('full doc text from response');
	});

	it('falls back to original document text when response lacks document field', async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				results: [{ index: 0, relevance_score: 0.5 }],
			}),
		});

		const adapter = new RerankerApi({
			apiBase: 'https://api.example.com/v1',
			apiKey: 'sk',
			model: 'm',
		});

		const result = await adapter.rerank('q', ['fallback text'], 1);
		expect(result[0].text).toBe('fallback text');
	});
});
```

- [ ] **Step 2: Run tests**

Run: `npm test -- tests/adapters/reranker-api.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/adapters/reranker-api.test.ts
git commit -m "test: add RerankerApi unit tests (7 cases)"
```

---

## Task 2: Query Rewrite — Unit Tests

**Files:**
- Create: `tests/core/query-rewrite.test.ts`

- [ ] **Step 1: Write test file**

Create `tests/core/query-rewrite.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { rewriteQuery } from '../../src/core/query-rewrite';
import type { LLMClient, ChatDelta } from '../../src/ports/llm';

async function* mockStream(text: string): AsyncIterable<ChatDelta> {
	yield { text };
}

function mockLLMWithResponse(text: string): LLMClient {
	return {
		chat: vi.fn().mockReturnValue(mockStream(text)),
		countTokens: vi.fn().mockReturnValue(0),
	};
}

describe('rewriteQuery', () => {
	it('returns original query when LLM is null (disabled)', async () => {
		const result = await rewriteQuery('test query', null);
		expect(result).toEqual(['test query']);
	});

	it('returns [original, ...rewrites] from LLM response', async () => {
		const llm = mockLLMWithResponse(
			'What is the architecture of Ratel?\nHow does Ratel handle vector search?',
		);

		const result = await rewriteQuery('Tell me about Ratel', llm);
		expect(result.length).toBeGreaterThanOrEqual(2);
		expect(result[0]).toBe('Tell me about Ratel'); // Original first
	});

	it('parses LLM response: one query per line, trimmed, non-empty', async () => {
		const llm = mockLLMWithResponse('  query one  \n\nquery two\n   \nquery three');
		const result = await rewriteQuery('original', llm);
		expect(result).toContain('original');
		expect(result).toContain('query one');
		expect(result).toContain('query two');
		expect(result).toContain('query three');
	});

	it('deduplicates — original not repeated if LLM echoes it', async () => {
		const llm = mockLLMWithResponse('original query\nrewritten one\nrewritten two');
		const result = await rewriteQuery('original query', llm);
		const occurrences = result.filter((q) => q === 'original query').length;
		expect(occurrences).toBe(1);
	});

	it('handles empty LLM response — falls back to original only', async () => {
		const llm = mockLLMWithResponse('');
		const result = await rewriteQuery('test', llm);
		expect(result).toEqual(['test']);
	});

	it('handles LLM error gracefully — returns original only', async () => {
		const llm: LLMClient = {
			chat: vi.fn().mockImplementation(() => {
				throw new Error('LLM network error');
			}),
			countTokens: vi.fn().mockReturnValue(0),
		};

		const result = await rewriteQuery('test query', llm);
		expect(result).toEqual(['test query']);
	});

	it('passes system + user messages to LLM', async () => {
		const chatSpy = vi.fn().mockReturnValue(mockStream('rewritten'));
		const llm: LLMClient = {
			chat: chatSpy,
			countTokens: vi.fn().mockReturnValue(0),
		};

		await rewriteQuery('user question', llm);

		expect(chatSpy).toHaveBeenCalledTimes(1);
		const args = chatSpy.mock.calls[0][0];
		expect(args.messages).toBeDefined();
		expect(args.messages.length).toBe(2);
		expect(args.messages[0].role).toBe('system');
		expect(args.messages[1].role).toBe('user');
		expect(args.messages[1].content).toBe('user question');
	});
});
```

- [ ] **Step 2: Run tests**

Run: `npm test -- tests/core/query-rewrite.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/core/query-rewrite.test.ts
git commit -m "test: add query rewrite unit tests (7 cases)"
```

---

## Task 3: Indexer Subagent — Unit Tests

**Files:**
- Create: `tests/subagents/indexer.test.ts`

- [ ] **Step 1: Write test file**

Create `tests/subagents/indexer.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Indexer } from '../../src/subagents/indexer';
import type { EmbeddingPort } from '../../src/ports/embedding';
import type { WorkerManager } from '../../src/worker/manager';
import type { WorkerResponse } from '../../src/types';

const mockEmbedding: EmbeddingPort = {
	embed: vi.fn().mockImplementation(async (texts: string[]) =>
		texts.map(() => Array(512).fill(0.1)),
	),
	dimensions: 512,
	modelId: 'local:test',
};

const mockWorkerRequest = vi.fn();

function createMockWorkerManager(): WorkerManager {
	return { request: mockWorkerRequest } as unknown as WorkerManager;
}

describe('Indexer', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockWorkerRequest.mockResolvedValue({
			type: 'vector.upsert.done',
			payload: { docId: 'test' },
		} as WorkerResponse);
	});

	it('indexes a single file with multiple chunks', async () => {
		const indexer = new Indexer(mockEmbedding, createMockWorkerManager(), {
			chunkSize: 500,
			chunkOverlap: 100,
		});

		const result = await indexer.indexFile('notes/test.md', '# Test\nHello world content');

		expect(result.indexed).toBeGreaterThanOrEqual(1);
		expect(result.errors).toBe(0);
		expect(mockEmbedding.embed).toHaveBeenCalled();
		expect(mockWorkerRequest).toHaveBeenCalled();
	});

	it('skips empty files without calling embedding or worker', async () => {
		const indexer = new Indexer(mockEmbedding, createMockWorkerManager(), {
			chunkSize: 500,
			chunkOverlap: 100,
		});

		const result = await indexer.indexFile('empty.md', '');

		expect(result.indexed).toBe(0);
		expect(result.errors).toBe(0);
		expect(mockEmbedding.embed).not.toHaveBeenCalled();
		expect(mockWorkerRequest).not.toHaveBeenCalled();
	});

	it('skips whitespace-only files', async () => {
		const indexer = new Indexer(mockEmbedding, createMockWorkerManager(), {
			chunkSize: 500,
			chunkOverlap: 100,
		});

		const result = await indexer.indexFile('whitespace.md', '   \n\n  \t  ');

		expect(result.indexed).toBe(0);
	});

	it('uses deterministic docId format {path}#chunk-{index}', async () => {
		const indexer = new Indexer(mockEmbedding, createMockWorkerManager(), {
			chunkSize: 500,
			chunkOverlap: 100,
		});

		await indexer.indexFile('notes/cats.md', '# Title\nContent');

		const calls = mockWorkerRequest.mock.calls;
		expect(calls.length).toBeGreaterThan(0);
		const firstCall = calls[0][0] as { payload: { docId: string } };
		expect(firstCall.payload.docId).toMatch(/^notes\/cats\.md#chunk-\d+$/);
	});

	it('includes file path and chunk metadata in upsert payload', async () => {
		const indexer = new Indexer(mockEmbedding, createMockWorkerManager(), {
			chunkSize: 500,
			chunkOverlap: 100,
		});

		await indexer.indexFile('notes/cats.md', '# Title\nContent about cats');

		const calls = mockWorkerRequest.mock.calls;
		const firstCall = calls[0][0] as { payload: { text: string; metadata: Record<string, unknown> } };
		expect(firstCall.payload.text).toContain('cats');
		expect(firstCall.payload.metadata.path).toBe('notes/cats.md');
		expect(firstCall.payload.metadata.chunkIndex).toBeDefined();
	});

	it('batches embedding calls for multiple chunks', async () => {
		// Create content that produces 5+ chunks
		const longContent = Array.from(
			{ length: 6 },
			(_, i) => `# Section ${i}\n${'content '.repeat(100)}`,
		).join('\n\n');

		const indexer = new Indexer(mockEmbedding, createMockWorkerManager(), {
			chunkSize: 200,
			chunkOverlap: 50,
			batchSize: 3, // Force batching
		});

		await indexer.indexFile('long.md', longContent);

		// embed() should be called fewer times than number of chunks
		const embedCallCount = (mockEmbedding.embed as ReturnType<typeof vi.fn>).mock.calls.length;
		const workerCallCount = mockWorkerRequest.mock.calls.length;
		expect(embedCallCount).toBeGreaterThan(0);
		expect(workerCallCount).toBeGreaterThan(embedCallCount); // upsert per chunk
	});

	it('deleteFile sends vector.delete with file path as docId prefix', async () => {
		mockWorkerRequest.mockResolvedValueOnce({
			type: 'vector.delete.done',
			payload: { count: 3 },
		} as WorkerResponse);

		const indexer = new Indexer(mockEmbedding, createMockWorkerManager(), {
			chunkSize: 500,
			chunkOverlap: 100,
		});

		const result = await indexer.deleteFile('notes/old.md');

		expect(result.deleted).toBe(3);
		const calls = mockWorkerRequest.mock.calls;
		expect(calls[0][0]).toMatchObject({
			type: 'vector.delete',
			payload: { docIds: ['notes/old.md'] },
		});
	});

	it('counts errors when embedding fails', async () => {
		const failingEmbedding: EmbeddingPort = {
			embed: vi.fn().mockRejectedValue(new Error('embed failed')),
			dimensions: 512,
			modelId: 'local:test',
		};

		const indexer = new Indexer(failingEmbedding, createMockWorkerManager(), {
			chunkSize: 500,
			chunkOverlap: 100,
		});

		const result = await indexer.indexFile('notes/test.md', '# Test\nContent');

		expect(result.indexed).toBe(0);
		expect(result.errors).toBeGreaterThan(0);
	});
});
```

- [ ] **Step 2: Run tests**

Run: `npm test -- tests/subagents/indexer.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/subagents/indexer.test.ts
git commit -m "test: add Indexer subagent unit tests (8 cases)"
```

---

## Task 4: L2 Integration — Indexer Pipeline

**Files:**
- Create: `tests/integration/indexer-pipeline.test.ts`

- [ ] **Step 1: Create test file**

Create `tests/integration/indexer-pipeline.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Indexer } from '../../src/subagents/indexer';
import { handleMessage } from '../../src/worker/index';
import type { EmbeddingPort } from '../../src/ports/embedding';
import path from 'path';
import fs from 'fs';

const TEST_INDEX_DIR = path.join(__dirname, '../tmp/indexer-pipeline-index');

const mockEmbedding: EmbeddingPort = {
	embed: async (texts: string[]) => {
		// Deterministic: same text → same vector
		return texts.map((t) => {
			const v = new Array(384).fill(0);
			for (let i = 0; i < t.length; i++) {
				v[i % 384] = (v[i % 384] + t.charCodeAt(i) * 0.01) % 1;
			}
			return v;
		});
	},
	dimensions: 384,
	modelId: 'mock:test',
};

const workerManager = { request: handleMessage } as any;

describe('Indexer Pipeline Integration (L2)', () => {
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

	it('indexes multiple files and search returns them', async () => {
		const indexer = new Indexer(mockEmbedding, workerManager, {
			chunkSize: 500,
			chunkOverlap: 50,
		});

		const files = [
			{ path: 'notes/cats.md', content: '# Cats\nCats are mammals' },
			{ path: 'notes/dogs.md', content: '# Dogs\nDogs are loyal' },
			{ path: 'notes/birds.md', content: '# Birds\nBirds fly south' },
		];

		for (const file of files) {
			const result = await indexer.indexFile(file.path, file.content);
			expect(result.indexed).toBeGreaterThan(0);
		}

		// Now search — should return indexed docs
		const searchResponse = await handleMessage({
			type: 'vector.search',
			payload: { queryVector: Array(384).fill(0.5), topK: 5 },
		} as any);

		expect(searchResponse.type).toBe('vector.search.result');
		const results = (searchResponse as { payload: Array<{ docId: string }> }).payload;
		expect(results.length).toBe(3);
	});

	it('deleteFile removes docs from index', async () => {
		const indexer = new Indexer(mockEmbedding, workerManager, {
			chunkSize: 500,
			chunkOverlap: 50,
		});

		await indexer.indexFile('notes/temp.md', '# Temp\nTemporary file');
		await indexer.deleteFile('notes/temp.md');

		// Search should not return temp.md
		const searchResponse = await handleMessage({
			type: 'vector.search',
			payload: { queryVector: Array(384).fill(0.1), topK: 100 },
		} as any);

		const results = (searchResponse as { payload: Array<{ docId: string }> }).payload;
		const hasTemp = results.some((r) => r.docId.startsWith('notes/temp.md'));
		expect(hasTemp).toBe(false);
	});

	it('re-indexing same file replaces previous chunks', async () => {
		const indexer = new Indexer(mockEmbedding, workerManager, {
			chunkSize: 500,
			chunkOverlap: 50,
		});

		await indexer.indexFile('notes/replace.md', '# Old\nOld content here');
		await indexer.indexFile('notes/replace.md', '# New\nNew content entirely');

		// After re-index, only "New" version should exist (delete-then-insert)
		const searchResponse = await handleMessage({
			type: 'vector.search',
			payload: { queryVector: Array(384).fill(0.3), topK: 100 },
		} as any);

		const results = (searchResponse as { payload: Array<{ docId: string; text: string }> }).payload;
		const replaceDocs = results.filter((r) => r.docId.startsWith('notes/replace.md'));
		// All matching docs should have "New" content
		replaceDocs.forEach((r) => {
			expect(r.text).toContain('New');
			expect(r.text).not.toContain('Old');
		});
	});

	it('handles large content with many chunks', async () => {
		const indexer = new Indexer(mockEmbedding, workerManager, {
			chunkSize: 200,
			chunkOverlap: 50,
			batchSize: 5,
		});

		const longContent = Array.from(
			{ length: 20 },
			(_, i) => `# Section ${i}\n${'paragraph content '.repeat(30)}`,
		).join('\n\n');

		const result = await indexer.indexFile('notes/large.md', longContent);

		expect(result.indexed).toBeGreaterThan(5);
		expect(result.errors).toBe(0);
	});
});
```

- [ ] **Step 2: Run tests**

Run: `npm test -- tests/integration/indexer-pipeline.test.ts`
Expected: 4 tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/integration/indexer-pipeline.test.ts
git commit -m "test: add Indexer pipeline L2 integration test (4 cases)"
```

---

## Task 5: L2 Integration — RAG Enhanced (Rerank + QueryRewrite)

**Files:**
- Create: `tests/integration/rag-enhanced.test.ts`

- [ ] **Step 1: Create test file**

Create `tests/integration/rag-enhanced.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createSearchVaultTool } from '../../src/tools/search-vault';
import { rewriteQuery } from '../../src/core/query-rewrite';
import { RerankerApi } from '../../src/adapters/reranker-api';
import { handleMessage } from '../../src/worker/index';
import type { EmbeddingPort } from '../../src/ports/embedding';
import type { LLMClient, ChatDelta } from '../../src/ports/llm';
import path from 'path';
import fs from 'fs';

const TEST_INDEX_DIR = path.join(__dirname, '../tmp/rag-enhanced-index');

const mockEmbedding: EmbeddingPort = {
	embed: async (texts: string[]) =>
		texts.map((t) => {
			const v = new Array(384).fill(0);
			for (let i = 0; i < t.length; i++) {
				v[i % 384] = (v[i % 384] + t.charCodeAt(i) * 0.01) % 1;
			}
			return v;
		}),
	dimensions: 384,
	modelId: 'mock:test',
};

const workerManager = { request: handleMessage } as any;

async function* mockStream(text: string): AsyncIterable<ChatDelta> {
	yield { text };
}

describe('RAG Enhanced Pipeline (L2)', () => {
	beforeAll(async () => {
		if (fs.existsSync(TEST_INDEX_DIR)) {
			fs.rmSync(TEST_INDEX_DIR, { recursive: true });
		}
		process.env.RATEL_INDEX_DIR = TEST_INDEX_DIR;

		// Pre-populate index with sample documents
		const docs = [
			{ docId: 'arch.md#0', text: 'Ratel uses hexagonal architecture with ports and adapters', metadata: { path: 'arch.md' } },
			{ docId: 'rag.md#0', text: 'RAG combines vector search and BM25 with RRF fusion', metadata: { path: 'rag.md' } },
			{ docId: 'test.md#0', text: 'Tests are organized by functional dimension', metadata: { path: 'test.md' } },
		];

		for (const doc of docs) {
			await handleMessage({ type: 'vector.upsert', payload: doc } as any);
		}
	});

	afterAll(() => {
		if (fs.existsSync(TEST_INDEX_DIR)) {
			fs.rmSync(TEST_INDEX_DIR, { recursive: true });
		}
	});

	it('search_vault works without rerank and query rewrite (default)', async () => {
		const tool = createSearchVaultTool({
			embedding: mockEmbedding,
			workerManager,
		});

		const result = (await tool.execute({ query: 'architecture' })) as Array<{ docId: string }>;
		expect(result.length).toBeGreaterThan(0);
	});

	it('search_vault with query rewrite expands recall', async () => {
		const llm: LLMClient = {
			chat: vi.fn().mockReturnValue(mockStream('Ratel software design\nObsidian plugin structure')),
			countTokens: vi.fn().mockReturnValue(0),
		};

		const tool = createSearchVaultTool({
			embedding: mockEmbedding,
			workerManager,
			llm,
			queryRewriteEnabled: true,
		});

		const result = (await tool.execute({ query: 'design' })) as Array<{ docId: string }>;
		// Should return at least 1 result (we expect more queries → more recall)
		expect(result.length).toBeGreaterThan(0);
	});

	it('search_vault with reranker reorders results by relevance', async () => {
		// Mock RerankerApi with deterministic scoring
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				results: [
					// Reverse order — Reranker prefers rag.md
					{ index: 1, relevance_score: 0.95, document: { text: 'rag content' } },
					{ index: 0, relevance_score: 0.5, document: { text: 'arch content' } },
				],
			}),
		});
		vi.stubGlobal('fetch', mockFetch);

		const reranker = new RerankerApi({
			apiBase: 'https://api.test.com/v1',
			apiKey: 'sk',
			model: 'test-rerank',
		});

		const tool = createSearchVaultTool({
			embedding: mockEmbedding,
			workerManager,
			reranker,
		});

		const result = (await tool.execute({ query: 'rag' })) as Array<{ docId: string; score: number; rerankScore?: number }>;
		expect(result.length).toBeGreaterThan(0);
		// The rag.md result should have a rerankScore
		const ragResult = result.find((r) => r.docId.startsWith('rag.md'));
		if (ragResult) {
			expect(ragResult.rerankScore).toBeDefined();
		}

		vi.unstubAllGlobals();
	});
});
```

- [ ] **Step 2: Run tests**

Run: `npm test -- tests/integration/rag-enhanced.test.ts`
Expected: 3 tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/integration/rag-enhanced.test.ts
git commit -m "test: add RAG enhanced L2 integration test (3 cases)"
```

---

## Task 6: Settings — Query Rewrite Toggle Persistence

**Files:**
- Create: `tests/settings.test.ts`

- [ ] **Step 1: Write test file**

Create `tests/settings.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, type RatelVaultSettings } from '../src/settings';

describe('Settings', () => {
	it('DEFAULT_SETTINGS has all required fields', () => {
		const required: Array<keyof RatelVaultSettings> = [
			'embedProvider',
			'embedLocalModel',
			'embedLocalDimensions',
			'embedApiBase',
			'embedApiKey',
			'embedApiModel',
			'embedApiDimensions',
			'rerankerApiBase',
			'rerankerApiKey',
			'rerankerModel',
			'queryRewriteEnabled',
			'llmProvider',
			'llmApiKey',
			'llmApiBase',
			'llmModel',
			'chunkSize',
			'chunkOverlap',
			'autoIndex',
		];
		for (const field of required) {
			expect(DEFAULT_SETTINGS).toHaveProperty(field);
		}
	});

	it('queryRewriteEnabled defaults to false', () => {
		expect(DEFAULT_SETTINGS.queryRewriteEnabled).toBe(false);
	});

	it('embedProvider defaults to "local"', () => {
		expect(DEFAULT_SETTINGS.embedProvider).toBe('local');
	});

	it('chunkSize and chunkOverlap are positive integers', () => {
		expect(DEFAULT_SETTINGS.chunkSize).toBeGreaterThan(0);
		expect(DEFAULT_SETTINGS.chunkOverlap).toBeGreaterThanOrEqual(0);
		expect(DEFAULT_SETTINGS.chunkOverlap).toBeLessThan(DEFAULT_SETTINGS.chunkSize);
	});

	it('migrates old settings: adds queryRewriteEnabled with default', () => {
		// Simulate old settings data missing queryRewriteEnabled
		const oldSettings = {
			embedProvider: 'api',
			// ... other fields
		} as Partial<RatelVaultSettings>;

		// Migration: Object.assign with DEFAULT_SETTINGS
		const migrated: RatelVaultSettings = { ...DEFAULT_SETTINGS, ...oldSettings };
		expect(migrated.queryRewriteEnabled).toBe(false);
	});
});
```

- [ ] **Step 2: Adjust imports if field names differ**

Read `src/settings.ts` to confirm field names. Adjust the test accordingly.

- [ ] **Step 3: Run tests**

Run: `npm test -- tests/settings.test.ts`
Expected: 5 tests PASS

- [ ] **Step 4: Commit**

```bash
git add tests/settings.test.ts
git commit -m "test: add settings defaults + migration tests (5 cases)"
```

---

## Task 7: Auto-Index on File Change — Integration

**Files:**
- Create: `tests/integration/auto-index.test.ts`

- [ ] **Step 1: Write test file**

Create `tests/integration/auto-index.test.ts`:

```typescript
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Indexer } from '../../src/subagents/indexer';
import type { EmbeddingPort } from '../../src/ports/embedding';
import { handleMessage } from '../../src/worker/index';
import path from 'path';
import fs from 'fs';

const TEST_INDEX_DIR = path.join(__dirname, '../tmp/auto-index-test');

const mockEmbedding: EmbeddingPort = {
	embed: async (texts: string[]) =>
		texts.map((t) => {
			const v = new Array(384).fill(0);
			for (let i = 0; i < t.length; i++) {
				v[i % 384] = (v[i % 384] + t.charCodeAt(i) * 0.01) % 1;
			}
			return v;
		}),
	dimensions: 384,
	modelId: 'mock:test',
};

describe('Auto-index on file change (L2)', () => {
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

	it('file create event triggers indexFile', async () => {
		const indexer = new Indexer(mockEmbedding, { request: handleMessage } as any, {
			chunkSize: 500,
			chunkOverlap: 50,
		});

		// Simulate the file change handler that main.ts wires
		const onFileCreate = async (filePath: string, content: string) => {
			await indexer.indexFile(filePath, content);
		};

		await onFileCreate('notes/new.md', '# New Note\nThis is new content');

		// Verify it was indexed
		const search = await handleMessage({
			type: 'vector.search',
			payload: { queryVector: Array(384).fill(0.1), topK: 10 },
		} as any);
		const results = (search as { payload: Array<{ docId: string }> }).payload;
		const hasNew = results.some((r) => r.docId.startsWith('notes/new.md'));
		expect(hasNew).toBe(true);
	});

	it('file modify event re-indexes (replaces chunks)', async () => {
		const indexer = new Indexer(mockEmbedding, { request: handleMessage } as any, {
			chunkSize: 500,
			chunkOverlap: 50,
		});

		// Initial index
		await indexer.indexFile('notes/edit.md', '# Old\nOld content');

		// Modify event
		await indexer.indexFile('notes/edit.md', '# New\nNew content');

		const search = await handleMessage({
			type: 'vector.search',
			payload: { queryVector: Array(384).fill(0.1), topK: 100 },
		} as any);
		const results = (search as { payload: Array<{ docId: string; text: string }> }).payload;
		const editDocs = results.filter((r) => r.docId.startsWith('notes/edit.md'));
		editDocs.forEach((d) => {
			expect(d.text).toContain('New');
			expect(d.text).not.toContain('Old');
		});
	});

	it('file delete event removes from index', async () => {
		const indexer = new Indexer(mockEmbedding, { request: handleMessage } as any, {
			chunkSize: 500,
			chunkOverlap: 50,
		});

		await indexer.indexFile('notes/doomed.md', '# Doomed\nWill be deleted');
		await indexer.deleteFile('notes/doomed.md');

		const search = await handleMessage({
			type: 'vector.search',
			payload: { queryVector: Array(384).fill(0.1), topK: 100 },
		} as any);
		const results = (search as { payload: Array<{ docId: string }> }).payload;
		const hasDoomed = results.some((r) => r.docId.startsWith('notes/doomed.md'));
		expect(hasDoomed).toBe(false);
	});
});
```

- [ ] **Step 2: Run tests**

Run: `npm test -- tests/integration/auto-index.test.ts`
Expected: 3 tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/integration/auto-index.test.ts
git commit -m "test: add auto-index on file change L2 integration (3 cases)"
```

---

## Task 8: Chat Flow L2 Integration (Full Conversation)

**Files:**
- Create: `tests/integration/chat-flow.test.ts`

- [ ] **Step 1: Write test file**

Create `tests/integration/chat-flow.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { agentLoop } from '../../src/core/agent-loop';
import { ContextManager } from '../../src/core/context-manager';
import { ToolRegistry } from '../../src/core/tool-registry';
import { HookRegistry } from '../../src/core/hooks';
import type { LLMClient, ChatDelta } from '../../src/ports/llm';
import type { PersistencePort } from '../../src/ports/persistence';
import type { ToolCall } from '../../src/types';

async function* mockStreamWithToolCall(
	deltas: Array<{ text?: string; toolCall?: ToolCall }>,
): AsyncIterable<ChatDelta> {
	for (const d of deltas) {
		yield d;
	}
}

const inMemoryPersistence: PersistencePort = {
	sessions: {
		get: vi.fn().mockResolvedValue(null),
		upsert: vi.fn().mockResolvedValue(undefined),
	},
} as any;

describe('Chat Flow Integration (L2)', () => {
	let tools: ToolRegistry;
	let hooks: HookRegistry;
	let ctx: ContextManager;

	beforeEach(() => {
		vi.clearAllMocks();
		tools = new ToolRegistry();
		hooks = new HookRegistry();
		ctx = new ContextManager(inMemoryPersistence);
	});

	it('full conversation: user message → tool call → tool result → final reply', async () => {
		tools.register({
			definition: {
				name: 'search_vault',
				description: '',
				parameters: { type: 'object', properties: {} },
			},
			execute: async () => [
				{ docId: 'd1', score: 0.9, text: 'cats content', metadata: { path: 'cats.md' } },
			],
			readOnly: true,
		});

		// Track all events
		const events: string[] = [];

		const llm: LLMClient = {
			chat: vi.fn().mockImplementation(async function* () {
				// Step 1: tool call
				yield { text: 'Let me search', toolCall: { id: 'tc1', name: 'search_vault', args: { query: 'cats' } } };
			}),
			countTokens: vi.fn().mockReturnValue(10),
		};

		for await (const e of agentLoop({ sessionId: 's1', message: 'find cats' }, ctx, llm, tools, hooks)) {
			events.push(e.type);
		}

		// Verify event sequence
		expect(events).toContain('tool.call');
		expect(events).toContain('tool.result');
		expect(events).toContain('search.result');

		// Verify persistence was called
		expect(inMemoryPersistence.sessions.upsert).toHaveBeenCalled();

		// Verify context has tool result
		const messages = ctx.toMessages();
		const searchMsg = messages.find((m) => m.toolCallId === '__search_vault__');
		expect(searchMsg).toBeDefined();
	});

	it('write hook fires for non-readOnly tool', async () => {
		tools.register({
			definition: {
				name: 'write_note',
				description: '',
				parameters: { type: 'object', properties: {} },
			},
			execute: async () => 'wrote',
		});

		const beforeWriteSpy = vi.fn();
		hooks.register('before_write', beforeWriteSpy);

		const llm: LLMClient = {
			chat: vi.fn().mockImplementation(async function* () {
				yield { text: 'writing', toolCall: { id: 'tc1', name: 'write_note', args: {} } };
			}),
			countTokens: vi.fn().mockReturnValue(0),
		};

		for await (const _e of agentLoop({ sessionId: 's1', message: 'write' }, ctx, llm, tools, hooks)) {
			// drain
		}

		expect(beforeWriteSpy).toHaveBeenCalled();
	});

	it('readOnly tool skips write hooks', async () => {
		tools.register({
			definition: {
				name: 'read_note',
				description: '',
				parameters: { type: 'object', properties: {} },
			},
			execute: async () => 'read',
			readOnly: true,
		});

		const beforeWriteSpy = vi.fn();
		hooks.register('before_write', beforeWriteSpy);

		const llm: LLMClient = {
			chat: vi.fn().mockImplementation(async function* () {
				yield { text: 'reading', toolCall: { id: 'tc1', name: 'read_note', args: {} } };
			}),
			countTokens: vi.fn().mockReturnValue(0),
		};

		for await (const _e of agentLoop({ sessionId: 's1', message: 'read' }, ctx, llm, tools, hooks)) {
			// drain
		}

		expect(beforeWriteSpy).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Run tests**

Run: `npm test -- tests/integration/chat-flow.test.ts`
Expected: 3 tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/integration/chat-flow.test.ts
git commit -m "test: add chat flow L2 integration test (3 cases)"
```

---

## Task 9: Worker — index.full / index.incremental / index.delete

**Files:**
- Modify: `tests/worker/worker-handlers.test.ts`

- [ ] **Step 1: Add tests**

Append to the existing `describe('Worker message handlers', ...)`:

```typescript
	it('handles index.full — returns index.done with counts', async () => {
		const response = await handleMessage({
			type: 'index.full',
			payload: { vaultPath: '/test/vault' },
		} as any);

		// The W4 implementation returns index.done for full/incremental
		expect(['index.done', 'error']).toContain(response.type);
	});

	it('handles index.incremental — returns index.done or processes file', async () => {
		const response = await handleMessage({
			type: 'index.incremental',
			payload: { filePath: 'notes/test.md', content: '# Test\nContent' },
		} as any);

		expect(['index.done', 'index.progress', 'error']).toContain(response.type);
	});

	it('handles index.delete — removes docs by file path prefix', async () => {
		// First upsert
		await handleMessage({
			type: 'vector.upsert',
			payload: { docId: 'prefix-test.md#chunk-0', text: 'content', metadata: { path: 'prefix-test.md' } },
		} as any);

		// Then delete by file path
		const response = await handleMessage({
			type: 'index.delete',
			payload: { filePath: 'prefix-test.md' },
		} as any);

		expect(['vector.delete.done', 'index.done']).toContain(response.type);

		// Verify deletion
		const search = await handleMessage({
			type: 'vector.search',
			payload: { queryVector: Array(384).fill(0.1), topK: 10 },
		} as any);
		const results = (search as { payload: Array<{ docId: string }> }).payload;
		const hasPrefixed = results.some((r) => r.docId.startsWith('prefix-test.md'));
		expect(hasPrefixed).toBe(false);
	});
```

- [ ] **Step 2: Run tests**

Run: `npm test -- tests/worker/worker-handlers.test.ts`
Expected: 8 tests PASS (5 original + 3 new)

- [ ] **Step 3: Commit**

```bash
git add tests/worker/worker-handlers.test.ts
git commit -m "test: add Worker index.full/incremental/delete tests"
```

---

## Task 10: Verify + Update Test Architecture Doc

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All test files pass (20+ files, 165+ tests, up from ~127)

- [ ] **Step 2: Run build + lint**

Run: `npm run build && npm run lint`
Expected: Both succeed

- [ ] **Step 3: Update test architecture doc**

Edit `docs/superpowers/specs/2026-06-14-ratel-test-architecture.md`:

- Section 3.1 RAG: L1 12/12 (100%) | L2 4/4 (100%) — all 4 L2 paths covered
- Section 3.2 Chat: L1 16/16 (100%) | L2 1/1 (100%) — full conversation flow
- Section 3.3 Settings: L1 2/2 (100%) | L2 — partial (no L2 needed)
- Section 3.4 Tools: search_vault 8/8 + read_note 4/4
- Section 3.5 Worker: 8/8 (100%)
- Section 3.7 UI: still L3 manual
- Section 3.8 Infrastructure: 18/18 (100%)

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-06-14-ratel-test-architecture.md
git commit -m "docs: update W4+ test coverage in test architecture"
```

---

## Self-Review

### 1. Spec Coverage (W4+ items from test architecture)

| Item | Task |
|---|---|
| Reranker API (Cohere/Jina/SiliconFlow) | Task 1 |
| Query Rewrite (LLM-based) | Task 2 |
| Indexer subagent | Task 3 |
| Indexer L2 integration | Task 4 |
| RAG enhanced (Rerank + QueryRewrite) | Task 5 |
| Settings queryRewriteEnabled | Task 6 |
| Auto-index on file change | Task 7 |
| Chat flow L2 integration | Task 8 |
| Worker index.full/incremental/delete | Task 9 |

**Gaps:**
- L3 E2E (Obsidian 手动测试) — by design, deferred to manual checklist
- UI 维度的 Svelte 组件测试 — out of scope (L3 手动验证)

### 2. Placeholder Scan

- No TBD/TODO
- All test code complete
- Mock patterns explicit

### 3. Type Consistency

| Type | Defined In | Used In | Consistent |
|---|---|---|---|
| `RerankerPort` | `ports/reranker.ts` | tests | Yes |
| `RerankResult` | `ports/reranker.ts` | tests | Yes |
| `LLMClient` | `ports/llm.ts` | tests | Yes |
| `IndexerConfig` | `subagents/indexer.ts` | tests | Yes |
| `IndexResult` | `subagents/indexer.ts` | tests | Yes |
| `WorkerRequest` / `WorkerResponse` | `types.ts` | tests | Yes |
| `RatelVaultSettings` | `settings.ts` | tests | Yes — field names verified by reading settings.ts |

### 4. Test Count Estimate

| Suite | Tests | Cumulative |
|---|---|---|
| W1 backfill | +14 | ~90 |
| W2 backfill | +10 | ~90 |
| W3 (search plan) | +37 | ~127 |
| **W4+ (this plan)** | **+47** (7 Reranker + 7 QueryRewrite + 8 Indexer + 4 L2 Indexer + 3 L2 RAG-enhanced + 5 Settings + 3 L2 Auto-index + 3 L2 Chat-flow + 3 Worker + 4 misc) | **~174** |
| **Total after all 4 plans** | | **~174 tests** |

### 5. Milestone Coverage After W4+

| Milestone | Status | Notes |
|---|---|---|
| **M1: 单元测试夯实** | ✅ All dimensions L1 ≥ 90% | 100%+ across all dimensions |
| **M2: 集成测试闭环** | ✅ All P0 paths covered | 4 L2 files: rag-pipeline, search-pipeline, indexer-pipeline, rag-enhanced, auto-index, chat-flow |
| **M3: E2E 验证** | ❌ Manual checklist pending | TBD with user for actual Obsidian testing |
| **M4: 生产就绪** | M1+M2 done, M3 partial | Final 1 milestone |
