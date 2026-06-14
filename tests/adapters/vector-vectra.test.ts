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
});
