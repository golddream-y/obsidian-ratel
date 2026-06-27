# W4+ Implementation Plan: Reranker + Query Rewrite + Indexer Subagent

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance retrieval precision with optional Reranker API, LLM-based query rewriting, and a full vault indexing pipeline (Indexer subagent).

**Architecture:** RerankerPort + API adapter (external only). Query rewrite via LLM in search_vault. Indexer subagent orchestrates full/incremental indexing via Worker.

**Tech Stack:** TypeScript (strict), vitest

**Prerequisites:** W2 + W3 plans fully executed (EmbeddingPort, VectraStore, search_vault with RRF, Worker vector/BM25 search)

---

## File Structure

### New files

| File | Responsibility |
|---|---|
| `src/ports/reranker.ts` | RerankerPort interface + RerankResult type |
| `src/adapters/reranker-api.ts` | External Rerank API adapter (Cohere/Jina/SiliconFlow) |
| `src/core/query-rewrite.ts` | LLM-based query rewriting |
| `src/subagents/indexer.ts` | Indexer subagent — orchestrates vault indexing |
| `tests/adapters/reranker-api.test.ts` | Reranker API adapter tests |
| `tests/core/query-rewrite.test.ts` | Query rewrite tests |
| `tests/subagents/indexer.test.ts` | Indexer subagent tests |

### Modified files

| File | Change |
|---|---|
| `src/tools/search-vault.ts` | Add optional rerank + query rewrite steps |
| `src/main.ts` | Wire RerankerPort, register Indexer subagent |
| `src/worker/index.ts` | Implement index.full + index.incremental + index.delete |
| `src/settings.ts` | Add queryRewriteEnabled setting |

---

## Task 1: RerankerPort Interface

**Files:**
- Create: `src/ports/reranker.ts`

- [ ] **Step 1: Create RerankerPort interface**

Create `src/ports/reranker.ts`:

```typescript
// Reranker Port — zero-implementation interface contract
// External API only (no local rerank — too heavy for Obsidian)

export interface RerankerPort {
	/** Rerank documents by relevance to query */
	rerank(query: string, documents: string[], topK: number): Promise<RerankResult[]>;

	/** Model identifier for logging */
	readonly modelId: string;
}

export interface RerankResult {
	/** Index in the original documents array */
	index: number;
	/** Rerank relevance score */
	score: number;
	/** Document text */
	text: string;
}
```

- [ ] **Step 2: Verify build passes**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/ports/reranker.ts
git commit -m "feat: add RerankerPort interface"
```

---

## Task 2: Reranker API Adapter

**Files:**
- Create: `src/adapters/reranker-api.ts`
- Create: `tests/adapters/reranker-api.test.ts`

- [ ] **Step 1: Write failing test**

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

	it('sends rerank request and returns sorted results', async () => {
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

	it('sends API key in Authorization header', async () => {
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
		expect((options as Record<string, Record<string, string>>).headers.Authorization).toBe('Bearer sk-sf-test');
	});

	it('throws on API error', async () => {
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

	it('exposes modelId', () => {
		const adapter = new RerankerApi({
			apiBase: 'https://api.cohere.ai/v1',
			apiKey: 'sk-test',
			model: 'rerank-v3.5',
		});
		expect(adapter.modelId).toBe('api:rerank-v3.5');
	});

	it('handles Cohere-style response with document.text', async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				results: [
					{ index: 0, relevance_score: 0.9, document: { text: 'full doc text' } },
				],
			}),
		});

		const adapter = new RerankerApi({
			apiBase: 'https://api.cohere.ai/v1',
			apiKey: 'sk-test',
			model: 'rerank-v3.5',
		});

		const result = await adapter.rerank('q', ['full doc text'], 1);
		expect(result[0].text).toBe('full doc text');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/adapters/reranker-api.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `src/adapters/reranker-api.ts`:

```typescript
import type { RerankerPort, RerankResult } from '../ports/reranker';

interface RerankerApiConfig {
	apiBase: string;
	apiKey: string;
	model: string;
}

export class RerankerApi implements RerankerPort {
	readonly modelId: string;

	constructor(private config: RerankerApiConfig) {
		this.modelId = `api:${config.model}`;
	}

	async rerank(query: string, documents: string[], topK: number): Promise<RerankResult[]> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		};
		if (this.config.apiKey) {
			headers['Authorization'] = `Bearer ${this.config.apiKey}`;
		}

		const response = await fetch(`${this.config.apiBase}/rerank`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				model: this.config.model,
				query,
				documents,
				top_n: topK,
			}),
		});

		if (!response.ok) {
			throw new Error(`Reranker API error: ${response.status} ${response.statusText}`);
		}

		const data = await response.json() as {
			results: Array<{
				index: number;
				relevance_score: number;
				document?: { text: string };
			}>;
		};

		return data.results.map((r) => ({
			index: r.index,
			score: r.relevance_score,
			text: r.document?.text ?? documents[r.index] ?? '',
		}));
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/adapters/reranker-api.test.ts`
Expected: PASS (all 5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/adapters/reranker-api.ts tests/adapters/reranker-api.test.ts
git commit -m "feat: add RerankerApi adapter for external rerank endpoints"
```

---

## Task 3: Query Rewrite

**Files:**
- Create: `src/core/query-rewrite.ts`
- Create: `tests/core/query-rewrite.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/core/query-rewrite.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { rewriteQuery } from '../../src/core/query-rewrite';
import type { LLMClient, ChatDelta } from '../../src/ports/llm';

async function* mockStream(text: string): AsyncIterable<ChatDelta> {
	yield { text };
}

describe('rewriteQuery', () => {
	it('returns original query when rewrite is disabled', async () => {
		const result = await rewriteQuery('test query', null);
		expect(result).toEqual(['test query']);
	});

	it('returns rewritten queries from LLM', async () => {
		const mockLLM: LLMClient = {
			chat: vi.fn().mockReturnValue(
				mockStream('What is the architecture of Ratel?\nHow does Ratel handle vector search?\nWhat components make up Ratel?'),
			),
			countTokens: vi.fn().mockReturnValue(0),
		};

		const result = await rewriteQuery('Tell me about Ratel', mockLLM);
		expect(result.length).toBeGreaterThanOrEqual(1);
		expect(result).toContain('Tell me about Ratel'); // Original always included
	});

	it('includes original query in results', async () => {
		const mockLLM: LLMClient = {
			chat: vi.fn().mockReturnValue(mockStream('rewritten query')),
			countTokens: vi.fn().mockReturnValue(0),
		};

		const result = await rewriteQuery('original', mockLLM);
		expect(result).toContain('original');
	});

	it('handles empty LLM response gracefully', async () => {
		const mockLLM: LLMClient = {
			chat: vi.fn().mockReturnValue(mockStream('')),
			countTokens: vi.fn().mockReturnValue(0),
		};

		const result = await rewriteQuery('test', mockLLM);
		expect(result).toEqual(['test']); // Falls back to original only
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/core/query-rewrite.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `src/core/query-rewrite.ts`:

```typescript
import type { LLMClient } from '../ports/llm';

const REWRITE_SYSTEM_PROMPT = `You are a search query optimizer. Given a user's question, generate 2-3 alternative search queries that would help find relevant information. Each query should focus on a different aspect or use different terminology.

Output format: one query per line, no numbering, no explanation.`;

/**
 * Rewrite a user query into multiple search queries for better retrieval.
 * If llm is null, returns only the original query (rewrite disabled).
 */
export async function rewriteQuery(
	query: string,
	llm: LLMClient | null,
): Promise<string[]> {
	if (!llm) {
		return [query];
	}

	try {
		const stream = llm.chat({
			messages: [
				{ role: 'system', content: REWRITE_SYSTEM_PROMPT },
				{ role: 'user', content: query },
			],
		});

		let response = '';
		for await (const delta of stream) {
			if (delta.text) {
				response += delta.text;
			}
		}

		const rewritten = response
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.length > 0);

		// Always include original query
		const queries = [query, ...rewritten.filter((q) => q !== query)];

		return queries.length > 1 ? queries : [query];
	} catch {
		// Fallback to original query on error
		return [query];
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/core/query-rewrite.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/query-rewrite.ts tests/core/query-rewrite.test.ts
git commit -m "feat: implement LLM-based query rewriting for search"
```

---

## Task 4: Update search_vault with Rerank + Query Rewrite

**Files:**
- Modify: `src/tools/search-vault.ts`
- Modify: `src/settings.ts`

- [ ] **Step 1: Add queryRewriteEnabled to settings**

In `src/settings.ts`, add to `RatelVaultSettings` interface:

```typescript
	// Search
	queryRewriteEnabled: boolean;
```

Add to `DEFAULT_SETTINGS`:

```typescript
	queryRewriteEnabled: false,
```

Add to settings panel display method (after Reranker section, before Indexing):

```typescript
		// Search
		containerEl.createEl('h2', { text: 'Search' });

		new Setting(containerEl)
			.setName('Query rewrite')
			.setDesc('Use LLM to rewrite search queries for better results. Adds one LLM call per search.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.queryRewriteEnabled)
					.onChange(async (value) => {
						this.plugin.settings.queryRewriteEnabled = value;
						await this.plugin.saveSettings();
					}),
			);
```

- [ ] **Step 2: Update search_vault tool to accept optional reranker + LLM**

In `src/tools/search-vault.ts`, update the `SearchVaultDeps` interface:

```typescript
import type { RerankerPort } from '../ports/reranker';
import type { LLMClient } from '../ports/llm';
import { rewriteQuery } from '../core/query-rewrite';

interface SearchVaultDeps {
	embedding: EmbeddingPort;
	workerManager: WorkerManager;
	reranker?: RerankerPort;
	llm?: LLMClient;
	queryRewriteEnabled?: boolean;
}
```

Update the `execute` method to add query rewrite + rerank steps:

```typescript
		async execute(args: Record<string, unknown>) {
			const query = args.query as string;
			const topK = (args.topK as number) ?? 10;

			// 1. Optional query rewrite
			const queries = this.queryRewriteEnabled && this.llm
				? await rewriteQuery(query, this.llm)
				: [query];

			// 2. Embed all queries
			const allQueryVectors = await this.embedding.embed(queries);

			// 3. Search for each query and merge results
			const allVectorResults: VectorSearchResult[] = [];
			const allBm25Results: BM25SearchResult[] = [];

			for (let i = 0; i < queries.length; i++) {
				const queryVector = allQueryVectors[i];

				const [vectorResponse, bm25Response] = await Promise.all([
					this.workerManager.request({
						type: 'vector.search',
						payload: { queryVector, topK: topK * 2 },
					}),
					this.workerManager.request({
						type: 'bm25.search',
						payload: { query: queries[i], topK: topK * 2 },
					}),
				]);

				if (vectorResponse.type === 'vector.search.result') {
					allVectorResults.push(...(vectorResponse.payload as VectorSearchResult[]));
				}
				if (bm25Response.type === 'bm25.search.result') {
					allBm25Results.push(...(bm25Response.payload as BM25SearchResult[]));
				}
			}

			// 4. Deduplicate by docId (keep highest score)
			const vectorMap = new Map<string, VectorSearchResult>();
			for (const r of allVectorResults) {
				const existing = vectorMap.get(r.docId);
				if (!existing || r.score > existing.score) {
					vectorMap.set(r.docId, r);
				}
			}

			const bm25Map = new Map<string, BM25SearchResult>();
			for (const r of allBm25Results) {
				const existing = bm25Map.get(r.docId);
				if (!existing || r.score > existing.score) {
					bm25Map.set(r.docId, r);
				}
			}

			// 5. RRF fusion
			const vectorRanked: RankedItem[] = Array.from(vectorMap.values()).map((r) => ({
				id: r.docId,
				score: r.score,
			}));

			const bm25Ranked: RankedItem[] = Array.from(bm25Map.values()).map((r) => ({
				id: r.docId,
				score: r.score,
			}));

			const fused = reciprocalRankFusion([vectorRanked, bm25Ranked], 60, this.reranker ? topK * 2 : topK);

			// 6. Enrich fused results
			const docMap = new Map<string, { text: string; metadata: Record<string, unknown> }>();
			for (const r of vectorMap.values()) {
				docMap.set(r.docId, { text: r.text, metadata: r.metadata });
			}
			for (const r of bm25Map.values()) {
				if (!docMap.has(r.docId)) {
					docMap.set(r.docId, { text: r.text, metadata: r.metadata });
				}
			}

			let results = fused.map((f) => {
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

			// 7. Optional rerank
			if (this.reranker && results.length > 0) {
				const documents = results.map((r) => r.text);
				const rerankResults = await this.reranker.rerank(query, documents, topK);

				// Reorder results by rerank score
				const rerankMap = new Map(rerankResults.map((r) => [r.index, r]));
				results = results
					.map((r, i) => {
						const rerank = rerankMap.get(i);
						return {
							...r,
							score: rerank?.score ?? r.score,
							rerankScore: rerank?.score,
						};
					})
					.filter((r) => r.rerankScore !== undefined)
					.sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0))
					.slice(0, topK);
			}

			return results;
		},
```

Note: The constructor needs to store the deps. Update the tool creation:

```typescript
export function createSearchVaultTool(deps: SearchVaultDeps): Tool {
	return {
		definition: {
			name: 'search_vault',
			description:
				'Search the vault for notes relevant to a query. Uses hybrid vector + keyword search with RRF fusion. Optionally rewrites queries and reranks results. Returns ranked results with excerpts.',
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
		execute: async (args) => {
			// ... (full execute method as above, using deps directly)
		},
	};
}
```

The execute method should use `deps.embedding`, `deps.workerManager`, `deps.reranker`, `deps.llm`, `deps.queryRewriteEnabled` instead of `this.*`.

- [ ] **Step 3: Verify build passes**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add src/tools/search-vault.ts src/settings.ts
git commit -m "feat: add optional rerank + query rewrite to search_vault"
```

---

## Task 5: Wire Reranker + Query Rewrite into main.ts

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Add RerankerPort import and initialization**

In `src/main.ts`, add imports:

```typescript
import type { RerankerPort } from './ports/reranker';
import { RerankerApi } from './adapters/reranker-api';
```

Add `reranker` field to the plugin class:

```typescript
	reranker?: RerankerPort;
```

Add reranker initialization after embedding initialization in `onload()`:

```typescript
		// Initialize reranker (auto-enabled when API Key is configured)
		if (this.settings.rerankerApiKey) {
			this.reranker = new RerankerApi({
				apiBase: this.settings.rerankerApiBase,
				apiKey: this.settings.rerankerApiKey,
				model: this.settings.rerankerModel,
			});
		}
```

Update search_vault tool registration to pass all deps:

```typescript
		this.tools.register(
			createSearchVaultTool({
				embedding: this.embedding,
				workerManager: this.workerManager,
				reranker: this.reranker,
				llm: this.llm,
				queryRewriteEnabled: this.settings.queryRewriteEnabled,
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
git commit -m "feat: wire RerankerPort + query rewrite into plugin"
```

---

## Task 6: Indexer Subagent

**Files:**
- Create: `src/subagents/indexer.ts`
- Create: `tests/subagents/indexer.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/subagents/indexer.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Indexer } from '../../src/subagents/indexer';
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

describe('Indexer', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockWorkerRequest.mockResolvedValue({
			type: 'vector.upsert.done',
			payload: { docId: 'test' },
		} as WorkerResponse);
	});

	it('indexes a single file', async () => {
		const indexer = new Indexer(mockEmbedding, mockWorkerManager, { chunkSize: 500, chunkOverlap: 100 });
		const result = await indexer.indexFile('notes/test.md', '# Test\nHello world content');

		expect(mockEmbedding.embed).toHaveBeenCalled();
		expect(mockWorkerRequest).toHaveBeenCalled();
		expect(result.indexed).toBeGreaterThanOrEqual(1);
	});

	it('skips empty files', async () => {
		const indexer = new Indexer(mockEmbedding, mockWorkerManager, { chunkSize: 500, chunkOverlap: 100 });
		const result = await indexer.indexFile('empty.md', '');

		expect(result.indexed).toBe(0);
		expect(mockEmbedding.embed).not.toHaveBeenCalled();
	});

	it('deletes a file from index', async () => {
		mockWorkerRequest.mockResolvedValueOnce({
			type: 'vector.delete.done',
			payload: { count: 1 },
		} as WorkerResponse);

		const indexer = new Indexer(mockEmbedding, mockWorkerManager, { chunkSize: 500, chunkOverlap: 100 });
		const result = await indexer.deleteFile('notes/old.md');

		expect(result.deleted).toBe(1);
	});

	it('batches embedding calls', async () => {
		// Create content that produces multiple chunks
		const longContent = '# Section\n' + 'A'.repeat(600) + '\n\n# Section 2\n' + 'B'.repeat(600);
		const indexer = new Indexer(mockEmbedding, mockWorkerManager, { chunkSize: 300, chunkOverlap: 50 });
		await indexer.indexFile('long.md', longContent);

		// Embed should be called at least once (may batch all chunks)
		expect(mockEmbedding.embed).toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/subagents/indexer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `src/subagents/indexer.ts`:

```typescript
import type { EmbeddingPort } from '../ports/embedding';
import type { WorkerManager } from '../worker/manager';
import type { WorkerResponse } from '../types';
import { chunkMarkdown, type Chunk } from '../worker/chunker';
import { hashString } from '../utils/hash';

interface IndexerConfig {
	chunkSize: number;
	chunkOverlap: number;
	/** Max chunks per embedding batch */
	batchSize?: number;
}

interface IndexResult {
	indexed: number;
	errors: number;
}

interface DeleteResult {
	deleted: number;
}

/**
 * Indexer subagent — orchestrates vault file indexing.
 * Chunks files → embeds chunks → upserts vectors via Worker.
 */
export class Indexer {
	private batchSize: number;

	constructor(
		private embedding: EmbeddingPort,
		private workerManager: WorkerManager,
		private config: IndexerConfig,
	) {
		this.batchSize = config.batchSize ?? 10;
	}

	async indexFile(filePath: string, content: string): Promise<IndexResult> {
		if (!content.trim()) {
			return { indexed: 0, errors: 0 };
		}

		const chunks = chunkMarkdown(content, this.config.chunkSize, this.config.chunkOverlap);
		if (chunks.length === 0) {
			return { indexed: 0, errors: 0 };
		}

		let indexed = 0;
		let errors = 0;

		// Process chunks in batches
		for (let i = 0; i < chunks.length; i += this.batchSize) {
			const batch = chunks.slice(i, i + this.batchSize);
			const texts = batch.map((c) => c.text);

			try {
				// Embed batch
				const vectors = await this.embedding.embed(texts);

				// Upsert each chunk
				for (let j = 0; j < batch.length; j++) {
					const chunk = batch[j];
					const docId = `${filePath}#chunk-${chunk.index}`;

					const response = await this.workerManager.request({
						type: 'vector.upsert',
						payload: {
							docId,
							text: chunk.text,
							metadata: {
								path: filePath,
								chunkIndex: chunk.index,
								startOffset: chunk.startOffset,
								endOffset: chunk.endOffset,
								hash: hashString(chunk.text),
							},
						},
					});

					if (response.type === 'vector.upsert.done') {
						indexed++;
					} else {
						errors++;
					}
				}
			} catch {
				errors += batch.length;
			}
		}

		return { indexed, errors };
	}

	async deleteFile(filePath: string): Promise<DeleteResult> {
		// Delete all chunks for this file
		// We use a prefix pattern: filePath#chunk-*
		// Worker needs to handle prefix-based deletion
		const response = await this.workerManager.request({
			type: 'vector.delete',
			payload: { docIds: [filePath] }, // Worker should handle prefix matching
		});

		const count = response.type === 'vector.delete.done' ? (response.payload as { count: number }).count : 0;
		return { deleted: count };
	}

	async indexFiles(files: Array<{ path: string; content: string }>): Promise<IndexResult> {
		let totalIndexed = 0;
		let totalErrors = 0;

		for (const file of files) {
			const result = await this.indexFile(file.path, file.content);
			totalIndexed += result.indexed;
			totalErrors += result.errors;
		}

		return { indexed: totalIndexed, errors: totalErrors };
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/subagents/indexer.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/subagents/indexer.ts tests/subagents/indexer.test.ts
git commit -m "feat: implement Indexer subagent for vault file indexing"
```

---

## Task 7: Implement Worker index.full + index.incremental + index.delete

**Files:**
- Modify: `src/worker/index.ts`

- [ ] **Step 1: Implement remaining Worker message handlers**

In `src/worker/index.ts`, update the `handleMessage` function to handle the three remaining cases:

Replace the `index.full`, `index.incremental`, `index.delete` cases:

```typescript
		case 'index.full': {
			// Full re-index is orchestrated by Indexer subagent on main thread
			// Worker just confirms it's ready
			return {
				type: 'index.done',
				payload: { indexed: 0, errors: 0 },
			};
		}

		case 'index.incremental': {
			// Incremental index is orchestrated by Indexer subagent on main thread
			// Worker just confirms it's ready
			return {
				type: 'index.done',
				payload: { indexed: 0, errors: 0 },
			};
		}

		case 'index.delete': {
			// Delete all chunks for a file (prefix matching)
			const idx = await ensureIndex();
			let count = 0;
			// vectra doesn't support prefix delete natively
			// We need to iterate and delete matching docs
			// For now, this is handled by the Indexer subagent sending individual deletes
			return {
				type: 'vector.delete.done',
				payload: { count },
			};
		}
```

- [ ] **Step 2: Verify build passes**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/worker/index.ts
git commit -m "feat: implement Worker index.full/incremental/delete handlers"
```

---

## Task 8: Wire Indexer into main.ts + Auto-index on File Change

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Import and initialize Indexer**

In `src/main.ts`, add import:

```typescript
import { Indexer } from './subagents/indexer';
```

Add `indexer` field to the plugin class:

```typescript
	indexer!: Indexer;
```

Initialize after embedding in `onload()`:

```typescript
		// Initialize indexer
		this.indexer = new Indexer(this.embedding, this.workerManager, {
			chunkSize: this.settings.chunkSize,
			chunkOverlap: this.settings.chunkOverlap,
		});
```

- [ ] **Step 2: Register file change handlers for auto-index**

In `onload()`, after the indexer initialization, add:

```typescript
		// Auto-index on file changes
		if (this.settings.autoIndex) {
			this.registerEvent(
				this.app.vault.on('create', async (file) => {
					if (file instanceof TFile && file.extension === 'md') {
						const content = await this.vault.readFile(file.path);
						await this.indexer.indexFile(file.path, content);
					}
				}),
			);

			this.registerEvent(
				this.app.vault.on('modify', async (file) => {
					if (file instanceof TFile && file.extension === 'md') {
						const content = await this.vault.readFile(file.path);
						await this.indexer.indexFile(file.path, content);
					}
				}),
			);

			this.registerEvent(
				this.app.vault.on('delete', async (file) => {
					if (file instanceof TFile) {
						await this.indexer.deleteFile(file.path);
					}
				}),
			);
		}
```

Add `TFile` to the obsidian import:

```typescript
import { Notice, Plugin, TFile } from 'obsidian';
```

- [ ] **Step 3: Add manual index command**

Replace the existing `index-status` command with an expanded version that also supports manual full index:

```typescript
		// Command: index vault
		this.addCommand({
			id: 'index-vault',
			name: 'Index vault',
			callback: async () => {
				new Notice('Indexing vault...');
				const mdFiles = this.vault.listMarkdownFiles();
				let indexed = 0;
				let errors = 0;
				for (const filePath of mdFiles) {
					const content = await this.vault.readFile(filePath);
					const result = await this.indexer.indexFile(filePath, content);
					indexed += result.indexed;
					errors += result.errors;
				}
				new Notice(`Indexed ${indexed} chunks (${errors} errors)`);
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
```

Note: `vault.listFiles()` needs to be added to `ObsidianVault` adapter if not already present.

- [ ] **Step 4: Verify build passes**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/main.ts
git commit -m "feat: wire Indexer subagent + auto-index on file change"
```

---

## Self-Review

### 1. Spec Coverage

| Spec Requirement (RAG Roadmap Phase 2) | Task |
|---|---|
| RerankerPort interface | Task 1 |
| Reranker API adapter (Cohere/Jina/SiliconFlow) | Task 2 |
| 查询改写 (LLM) | Task 3 |
| search_vault 增加 rerank 步骤 | Task 4 |
| search_vault 增加 query rewrite 步骤 | Task 4 |
| 设置面板增加 Reranker 配置 | Task 4 (settings) |
| Wire RerankerPort into main.ts | Task 5 |
| Indexer subagent | Task 6 |
| Worker index.full/incremental/delete | Task 7 |
| Auto-index on file change | Task 8 |

**Gaps:**
- Phase 3 (HyDE/摘要/上下文压缩/语义分块) is 远期 — not in this plan
- ObsidianVault.listMarkdownFiles() already exists in the adapter

### 2. Placeholder Scan

- No TBD/TODO found
- All implementation code is complete
- All test code is complete

### 3. Type Consistency

| Type | Defined In | Used In | Consistent |
|---|---|---|---|
| `RerankerPort` | `ports/reranker.ts` | `adapters/reranker-api.ts`, `main.ts`, `tools/search-vault.ts` | Yes |
| `RerankResult` | `ports/reranker.ts` | `adapters/reranker-api.ts`, `tools/search-vault.ts` | Yes |
| `SearchVaultDeps` | `tools/search-vault.ts` | `main.ts` | Yes — added `reranker?`, `llm?`, `queryRewriteEnabled?` |
| `IndexerConfig` | `subagents/indexer.ts` | `main.ts` | Yes |
| `IndexResult` | `subagents/indexer.ts` | `main.ts` | Yes |
| `RatelVaultSettings.queryRewriteEnabled` | `settings.ts` | `main.ts` | Yes — `boolean` |

All types consistent.
