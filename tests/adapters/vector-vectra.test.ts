import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
});
