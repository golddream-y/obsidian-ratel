import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { VectraStore, isBm25CorpusTooSmall } from '../../src/adapters/vector-vectra';
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

	it('deleteByPath - 删除指定文件所有 chunk', async () => {
		// 关键路径:用一个独立的子目录,避免污染其他用例的索引。
		const subDir = path.join(TEST_INDEX_DIR, 'delete-by-path-test');
		if (fs.existsSync(subDir)) {
			fs.rmSync(subDir, { recursive: true });
		}
		const subStore = new VectraStore(subDir, mockEmbeddings);

		// 写入一个文件的多个 chunk(用 upsertItem 模拟 indexProcessor 的写入路径)
		await subStore.beginFileUpdate();
		const dummyVector = Array(512).fill(0).map(() => Math.random());
		await subStore.upsertItem('notes/foo.md#chunk-0', dummyVector, { path: 'notes/foo.md', chunkIndex: 0 });
		await subStore.upsertItem('notes/foo.md#chunk-1', dummyVector, { path: 'notes/foo.md', chunkIndex: 1 });
		await subStore.upsertItem('notes/foo.md#chunk-2', dummyVector, { path: 'notes/foo.md', chunkIndex: 2 });
		await subStore.endFileUpdate();

		const deleted = await subStore.deleteByPath('notes/foo.md');
		expect(deleted).toBe(3);

		// 搜索应不再命中该文件
		const queryVector = Array(512).fill(0).map(() => Math.random());
		const results = await subStore.search(queryVector, 10);
		const fooResults = results.filter((r) => (r.metadata as { path?: string }).path === 'notes/foo.md');
		expect(fooResults).toHaveLength(0);

		if (fs.existsSync(subDir)) {
			fs.rmSync(subDir, { recursive: true });
		}
	});

	it('deleteByPath - 文件不存在 - 返回 0 不抛错', async () => {
		const subDir = path.join(TEST_INDEX_DIR, 'delete-by-path-empty');
		if (fs.existsSync(subDir)) {
			fs.rmSync(subDir, { recursive: true });
		}
		const subStore = new VectraStore(subDir, mockEmbeddings);
		const deleted = await subStore.deleteByPath('nonexistent.md');
		expect(deleted).toBe(0);
		if (fs.existsSync(subDir)) {
			fs.rmSync(subDir, { recursive: true });
		}
	});

	it('deleteByPath - 多文件场景只删目标文件', async () => {
		const subDir = path.join(TEST_INDEX_DIR, 'delete-by-path-multi');
		if (fs.existsSync(subDir)) {
			fs.rmSync(subDir, { recursive: true });
		}
		const subStore = new VectraStore(subDir, mockEmbeddings);
		const dummyVector = Array(512).fill(0).map(() => Math.random());

		await subStore.beginFileUpdate();
		await subStore.upsertItem('a.md#chunk-0', dummyVector, { path: 'a.md', chunkIndex: 0 });
		await subStore.upsertItem('b.md#chunk-0', dummyVector, { path: 'b.md', chunkIndex: 0 });
		await subStore.upsertItem('b.md#chunk-1', dummyVector, { path: 'b.md', chunkIndex: 1 });
		await subStore.endFileUpdate();

		const deleted = await subStore.deleteByPath('b.md');
		expect(deleted).toBe(2);

		// a.md 应仍可被搜索命中
		const queryVector = Array(512).fill(0).map(() => Math.random());
		const results = await subStore.search(queryVector, 10);
		const aResults = results.filter((r) => (r.metadata as { path?: string }).path === 'a.md');
		expect(aResults.length).toBeGreaterThan(0);
		const bResults = results.filter((r) => (r.metadata as { path?: string }).path === 'b.md');
		expect(bResults).toHaveLength(0);

		if (fs.existsSync(subDir)) {
			fs.rmSync(subDir, { recursive: true });
		}
	});

	it('dropIndex - 目录存在 - 删除并重建空索引', async () => {
		// 关键路径:独立子目录,dropIndex 会清空整个索引,不能污染共享 store。
		const subDir = path.join(TEST_INDEX_DIR, 'drop-index-test');
		if (fs.existsSync(subDir)) {
			fs.rmSync(subDir, { recursive: true });
		}
		const subStore = new VectraStore(subDir, mockEmbeddings);

		// 关键路径:先建索引写入数据,再 drop,验证目录被清空且可重建。
		const dummyVector = Array(512).fill(0.5);
		await subStore.beginFileUpdate();
		await subStore.upsertItem('test#0', dummyVector, { path: 'test.md', chunkIndex: 0 });
		await subStore.endFileUpdate();
		expect(fs.existsSync(subDir)).toBe(true);

		await subStore.dropIndex();

		// 关键路径:目录重建后应为空(或仅含 vectra 初始化文件),原数据消失。
		const results = await subStore.search(dummyVector, 10);
		expect(results).toHaveLength(0);

		if (fs.existsSync(subDir)) {
			fs.rmSync(subDir, { recursive: true });
		}
	});

	it('dropIndex - 目录不存在 - 不抛错', async () => {
		// 关键路径:force:true 应处理目录不存在的情况。
		const subDir = path.join(TEST_INDEX_DIR, 'drop-index-empty');
		if (fs.existsSync(subDir)) {
			fs.rmSync(subDir, { recursive: true });
		}
		const subStore = new VectraStore(subDir, mockEmbeddings);
		// 先 init 一次确保 store 就绪,再手动删目录模拟异常状态。
		const dummyVector = Array(512).fill(0.5);
		await subStore.beginFileUpdate();
		await subStore.upsertItem('test#0', dummyVector, { path: 'test.md', chunkIndex: 0 });
		await subStore.endFileUpdate();
		fs.rmSync(subDir, { recursive: true, force: true });

		await expect(subStore.dropIndex()).resolves.not.toThrow();

		if (fs.existsSync(subDir)) {
			fs.rmSync(subDir, { recursive: true });
		}
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

	it('hybridSearch - BM25 语料过小 - 降级纯向量且不抛错', async () => {
		const queryItemsMock = vi
			.fn()
			.mockRejectedValueOnce(
				new Error('winkBM25S: document collection is too small for consolidation; add more docs!'),
			)
			.mockResolvedValueOnce([]);
		const fakeIndex = {
			queryItems: queryItemsMock,
			isIndexCreated: vi.fn().mockResolvedValue(true),
			createIndex: vi.fn(),
			getDocumentUri: vi.fn(),
			getCatalogStats: vi.fn(),
			listDocuments: vi.fn(),
		} as unknown as import('vectra').LocalDocumentIndex;

		const store = new VectraStore('/tmp/test-index-bm25-small');
		(store as unknown as { index: unknown }).index = fakeIndex;
		(store as unknown as { _ready: Promise<void> | null })._ready = Promise.resolve();

		await expect(store.hybridSearch('q', [0.1], 3)).resolves.toEqual([]);
		// 第一次 hybrid(BM25=true),第二次 search(无 isBm25)
		expect(queryItemsMock).toHaveBeenCalledTimes(2);
		expect(queryItemsMock.mock.calls[0]![4]).toBe(true);
		expect(queryItemsMock.mock.calls[1]!).toHaveLength(3);
	});
});

describe('isBm25CorpusTooSmall', () => {
	it('识别 - wink 小库文案 - true', () => {
		expect(
			isBm25CorpusTooSmall(
				new Error('winkBM25S: document collection is too small for consolidation; add more docs!'),
			),
		).toBe(true);
		expect(isBm25CorpusTooSmall(new Error('network timeout'))).toBe(false);
	});
});

describe('upsertItem 事务回滚', () => {
	it('cancelFileUpdate - 事务中写入的 chunk 不被持久化', async () => {
		// 关键路径:独立子目录,避免污染共享 store。
		const subDir = path.join(TEST_INDEX_DIR, 'rollback-cancel-test');
		if (fs.existsSync(subDir)) {
			fs.rmSync(subDir, { recursive: true });
		}
		const subStore = new VectraStore(subDir, mockEmbeddings);

		// 开启事务后写入 2 个 chunk,然后 cancel(模拟 embed 中途失败)
		await subStore.beginFileUpdate();
		const dummyVector = Array(512).fill(0).map(() => Math.random());
		await subStore.upsertItem('notes/foo.md#chunk-0', dummyVector, { path: 'notes/foo.md', chunkIndex: 0 });
		await subStore.upsertItem('notes/foo.md#chunk-1', dummyVector, { path: 'notes/foo.md', chunkIndex: 1 });
		await subStore.cancelFileUpdate();

		// 关键路径:cancel 后搜索不应命中这些 chunk(vectra 事务回滚)
		const results = await subStore.search(dummyVector, 10);
		expect(results).toHaveLength(0);

		if (fs.existsSync(subDir)) {
			fs.rmSync(subDir, { recursive: true });
		}
	});

	it('endFileUpdate 后 cancelFileUpdate - 已提交事务不回滚', async () => {
		// 关键路径:已 endUpdate 的事务,cancel 不应影响已持久化数据
		const subDir = path.join(TEST_INDEX_DIR, 'rollback-after-commit');
		if (fs.existsSync(subDir)) {
			fs.rmSync(subDir, { recursive: true });
		}
		const subStore = new VectraStore(subDir, mockEmbeddings);

		const dummyVector = Array(512).fill(0).map(() => Math.random());
		await subStore.beginFileUpdate();
		await subStore.upsertItem('notes/foo.md#chunk-0', dummyVector, { path: 'notes/foo.md', chunkIndex: 0 });
		await subStore.endFileUpdate();

		// 关键路径:已提交后 cancel,不应影响已写入数据
		await expect(subStore.cancelFileUpdate()).resolves.not.toThrow();
		const results = await subStore.search(dummyVector, 10);
		expect(results.length).toBeGreaterThan(0);

		if (fs.existsSync(subDir)) {
			fs.rmSync(subDir, { recursive: true });
		}
	});
});

describe('deleteByPath 失败保护', () => {
	it('deleteByPath - 文件不存在 - 返回 0 不破坏索引状态', async () => {
		// 关键路径:删除不存在的文件不应抛错,索引仍可查询
		const subDir = path.join(TEST_INDEX_DIR, 'delete-fail-protect');
		if (fs.existsSync(subDir)) {
			fs.rmSync(subDir, { recursive: true });
		}
		const subStore = new VectraStore(subDir, mockEmbeddings);

		// 先写入一个文件
		const dummyVector = Array(512).fill(0).map(() => Math.random());
		await subStore.beginFileUpdate();
		await subStore.upsertItem('a.md#chunk-0', dummyVector, { path: 'a.md', chunkIndex: 0 });
		await subStore.endFileUpdate();

		// 删除不存在的文件
		const deleted = await subStore.deleteByPath('nonexistent.md');
		expect(deleted).toBe(0);

		// 关键路径:索引仍可查询,a.md 数据未受影响
		const results = await subStore.search(dummyVector, 10);
		const aResults = results.filter((r) => (r.metadata as { path?: string }).path === 'a.md');
		expect(aResults.length).toBeGreaterThan(0);

		if (fs.existsSync(subDir)) {
			fs.rmSync(subDir, { recursive: true });
		}
	});
});
