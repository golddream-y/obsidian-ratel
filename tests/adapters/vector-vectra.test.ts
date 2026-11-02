import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VectraStore, VectorStoreError } from '../../src/adapters/vector-vectra';
import { AtomicIndexStorage } from '../../src/adapters/atomic-index-storage';
import type {
	AtomicDirectoryHandle,
	AtomicWriteFileSystem,
	AtomicWriteHandle,
} from '../../src/adapters/atomic-index-storage';
import type { EmbeddingsModel, EmbeddingsResponse } from 'vectra';
import fsp from 'node:fs/promises';
import path from 'path';
import fs from 'fs';
import os from 'node:os';

/**
 * 每个用例独立的索引根。
 *
 * 关键路径(修掉既有 flaky 的根因):此前所有用例共享 `tests/tmp/test-vectra-index` 这个固定目录,
 * 并在 `beforeAll`/用例内整目录 `rmSync`。并发或背靠背负载下,同一文件的两例、或测试文件之间
 * 会互相删掉对方正在使用的索引目录(实测表现为「只删目标文件」与「删除旧块」类断言偶发失败)。
 * 改为每例 `mkdtemp` 独立根 + `afterEach` 清理后,用例之间不再共享任何磁盘状态。
 */
let TEST_INDEX_DIR = '';
beforeEach(() => { TEST_INDEX_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-vectra-')); });
afterEach(() => { if (TEST_INDEX_DIR) fs.rmSync(TEST_INDEX_DIR, { recursive: true, force: true }); });

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

	beforeEach(() => {
		// 关键路径:每例新建实例并落在本例独立根上 —— 此前共享 store 时用例之间存在
		// 「上一例写入的文档」这种隐式依赖(「更新后状态」用例靠前序用例留下文档才会通过)。
		store = new VectraStore(TEST_INDEX_DIR, mockEmbeddings);
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
		// 关键路径:自己播种数据,不再依赖前序用例留下的文档(共享 store 时代的隐式排序依赖)。
		await store.upsert('doc-status', 'Status content', { path: 'notes/status.md' });
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

/**
 * 递归删除硬守卫 — `fs.rmSync(indexDir, { recursive: true })` 是本适配器唯一的递归删除边界。
 *
 * 关键路径(阻断 B2):代际布局下 `.index/` 根含控制指针、owner 锁与 `generations/` 聚合目录;
 * 一旦装配层把根或聚合目录当索引目录传进来,必须拒绝并且**不删除任何文件**。
 */
describe('dropIndex 递归删除硬守卫', () => {
	/** 断言拒绝删除且整棵目录树原样保留。 */
	async function expectRefused(target: string, keptPaths: string[]): Promise<void> {
		const store = new VectraStore(target, { autoInit: false });
		let caught: unknown;
		try {
			await store.dropIndex();
		}
		catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(VectorStoreError);
		expect((caught as VectorStoreError).code).toBe('drop-refused');
		for (const kept of keptPaths) {
			expect({ kept, exists: fs.existsSync(kept) }).toEqual({ kept, exists: true });
		}
	}

	it('dropIndex - 目标是 .index 根(内含 control.json 与 generations/) - 拒绝且不删除任何文件', async () => {
		const root = path.join(TEST_INDEX_DIR, '.index');
		const generation = path.join(root, 'generations', 'gen-0123456789abcdef');
		fs.mkdirSync(generation, { recursive: true });
		fs.writeFileSync(path.join(root, 'control.json'), '{"activeGenerationId":"gen-0123456789abcdef"}', 'utf8');
		fs.writeFileSync(path.join(root, 'owner.lock'), '{}', 'utf8');
		fs.writeFileSync(path.join(generation, 'index.json'), '{}', 'utf8');

		await expectRefused(root, [
			path.join(root, 'control.json'),
			path.join(root, 'owner.lock'),
			path.join(generation, 'index.json'),
		]);
		// 关键路径:守卫在任何删除动作与 init 之前闭合 —— 根上不得出现 store 初始化产物。
		expect(fs.existsSync(path.join(root, 'index.json'))).toBe(false);
	});

	it('dropIndex - 目标是 generations 聚合目录 - 拒绝且不删除任何代际', async () => {
		const root = path.join(TEST_INDEX_DIR, '.index');
		const generations = path.join(root, 'generations');
		const generation = path.join(generations, 'gen-0123456789abcdef');
		fs.mkdirSync(generation, { recursive: true });
		fs.writeFileSync(path.join(generation, 'index.json'), '{}', 'utf8');

		await expectRefused(generations, [
			path.join(generation, 'index.json'),
		]);
		expect(fs.existsSync(generations)).toBe(true);
	});

	it('dropIndex - 代际目录内含 control.json(内容探测) - 拒绝删除凭据', async () => {
		const generation = path.join(TEST_INDEX_DIR, 'gen-0123456789abcdef');
		fs.mkdirSync(generation, { recursive: true });
		fs.writeFileSync(path.join(generation, 'control.json'), '{}', 'utf8');
		fs.writeFileSync(path.join(generation, 'index.json'), '{}', 'utf8');

		await expectRefused(generation, [
			path.join(generation, 'control.json'),
			path.join(generation, 'index.json'),
		]);
	});

	it('dropIndex - 普通索引目录 - 仍正常删除并重建(守卫不误伤)', async () => {
		const dir = path.join(TEST_INDEX_DIR, 'plain-index');
		fs.mkdirSync(dir, { recursive: true });
		const store = new VectraStore(dir, { embeddings: mockEmbeddings });
		await store.init();
		await store.beginFileUpdate();
		await store.upsertItem('plain#0', Array(512).fill(0.5), { path: 'plain.md', chunkIndex: 0 });
		await store.endFileUpdate();

		await expect(store.dropIndex()).resolves.not.toThrow();
		const results = await store.search(Array(512).fill(0.5), 10);
		expect(results).toEqual([]);
	});

	it('dropIndex - pluginDir 形状的普通目录 - 拒绝且删除前不删任何文件', async () => {
		// 关键路径:审查者实测 —— 收紧形状白名单之前,这个目录会被静默递归删除
		// (适配器只探测受保护文件/聚合目录,插件产物目录一条都不命中)。
		const pluginDir = path.join(TEST_INDEX_DIR, 'plugin-dir-shape');
		const attachments = path.join(pluginDir, 'attachments');
		fs.mkdirSync(attachments, { recursive: true });
		fs.writeFileSync(path.join(pluginDir, 'main.js'), 'module.exports = {};', 'utf8');
		fs.writeFileSync(path.join(pluginDir, 'manifest.json'), '{"id":"ratel-vault"}', 'utf8');
		fs.writeFileSync(path.join(pluginDir, 'data.json'), '{}', 'utf8');
		fs.writeFileSync(path.join(attachments, 'note.png'), 'BIN', 'utf8');

		await expectRefused(pluginDir, [
			path.join(pluginDir, 'main.js'),
			path.join(pluginDir, 'manifest.json'),
			path.join(pluginDir, 'data.json'),
			path.join(attachments, 'note.png'),
		]);
		// 关键路径:拒绝发生在任何删除动作之前 —— 目录结构逐字不变,且没有 store 初始化产物。
		expect(fs.readdirSync(pluginDir).sort()).toEqual(['attachments', 'data.json', 'main.js', 'manifest.json']);
		expect(fs.readdirSync(attachments)).toEqual(['note.png']);
		expect(fs.existsSync(path.join(pluginDir, 'index.json'))).toBe(false);
	});

	it('dropIndex - generations 下的非代际目录 - 与后端判定一致地拒绝(适配器补第 4 条)', async () => {
		// 关键路径:这一条此前只在后端 `describeForeignIndexDir` 有,适配器缺失 ——
		// `generations/legacy-index` 只要含 index.json 就能被递归删掉,两份判定必须一致。
		const root = path.join(TEST_INDEX_DIR, '.index');
		const foreign = path.join(root, 'generations', 'legacy-index');
		fs.mkdirSync(foreign, { recursive: true });
		fs.writeFileSync(path.join(foreign, 'index.json'), '{}', 'utf8');

		await expectRefused(foreign, [
			path.join(foreign, 'index.json'),
			path.join(root, 'generations'),
		]);
		expect(fs.existsSync(path.join(root, 'generations'))).toBe(true);
	});

	it('dropIndex - 含 index.json 的普通索引目录与空目录 - 仍允许删除(形状白名单不误伤全量重建)', async () => {
		// 关键路径:今天未接线时的全量重建目标就是「普通索引目录 + index.json」;
		// 形状白名单只拒绝「非空且无索引特征」,不能把它一并拒掉。
		const plain = path.join(TEST_INDEX_DIR, 'legacy-plain-index');
		fs.mkdirSync(plain, { recursive: true });
		fs.writeFileSync(path.join(plain, 'index.json'), '{"version":1,"items":[]}', 'utf8');
		await expect(new VectraStore(plain, { autoInit: false }).dropIndex()).resolves.not.toThrow();
		// 删除后按自包含流程重建:目录重新存在且是新索引。
		expect(fs.existsSync(path.join(plain, 'index.json'))).toBe(true);

		const empty = path.join(TEST_INDEX_DIR, 'empty-index');
		fs.mkdirSync(empty, { recursive: true });
		await expect(new VectraStore(empty, { autoInit: false }).dropIndex()).resolves.not.toThrow();
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

// ---------------------------------------------------------------------------
// T2: FileReplaceStore — 完整枚举、同事务替换、故障后重载
// ---------------------------------------------------------------------------

/** 生成确定性向量(与夹具无关,测试内自足)。 */
function vectorFor(seed: string, dimensions = 512): number[] {
	let state = 0x9e3779b9;
	for (let i = 0; i < seed.length; i++) {
		state = (Math.imul(state ^ seed.charCodeAt(i), 16777619) >>> 0) || 1;
	}
	const vector: number[] = new Array<number>(dimensions);
	for (let i = 0; i < dimensions; i++) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		vector[i] = state / 0xffffffff - 0.5;
	}
	return vector;
}

/** 构造一条块。 */
function block(id: string, seed: string, extra: Record<string, unknown> = {}): {
	id: string;
	vector: number[];
	metadata: Record<string, unknown>;
} {
	return {
		id,
		vector: vectorFor(seed),
		metadata: { path: 'notes/replace.md', chunkIndex: 0, ...extra },
	};
}

/**
 * 取适配器内部的 `LocalDocumentIndex` — 只用于观察底层枚举次数。
 *
 * 关键路径:批量枚举的价值就是「一次 `listItems()`」,这只能通过直接观察内部实例来证明;
 * 结构替身无法证明真实实现没有退化成逐路径枚举。
 */
async function internalIndex(store: VectraStore): Promise<{ listItems(): Promise<unknown[]> }> {
	return await (store as unknown as { ensureIndex(): Promise<{ listItems(): Promise<unknown[]> }> }).ensureIndex();
}

/**
 * 可注入故障的原子写入接缝 — 只覆盖写入路径,读路径仍是真实磁盘。
 *
 * 关键路径:`before-rename` 让临时文件打开失败(磁盘保持完整旧版);
 * `after-rename` 让目录同步失败(rename 已生效,磁盘是完整新版但调用方收到错误)。
 */
function faultingFileSystem(
	failure: 'before-rename' | 'after-rename',
	armed: () => boolean,
): AtomicWriteFileSystem {
	return {
		async openFile(filePath: string): Promise<AtomicWriteHandle> {
			if (armed() && failure === 'before-rename') {
				const error = new Error('注入故障:打开临时文件失败');
				(error as { code?: string }).code = 'EIO';
				throw error;
			}
			const handle = await fsp.open(filePath, 'wx');
			return {
				async write(buffer: Uint8Array, offset: number, length: number): Promise<number> {
					const result = await handle.write(buffer, offset, length);
					return result.bytesWritten;
				},
				sync: () => handle.sync(),
				close: () => handle.close(),
			};
		},
		async openDirectory(directoryPath: string): Promise<AtomicDirectoryHandle> {
			if (armed() && failure === 'after-rename') {
				const error = new Error('注入故障:目录同步失败');
				(error as { code?: string }).code = 'EIO';
				throw error;
			}
			const handle = await fsp.open(directoryPath, 'r');
			return { sync: () => handle.sync(), close: () => handle.close() };
		},
		rename: (from: string, to: string) => fsp.rename(from, to),
		async removeFile(filePath: string): Promise<void> {
			await fsp.rm(filePath, { force: true });
		},
	};
}

describe('FileReplaceStore 替换语义', () => {
	/** 每个用例独立的索引目录,结束递归清理。 */
	function freshDir(name: string): string {
		const dir = path.join(TEST_INDEX_DIR, name);
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
		fs.mkdirSync(dir, { recursive: true });
		return dir;
	}

	it('replaceFile - 删除旧块并写入新块 - 单次索引提交且每个块带 commitId', async () => {
		const dir = freshDir('replace-basic');
		const storage = new AtomicIndexStorage({ generationRoot: dir });
		const store = new VectraStore(dir, { embeddings: mockEmbeddings, storage });
		await store.init();
		await store.replaceFile({
			path: 'notes/replace.md',
			commitId: 'commit-old',
			blocks: [block('notes/replace.md#chunk-0', 'old-0'), block('notes/replace.md#chunk-1', 'old-1')],
		});
		const writesBefore = storage.getWriteRecords().filter((record) => record.path.endsWith('index.json')).length;

		await store.replaceFile({
			path: 'notes/replace.md',
			commitId: 'commit-new',
			blocks: [block('notes/replace.md#chunk-0', 'new-0')],
		});

		const blocks = await store.inspectFile('notes/replace.md');
		expect(blocks.map((entry) => entry.id)).toEqual(['notes/replace.md#chunk-0']);
		// 关键路径:块 metadata 必须带 commitId,供 T3 的完成记录核对。
		expect(blocks[0]?.metadata.commitId).toBe('commit-new');
		expect(blocks[0]?.metadata.path).toBe('notes/replace.md');
		// 关键路径:删除与插入在同一事务内,只产生一次 index.json 落盘。
		const writesAfter = storage.getWriteRecords().filter((record) => record.path.endsWith('index.json')).length;
		expect(writesAfter - writesBefore).toBe(1);
	});

	it('replaceFile - blocks 为空数组 - 删除该路径全部块', async () => {
		const dir = freshDir('replace-empty');
		const store = new VectraStore(dir, { embeddings: mockEmbeddings });
		await store.init();
		await store.replaceFile({
			path: 'notes/replace.md',
			commitId: 'commit-1',
			blocks: Array.from({ length: 4 }, (_unused, index) =>
				block(`notes/replace.md#chunk-${index}`, `seed-${index}`),
			),
		});
		expect((await store.inspectFile('notes/replace.md')).length).toBe(4);

		await store.replaceFile({ path: 'notes/replace.md', commitId: 'commit-2', blocks: [] });

		expect(await store.inspectFile('notes/replace.md')).toEqual([]);
	});

	it('inspectFile - 全量枚举 - 超过 100 块也全部返回', async () => {
		const dir = freshDir('replace-inspect-120');
		const store = new VectraStore(dir, { embeddings: mockEmbeddings });
		await store.init();
		await store.replaceFile({
			path: 'notes/replace.md',
			commitId: 'commit-120',
			blocks: Array.from({ length: 120 }, (_unused, index) =>
				block(`notes/replace.md#chunk-${index}`, `wide-${index}`),
			),
		});

		const blocks = await store.inspectFile('notes/replace.md');
		// 关键路径:零向量查询只返回数组前 100 项,完整枚举必须走 listItems。
		expect(blocks).toHaveLength(120);
		expect(new Set(blocks.map((entry) => entry.id)).size).toBe(120);
	});

	it('inspectFiles - 与逐条 inspectFile 结果一致且只做一次全量枚举', async () => {
		const dir = freshDir('replace-inspect-files');
		const store = new VectraStore(dir, { embeddings: mockEmbeddings });
		await store.init();
		await store.replaceFile({
			path: 'notes/a.md',
			commitId: 'commit-a',
			blocks: [block('a#chunk-0', 'a-0'), block('a#chunk-1', 'a-1')],
		});
		await store.replaceFile({
			path: 'notes/b.md',
			commitId: 'commit-b',
			blocks: [block('b#chunk-0', 'b-0')],
		});

		// 关键路径:先取逐条真值(此时不打桩),再打桩测批量入口的枚举次数。
		const expectedA = await store.inspectFile('notes/a.md');
		const expectedB = await store.inspectFile('notes/b.md');
		const index = await internalIndex(store);
		const listItems = vi.spyOn(index, 'listItems');
		try {
			const grouped = await store.inspectFiles(['notes/a.md', 'notes/b.md', 'notes/missing.md', 'notes/a.md']);

			// 关键路径(O(N²) 接缝):逐条调用是「路径数 × 总块数」,批量入口必须只有一次全量枚举。
			expect(listItems).toHaveBeenCalledTimes(1);
			expect(grouped.get('notes/a.md')).toEqual(expectedA);
			expect(grouped.get('notes/b.md')).toEqual(expectedB);
			// 未命中的请求路径映射为空数组(不是缺键),未请求的路径不出现。
			expect(grouped.get('notes/missing.md')).toEqual([]);
			expect(grouped.has('notes/other.md')).toBe(false);
			expect(grouped.size).toBe(3);
		}
		finally {
			listItems.mockRestore();
		}
	});

	it('inspectFiles - 存储需重载时与逐条 inspectFile 一样拒绝', async () => {
		const dir = freshDir('replace-inspect-files-reload');
		let armed = false;
		const faultingStore = new VectraStore(dir, {
			embeddings: mockEmbeddings,
			storage: new AtomicIndexStorage({
				generationRoot: dir,
				fileSystem: faultingFileSystem('before-rename', () => armed),
			}),
		});
		await faultingStore.init();
		await faultingStore.replaceFile({
			path: 'notes/f.md',
			commitId: 'commit-f',
			blocks: [block('f#chunk-0', 'f-0')],
		});
		armed = true;
		await expect(faultingStore.replaceFile({
			path: 'notes/f.md',
			commitId: 'commit-f2',
			blocks: [block('f#chunk-0', 'f-1')],
		})).rejects.toBeInstanceOf(VectorStoreError);

		// 关键路径:批量入口与逐条入口共用同一可用性断言,不得绕过需重载状态。
		await expect(faultingStore.inspectFiles(['notes/f.md'])).rejects.toMatchObject({ code: 'reload-required' });
	});

	it('replaceFile - 提交前失败 - 磁盘保持完整旧版且存储进入需重载状态', async () => {
		const dir = freshDir('replace-before-rename');
		let armed = false;
		const storage = new AtomicIndexStorage({
			generationRoot: dir,
			fileSystem: faultingFileSystem('before-rename', () => armed),
		});
		const store = new VectraStore(dir, { embeddings: mockEmbeddings, storage });
		await store.init();
		await store.replaceFile({
			path: 'notes/replace.md',
			commitId: 'commit-old',
			blocks: [block('notes/replace.md#chunk-0', 'old-0')],
		});

		armed = true;
		let caught: unknown;
		try {
			await store.replaceFile({
				path: 'notes/replace.md',
				commitId: 'commit-new',
				blocks: [block('notes/replace.md#chunk-0', 'new-0')],
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(VectorStoreError);
		expect((caught as VectorStoreError).code).toBe('replace-failed');
		// 关键路径:rename 未执行 = 磁盘仍是完整旧版,不能当成「状态不明」。
		expect((caught as VectorStoreError).diskState).toBe('complete-previous');

		// 关键路径:失败后不得继续用旧内存缓存服务查询。
		await expect(store.inspectFile('notes/replace.md')).rejects.toMatchObject({ code: 'reload-required' });
		await expect(store.search(vectorFor('query'), 5)).rejects.toMatchObject({ code: 'reload-required' });

		await store.reload();
		const blocks = await store.inspectFile('notes/replace.md');
		expect(blocks.map((entry) => entry.id)).toEqual(['notes/replace.md#chunk-0']);
		expect(blocks[0]?.metadata.commitId).toBe('commit-old');
	});

	it('replaceFile - rename 后失败 - 磁盘为完整新版且重载后读到新块', async () => {
		const dir = freshDir('replace-after-rename');
		let armed = false;
		const storage = new AtomicIndexStorage({
			generationRoot: dir,
			fileSystem: faultingFileSystem('after-rename', () => armed),
		});
		const store = new VectraStore(dir, { embeddings: mockEmbeddings, storage });
		await store.init();
		await store.replaceFile({
			path: 'notes/replace.md',
			commitId: 'commit-old',
			blocks: [block('notes/replace.md#chunk-0', 'old-0'), block('notes/replace.md#chunk-1', 'old-1')],
		});

		armed = true;
		let caught: unknown;
		try {
			await store.replaceFile({
				path: 'notes/replace.md',
				commitId: 'commit-new',
				blocks: [block('notes/replace.md#chunk-0', 'new-0')],
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(VectorStoreError);
		expect((caught as VectorStoreError).code).toBe('replace-failed');
		// 关键路径:rename 已执行 = 磁盘是完整新版;把「endUpdate 抛错」当旧版会丢数据。
		expect((caught as VectorStoreError).diskState).toBe('complete-next');

		await expect(store.inspectFile('notes/replace.md')).rejects.toMatchObject({ code: 'reload-required' });
		await store.reload();
		const blocks = await store.inspectFile('notes/replace.md');
		expect(blocks.map((entry) => entry.id)).toEqual(['notes/replace.md#chunk-0']);
		expect(blocks[0]?.metadata.commitId).toBe('commit-new');
	});

	it('replaceFile - 向量含非有限值 - 拒绝写入且索引保持可用', async () => {
		const dir = freshDir('replace-invalid');
		const store = new VectraStore(dir, { embeddings: mockEmbeddings });
		await store.init();
		await store.replaceFile({
			path: 'notes/replace.md',
			commitId: 'commit-old',
			blocks: [block('notes/replace.md#chunk-0', 'old-0')],
		});

		const invalid = block('notes/replace.md#chunk-1', 'bad');
		invalid.vector[0] = Number.NaN;
		let caught: unknown;
		try {
			await store.replaceFile({ path: 'notes/replace.md', commitId: 'commit-bad', blocks: [invalid] });
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(VectorStoreError);
		expect((caught as VectorStoreError).code).toBe('invalid-replacement');
		// 关键路径:输入校验在事务之前完成,索引仍是完整旧版且不需要重载。
		const blocks = await store.inspectFile('notes/replace.md');
		expect(blocks.map((entry) => entry.id)).toEqual(['notes/replace.md#chunk-0']);
	});
});

// ---------------------------------------------------------------------------
// 构造判别式:options 与旧签名 `(dir, embeddings?)` 的分流
// ---------------------------------------------------------------------------

describe('VectraStore 构造判别式', () => {
	/** 每个用例独立的索引目录,结束递归清理。 */
	function freshDir(name: string): string {
		const dir = path.join(TEST_INDEX_DIR, name);
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
		fs.mkdirSync(dir, { recursive: true });
		return dir;
	}

	it('构造函数 - { autoInit: false } - 不自动 init,显式 init 后才落地索引文件', async () => {
		const dir = freshDir('ctor-no-autoinit');
		const initSpy = vi.spyOn(VectraStore.prototype, 'init');
		try {
			const store = new VectraStore(dir, { autoInit: false });
			// 关键路径:`autoInit: false` 的生产用途是「等模型就绪再 init」;
			// 构造期触发 init 会在 onload 阶段阻塞主线程。
			expect(initSpy).not.toHaveBeenCalled();
			expect(fs.existsSync(path.join(dir, 'index.json'))).toBe(false);

			await store.init();
			expect(initSpy).toHaveBeenCalledTimes(1);
			expect(fs.existsSync(path.join(dir, 'index.json'))).toBe(true);
		} finally {
			initSpy.mockRestore();
		}
	});

	it('构造函数 - 默认 autoInit - 构造期即自动 init 并创建索引文件', async () => {
		const dir = freshDir('ctor-default-autoinit');
		const initSpy = vi.spyOn(VectraStore.prototype, 'init');
		try {
			const store = new VectraStore(dir, { storage: new AtomicIndexStorage({ generationRoot: dir }) });
			expect(initSpy).toHaveBeenCalledTimes(1);
			await store.isIndexCreated();
			expect(fs.existsSync(path.join(dir, 'index.json'))).toBe(true);
		} finally {
			initSpy.mockRestore();
		}
	});

	it('构造函数 - { autoInit: false } - options 对象不被误当成 EmbeddingsModel', async () => {
		const dir = freshDir('ctor-options-not-embeddings');
		const store = new VectraStore(dir, { autoInit: false });
		await store.init();

		// 关键路径:若把 options 对象误设成 embeddings,vectra 会去调不存在的
		// `createEmbeddings` 抛 TypeError;只有「未配置 embeddings」才会是这条稳定文案,
		// 因此判别式必须落在这里,而不是只看 init 是否被调用。
		await expect(store.upsert('doc-1', '正文')).rejects.toThrow('Embeddings model not configured');
	});
});

// ---------------------------------------------------------------------------
// 生产装配契约:所有 `new VectraStore(...)` 都必须注入原子存储
// ---------------------------------------------------------------------------

describe('生产装配 - VectraStore 构造点存储注入契约', () => {
	/**
	 * 递归收集目录下的 TypeScript 源文件。
	 *
	 * @param root - 起始目录。
	 * @returns 绝对路径列表(已排序,保证断言稳定)。
	 */
	function collectSourceFiles(root: string): string[] {
		const collected: string[] = [];
		const pending: string[] = [root];
		while (pending.length > 0) {
			const current = pending.pop();
			if (!current) continue;
			for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
				const fullPath = path.join(current, entry.name);
				if (entry.isDirectory()) pending.push(fullPath);
				else if (entry.isFile() && entry.name.endsWith('.ts')) collected.push(fullPath);
			}
		}
		return collected.sort();
	}

	/**
	 * 取出每个 `new VectraStore(` 的完整实参文本。
	 *
	 * 关键路径:用括号配平切出整段实参,而不是按行匹配 ——
	 * 构造参数跨多行(注入 storage 后就是多行),按行判断会漏掉未注入的写法。
	 *
	 * @param source - 源文件内容。
	 * @returns 每处构造的实参文本(含外层括号)。
	 */
	function constructArguments(source: string): string[] {
		const calls: string[] = [];
		const marker = 'new VectraStore(';
		let index = source.indexOf(marker);
		while (index >= 0) {
			const start = index + marker.length - 1;
			let depth = 0;
			let end = start;
			for (; end < source.length; end += 1) {
				const char = source[end];
				if (char === '(') depth += 1;
				else if (char === ')') {
					depth -= 1;
					if (depth === 0) break;
				}
			}
			calls.push(source.slice(start, end + 1));
			index = source.indexOf(marker, end + 1);
		}
		return calls;
	}

	it('生产构造点 - new VectraStore - 全部注入 storage', () => {
		const repoRoot = path.resolve(__dirname, '../..');
		const sites: Array<{ file: string; args: string }> = [];
		for (const file of collectSourceFiles(path.join(repoRoot, 'src'))) {
			const source = fs.readFileSync(file, 'utf8');
			for (const args of constructArguments(source)) {
				sites.push({ file: path.relative(repoRoot, file), args });
			}
		}

		// 关键路径(B3):未注入 storage 的构造点会让 `getLastWriteOutcome` 恒为 null,
		// 提交失败只能报「磁盘状态不明」,重载决策失去依据。
		expect(sites.filter((site) => !site.args.includes('storage:')).map((site) => site.file)).toEqual([]);
		// 关键路径:守卫必须真的扫到生产装配点 —— 全量重写或装配下沉后若位置/数量变化,
		// 这里要显式失败而不是静默通过。T8 把通用工厂(`createIndexRuntimeStore`)与 legacy 只读枚举
		// 两处构造点从 `src/main.ts` 下沉到 `src/core/index-runtime-assembly.ts`,
		// 因此账本从「main.ts 4 + handler 1」改为下面的逐文件计数(main.ts 只剩 createVectraStore 的转发调用)。
		const sitesByFile: Record<string, number> = {};
		for (const site of sites) sitesByFile[site.file] = (sitesByFile[site.file] ?? 0) + 1;
		expect(sitesByFile).toEqual({
			'src/core/index-runtime-assembly.ts': 2,
			'src/main.ts': 1,
			'src/worker/handler.ts': 1,
			// 索引线程与 T0 实验各有一处构造点,同样必须注入同一份原子存储。
			'src/worker/index-runtime-session.ts': 1,
			'src/experiment/index-thread-probe.ts': 1,
		});
	});
});
