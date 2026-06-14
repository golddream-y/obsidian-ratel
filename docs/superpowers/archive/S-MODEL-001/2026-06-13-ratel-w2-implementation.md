# W2 Implementation Plan: Embedding + Settings + Indexing Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users can embed vault notes using a local model (zero-config) or external API, and the Worker can store vectors via vectra.

**Architecture:** EmbeddingPort separates embedding from LLM. Two adapters: local (`@huggingface/transformers` ONNX) and API (OpenAI-compatible). Settings panel gains Embedding Provider dropdown. Worker gains vectra-based vector store. Markdown chunker gets full implementation.

**Tech Stack:** TypeScript (strict), vitest, `@huggingface/transformers` v3 (ONNX WASM), vectra (pure JS), esbuild

---

## File Structure

### New files

| File | Responsibility |
|---|---|
| `src/ports/embedding.ts` | EmbeddingPort interface |
| `src/adapters/embedding-api.ts` | OpenAI-compatible embedding API adapter |
| `src/adapters/embedding-local.ts` | @huggingface/transformers local ONNX adapter |
| `src/adapters/vector-vectra.ts` | vectra LocalDocumentIndex wrapper (replace placeholder) |
| `src/worker/chunker.ts` | Markdown-aware chunking (replace placeholder) |
| `tests/adapters/embedding-api.test.ts` | Embedding API adapter tests |
| `tests/adapters/embedding-local.test.ts` | Embedding local adapter tests |
| `tests/adapters/vector-vectra.test.ts` | vectra adapter tests |
| `tests/worker/chunker.test.ts` | Chunker tests |

### Modified files

| File | Change |
|---|---|
| `src/ports/llm.ts` | Remove `embed()` from LLMClient interface |
| `src/adapters/llm-deepseek.ts` | Remove `embed()` method |
| `src/settings.ts` | Add Embedding Provider + Reranker settings |
| `src/main.ts` | Create EmbeddingPort based on settings, wire into plugin |
| `src/types.ts` | Add WorkerRequest variants for embedding-aware indexing |

---

## Task 1: EmbeddingPort Interface

**Files:**
- Create: `src/ports/embedding.ts`

- [ ] **Step 1: Create EmbeddingPort interface**

Create `src/ports/embedding.ts`:

```typescript
// Embedding Port — zero-implementation interface contract
// Separates embedding from LLM (embed() removed from LLMClient in Task 2)

export interface EmbeddingPort {
	/** Generate embedding vectors for a batch of texts */
	embed(texts: string[]): Promise<number[][]>;

	/** Embedding vector dimensions (e.g. 512 for bge-small-zh, 1024 for bge-m3) */
	readonly dimensions: number;

	/** Model identifier for logging and cache keys */
	readonly modelId: string;
}
```

- [ ] **Step 2: Verify build passes**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/ports/embedding.ts
git commit -m "feat: add EmbeddingPort interface"
```

---

## Task 2: Remove embed() from LLMClient

**Files:**
- Modify: `src/ports/llm.ts`
- Modify: `src/adapters/llm-deepseek.ts`

- [ ] **Step 1: Remove embed() from LLMClient interface**

In `src/ports/llm.ts`, change:

```typescript
export interface LLMClient {
	chat(req: ChatRequest): AsyncIterable<ChatDelta>;
	embed(texts: string[]): Promise<number[][]>;
	countTokens(text: string): number;
}
```

to:

```typescript
export interface LLMClient {
	chat(req: ChatRequest): AsyncIterable<ChatDelta>;
	countTokens(text: string): number;
}
```

- [ ] **Step 2: Remove embed() from DeepSeekLLM**

In `src/adapters/llm-deepseek.ts`, delete the `embed()` method (lines 125-127):

```typescript
	async embed(_texts: string[]): Promise<number[][]> {
		throw new Error('embed() not implemented in W1 — use W2 vector search instead');
	}
```

- [ ] **Step 3: Verify build + tests pass**

Run: `npm run build && npm test`
Expected: Build succeeds, all tests pass

- [ ] **Step 4: Commit**

```bash
git add src/ports/llm.ts src/adapters/llm-deepseek.ts
git commit -m "refactor: remove embed() from LLMClient, moved to EmbeddingPort"
```

---

## Task 3: Embedding API Adapter

**Files:**
- Create: `src/adapters/embedding-api.ts`
- Create: `tests/adapters/embedding-api.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/adapters/embedding-api.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmbeddingApi } from '../../src/adapters/embedding-api';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('EmbeddingApi', () => {
	beforeEach(() => {
		mockFetch.mockReset();
	});

	it('sends embedding request and returns vectors', async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				data: [
					{ embedding: [0.1, 0.2, 0.3], index: 0 },
					{ embedding: [0.4, 0.5, 0.6], index: 1 },
				],
				model: 'bge-m3',
				usage: { prompt_tokens: 10, total_tokens: 10 },
			}),
		});

		const adapter = new EmbeddingApi({
			apiBase: 'http://localhost:11434/v1',
			apiKey: '',
			model: 'bge-m3',
			dimensions: 1024,
		});

		const result = await adapter.embed(['hello', 'world']);
		expect(result).toEqual([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]);
		expect(mockFetch).toHaveBeenCalledOnce();
		const [url, options] = mockFetch.mock.calls[0]!;
		expect(url).toBe('http://localhost:11434/v1/embeddings');
		expect((options as RequestInit).method).toBe('POST');
	});

	it('sends API key when provided', async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				data: [{ embedding: [0.1], index: 0 }],
			}),
		});

		const adapter = new EmbeddingApi({
			apiBase: 'https://api.siliconflow.cn/v1',
			apiKey: 'sk-test',
			model: 'BAAI/bge-m3',
			dimensions: 1024,
		});

		await adapter.embed(['test']);
		const [, options] = mockFetch.mock.calls[0]!;
		expect((options as Record<string, Record<string, string>>).headers.Authorization).toBe('Bearer sk-test');
	});

	it('throws on API error', async () => {
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 401,
			statusText: 'Unauthorized',
		});

		const adapter = new EmbeddingApi({
			apiBase: 'https://api.siliconflow.cn/v1',
			apiKey: 'sk-bad',
			model: 'bge-m3',
			dimensions: 1024,
		});

		await expect(adapter.embed(['test'])).rejects.toThrow('Embedding API error: 401 Unauthorized');
	});

	it('exposes dimensions and modelId', () => {
		const adapter = new EmbeddingApi({
			apiBase: 'http://localhost:11434/v1',
			apiKey: '',
			model: 'bge-m3',
			dimensions: 1024,
		});
		expect(adapter.dimensions).toBe(1024);
		expect(adapter.modelId).toBe('api:bge-m3');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/adapters/embedding-api.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `src/adapters/embedding-api.ts`:

```typescript
import type { EmbeddingPort } from '../ports/embedding';

interface EmbeddingApiConfig {
	apiBase: string;
	apiKey: string;
	model: string;
	dimensions: number;
}

export class EmbeddingApi implements EmbeddingPort {
	readonly dimensions: number;
	readonly modelId: string;

	constructor(private config: EmbeddingApiConfig) {
		this.dimensions = config.dimensions;
		this.modelId = `api:${config.model}`;
	}

	async embed(texts: string[]): Promise<number[][]> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		};
		if (this.config.apiKey) {
			headers['Authorization'] = `Bearer ${this.config.apiKey}`;
		}

		const response = await fetch(`${this.config.apiBase}/embeddings`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				model: this.config.model,
				input: texts,
			}),
		});

		if (!response.ok) {
			throw new Error(`Embedding API error: ${response.status} ${response.statusText}`);
		}

		const data = await response.json() as {
			data: Array<{ embedding: number[]; index: number }>;
		};

		// Sort by index to ensure order matches input
		return data.data
			.sort((a, b) => a.index - b.index)
			.map((d) => d.embedding);
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/adapters/embedding-api.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/adapters/embedding-api.ts tests/adapters/embedding-api.test.ts
git commit -m "feat: add EmbeddingApi adapter for OpenAI-compatible embedding endpoints"
```

---

## Task 4: Embedding Local Adapter

**Files:**
- Create: `src/adapters/embedding-local.ts`
- Create: `tests/adapters/embedding-local.test.ts`

- [ ] **Step 1: Install @huggingface/transformers**

Run: `npm install -D @huggingface/transformers`

- [ ] **Step 2: Write failing test**

Create `tests/adapters/embedding-local.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { EmbeddingLocal } from '../../src/adapters/embedding-local';

// Mock @huggingface/transformers pipeline
vi.mock('@huggingface/transformers', () => ({
	pipeline: vi.fn().mockResolvedValue(
		vi.fn(async (texts: string[], options: Record<string, unknown>) => {
			// Return mock tensor-like object with tolist()
			const dims = 512;
			const batch = Array.isArray(texts) ? texts : [texts];
			const vectors = batch.map(() =>
				Array.from({ length: dims }, () => Math.random()),
			);
			return { tolist: () => vectors };
		}),
	),
}));

describe('EmbeddingLocal', () => {
	it('creates instance with correct defaults', () => {
		const adapter = new EmbeddingLocal();
		expect(adapter.modelId).toBe('local:Xenova/bge-small-zh-v1.5');
		expect(adapter.dimensions).toBe(512);
	});

	it('creates instance with custom model', () => {
		const adapter = new EmbeddingLocal('Xenova/bge-micro-v2', 384);
		expect(adapter.modelId).toBe('local:Xenova/bge-micro-v2');
		expect(adapter.dimensions).toBe(384);
	});

	it('embeds texts and returns number[][]', async () => {
		const adapter = new EmbeddingLocal();
		const result = await adapter.embed(['hello', 'world']);
		expect(result).toHaveLength(2);
		expect(result[0]).toHaveLength(512);
		expect(result[1]).toHaveLength(512);
	});

	it('initializes pipeline lazily on first embed call', async () => {
		const { pipeline } = await import('@huggingface/transformers');
		const adapter = new EmbeddingLocal();
		// Pipeline not called yet
		expect(pipeline).not.toHaveBeenCalled();
		await adapter.embed(['test']);
		// Pipeline called on first embed
		expect(pipeline).toHaveBeenCalledWith(
			'feature-extraction',
			'Xenova/bge-small-zh-v1.5',
			expect.objectContaining({ dtype: 'q8' }),
		);
	});

	it('reuses pipeline on subsequent calls', async () => {
		const adapter = new EmbeddingLocal();
		await adapter.embed(['first']);
		await adapter.embed(['second']);
		const { pipeline } = await import('@huggingface/transformers');
		// Pipeline only initialized once
		expect(pipeline).toHaveBeenCalledOnce();
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- tests/adapters/embedding-local.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Write implementation**

Create `src/adapters/embedding-local.ts`:

```typescript
import type { EmbeddingPort } from '../ports/embedding';

export class EmbeddingLocal implements EmbeddingPort {
	private extractor: ((texts: string[], options: Record<string, unknown>) => Promise<{ tolist: () => number[][] }>) | null = null;
	readonly modelId: string;
	readonly dimensions: number;

	constructor(modelId = 'Xenova/bge-small-zh-v1.5', dimensions = 512) {
		this.modelId = `local:${modelId}`;
		this.dimensions = dimensions;
	}

	private async init(): Promise<void> {
		if (this.extractor) return;

		const { pipeline } = await import('@huggingface/transformers');
		this.extractor = await pipeline('feature-extraction', this.modelId.replace('local:', ''), {
			dtype: 'q8',
			progress_callback: (progress: { status: string; progress?: number; file?: string }) => {
				if (progress.status === 'progress' && progress.progress !== undefined) {
					console.log(`Model download: ${progress.file} ${Math.round(progress.progress)}%`);
				}
			},
		}) as unknown as typeof this.extractor;
	}

	async embed(texts: string[]): Promise<number[][]> {
		await this.init();
		const output = await this.extractor!(texts, {
			pooling: 'mean',
			normalize: true,
		});
		return output.tolist();
	}
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/adapters/embedding-local.test.ts`
Expected: PASS (all 5 tests)

- [ ] **Step 6: Commit**

```bash
git add src/adapters/embedding-local.ts tests/adapters/embedding-local.test.ts package.json package-lock.json
git commit -m "feat: add EmbeddingLocal adapter with @huggingface/transformers ONNX"
```

---

## Task 5: Markdown Chunker

**Files:**
- Modify: `src/worker/chunker.ts`
- Create: `tests/worker/chunker.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/worker/chunker.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { chunkMarkdown } from '../../src/worker/chunker';

describe('chunkMarkdown', () => {
	it('returns empty array for empty input', () => {
		expect(chunkMarkdown('')).toEqual([]);
	});

	it('returns single chunk for short content', () => {
		const result = chunkMarkdown('Hello world', 500, 100);
		expect(result).toHaveLength(1);
		expect(result[0].text).toBe('Hello world');
		expect(result[0].index).toBe(0);
	});

	it('splits long content into multiple chunks', () => {
		const longText = 'Word '.repeat(200); // ~1000 chars
		const result = chunkMarkdown(longText, 100, 20);
		expect(result.length).toBeGreaterThan(1);
		// Each chunk should have an index
		result.forEach((chunk, i) => {
			expect(chunk.index).toBe(i);
		});
	});

	it('respects chunk size approximately', () => {
		const longText = 'A'.repeat(1000);
		const result = chunkMarkdown(longText, 300, 50);
		// First chunk should be ~300 chars (not exact due to word boundaries)
		expect(result[0].text.length).toBeLessThanOrEqual(350);
	});

	it('preserves heading boundaries', () => {
		const content = '# Section 1\nContent 1\n\n# Section 2\nContent 2';
		const result = chunkMarkdown(content, 500, 100);
		// Short enough to fit in one chunk
		expect(result).toHaveLength(1);
		expect(result[0].text).toContain('# Section 1');
		expect(result[0].text).toContain('# Section 2');
	});

	it('splits at heading boundaries when content is long', () => {
		const content = '# Section 1\n' + 'A'.repeat(400) + '\n\n# Section 2\n' + 'B'.repeat(400);
		const result = chunkMarkdown(content, 300, 50);
		expect(result.length).toBeGreaterThan(1);
		// At least one chunk should start with a heading
		expect(result.some((c) => c.text.startsWith('#'))).toBe(true);
	});

	it('sets startOffset and endOffset', () => {
		const result = chunkMarkdown('Hello world', 500, 100);
		expect(result[0].startOffset).toBe(0);
		expect(result[0].endOffset).toBeGreaterThan(0);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/worker/chunker.test.ts`
Expected: FAIL — chunkMarkdown returns empty array

- [ ] **Step 3: Write implementation**

Replace entire content of `src/worker/chunker.ts`:

```typescript
// Markdown chunker — splits Markdown into ~chunkSize char chunks with overlap
// Tries to split at heading boundaries first, then at paragraph boundaries

export interface Chunk {
	text: string;
	index: number;
	startOffset: number;
	endOffset: number;
}

/**
 * Split Markdown content into chunks.
 * Strategy: split at heading boundaries first, then paragraph boundaries,
 * then sentence boundaries if needed.
 */
export function chunkMarkdown(
	content: string,
	chunkSize = 500,
	overlap = 100,
): Chunk[] {
	if (!content.trim()) return [];

	// Split into sections by headings
	const sections = splitByHeadings(content);

	// Merge small sections and split large ones
	const chunks: Chunk[] = [];
	let currentText = '';
	let currentStart = 0;

	for (const section of sections) {
		if (currentText.length + section.text.length > chunkSize && currentText.length > 0) {
			// Current section would exceed chunk size — flush current chunk
			chunks.push({
				text: currentText.trim(),
				index: chunks.length,
				startOffset: currentStart,
				endOffset: currentStart + currentText.length,
			});

			// Start new chunk with overlap from previous
			const overlapText = getOverlapSuffix(currentText, overlap);
			currentText = overlapText + section.text;
			currentStart = section.startOffset - overlapText.length;
		} else {
			currentText += (currentText ? '\n\n' : '') + section.text;
			if (currentText === section.text) {
				currentStart = section.startOffset;
			}
		}

		// If current text is still too long, split further
		if (currentText.length > chunkSize * 1.5) {
			const subChunks = splitLongText(currentText, chunkSize, overlap);
			for (const sub of subChunks) {
				chunks.push({
					text: sub.trim(),
					index: chunks.length,
					startOffset: currentStart,
					endOffset: currentStart + sub.length,
				});
			}
			currentText = '';
		}
	}

	// Flush remaining
	if (currentText.trim()) {
		chunks.push({
			text: currentText.trim(),
			index: chunks.length,
			startOffset: currentStart,
			endOffset: currentStart + currentText.length,
		});
	}

	return chunks;
}

interface Section {
	text: string;
	startOffset: number;
}

function splitByHeadings(content: string): Section[] {
	const lines = content.split('\n');
	const sections: Section[] = [];
	let currentLines: string[] = [];
	let currentStart = 0;
	let charOffset = 0;

	for (const line of lines) {
		if (/^#{1,6}\s/.test(line) && currentLines.length > 0) {
			sections.push({
				text: currentLines.join('\n'),
				startOffset: currentStart,
			});
			currentStart = charOffset;
			currentLines = [line];
		} else {
			if (currentLines.length === 0) {
				currentStart = charOffset;
			}
			currentLines.push(line);
		}
		charOffset += line.length + 1; // +1 for \n
	}

	if (currentLines.length > 0) {
		sections.push({
			text: currentLines.join('\n'),
			startOffset: currentStart,
		});
	}

	return sections;
}

function splitLongText(text: string, chunkSize: number, overlap: number): string[] {
	const chunks: string[] = [];
	let remaining = text;

	while (remaining.length > 0) {
		if (remaining.length <= chunkSize) {
			chunks.push(remaining);
			break;
		}

		// Try to split at paragraph boundary
		let splitPoint = remaining.lastIndexOf('\n\n', chunkSize);
		if (splitPoint < chunkSize * 0.3) {
			// Try sentence boundary
			splitPoint = remaining.lastIndexOf('。', chunkSize);
			if (splitPoint < chunkSize * 0.3) {
				splitPoint = remaining.lastIndexOf('. ', chunkSize);
			}
			if (splitPoint < chunkSize * 0.3) {
				// Force split at chunkSize
				splitPoint = chunkSize;
			}
		}

		chunks.push(remaining.slice(0, splitPoint + 1));
		remaining = remaining.slice(Math.max(splitPoint + 1 - overlap, 1));
	}

	return chunks;
}

function getOverlapSuffix(text: string, overlapSize: number): string {
	if (overlapSize <= 0 || text.length <= overlapSize) return '';
	const suffix = text.slice(-overlapSize);
	// Start from the next sentence/paragraph boundary
	const newlineIdx = suffix.indexOf('\n');
	if (newlineIdx >= 0 && newlineIdx < suffix.length - 1) {
		return suffix.slice(newlineIdx + 1);
	}
	return suffix;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/worker/chunker.test.ts`
Expected: PASS (all 6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/worker/chunker.ts tests/worker/chunker.test.ts
git commit -m "feat: implement Markdown-aware chunker with heading/paragraph boundaries"
```

---

## Task 6: Settings Panel Update

**Files:**
- Modify: `src/settings.ts`

- [ ] **Step 1: Update RatelVaultSettings interface**

Replace the settings interface in `src/settings.ts`:

```typescript
export interface RatelVaultSettings {
	// Chat
	chatModel: string;
	chatApiKey: string;
	chatApiBase: string;

	// Embedding
	embedProvider: 'local' | 'api';
	embedLocalModel: string;
	embedApiBase: string;
	embedApiKey: string;
	embedApiModel: string;

	// Reranker (optional — auto-enabled when apiKey is set)
	rerankerProvider: 'cohere' | 'jina' | 'siliconflow' | 'custom';
	rerankerApiBase: string;
	rerankerApiKey: string;
	rerankerModel: string;

	// Indexing
	chunkSize: number;
	chunkOverlap: number;
	autoIndex: boolean;

	// Link Suggestions
	autoSuggestLinks: boolean;
	linkConfidenceThreshold: number;
}
```

- [ ] **Step 2: Update DEFAULT_SETTINGS**

Replace the defaults:

```typescript
export const DEFAULT_SETTINGS: RatelVaultSettings = {
	chatModel: 'deepseek-chat',
	chatApiKey: '',
	chatApiBase: 'https://api.deepseek.com',

	embedProvider: 'local',
	embedLocalModel: 'Xenova/bge-small-zh-v1.5',
	embedApiBase: 'http://localhost:11434/v1',
	embedApiKey: '',
	embedApiModel: 'bge-m3',

	rerankerProvider: 'cohere',
	rerankerApiBase: 'https://api.cohere.ai/v1',
	rerankerApiKey: '',
	rerankerModel: 'rerank-v3.5',

	chunkSize: 500,
	chunkOverlap: 100,
	autoIndex: true,

	autoSuggestLinks: true,
	linkConfidenceThreshold: 0.75,
};
```

- [ ] **Step 3: Update settings panel display method**

Replace the `display()` method body in `RatelVaultSettingTab`. Keep the Chat Model section, replace the Embedding Model section, add Reranker section, keep Indexing and Link Suggestions:

```typescript
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Chat Model
		containerEl.createEl('h2', { text: 'Chat Model' });

		new Setting(containerEl)
			.setName('Model')
			.setDesc('Chat model identifier')
			.addText((text) =>
				text
					.setPlaceholder('deepseek-chat')
					.setValue(this.plugin.settings.chatModel)
					.onChange(async (value) => {
						this.plugin.settings.chatModel = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('API Key')
			.setDesc('Chat model API key')
			.addText((text) => {
				text.inputEl.type = 'password';
				text
					.setPlaceholder('sk-...')
					.setValue(this.plugin.settings.chatApiKey)
					.onChange(async (value) => {
						this.plugin.settings.chatApiKey = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('API Base URL')
			.setDesc('Chat model API base URL')
			.addText((text) =>
				text
					.setPlaceholder('https://api.deepseek.com')
					.setValue(this.plugin.settings.chatApiBase)
					.onChange(async (value) => {
						this.plugin.settings.chatApiBase = value;
						await this.plugin.saveSettings();
					}),
			);

		// Embedding Model
		containerEl.createEl('h2', { text: 'Embedding Model' });

		new Setting(containerEl)
			.setName('Provider')
			.setDesc('Local uses built-in ONNX model (zero-config). API uses OpenAI-compatible endpoint (Ollama/SiliconFlow/etc).')
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({ local: 'Local (built-in)', api: 'API (external)' })
					.setValue(this.plugin.settings.embedProvider)
					.onChange(async (value: string) => {
						this.plugin.settings.embedProvider = value as 'local' | 'api';
						await this.plugin.saveSettings();
						this.display(); // Refresh to show/hide fields
					}),
			);

		if (this.plugin.settings.embedProvider === 'local') {
			new Setting(containerEl)
				.setName('Model')
				.setDesc('Local ONNX model identifier (from HuggingFace Xenova/ namespace)')
				.addText((text) =>
					text
						.setPlaceholder('Xenova/bge-small-zh-v1.5')
						.setValue(this.plugin.settings.embedLocalModel)
						.onChange(async (value) => {
							this.plugin.settings.embedLocalModel = value;
							await this.plugin.saveSettings();
						}),
				);
		} else {
			new Setting(containerEl)
				.setName('API Base URL')
				.setDesc('Embedding API base URL (Ollama: http://localhost:11434/v1)')
				.addText((text) =>
					text
						.setPlaceholder('http://localhost:11434/v1')
						.setValue(this.plugin.settings.embedApiBase)
						.onChange(async (value) => {
							this.plugin.settings.embedApiBase = value;
							await this.plugin.saveSettings();
						}),
				);

			new Setting(containerEl)
				.setName('API Key')
				.setDesc('Embedding API key (leave empty for Ollama)')
				.addText((text) => {
					text.inputEl.type = 'password';
					text
						.setPlaceholder('sk-...')
						.setValue(this.plugin.settings.embedApiKey)
						.onChange(async (value) => {
							this.plugin.settings.embedApiKey = value;
							await this.plugin.saveSettings();
						});
				});

			new Setting(containerEl)
				.setName('Model')
				.setDesc('Embedding model identifier')
				.addText((text) =>
					text
						.setPlaceholder('bge-m3')
						.setValue(this.plugin.settings.embedApiModel)
						.onChange(async (value) => {
							this.plugin.settings.embedApiModel = value;
							await this.plugin.saveSettings();
						}),
				);
		}

		// Reranker (optional — auto-enabled when API Key is provided)
		containerEl.createEl('h2', { text: 'Reranker (Optional)' });

		new Setting(containerEl)
			.setName('Provider')
			.setDesc('Reranker API provider. Auto-enabled when API Key is set.')
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						cohere: 'Cohere',
						jina: 'Jina',
						siliconflow: 'SiliconFlow',
						custom: 'Custom',
					})
					.setValue(this.plugin.settings.rerankerProvider)
					.onChange(async (value: string) => {
						this.plugin.settings.rerankerProvider = value as RatelVaultSettings['rerankerProvider'];
						// Auto-fill API base for known providers
						const bases: Record<string, string> = {
							cohere: 'https://api.cohere.ai/v1',
							jina: 'https://api.jina.ai/v1',
							siliconflow: 'https://api.siliconflow.cn/v1',
						};
						if (bases[value]) {
							this.plugin.settings.rerankerApiBase = bases[value];
						}
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		new Setting(containerEl)
			.setName('API Base URL')
			.setDesc('Reranker API base URL')
			.addText((text) =>
				text
					.setValue(this.plugin.settings.rerankerApiBase)
					.onChange(async (value) => {
						this.plugin.settings.rerankerApiBase = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('API Key')
			.setDesc('Reranker API key. Leave empty to disable reranking.')
			.addText((text) => {
				text.inputEl.type = 'password';
				text
					.setValue(this.plugin.settings.rerankerApiKey)
					.onChange(async (value) => {
						this.plugin.settings.rerankerApiKey = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Model')
			.setDesc('Reranker model identifier')
			.addText((text) =>
				text
					.setValue(this.plugin.settings.rerankerModel)
					.onChange(async (value) => {
						this.plugin.settings.rerankerModel = value;
						await this.plugin.saveSettings();
					}),
			);

		// Indexing
		containerEl.createEl('h2', { text: 'Indexing' });

		new Setting(containerEl)
			.setName('Chunk size (tokens)')
			.setDesc('Number of tokens per chunk')
			.addSlider((slider) =>
				slider
					.setLimits(100, 1000, 50)
					.setValue(this.plugin.settings.chunkSize)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.chunkSize = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Chunk overlap (tokens)')
			.setDesc('Overlap between chunks')
			.addSlider((slider) =>
				slider
					.setLimits(0, 200, 10)
					.setValue(this.plugin.settings.chunkOverlap)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.chunkOverlap = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Auto index')
			.setDesc('Automatically re-index on file changes')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoIndex)
					.onChange(async (value) => {
						this.plugin.settings.autoIndex = value;
						await this.plugin.saveSettings();
					}),
			);

		// Link Suggestions
		containerEl.createEl('h2', { text: 'Link Suggestions' });

		new Setting(containerEl)
			.setName('Auto suggest links')
			.setDesc('Automatically suggest links after writing')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoSuggestLinks)
					.onChange(async (value) => {
						this.plugin.settings.autoSuggestLinks = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Confidence threshold')
			.setDesc('Minimum similarity to suggest a link')
			.addSlider((slider) =>
				slider
					.setLimits(0.5, 1.0, 0.05)
					.setValue(this.plugin.settings.linkConfidenceThreshold)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.linkConfidenceThreshold = value;
						await this.plugin.saveSettings();
					}),
			);
	}
```

- [ ] **Step 4: Verify build passes**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add src/settings.ts
git commit -m "feat: update settings with Embedding Provider + Reranker config"
```

---

## Task 7: Wire Embedding into main.ts

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Add EmbeddingPort import and initialization**

In `src/main.ts`, add imports after existing imports:

```typescript
import type { EmbeddingPort } from './ports/embedding';
import { EmbeddingLocal } from './adapters/embedding-local';
import { EmbeddingApi } from './adapters/embedding-api';
```

Add `embedding` field to the plugin class:

```typescript
export default class RatelVaultPlugin extends Plugin {
	settings!: RatelVaultSettings;
	vault!: ObsidianVault;
	persistence!: PersistenceJson;
	llm!: DeepSeekLLM;
	embedding!: EmbeddingPort;
	tools!: ToolRegistry;
	hooks!: HookRegistry;
	workerManager!: WorkerManager;
```

Add embedding initialization after LLM initialization in `onload()`:

```typescript
		// Initialize embedding adapter
		if (this.settings.embedProvider === 'local') {
			this.embedding = new EmbeddingLocal(
				this.settings.embedLocalModel,
				512, // bge-small-zh dimensions
			);
		} else {
			this.embedding = new EmbeddingApi({
				apiBase: this.settings.embedApiBase,
				apiKey: this.settings.embedApiKey,
				model: this.settings.embedApiModel,
				dimensions: 1024, // bge-m3 dimensions
			});
		}
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
git commit -m "feat: wire EmbeddingPort into plugin based on settings"
```

---

## Task 8: vectra VectorStore Adapter

**Files:**
- Modify: `src/adapters/vector-vectra.ts`
- Create: `tests/adapters/vector-vectra.test.ts`

- [ ] **Step 1: Install vectra**

Run: `npm install vectra`

- [ ] **Step 2: Write failing test**

Create `tests/adapters/vector-vectra.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { VectraStore } from '../../src/adapters/vector-vectra';
import path from 'path';
import fs from 'fs';

const TEST_INDEX_DIR = path.join(__dirname, '../tmp/test-vectra-index');

describe('VectraStore', () => {
	let store: VectraStore;

	beforeAll(() => {
		// Clean up any previous test index
		if (fs.existsSync(TEST_INDEX_DIR)) {
			fs.rmSync(TEST_INDEX_DIR, { recursive: true });
		}
		store = new VectraStore(TEST_INDEX_DIR);
	});

	afterAll(() => {
		// Clean up test index
		if (fs.existsSync(TEST_INDEX_DIR)) {
			fs.rmSync(TEST_INDEX_DIR, { recursive: true });
		}
	});

	it('starts with empty status', async () => {
		const status = await store.status();
		expect(status.totalDocs).toBe(0);
	});

	it('upserts and searches documents', async () => {
		await store.upsert('doc1', 'Hello world', { path: 'notes/test.md' });

		// Search with a dummy vector (same dimensions as we'll use in production)
		const queryVector = Array(512).fill(0).map(() => Math.random());
		const results = await store.search(queryVector, 5);
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].docId).toBe('doc1');
	});

	it('deletes documents', async () => {
		await store.upsert('doc2', 'To be deleted', { path: 'notes/del.md' });
		const count = await store.delete(['doc2']);
		expect(count).toBe(1);
	});

	it('returns updated status after operations', async () => {
		const status = await store.status();
		expect(status.totalDocs).toBeGreaterThan(0);
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- tests/adapters/vector-vectra.test.ts`
Expected: FAIL — VectraStore not implemented

- [ ] **Step 4: Write implementation**

Replace entire content of `src/adapters/vector-vectra.ts`:

```typescript
import type { VectorStore, VectorSearchResult, IndexStatus } from '../ports/vector';
import { LocalDocumentIndex } from 'vectra';

export class VectraStore implements VectorStore {
	private index: LocalDocumentIndex | null = null;
	private indexDir: string;

	constructor(indexDir: string) {
		this.indexDir = indexDir;
	}

	private async ensureIndex(): Promise<LocalDocumentIndex> {
		if (!this.index) {
			this.index = new LocalDocumentIndex({
				folderPath: this.indexDir,
			});
			await this.index.initialize();
		}
		return this.index;
	}

	async upsert(docId: string, text: string, metadata?: Record<string, unknown>): Promise<void> {
		const index = await this.ensureIndex();
		// Check if document already exists
		const existing = await index.getDocument(docId);
		if (existing) {
			await index.deleteDocument(docId);
		}
		await index.addDocument(docId, text, metadata ?? {});
	}

	async search(queryVector: number[], topK: number, filter?: import('../ports/vector').SearchFilter): Promise<VectorSearchResult[]> {
		const index = await this.ensureIndex();
		const results = await index.queryDocuments(queryVector, topK);

		return results.map((r) => ({
			docId: r.document.id,
			score: r.score,
			metadata: r.document.metadata as Record<string, unknown>,
		}));
	}

	async delete(docIds: string[]): Promise<number> {
		const index = await this.ensureIndex();
		let count = 0;
		for (const id of docIds) {
			try {
				await index.deleteDocument(id);
				count++;
			} catch {
				// Document may not exist
			}
		}
		return count;
	}

	async status(): Promise<IndexStatus> {
		try {
			const index = await this.ensureIndex();
			const stats = await index.getIndexStats();
			return {
				totalDocs: stats?.totalDocuments ?? 0,
				lastIndexTime: Date.now(),
				isIndexing: false,
			};
		} catch {
			return {
				totalDocs: 0,
				lastIndexTime: 0,
				isIndexing: false,
			};
		}
	}
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/adapters/vector-vectra.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/adapters/vector-vectra.ts tests/adapters/vector-vectra.test.ts package.json package-lock.json
git commit -m "feat: implement VectraStore adapter with vectra LocalDocumentIndex"
```

---

## Self-Review

### 1. Spec Coverage

| Spec Requirement | Task |
|---|---|
| EmbeddingPort interface | Task 1 |
| Remove embed() from LLMClient | Task 2 |
| EmbeddingApi adapter (OpenAI-compatible) | Task 3 |
| EmbeddingLocal adapter (@huggingface/transformers) | Task 4 |
| Markdown chunker | Task 5 |
| Settings: Embedding Provider + Reranker | Task 6 |
| Wire EmbeddingPort into main.ts | Task 7 |
| VectraStore adapter | Task 8 |

**Gaps:** RerankerPort interface and adapter are W4+ per spec, not included in W2 plan. search_vault tool is W3.

### 2. Placeholder Scan

- No TBD/TODO found
- All implementation code is complete
- All test code is complete

### 3. Type Consistency

| Type | Defined In | Used In | Consistent |
|---|---|---|---|
| `EmbeddingPort` | `ports/embedding.ts` | `embedding-api.ts`, `embedding-local.ts`, `main.ts` | Yes |
| `EmbeddingApiConfig` | `adapters/embedding-api.ts` | constructor | Yes |
| `Chunk` | `worker/chunker.ts` | test | Yes |
| `VectorStore` | `ports/vector.ts` | `vector-vectra.ts` | Yes |
| `RatelVaultSettings.embedProvider` | `settings.ts` | `main.ts` | Yes — `'local' \| 'api'` |

All types consistent.
