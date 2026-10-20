# 检索质量实现计划

> **给执行者:** 建议按 subagent-driven-development 逐任务执行；也可用 executing-plans 批量推进。步骤用 `- [ ]` 勾选跟踪。

**Goal:** 让分块按 token 预算并真正使用用户设置、块携带结构前缀，同时让精排可选专用模型或对话模型。

**Architecture:** 分块层引入可注入的 token 计数器（本地词表精确计数、API 模型按字符上界估算），chunker 按预算切分并对每个块生成「前缀 + 正文」的嵌入输入；精排层保留 `RerankerPort`，新增基于对话模型的实现，在 `main.ts` 按模式装配，检索链路不变。

**Tech Stack:** TypeScript、vitest、Obsidian 插件（无原生模块）、vectra、onnxruntime-web、现有 `LLMClient` 流式接口。

---

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `src/core/token-counter.ts` | 文本 → token 数的唯一入口；精确或估算 | 新增 |
| `src/worker/chunker.ts` | 按 token 预算切分，产出 `text` / `embedText` / 偏移 / 标题路径 | 修改 |
| `src/worker/index-processor.ts` | 用真实参数调用 chunker，嵌入 `embedText` | 修改 |
| `src/worker/handler.ts` | `index.*` 消息透传分块参数 | 修改 |
| `src/types.ts` | 消息 payload 字段 | 修改 |
| `src/core/index-manifest.ts` | `chunkerVersion` 参与重建判定 | 修改 |
| `src/adapters/reranker-llm.ts` | 对话模型精排适配器 | 新增 |
| `src/core/rerank-mode.ts` | 开关 + 来源 → 实际生效来源 | 新增 |
| `src/core/multi-query-searcher.ts` | 候选 ≤3 时跳过精排 | 修改 |
| `src/settings.ts` | `rerankMode` 与默认值 | 修改 |
| `src/core/model-manager.ts` | 暴露 `getVocabContent()` | 修改 |
| `src/main.ts` | 装配 token 计数器、分块参数与 reranker | 修改 |
| `src/i18n/zh.ts` / `en.ts` | 设置项、模式、成本与外发说明 | 修改 |

---

## Task 1: token 计数器

**Files:**
- Create: `src/core/token-counter.ts`
- Test: `tests/core/token-counter.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { createTokenCounter } from '../../src/core/token-counter';

// 极简词表:[PAD] [UNK] [CLS] [SEP] 我 们 你 好
const VOCAB = '[PAD]\n[UNK]\n[CLS]\n[SEP]\n我\n们\n你\n好\n';

describe('createTokenCounter', () => {
	it('有词表 - 精确计数 - 按 tokenize 结果', () => {
		const c = createTokenCounter(VOCAB);
		expect(c.exact).toBe(true);
		expect(c.count('我们')).toBe(2);
		expect(c.count('')).toBe(0);
	});

	it('无词表 - 估算 - 按字符数取上界', () => {
		const c = createTokenCounter(null);
		expect(c.exact).toBe(false);
		expect(c.count('我们')).toBe(2);
		expect(c.count('hello')).toBe(5);
	});

	it('maxInputTokens 默认 512 且可覆盖', () => {
		expect(createTokenCounter(null).maxInputTokens).toBe(512);
		expect(createTokenCounter(null, 1024).maxInputTokens).toBe(1024);
	});
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/core/token-counter.test.ts`
Expected: FAIL，`Cannot find module '../../src/core/token-counter'`

- [ ] **Step 3: 实现**

```ts
/**
 * @file src/core/token-counter.ts
 * @description 文本 token 计数 — 本地词表精确计数，缺词表时按字符上界估算。
 * @module core/token-counter
 */

import { createTokenizer, parseVocab } from '../adapters/bert-tokenizer';

export interface TokenCounter {
	/** true = 词表精确计数；false = 字符上界估算。 */
	readonly exact: boolean;
	/** 模型输入上限（token，含特殊 token）。 */
	readonly maxInputTokens: number;
	/** 单条文本的内容 token 数（不含 [CLS]/[SEP]）。 */
	count(text: string): number;
}

/**
 * 构造计数器。
 *
 * 关键路径：估算方向必须是「高估」——高估只会让块更小，
 * 低估会让块超出模型上限并被静默截断。
 *
 * @param vocabContent - vocab.txt 文本；为空表示没有本地词表（如 API embedding）。
 * @param maxInputTokens - 模型输入上限，默认 bge-small 的 512。
 */
export function createTokenCounter(
	vocabContent: string | null,
	maxInputTokens = 512,
): TokenCounter {
	if (!vocabContent) {
		return { exact: false, maxInputTokens, count: (text) => text.length };
	}
	const tokenizer = createTokenizer(parseVocab(vocabContent));
	return {
		exact: true,
		maxInputTokens,
		count: (text) => tokenizer.tokenize(text).length,
	};
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/core/token-counter.test.ts`
Expected: PASS（3 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/core/token-counter.ts tests/core/token-counter.test.ts
git commit -m "feat: 新增 token 计数器，本地词表精确、API 按字符上界估算"
```

---

## Task 2: chunker 按 token 预算切分并带结构前缀

**Files:**
- Modify: `src/worker/chunker.ts`
- Test: `tests/worker/chunker.test.ts`

- [ ] **Step 1: 写失败测试（追加到现有文件）**

```ts
it('按 token 预算切分 - 任何块都不超过 maxTokens', () => {
	const count = (t: string) => t.length; // 1 字符 = 1 token
	const chunks = chunkMarkdown('一二三四五六七八九十'.repeat(20), {
		maxTokens: 40,
		overlapTokens: 0,
		count,
	});
	expect(chunks.length).toBeGreaterThan(1);
	for (const c of chunks) expect(count(c.text)).toBeLessThanOrEqual(40);
});

it('结构前缀 - 只进 embedText，不进 text 与偏移', () => {
	const chunks = chunkMarkdown('# 项目\n\n预算说明', {
		maxTokens: 100,
		overlapTokens: 0,
		count: (t) => t.length,
		docTitle: '项目汇报',
	});
	const c = chunks[0]!;
	expect(c.prefix).toBe('项目汇报 › 项目 › ');
	expect(c.embedText.startsWith('项目汇报 › 项目 › ')).toBe(true);
	expect(c.text.includes('项目汇报')).toBe(false);
	expect(c.startOffset).toBe(0);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/worker/chunker.test.ts`
Expected: FAIL，`chunkMarkdown` 第二个参数类型不匹配

- [ ] **Step 3: 改类型与签名**

```ts
export interface Chunk {
	/** 正文（不含前缀）——用于精确检索与返回。 */
	text: string;
	/** 嵌入输入 = prefix + text。 */
	embedText: string;
	index: number;
	startOffset: number;
	endOffset: number;
	/** 结构前缀（文件/标题路径），无前缀时为空串。 */
	prefix: string;
	/** 所属标题路径，供上层扩展页号与表头。 */
	headingPath: string[];
}

export interface ChunkOptions {
	/** 单块总预算（含结构前缀）。 */
	maxTokens: number;
	overlapTokens: number;
	count: (text: string) => number;
	/** 文档标题，与标题路径一起拼结构前缀。 */
	docTitle?: string;
}

export function chunkMarkdown(content: string, opts: ChunkOptions): Chunk[] {
	const { maxTokens, overlapTokens, count, docTitle } = opts;

	// 关键路径：前缀逐块不同（取决于所在标题层级），因此预算也要逐块算。
	const prefixOf = (headingPath: string[]): string => {
		const parts = [docTitle, ...headingPath].filter((x): x is string => !!x && x.length > 0);
		return parts.length > 0 ? parts.join(' › ') + ' › ' : '';
	};

	// …以下沿用现有三级回退逻辑，把字符比较换成 count() 比较…
}
```

- [ ] **Step 4: 改切分循环**

把现有的 `currentText.length + section.text.length > chunkSize` 换成：

```ts
const fits = (text: string) => count(text) <= maxTokens;
const join = (a: string, b: string) => (a ? `${a}\n\n${b}` : b);

const budgetOf = (headingPath: string[]) => maxTokens - count(prefixOf(headingPath));
const fits = (text: string, budget: number) => count(text) <= budget;

if (currentText && !fits(join(currentText, section.text), budgetOf(section.headingPath))) {
	flush(currentText);
	const overlapText = takeOverlapSuffix(currentText, overlapTokens, count);
	currentText = join(overlapText, section.text);
	currentStart = Math.max(0, section.startOffset - overlapText.length);
} else {
	currentText = join(currentText, section.text);
	if (!currentStart) currentStart = section.startOffset;
}
```

`flush` 产出块时同时写三个字段：

```ts
const prefix = prefixOf(currentHeadingPath);
chunks.push({
	text: text.trim(),
	embedText: prefix + text.trim(),
	prefix,
	headingPath: currentHeadingPath,
	index: chunks.length,
	startOffset,
	endOffset: startOffset + text.length,
});
```

- [ ] **Step 5: overlap 改为按 token 取尾**

现有 `getOverlapSuffix(text, overlapSize)` 按字符截断，单位变了必须换掉：

```ts
/** 取文本末尾不超过 budgetTokens 的最长后缀，尽量从换行后开始。 */
function takeOverlapSuffix(text: string, budgetTokens: number, count: (t: string) => number): string {
	if (budgetTokens <= 0 || text.length === 0) return '';
	let start = text.length;
	// 从尾部逐字符左移，直到再加一个就超预算
	while (start > 0 && count(text.slice(start - 1)) <= budgetTokens) start--;
	const suffix = text.slice(start);
	const nl = suffix.indexOf('\n');
	return nl >= 0 && nl < suffix.length - 1 ? suffix.slice(nl + 1) : suffix;
}
```

- [ ] **Step 6: 标题路径**

`splitByHeadings` 维护标题栈，section 带 `headingPath: string[]`；进入新标题时按层级截断栈再压入。

- [ ] **Step 7: 更新既有用例**

现有用例的 `chunkMarkdown(content, 500, 100)` 改为：

```ts
chunkMarkdown(content, { maxTokens: 500, overlapTokens: 100, count: (t) => t.length })
```

预期断言（块数量与合并行为）保持不变。

- [ ] **Step 8: 运行确认通过**

Run: `npx vitest run tests/worker/chunker.test.ts`
Expected: PASS（原有 + 新增用例全绿）

- [ ] **Step 9: 提交**

```bash
git add src/worker/chunker.ts tests/worker/chunker.test.ts
git commit -m "feat: 分块改按 token 预算切分，块携带结构前缀与嵌入文本"
```

---

## Task 3: 分块参数与计数器贯通到索引

**Files:**
- Modify: `src/worker/index-processor.ts`、`src/worker/handler.ts`、`src/types.ts`、`src/main.ts`、`src/core/model-manager.ts`
- 注意：`handler.ts` 有**两处** `new IndexProcessor(store, embeddingPort)`（`initProcessor` 与 `initProcessorWithStore`），都要补第三个参数

- [ ] **Step 1: 写失败测试（`tests/worker/index-processor.test.ts`）**

```ts
it('indexIncremental - 使用构造时传入的 chunkSize 而不是硬编码 500', async () => {
	const store = createFakeStore();
	const processor = new IndexProcessor(store, embeddings, {
		maxTokens: 20,
		overlapTokens: 0,
		count: (t) => t.length,
	});
	const content = '一'.repeat(100);
	await processor.indexIncremental({ path: 'a.md', content });
	const upserted = store.upsertItemIds.length;
	expect(upserted).toBeGreaterThan(1); // 100 字符 / 20 token 预算 → 多块
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/worker/index-processor.test.ts`
Expected: FAIL，`IndexProcessor` 构造参数数量不符

- [ ] **Step 3: 改 IndexProcessor**

```ts
export class IndexProcessor {
	constructor(
		public store: VectraStore,
		private embeddings: EmbeddingPort,
		private chunkOptions: ChunkOptions,
	) {}

	private chunk(content: string): Chunk[] {
		return chunkMarkdown(content, this.chunkOptions);
	}
}
```

三处 `chunkMarkdown(file.content, 500, 100)` 统一改为 `this.chunk(file.content)`；嵌入用 `chunks.map((c) => c.embedText)`，写入 metadata 时附 `prefix` 与 `headingPath`：

```ts
await this.store.upsertItem(`${file.path}#chunk-${idx}`, vectors[idx]!, {
	path: file.path,
	chunkIndex: idx,
	startOffset: chunk.startOffset,
	headingPath: chunk.headingPath,
});
```

- [ ] **Step 4: 改消息与装配**

`src/types.ts` 的 `index.full / index.incremental / index.batch` payload 增加 `chunkOptions: { maxTokens: number; overlapTokens: number }`。

**词表如何到 Worker**：`ChunkOptions.count` 是函数，不能过 postMessage。因此把 `vocabContent`（字符串，约 109KB）通过 `initProcessor(store, embeddingPort, vocabContent)` 在初始化时传一次，`handler` 内部持有并构造 `createTokenCounter`。不要按消息传，增量索引每文件传 109KB 是浪费。

`main.ts` 从 settings 组装：

```ts
const counter = createTokenCounter(this.vocabContent, 512);
const chunkOptions = {
	maxTokens: Math.min(this.settings.chunkSize, counter.maxInputTokens - 64),
	overlapTokens: this.settings.chunkOverlap,
	count: (t: string) => counter.count(t),
};
```

`vocabContent` 当前拿不到：`ModelManager` 只在初始化时本地读一次 `vocab.txt`，没有对外暴露。需要新增 `ModelManager.getVocabContent(): string | null`（就绪后返回缓存串）。API embedding 或模型未就绪时返回 `null`，走估算。

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run tests/worker tests/core`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/worker/index-processor.ts src/worker/handler.ts src/types.ts src/main.ts tests/worker/index-processor.test.ts
git commit -m "feat: 分块参数从设置贯通到索引，嵌入改用带前缀文本"
```

---

## Task 4: chunkerVersion 触发重建

**Files:**
- Modify: `src/core/index-manifest.ts`、`src/main.ts`

- [ ] **Step 1: 写失败测试**

```ts
it('shouldFullRebuild - chunkerVersion 变化 - 返回 true', () => {
	const m = new IndexManifest('/tmp/x.json');
	const data = { version: 1, embedModelId: 'a', chunkSize: 500, chunkOverlap: 100, chunkerVersion: 2, lastIndexTime: 0, entries: {} };
	expect(m.shouldFullRebuild(data, 'a', 500, 100, 2)).toBe(false);
	expect(m.shouldFullRebuild(data, 'a', 500, 100, 3)).toBe(true);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/core/index-manifest.test.ts`
Expected: FAIL，参数数量不符

- [ ] **Step 3: 改清单**

`IndexManifestData` 增加 `chunkerVersion: number`；`shouldFullRebuild(data, modelId, chunkSize, chunkOverlap, chunkerVersion)` 增加最后一项比较。常量 `CURRENT_CHUNKER_VERSION = 1` 放在同文件导出（旧清单没有该字段，`undefined !== 1` 即触发一次重建）。`main.ts` 两处构造 manifest 时写入该常量，判定时传入。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/core/index-manifest.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/index-manifest.ts src/main.ts tests/core/index-manifest.test.ts
git commit -m "feat: 清单记录 chunkerVersion，分块规则变化触发全量重建"
```

---

## Task 5: 对话模型精排适配器

**Files:**
- Create: `src/adapters/reranker-llm.ts`
- Test: `tests/adapters/reranker-llm.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
it('rerank - 解析模型返回的 JSON 数组', async () => {
	const llm = fakeLlm('[{"id":"a","score":0.9},{"id":"b","score":0.4}]');
	const r = new LlmReranker({ llm, maxCandidates: 12, maxCharsPerDoc: 400 });
	const out = await r.rerank('q', [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], 2);
	expect(out.map((x) => x.id)).toEqual(['a', 'b']);
});

it('rerank - 非法 JSON - 抛错交由调用方降级', async () => {
	const llm = fakeLlm('不是 json');
	const r = new LlmReranker({ llm, maxCandidates: 12, maxCharsPerDoc: 400 });
	await expect(r.rerank('q', [{ id: 'a', text: 'A' }], 1)).rejects.toThrow();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/adapters/reranker-llm.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

```ts
/**
 * @file src/adapters/reranker-llm.ts
 * @description 用当前对话模型做精排 — 产出与专用 rerank 模型同构的 { id, score }。
 */
import type { LLMClient } from '../ports/llm';
import type { RerankerPort } from '../ports/reranker';

export interface LlmRerankerOptions {
	llm: LLMClient;
	/** 最多送多少条候选。 */
	maxCandidates: number;
	/** 单条正文最多截取多少字符。 */
	maxCharsPerDoc: number;
}

export class LlmReranker implements RerankerPort {
	constructor(private options: LlmRerankerOptions) {}

	async rerank(
		query: string,
		documents: Array<{ id: string; text: string }>,
		topK: number,
	): Promise<Array<{ id: string; score: number }>> {
		const candidates = documents.slice(0, this.options.maxCandidates);
		if (candidates.length === 0) return [];

		const list = candidates
			.map((d, i) => `[${i + 1}] id=${d.id}\n${d.text.slice(0, this.options.maxCharsPerDoc)}`)
			.join('\n\n');

		const messages = [
			{
				role: 'system' as const,
				content:
					'你是检索精排器。按与查询的相关性给候选打分，0 到 1，越高越相关。' +
					'只输出 JSON 数组，形如 [{"id":"…","score":0.87}]，不要解释，不要代码块。',
			},
			{ role: 'user' as const, content: `查询：${query}\n\n候选：\n${list}` },
		];

		let output = '';
		for await (const delta of this.options.llm.chat({ messages, options: { maxTokens: 400 } })) {
			if (delta.text) output += delta.text;
		}

		// 关键路径：模型可能裹代码块或加解释，只取最外层数组。
		const start = output.indexOf('[');
		const end = output.lastIndexOf(']');
		if (start < 0 || end <= start) throw new Error('rerank: 无法解析模型输出');

		const parsed: unknown = JSON.parse(output.slice(start, end + 1));
		if (!Array.isArray(parsed)) throw new Error('rerank: 输出不是数组');

		const known = new Set(candidates.map((d) => d.id));
		const scored = parsed
			.filter((x): x is { id: string; score: number } =>
				typeof x === 'object' && x !== null
				&& typeof (x as { id?: unknown }).id === 'string'
				&& typeof (x as { score?: unknown }).score === 'number',
			)
			.filter((x) => known.has(x.id))
			.map((x) => ({ id: x.id, score: x.score }));

		if (scored.length === 0) throw new Error('rerank: 没有可用的打分结果');

		return scored.sort((a, b) => b.score - a.score).slice(0, topK);
	}
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/adapters/reranker-llm.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/adapters/reranker-llm.ts tests/adapters/reranker-llm.test.ts
git commit -m "feat: 新增对话模型精排适配器，输出与专用 rerank 同构"
```

---

## Task 6: 精排开关、来源与短路

**Files:**
- Create: `src/core/rerank-mode.ts`
- Modify: `src/settings.ts`、`src/main.ts`、`src/core/multi-query-searcher.ts`、`src/i18n/zh.ts`、`src/i18n/en.ts`、`src/ui/chat/model-info-modal.ts`
- Test: `tests/core/rerank-mode.test.ts`、`tests/core/multi-query-searcher.test.ts`

- [ ] **Step 1: 写失败测试（`tests/core/rerank-mode.test.ts`）**

```ts
import { describe, it, expect } from 'vitest';
import { resolveRerankMode } from '../../src/core/rerank-mode';

describe('resolveRerankMode', () => {
	const cap = (native: boolean, llm: boolean) => ({ hasNativeKey: native, hasLlm: llm });

	it('开关关闭 - 任意来源都不精排', () => {
		expect(resolveRerankMode(false, 'native', cap(true, true))).toBe('off');
		expect(resolveRerankMode(false, 'llm', cap(true, true))).toBe('off');
	});

	it('默认来源 native - 有密钥生效', () => {
		expect(resolveRerankMode(true, 'native', cap(true, false))).toBe('native');
	});

	it('native 无密钥 - 关闭，且不回落对话模型', () => {
		expect(resolveRerankMode(true, 'native', cap(false, true))).toBe('off');
	});

	it('llm - 对话模型可用时替代专用模型', () => {
		expect(resolveRerankMode(true, 'llm', cap(true, true))).toBe('llm');
	});

	it('llm 不可用 - 关闭', () => {
		expect(resolveRerankMode(true, 'llm', cap(true, false))).toBe('off');
	});
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/core/rerank-mode.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现模式解析**

```ts
/**
 * @file src/core/rerank-mode.ts
 * @description 精排开关与来源 → 实际生效来源。
 */
export type RerankSource = 'native' | 'llm';
export type EffectiveRerank = 'off' | 'native' | 'llm';

/**
 * 解析实际生效的精排来源。
 *
 * 关键路径：两种来源互斥——选定 llm 即替代 native，不叠加、不回落。
 * 缺能力时返回 off，由界面如实说明原因，不悄悄换一条更贵的路径。
 */
export function resolveRerankMode(
	enabled: boolean,
	source: RerankSource,
	cap: { hasNativeKey: boolean; hasLlm: boolean },
): EffectiveRerank {
	if (!enabled) return 'off';
	if (source === 'llm') return cap.hasLlm ? 'llm' : 'off';
	return cap.hasNativeKey ? 'native' : 'off';
}
```

- [ ] **Step 4: 写短路测试（`tests/core/multi-query-searcher.test.ts`）**

```ts
it('search - 候选 ≤3 条 - 不调用精排且不读全文', async () => {
	const embedding = createMockEmbedding();
	const worker = createMockWorkerManager([[
		{ docId: 'a.md#chunk-0', score: 0.9, metadata: { path: 'a.md', chunkIndex: 0 } },
		{ docId: 'b.md#chunk-0', score: 0.8, metadata: { path: 'b.md', chunkIndex: 0 } },
		{ docId: 'c.md#chunk-0', score: 0.7, metadata: { path: 'c.md', chunkIndex: 0 } },
	]]);
	// 关键路径：必须是 vi.fn，否则无法断言「没读过全文」
	const readFile = vi.fn(async () => 'content');
	const vault = createMockVault(readFile);
	const reranker = { rerank: vi.fn(async () => []) };

	const searcher = new MultiQuerySearcher({ embedding, workerManager: worker, vault, reranker });
	const results = await searcher.search('查询', 5);

	expect(reranker.rerank).not.toHaveBeenCalled();
	expect(readFile).not.toHaveBeenCalled();
	expect(results.every((r) => r.reranked === false)).toBe(true);
});
```

- [ ] **Step 5: 实现短路**

`src/core/multi-query-searcher.ts` 顶部加常量，并把 Step 4 的守卫加在**读全文之前**：

```ts
/** 候选不超过 3 条就不精排：结果本来就少，排序收益接近零。 */
const MIN_RERANK_CANDIDATES = 4;

// --- Step 4: 可选 Rerank 精排（候选不足时直接跳过，连全文都不读）---
if (this.deps.reranker && finalResults.length >= MIN_RERANK_CANDIDATES) {
	// …现有精排逻辑不变…
} else {
	finalResults = finalResults.map((r) => ({ ...r, reranked: false }));
}
```

注意：现有用例「reranker 存在但所有文档缺 metadata.path」只有 **2 条**结果，加了短路后会直接跳过精排、测不到原意。执行时必须先把它补到 4 条以上（每条都缺 `metadata.path`），再验证 `reranked=false`。

- [ ] **Step 6: 接入设置与装配**

`settings.ts` 增加两个字段：

```ts
/** 是否启用检索精排，默认开。 */
rerankEnabled: boolean;
/** 精排来源：专用模型（默认）或对话模型，两者互斥。 */
rerankSource: 'native' | 'llm';
```

默认值 `rerankEnabled: true`、`rerankSource: 'native'`。设置页给「启用精排」开关 + 「精排来源」下拉，旁注「专用模型会把候选内容发送到该地址；对话模型沿用当前供应商，不新增外发目的地」。

`main.ts` 替换现有装配：

```ts
const effective = resolveRerankMode(this.settings.rerankEnabled, this.settings.rerankSource, {
	hasNativeKey: hasRerankApiKey(this.app),
	hasLlm: hasChatApiKey(this.app, this.settings),
});
const reranker =
	effective === 'native'
		? new BailianReranker({
				apiBase: this.settings.rerankerApiBase,
				apiKey: resolveRerankApiKey(this.app) ?? '',
				model: this.settings.rerankerModel,
			})
		: effective === 'llm'
			? new LlmReranker({ llm: this.llm, maxCandidates: 12, maxCharsPerDoc: 400 })
			: undefined;
```

`hasLlm` 必须用 `hasChatApiKey(app, settings)` 判断——`this.llm` 在启动时**总是**被构造，用 `!!this.llm` 会永远为真。

- [ ] **Step 7: 更新提示文案**

`model-info-modal.ts` 的「已配置(百炼)/未配置」改为显示实际生效来源（未启用 / 专用模型 / 对话模型）；i18n 中英同步。

- [ ] **Step 8: 运行确认通过**

Run: `npx vitest run tests/core/rerank-mode.test.ts tests/core/multi-query-searcher.test.ts tests/ui`
Expected: PASS

- [ ] **Step 9: 提交**

```bash
git add src/core/rerank-mode.ts src/settings.ts src/main.ts src/core/multi-query-searcher.ts src/i18n src/ui/chat/model-info-modal.ts tests/core/rerank-mode.test.ts tests/core/multi-query-searcher.test.ts
git commit -m "feat: 精排支持开关与双来源，候选不足三条时跳过"
```

---

## Task 7: 验收与回归

- [ ] **Step 1: 块长分布（自动化，不用手工样本）**

```ts
it('块长分布 - 长样本无超预算块，且前缀计入预算', () => {
	const sample = '# 项目\n\n' + '这是一段用于测量分块的中文样本。'.repeat(200);
	const counter = createTokenCounter(null); // 字符上界，宁严勿松
	const chunks = chunkMarkdown(sample, {
		maxTokens: 448,
		overlapTokens: 0,
		count: (t) => counter.count(t),
		docTitle: '样本',
	});
	const over = chunks.filter((c) => counter.count(c.embedText) > 448);
	expect(over).toHaveLength(0);
	expect(chunks.length).toBeGreaterThan(1);
});
```

Run: `npx vitest run tests/worker/chunker.test.ts -t 块长分布`
Expected: PASS（超预算块数为 0）

- [ ] **Step 2: 全量测试**

Run: `npm test`
Expected: 全部通过（当前基线 274 文件 / 2060 用例）

- [ ] **Step 3: 类型与构建**

Run: `npm run typecheck && npm run build`
Expected: 无新增错误；构建产出 `main.js`

- [ ] **Step 4: 设置单位变更的用户说明**

`chunkSize` / `chunkOverlap` 从「字符」改为「token」，同一个数值的含义变了（500 token 通常比 500 字符覆盖更多中文）。这一步必须做，否则老用户会以为设置失效：

- 设置项描述改为「分块大小（token）」「分块重叠（token）」；
- 在 CHANGELOG 的 `[Unreleased]` 下补一条：说明单位变化、升级会重建一次索引、旧自定义值的实际效果会变。

- [ ] **Step 5: 手工验收（Sandbox）**

按 [预览库链接](../../../.agents/skills/obsidian-vault-preview/SKILL.md) 链接到 Sandbox，重载后检查：索引进度正常完成、检索返回带「精排」徽标、设置页显示实际生效的精排来源、缺少密钥时如实显示原因。

- [ ] **Step 6: 提交并更新 STATUS**

```bash
git add docs/superpowers/STATUS.md
git commit -m "docs: 更新检索质量 plan 执行状态"
```

---

## 自审

| 检查 | 结果 |
|---|---|
| spec 覆盖 | §4.1 分块预算 → Task 1/2；§4.2 设置生效 → Task 3；§4.3 结构前缀 → Task 2；§4.4 双来源与切换 → Task 5/6；§4.5 重建 → Task 4；§6 验收 → Task 7 |
| 占位符 | 已清理：Task 7 原「用真实样本跑一次」改为可执行用例 |
| 类型一致 | `ChunkOptions`（Task 2）被 Task 3 复用；`RerankMode` / `EffectiveRerank` 与 `RerankerPort` 契约一致；`chunkerVersion` 命名一致 |
| 自审修掉的问题 | ① spec 原写「扩展 EmbeddingPort」，实际改为独立 token-counter 模块，spec 已同步；② `embedText` 原来忽略 `headingPath`，改为逐块拼前缀并逐块算预算；③ `!!this.llm` 恒为真，改为 `hasChatApiKey`；④ Worker 拿不到 `vocabContent`，补 `ModelManager.getVocabContent()` 与 `initProcessor` 传参；⑤ `getOverlapSuffix` 按字符，改为按 token 的 `takeOverlapSuffix`；⑥ 设置单位变化缺用户说明，补 Task 7 Step 4 |
| 追加需求 | 精排改为「开关（默认开）+ 来源（native / llm 二选一）」两设置，去掉了与原 native 重复的 auto；候选 ≤3 短路；llm 显式选择即替代 native |
| 已知未覆盖 | ① `MultiQuerySearcher` 精排前会读全文，LLM 模式只为截 400 字符也读整篇——属检索链路优化，另案；② 精排装配（main.ts）只有纯函数测试，无集成测试；③ spec §7 五个待决未定，默认值可后续调整 |
