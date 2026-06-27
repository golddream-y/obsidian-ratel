import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { VectraStore } from '../../src/adapters/vector-vectra';
import type { EmbeddingsModel, EmbeddingsResponse } from 'vectra';
import path from 'path';
import fs from 'fs';

const TEST_INDEX_DIR = path.join(__dirname, '../tmp/test-vectra-index');

/** Mock embeddings model that returns random 512-dim vectors for testing */
const mockEmbeddings: EmbeddingsModel = {
	maxTokens: 8192,
	async createEmbeddings(inputs: string | string[]): Promise<EmbeddingsResponse> {
		const inputArray = Array.isArray(inputs) ? inputs : [inputs];
		const output = inputArray.map(() =>
			Array(512).fill(0).map(() => Math.random()),
		);
		return { status: 'success', output };
	},
};

describe('VectraStore', () => {
	let store: VectraStore;

	beforeAll(() => {
		// Clean up any previous test index
		if (fs.existsSync(TEST_INDEX_DIR)) {
			fs.rmSync(TEST_INDEX_DIR, { recursive: true });
		}
		store = new VectraStore(TEST_INDEX_DIR, mockEmbeddings);
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

		// Search with a dummy vector (same dimensions as mock embeddings)
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

	it('replaces existing document on duplicate upsert (same docId)', async () => {
		// 关键路径:独立子目录避免与共享 store 串数据。
		const dupStore = new VectraStore(path.join(TEST_INDEX_DIR, 'dup-test'), mockEmbeddings);
		await dupStore.upsert('dup-doc-1', 'First version', { path: 'test1.md' });
		await dupStore.upsert('dup-doc-1', 'Second version', { path: 'test1.md' });

		// 关键路径:重复 upsert 应当替换,底层文档数为 1(非 >= 1)。
		const status = await dupStore.status();
		expect(status.totalDocs).toBe(1);

		// 关键路径:搜索结果中此 docId 应有 1 个文档(多 chunk 也聚合为 1)。
		const vector = Array(512).fill(0).map(() => Math.random());
		const results = await dupStore.search(vector, 100);
		const doc1Results = results.filter((r) => r.docId === 'dup-doc-1');
		expect(doc1Results).toHaveLength(1);
	});

	it('returns empty array when searching empty index', async () => {
		const emptyStore = new VectraStore(path.join(TEST_INDEX_DIR, 'empty-test'), mockEmbeddings);
		// 不向 store 写入任何数据,直接搜索。
		const vector = Array(512).fill(0.5);
		const results = await emptyStore.search(vector, 10);
		expect(results).toEqual([]);
	});

	it('status reports zero docs on empty index', async () => {
		const emptyStore = new VectraStore(path.join(TEST_INDEX_DIR, 'empty-status-test'), mockEmbeddings);
		const status = await emptyStore.status();
		expect(status.totalDocs).toBe(0);
	});

	it('upsertItem - 写入预计算向量并搜索', async () => {
		const vector = Array(512).fill(0).map((_, i) => i / 512);
		await store.beginFileUpdate();
		await store.upsertItem('precomputed-1', vector, { path: 'notes/pre.md', chunkIndex: 0 });
		await store.endFileUpdate();

		const results = await store.search(vector, 1);
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].docId).toBe('precomputed-1');
	});

	it('upsertItem - 事务回滚后数据不写入', async () => {
		const vector = Array(512).fill(0.5);
		await store.beginFileUpdate();
		await store.upsertItem('rollback-1', vector, { path: 'notes/rb.md' });
		await store.cancelFileUpdate();

		const results = await store.search(vector, 1);
		const found = results.find((r) => r.docId === 'rollback-1');
		expect(found).toBeUndefined();
	});
});

describe('VectraStore.hybridSearch', () => {
	it('hybridSearch - 调用 queryItems 传 isBm25=true 且 query 非空', async () => {
		// 关键路径:mock LocalDocumentIndex,捕获 queryItems 的入参
		const queryItemsMock = vi.fn().mockResolvedValue([]);
		const listDocumentsMock = vi.fn().mockResolvedValue([]);
		const isIndexCreatedMock = vi.fn().mockResolvedValue(true);
		const fakeIndex = {
			queryItems: queryItemsMock,
			listDocuments: listDocumentsMock,
			isIndexCreated: isIndexCreatedMock,
			createIndex: vi.fn(),
			getDocumentUri: vi.fn(),
			getCatalogStats: vi.fn().mockResolvedValue({ documents: 0 }),
		} as unknown as import('vectra').LocalDocumentIndex;

		// 关键路径:用 Object.defineProperty 注入 fakeIndex,绕过 ensureIndex 的真实初始化
		const store = new VectraStore('/tmp/test-index');
		// 把 store.index 私有字段强行替换为 fakeIndex
		(store as unknown as { index: unknown }).index = fakeIndex;
		// 把 _ready 设为已 resolved,跳过 init()
		(store as unknown as { _ready: Promise<void> | null })._ready = Promise.resolve();

		await store.hybridSearch('我的笔记', [0.1, 0.2, 0.3], 5);

		expect(queryItemsMock).toHaveBeenCalledTimes(1);
		const [vectorArg, queryArg, topKArg, filterArg, isBm25Arg] = queryItemsMock.mock.calls[0]!;
		expect(queryArg).toBe('我的笔记');
		expect(vectorArg).toEqual([0.1, 0.2, 0.3]);
		expect(topKArg).toBe(50); // 5 * 10 过度抓取
		expect(filterArg).toBeUndefined();
		expect(isBm25Arg).toBe(true);
	});

	it('hybridSearch - 聚合 chunk 到文档级并按分数降序', async () => {
		// mock 两条 chunk,同属 notes/a.md,聚合后取最高分
		const queryItemsMock = vi.fn().mockResolvedValue([
			{ score: 0.8, item: { metadata: { documentId: 'doc-1', path: 'notes/a.md', chunkIndex: 0 } } },
			{ score: 0.9, item: { metadata: { documentId: 'doc-1', path: 'notes/a.md', chunkIndex: 1 } } },
			{ score: 0.6, item: { metadata: { documentId: 'doc-2', path: 'notes/b.md', chunkIndex: 0 } } },
		]);
		const fakeIndex = {
			queryItems: queryItemsMock,
			isIndexCreated: vi.fn().mockResolvedValue(true),
			createIndex: vi.fn(),
			getDocumentUri: vi.fn().mockImplementation(async (id: string) => `uri-${id}`),
			getCatalogStats: vi.fn(),
			listDocuments: vi.fn(),
		} as unknown as import('vectra').LocalDocumentIndex;

		const store = new VectraStore('/tmp/test-index');
		(store as unknown as { index: unknown }).index = fakeIndex;
		(store as unknown as { _ready: Promise<void> | null })._ready = Promise.resolve();

		const results = await store.hybridSearch('query', [0.1, 0.2], 5);

		// 关键路径:聚合后 doc-1 取最高分 0.9,doc-2 取 0.6,按降序
		expect(results).toHaveLength(2);
		expect(results[0]!.docId).toBe('uri-doc-1');
		expect(results[0]!.score).toBe(0.9);
		expect(results[1]!.docId).toBe('uri-doc-2');
		expect(results[1]!.score).toBe(0.6);
		// 关键路径:hybridSearch 不填 index(由 search_vault 工具层填)
		expect(results[0]!.index).toBeUndefined();
	});
});
