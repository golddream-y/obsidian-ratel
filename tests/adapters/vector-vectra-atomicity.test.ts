/**
 * @file tests/adapters/vector-vectra-atomicity.test.ts
 * @description T0 实验 — 固化 vectra 删除启发式缺陷,验证完整枚举、同事务替换与原子存储注入
 * @module tests/adapters/vector-vectra-atomicity
 * @depends adapters/vector-vectra, worker/index-processor, vectra
 *
 * 关键路径:
 * - 本文件只做 T0 可行性验证,不修改 `src/` 生产路径;所有磁盘操作都在系统临时目录。
 * - 「现有缺陷固化」用例断言的是**正确行为**,因此在当前实现上必然失败(测试名带 `【预期失败】`),
 *   用于记录真实残留,不允许 skip 或 `it.fails` 伪造通过;T2 修复生产路径后这些断言转为通过。
 * - 「实验路径」用例只用公开 API(`listItems` / `listItemsByMetadata` / `deleteItems` /
 *   `beginUpdate` / `endUpdate` / `storage` 配置),不访问 vectra 私有字段。
 * - 基线采集(耗时/内存/写入量)已拆到 `vector-vectra-baseline.test.ts`;本文件只保留缺陷固化、
 *   行为记录、实验路径、存储注入与门槛守卫。
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LocalDocumentIndex } from 'vectra';
import { chunkMarkdown } from '../../src/worker/chunker';
import { VectraStore } from '../../src/adapters/vector-vectra';
import { IndexProcessor } from '../../src/worker/index-processor';
import {
	AtomicTestFileStorage,
	FakeEmbeddingPort,
	T0_CHUNK_OPTIONS,
	blockMetadata,
	chunkIdsFor,
	createDocumentIndex,
	createTempWorkspace,
	deterministicVector,
	listBlockIds,
	listBlockIdsByMetadata,
	readDiskBlockIds,
	readDiskIndexFile,
	seedBlocks,
	seedStoreBlocks,
	type TempWorkspace,
} from '../helpers/index-reliability-fixture';

// ---------------------------------------------------------------------------
// 公共测试辅助
// ---------------------------------------------------------------------------

/** 512 维 — 生产 `deleteByPath` 硬编码的维度。 */
const DIMENSIONS_512 = 512;

/**
 * 仓库根目录 — 由测试文件自身位置推导,与进程工作目录无关。
 *
 * 关键路径:守卫用例要读仓库内文件,不能用 `process.cwd()` ——
 * 从别的目录启动 vitest 时会指向错误位置。
 */
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
/** 本测试文件自身路径 — 守卫用例需要扫描它。 */
const SELF_PATH = fileURLToPath(import.meta.url);

const workspaces: TempWorkspace[] = [];

/** 创建并在用例结束后清理的临时工作区。 */
function workspace(prefix: string): TempWorkspace {
	const created = createTempWorkspace(prefix);
	workspaces.push(created);
	return created;
}

afterEach(() => {
	while (workspaces.length > 0) workspaces.pop()?.dispose();
});

/** 用公开 API 只读打开已存在的索引,用于核对磁盘/内存真值。 */
async function openIndexForRead(folderPath: string): Promise<LocalDocumentIndex> {
	return createDocumentIndex({ folderPath });
}

/** 枚举指定路径在索引中的块 ID(走 `listItems()` 完整枚举)。 */
async function listBlocksIn(folderPath: string, filePath: string): Promise<string[]> {
	const index = await openIndexForRead(folderPath);
	return listBlockIds(index, filePath);
}

/** 统计指定路径在索引中的块数(走 `listItems()` 完整枚举)。 */
async function countBlocks(folderPath: string, filePath: string): Promise<number> {
	return (await listBlocksIn(folderPath, filePath)).length;
}

/**
 * 生成含 `sectionCount` 个小节的 Markdown,每个小节在 T0 分块配置下基本各成一块。
 *
 * @param sectionCount - 小节数量。
 * @returns Markdown 正文。
 */
function markdownWithSections(sectionCount: number): string {
	const lines: string[] = ['# 大文件', ''];
	for (let i = 0; i < sectionCount; i++) {
		lines.push(`## 小节 ${i}`, '');
		lines.push(`第 ${i} 段正文。${'内容填充'.repeat(16)}`);
		lines.push('');
	}
	return lines.join('\n');
}

/** 该正文在固定分块配置下的真实块数(不靠猜测)。 */
function expectedChunks(content: string): number {
	return chunkMarkdown(content, T0_CHUNK_OPTIONS).length;
}

// ---------------------------------------------------------------------------
// 1. 现有缺陷固化(预期失败)
// ---------------------------------------------------------------------------

describe('现有缺陷固化 - 预期失败', () => {
	it('deleteByPath - 单个文件 150 块 - 应删除该路径全部旧块', async () => {
		const ws = workspace('ratel-t0-del-');
		const dir = ws.mkdir('index');
		const store = new VectraStore(dir);
		await store.isIndexCreated();
		await seedStoreBlocks(store, 'notes/big.md', 150, DIMENSIONS_512);

		const before = await countBlocks(dir, 'notes/big.md');
		const deleted = await store.deleteByPath('notes/big.md');
		const remaining = await countBlocks(dir, 'notes/big.md');

		// 关键路径:期望按路径完整删除 150 块;真实实现只覆盖 top100 候选。
		expect({ before, deleted, remaining }).toEqual({ before: 150, deleted: 150, remaining: 0 });
	});

	it('deleteByPath - 目标块位于索引数组第 100 项之后 - 应仍能删除该路径全部块', async () => {
		const ws = workspace('ratel-t0-del-after-');
		const dir = ws.mkdir('index');
		const store = new VectraStore(dir);
		await store.isIndexCreated();
		// 关键路径:先播种其他文件,把目标文件的块推到数组第 100 项之后 —— 真实库中的常见情形。
		await seedStoreBlocks(store, 'notes/other.md', 120, DIMENSIONS_512);
		await seedStoreBlocks(store, 'notes/target.md', 30, DIMENSIONS_512);

		const deleted = await store.deleteByPath('notes/target.md');
		const remaining = await countBlocks(dir, 'notes/target.md');

		expect({ deleted, remaining }).toEqual({ deleted: 30, remaining: 0 });
	});

	it('indexBatch - 文件变短 - 不应残留旧块', async () => {
		const ws = workspace('ratel-t0-shrink-');
		const dir = ws.mkdir('index');
		const store = new VectraStore(dir);
		await store.isIndexCreated();
		await seedStoreBlocks(store, 'notes/other.md', 120, DIMENSIONS_512);
		await seedStoreBlocks(store, 'notes/target.md', 30, DIMENSIONS_512);

		const content = markdownWithSections(3);
		const expected = expectedChunks(content);
		const processor = new IndexProcessor(store, new FakeEmbeddingPort(DIMENSIONS_512), T0_CHUNK_OPTIONS);
		const result = await processor.indexBatch([{ path: 'notes/target.md', content }]);
		const remainingIds = await listBlocksIn(dir, 'notes/target.md');
		const expectedIds = chunkIdsFor('notes/target.md', expected);

		// 关键路径:变短后应只剩新块;真实实现会留下旧块(删除启发式没命中)。
		// 只比数量不够 —— 数量相同也可能残留的是旧块,必须同时核对 ID 集合。
		expect({
			errors: result.errors,
			expected,
			remaining: remainingIds.length,
			remainingIds: [...remainingIds].sort(),
		}).toEqual({
			errors: 0,
			expected,
			remaining: expected,
			remainingIds: [...expectedIds].sort(),
		});
	});

	it('indexBatch - 文件内容变空 - 应删除该路径全部旧块', async () => {
		const ws = workspace('ratel-t0-empty-');
		const dir = ws.mkdir('index');
		const store = new VectraStore(dir);
		await store.isIndexCreated();
		await seedStoreBlocks(store, 'notes/other.md', 120, DIMENSIONS_512);
		await seedStoreBlocks(store, 'notes/target.md', 20, DIMENSIONS_512);

		const processor = new IndexProcessor(store, new FakeEmbeddingPort(DIMENSIONS_512), T0_CHUNK_OPTIONS);
		const result = await processor.indexBatch([{ path: 'notes/target.md', content: '' }]);
		const remainingIds = await listBlocksIn(dir, 'notes/target.md');

		// 关键路径:空文件应删除全部旧块;真实实现一块都不删,旧内容仍可被检索。
		expect({ errors: result.errors, remaining: remainingIds.length, remainingIds }).toEqual({
			errors: 0,
			remaining: 0,
			remainingIds: [],
		});
	});

	it('indexBatch - 非 512 维向量 - 超过 100 块时不应残留旧块', async () => {
		const ws = workspace('ratel-t0-768-');
		const dir = ws.mkdir('index');
		const store = new VectraStore(dir);
		await store.isIndexCreated();
		// 关键路径:768 维向量 + 目标块排在 100 项之后,覆盖「固定 512 维」这一假设。
		await seedStoreBlocks(store, 'notes/other.md', 130, 768);
		await seedStoreBlocks(store, 'notes/target.md', 25, 768);

		const content = markdownWithSections(6);
		const expected = expectedChunks(content);
		const processor = new IndexProcessor(store, new FakeEmbeddingPort(768), T0_CHUNK_OPTIONS);
		const result = await processor.indexBatch([{ path: 'notes/target.md', content }]);
		const remainingIds = await listBlocksIn(dir, 'notes/target.md');
		const expectedIds = chunkIdsFor('notes/target.md', expected);

		// 关键路径:维度不同不影响删除正确性;真实实现按 512 维零向量查询,一个都删不掉。
		expect({
			errors: result.errors,
			expected,
			remaining: remainingIds.length,
			remainingIds: [...remainingIds].sort(),
		}).toEqual({
			errors: 0,
			expected,
			remaining: expected,
			remainingIds: [...expectedIds].sort(),
		});
	});

	it('indexBatch - 推理阶段失败 - 不应丢失旧块', async () => {
		const ws = workspace('ratel-t0-embed-fail-');
		const dir = ws.mkdir('index');
		const store = new VectraStore(dir);
		await store.isIndexCreated();
		// 关键路径:目标块排在数组前 100 项内,删除启发式会真的删掉它们。
		await seedStoreBlocks(store, 'notes/target.md', 6, DIMENSIONS_512);
		const oldIds = chunkIdsFor('notes/target.md', 6);

		const processor = new IndexProcessor(store, new FakeEmbeddingPort(DIMENSIONS_512, { failOnCall: 1 }), T0_CHUNK_OPTIONS);
		const result = await processor.indexBatch([{ path: 'notes/target.md', content: markdownWithSections(2) }]);
		const remainingIds = await listBlocksIn(dir, 'notes/target.md');

		// 关键路径:推理失败时应保留完整旧版本;真实实现先删后推理,旧块已丢。
		// ID 集合是数据丢失的直接证据 —— 剩余数量为 0 时集合必然为空,不能只看数量。
		expect({
			errors: result.errors,
			remaining: remainingIds.length,
			remainingIds: [...remainingIds].sort(),
		}).toEqual({
			errors: 1,
			remaining: 6,
			remainingIds: [...oldIds].sort(),
		});
	});
});

// ---------------------------------------------------------------------------
// 2. 行为记录(通过):把机制真实行为写成可复核断言
// ---------------------------------------------------------------------------

describe('现有机制行为记录', () => {
	it('零向量查询 - 512 维全零 - 返回索引数组前 100 项且相似度为 NaN', async () => {
		const ws = workspace('ratel-t0-zero-');
		const dir = ws.mkdir('index');
		const index = await createDocumentIndex({ folderPath: dir });
		await seedBlocks(index, 'notes/a.md', 130, DIMENSIONS_512);
		await seedBlocks(index, 'notes/b.md', 40, DIMENSIONS_512);

		const allIds = (await index.listItems()).map((item) => item.id);
		const results = await index.queryItems(new Array<number>(DIMENSIONS_512).fill(0), '', 100);

		// 关键路径:零向量范数为 0,余弦相似度全部 NaN,堆比较恒为 false,
		// 因此 topK 退化成「数组前 100 项」,与相似度和文件归属无关。
		expect(results).toHaveLength(100);
		expect(results.map((result) => result.item.id)).toEqual(allIds.slice(0, 100));
		expect(results.every((result) => Number.isNaN(result.score))).toBe(true);
		expect(allIds).toHaveLength(170);
	});

	it('reembedFile 调用链 - 推理开始前 - 旧块已被删除(先删后推理)', async () => {
		// 关键路径:调用链为 PersistentIndexBackend.smartReindex → worker `index.batch`
		// → IndexProcessor.indexBatch → reembedFile → deleteByPath → 分块/嵌入。
		// 该顺序意味着推理失败时旧版本已经不在索引里;T2 必须改成「推理完成后再替换」。
		const ws = workspace('ratel-t0-order-');
		const dir = ws.mkdir('index');
		const store = new VectraStore(dir);
		await store.isIndexCreated();
		await seedStoreBlocks(store, 'notes/target.md', 5, DIMENSIONS_512);

		let blocksDuringEmbed = -1;
		const port = new FakeEmbeddingPort(DIMENSIONS_512);
		const observingPort = {
			dimensions: DIMENSIONS_512,
			modelId: 'test:observing',
			async embed(texts: string[]): Promise<number[][]> {
				// 关键路径:在推理回调内读取磁盘真值,确认旧块此时是否还在。
				blocksDuringEmbed = await countBlocks(dir, 'notes/target.md');
				return port.embed(texts);
			},
		};
		const processor = new IndexProcessor(store, observingPort, T0_CHUNK_OPTIONS);
		const content = markdownWithSections(2);
		const result = await processor.indexBatch([{ path: 'notes/target.md', content }]);

		expect(result.errors).toBe(0);
		// 关键路径:当前实现先删旧块,推理时磁盘上已无该路径的块 —— 这是数据丢失的根因。
		expect(blocksDuringEmbed).toBe(0);
		expect(await countBlocks(dir, 'notes/target.md')).toBe(expectedChunks(content));
	});

	it('事务进行中 - 调用 listItems - 返回已提交视图而不含未提交块', async () => {
		const ws = workspace('ratel-t0-view-');
		const dir = ws.mkdir('index');
		const index = await createDocumentIndex({ folderPath: dir });
		await seedBlocks(index, 'notes/a.md', 5, DIMENSIONS_512);

		await index.beginUpdate();
		try {
			await index.upsertItem({
				id: 'notes/a.md#chunk-new',
				vector: deterministicVector('new', DIMENSIONS_512),
				metadata: blockMetadata('notes/a.md', 99),
			});
			// 关键路径:事务内的枚举看到的是已提交快照 —— 删除枚举必须在插入前完成。
			expect((await index.listItems()).some((item) => item.id === 'notes/a.md#chunk-new')).toBe(false);
			expect((await listBlockIds(index, 'notes/a.md')).length).toBe(5);
		} finally {
			index.cancelUpdate();
		}
	});

	it('外置 metadata - 删除块后 - metadata 文件不被回收', async () => {
		const ws = workspace('ratel-t0-meta-delete-');
		const dir = ws.mkdir('index');
		const storage = new AtomicTestFileStorage();
		const index = await createDocumentIndex({ folderPath: dir, storage, indexedMetadataKeys: ['path'] });
		await index.beginUpdate();
		try {
			await index.upsertItem({
				id: 'notes/e.md#chunk-0',
				vector: deterministicVector('e', DIMENSIONS_512),
				metadata: blockMetadata('notes/e.md', 0, { prefix: '前缀' }),
			});
			await index.endUpdate();
		} catch (err) {
			index.cancelUpdate();
			throw err;
		}
		const metadataFilesAfterSeed = fs
			.readdirSync(dir)
			.filter((name) => name !== 'index.json' && name !== 'catalog.json');
		expect(metadataFilesAfterSeed).toHaveLength(1);

		await index.beginUpdate();
		try {
			await index.deleteItems(['notes/e.md#chunk-0']);
			await index.endUpdate();
		} catch (err) {
			index.cancelUpdate();
			throw err;
		}

		expect(await listBlockIds(index, 'notes/e.md')).toEqual([]);
		// 关键路径:deleteItems 只从 items 数组移除条目,不删除外置 metadata 文件。
		const metadataFilesAfterDelete = fs
			.readdirSync(dir)
			.filter((name) => name !== 'index.json' && name !== 'catalog.json');
		expect(metadataFilesAfterDelete).toEqual(metadataFilesAfterSeed);
	});

	it('向量维度 - 同一索引写入 512 与 768 维 - 不会被拒绝', async () => {
		const ws = workspace('ratel-t0-mixed-');
		const dir = ws.mkdir('index');
		const index = await createDocumentIndex({ folderPath: dir });
		await seedBlocks(index, 'notes/a.md', 2, DIMENSIONS_512);
		await seedBlocks(index, 'notes/b.md', 2, 768);

		// 关键路径:vectra 不校验维度,混合维度会被接受;T1 必须在写入前自行校验。
		expect((await index.listItems()).length).toBe(4);
		expect(await listBlockIds(index, 'notes/a.md')).toHaveLength(2);
		expect(await listBlockIds(index, 'notes/b.md')).toHaveLength(2);
	});

	it('外置 metadata - path 未列入 indexed 键 - listItems 无法按 path 枚举', async () => {
		const ws = workspace('ratel-t0-ext-meta-');
		const dir = ws.mkdir('index');
		const storage = new AtomicTestFileStorage();
		const index = await createDocumentIndex({ folderPath: dir, storage, indexedMetadataKeys: ['chunkIndex'] });
		await index.beginUpdate();
		try {
			await index.upsertItem({
				id: 'notes/d.md#chunk-0',
				vector: deterministicVector('d', DIMENSIONS_512),
				metadata: blockMetadata('notes/d.md', 0),
			});
			await index.endUpdate();
		} catch (err) {
			index.cancelUpdate();
			throw err;
		}

		const items = await index.listItems();
		// 关键路径:索引文件只保留 indexed 键,path 落在外置 metadata 文件里。
		expect(items).toHaveLength(1);
		expect(items[0]?.metadata).toEqual({ chunkIndex: 0 });
		expect(await listBlockIdsByMetadata(index, 'notes/d.md')).toHaveLength(0);
		expect(storage.writes.some((write) => write.kind === 'metadata')).toBe(true);
		// 关键路径:磁盘 index.json 同样看不到 path,删除枚举不能只依赖它。
		expect(await readDiskBlockIds(dir, 'notes/d.md')).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 3. 完整枚举与同事务替换(通过)
// ---------------------------------------------------------------------------

describe('完整枚举与同事务替换', () => {
	it('listItems - 150 块目标文件 - 枚举出全部块且两种枚举方式一致', async () => {
		const ws = workspace('ratel-t0-enum-');
		const dir = ws.mkdir('index');
		const index = await createDocumentIndex({ folderPath: dir });
		await seedBlocks(index, 'notes/other.md', 20, DIMENSIONS_512);
		await seedBlocks(index, 'notes/big.md', 150, DIMENSIONS_512);

		const targetIds = await listBlockIds(index, 'notes/big.md');
		const byMetadata = await listBlockIdsByMetadata(index, 'notes/big.md');

		expect(targetIds).toHaveLength(150);
		expect(byMetadata).toEqual(targetIds);
		expect(await listBlockIds(index, 'notes/other.md')).toHaveLength(20);
	});

	it('单事务替换 - 150 旧块换 120 新块 - 一次索引写入且重载后为完整新版本', async () => {
		const ws = workspace('ratel-t0-replace-');
		const dir = ws.mkdir('index');
		const storage = new AtomicTestFileStorage();
		const index = await createDocumentIndex({ folderPath: dir, storage });
		await seedBlocks(index, 'notes/other.md', 20, DIMENSIONS_512);
		await seedBlocks(index, 'notes/big.md', 150, DIMENSIONS_512);
		const otherBefore = await listBlockIds(index, 'notes/other.md');

		// 1. 准备完整新向量
		const blocks = Array.from({ length: 120 }, (_unused, i) => ({
			id: `notes/big.md#chunk-${i}`,
			vector: deterministicVector(`new-block-${i}`, DIMENSIONS_512),
			metadata: blockMetadata('notes/big.md', i, { commitId: 'commit-new' }),
		}));
		const writesBefore = storage.indexWriteCount();

		// 2. 开启事务
		let oldIds: string[] = [];
		await index.beginUpdate();
		try {
			// 3. 事务内用公开枚举取全部旧块 ID,再一次性删除
			oldIds = await listBlockIds(index, 'notes/big.md');
			expect(oldIds).toHaveLength(150);
			await index.deleteItems(oldIds);
			// 4. 写入全部新块
			for (const block of blocks) {
				await index.upsertItem(block);
			}
			// 5. 提交
			await index.endUpdate();
		} catch (err) {
			index.cancelUpdate();
			throw err;
		}

		// 关键路径:整次替换只产生一次索引文件写入。
		expect(storage.indexWriteCount() - writesBefore).toBe(1);

		const expectedIds = blocks.map((block) => block.id);
		expect(await listBlockIds(index, 'notes/big.md')).toEqual(expectedIds);
		expect(await listBlockIds(index, 'notes/other.md')).toEqual(otherBefore);
		expect(await readDiskBlockIds(dir, 'notes/big.md')).toEqual(expectedIds);

		// 6. 重建存储实例读取确认
		const reloaded = await openIndexForRead(dir);
		expect(await listBlockIds(reloaded, 'notes/big.md')).toEqual(expectedIds);
		expect(await listBlockIds(reloaded, 'notes/other.md')).toEqual(otherBefore);
		// 关键路径:旧块 #120~#149 必须消失,不能靠「数量相同」判断提交成功。
		const staleIds = oldIds.filter((id) => Number(id.split('#chunk-')[1] ?? '0') >= 120);
		expect(staleIds).toHaveLength(30);
		const diskIds = await readDiskBlockIds(dir, 'notes/big.md');
		expect(diskIds.filter((id) => staleIds.includes(id))).toEqual([]);
	});

	it('事务回滚 - 删除并插入后抛错 - 磁盘与内存都保持完整旧版本', async () => {
		const ws = workspace('ratel-t0-rollback-');
		const dir = ws.mkdir('index');
		const index = await createDocumentIndex({ folderPath: dir });
		await seedBlocks(index, 'notes/other.md', 20, DIMENSIONS_512);
		await seedBlocks(index, 'notes/big.md', 150, DIMENSIONS_512);
		const oldIds = await listBlockIds(index, 'notes/big.md');
		const otherBefore = await listBlockIds(index, 'notes/other.md');

		await index.beginUpdate();
		let caught: unknown;
		try {
			await index.deleteItems(oldIds);
			for (let i = 0; i < 120; i++) {
				await index.upsertItem({
					id: `notes/big.md#chunk-${i}`,
					vector: deterministicVector(`new-${i}`, DIMENSIONS_512),
					metadata: blockMetadata('notes/big.md', i),
				});
			}
			// 模拟插入完成后抛错
			throw new Error('注入故障:插入后抛错');
		} catch (err) {
			caught = err;
			index.cancelUpdate();
		}

		expect(caught).toBeInstanceOf(Error);
		// 关键路径:cancelUpdate 只丢弃内存事务,未提交时磁盘从未写入。
		expect(await listBlockIds(index, 'notes/big.md')).toEqual(oldIds);
		expect(await readDiskBlockIds(dir, 'notes/big.md')).toEqual(oldIds);
		const reloaded = await openIndexForRead(dir);
		expect(await listBlockIds(reloaded, 'notes/big.md')).toEqual(oldIds);
		expect(await listBlockIds(reloaded, 'notes/other.md')).toEqual(otherBefore);
	});

	it('单事务替换 - 目标文件变空 - 删除全部块且其他文件不变', async () => {
		const ws = workspace('ratel-t0-clear-');
		const dir = ws.mkdir('index');
		const storage = new AtomicTestFileStorage();
		const index = await createDocumentIndex({ folderPath: dir, storage });
		await seedBlocks(index, 'notes/other.md', 20, DIMENSIONS_512);
		await seedBlocks(index, 'notes/big.md', 150, DIMENSIONS_512);
		const otherBefore = await listBlockIds(index, 'notes/other.md');

		await index.beginUpdate();
		try {
			const oldIds = await listBlockIds(index, 'notes/big.md');
			await index.deleteItems(oldIds);
			await index.endUpdate();
		} catch (err) {
			index.cancelUpdate();
			throw err;
		}

		expect(await listBlockIds(index, 'notes/big.md')).toEqual([]);
		expect(await listBlockIds(index, 'notes/other.md')).toEqual(otherBefore);
		const reloaded = await openIndexForRead(dir);
		expect(await listBlockIds(reloaded, 'notes/big.md')).toEqual([]);
		expect(await listBlockIds(reloaded, 'notes/other.md')).toEqual(otherBefore);
	});
});

// ---------------------------------------------------------------------------
// 4. 原子存储注入(通过)
// ---------------------------------------------------------------------------

describe('原子存储注入', () => {
	it('存储注入 - 通过公开 storage 配置 - 索引创建与提交都经过注入实例', async () => {
		const ws = workspace('ratel-t0-inject-');
		const dir = ws.mkdir('index');
		const storage = new AtomicTestFileStorage();
		const index = await createDocumentIndex({ folderPath: dir, storage });

		expect(index.storage).toBe(storage);
		expect(storage.writes.map((write) => write.kind)).toEqual(['index', 'catalog']);
		expect(storage.indexWriteCount()).toBe(1);
	});

	it('endUpdate - 事务进行中 - 索引文件保持旧版本且仅在提交时写入一次', async () => {
		const ws = workspace('ratel-t0-timing-');
		const dir = ws.mkdir('index');
		const storage = new AtomicTestFileStorage();
		const index = await createDocumentIndex({ folderPath: dir, storage });
		await seedBlocks(index, 'notes/a.md', 3, DIMENSIONS_512);

		const before = await readDiskIndexFile(dir);
		const writesOffset = storage.writes.length;
		const indexWritesBefore = storage.indexWriteCount();

		await index.beginUpdate();
		try {
			for (let i = 0; i < 5; i++) {
				await index.upsertItem({
					id: `notes/a.md#chunk-${i}`,
					vector: deterministicVector(`timing-${i}`, DIMENSIONS_512),
					metadata: blockMetadata('notes/a.md', i),
				});
			}
			const duringDisk = await readDiskIndexFile(dir);
			// 关键路径:事务期间索引文件不变,写入只发生在 endUpdate。
			expect(duringDisk.text).toBe(before.text);
			expect(duringDisk.bytes).toBe(before.bytes);
			expect(storage.indexWriteCount()).toBe(indexWritesBefore);
			await index.endUpdate();
		} catch (err) {
			index.cancelUpdate();
			throw err;
		}

		expect(storage.indexWriteCount()).toBe(indexWritesBefore + 1);
		const after = await readDiskIndexFile(dir);
		expect(after.text).not.toBe(before.text);
		// 关键路径:先写索引文件,再写 catalog;两者各自原子替换。
		expect(storage.writes.slice(writesOffset).map((write) => write.kind)).toEqual(['index', 'catalog']);
	});

	it('提交失败 - rename 完成后抛错 - 磁盘为新版而内存为旧版且必须重建实例', async () => {
		const ws = workspace('ratel-t0-after-rename-');
		const dir = ws.mkdir('index');
		let armed = false;
		const storage = new AtomicTestFileStorage({ failure: 'after-rename', failOn: () => armed });
		const index = await createDocumentIndex({ folderPath: dir, storage });
		await seedBlocks(index, 'notes/a.md', 3, DIMENSIONS_512);
		const oldIds = await listBlockIds(index, 'notes/a.md');

		armed = true;
		await index.beginUpdate();
		await index.deleteItems(oldIds);
		await index.upsertItem({
			id: 'notes/a.md#chunk-0',
			vector: deterministicVector('new', DIMENSIONS_512),
			metadata: blockMetadata('notes/a.md', 0),
		});
		let caught: unknown;
		try {
			await index.endUpdate();
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(Error);
		// 关键路径:vectra 把底层错误包装成新的 Error,原始文案与类型丢失。
		// 这里不断言上游英文文案(vectra 升级会无谓失败);包装事实与实测文案
		// 记录在 docs/superpowers/plans/2026-10-31-index-reliability-t0-evidence.md 第 3 节。
		// 磁盘已是新版(rename 已生效),不能把「endUpdate 抛错」等同于「磁盘仍是旧版」。
		expect(await readDiskBlockIds(dir, 'notes/a.md')).toEqual(['notes/a.md#chunk-0']);
		// 内存仍是旧版:失败路径没有更新已提交视图。
		expect(await listBlockIds(index, 'notes/a.md')).toEqual(oldIds);
		// 事务未清空,同一实例不能直接开始下一次提交。
		await expect(index.beginUpdate()).rejects.toThrow('Update already in progress');
		// 取消后内存仍是旧版:已加载的视图不会自动重读磁盘。
		index.cancelUpdate();
		expect(await listBlockIds(index, 'notes/a.md')).toEqual(oldIds);
		// 只有重建实例才能确定磁盘真值。
		const reloaded = await openIndexForRead(dir);
		expect(await listBlockIds(reloaded, 'notes/a.md')).toEqual(['notes/a.md#chunk-0']);
	});

	it('提交失败 - 目录 catalog 写入失败 - 索引已提交而 catalog 保持旧版', async () => {
		const ws = workspace('ratel-t0-catalog-fail-');
		const dir = ws.mkdir('index');
		let armed = false;
		const storage = new AtomicTestFileStorage({
			failure: 'after-rename',
			failOn: (filePath) => armed && filePath.endsWith('catalog.json'),
		});
		const index = await createDocumentIndex({ folderPath: dir, storage });
		await seedBlocks(index, 'notes/a.md', 3, DIMENSIONS_512);
		const oldIds = await listBlockIds(index, 'notes/a.md');

		armed = true;
		await index.beginUpdate();
		await index.deleteItems(oldIds);
		await index.upsertItem({
			id: 'notes/a.md#chunk-0',
			vector: deterministicVector('new', DIMENSIONS_512),
			metadata: blockMetadata('notes/a.md', 0),
		});
		let caught: unknown;
		try {
			await index.endUpdate();
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(Error);
		// 关键路径:catalog 失败同样被包装,不断言上游英文文案(vectra 升级会无谓失败)。
		// 关键路径:index.json 与 catalog.json 是两次独立写入,不是跨文件事务。
		const indexWrites = storage.writes.filter((write) => write.kind === 'index');
		const catalogWrites = storage.writes.filter((write) => write.kind === 'catalog');
		expect(indexWrites.at(-1)?.outcome).toBe('renamed');
		expect(catalogWrites.at(-1)?.outcome).toBe('failed-after-rename');
		// 索引已是新版,内存已提交视图也已切到新版(super.endUpdate 先成功)。
		expect(await readDiskBlockIds(dir, 'notes/a.md')).toEqual(['notes/a.md#chunk-0']);
		expect(await listBlockIds(index, 'notes/a.md')).toEqual(['notes/a.md#chunk-0']);
	});

	it('提交失败 - 临时文件写入前抛错 - 原索引字节不变且临时文件被清理', async () => {
		const ws = workspace('ratel-t0-before-write-');
		const dir = ws.mkdir('index');
		let armed = false;
		const storage = new AtomicTestFileStorage({ failure: 'before-write', failOn: () => armed });
		const index = await createDocumentIndex({ folderPath: dir, storage });
		await seedBlocks(index, 'notes/a.md', 3, DIMENSIONS_512);
		const oldIds = await listBlockIds(index, 'notes/a.md');
		const before = await readDiskIndexFile(dir);

		armed = true;
		await index.beginUpdate();
		await index.upsertItem({
			id: 'notes/a.md#chunk-0',
			vector: deterministicVector('new', DIMENSIONS_512),
			metadata: blockMetadata('notes/a.md', 0),
		});
		let caught: unknown;
		try {
			await index.endUpdate();
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(Error);
		const after = await readDiskIndexFile(dir);
		// 关键路径:rename 之前的失败必须让原文件逐字节保持不变。
		expect(after.text).toBe(before.text);
		expect(after.bytes).toBe(before.bytes);
		expect(fs.readdirSync(dir).filter((name) => name.includes('.tmp-'))).toEqual([]);
		expect(await listBlockIds(index, 'notes/a.md')).toEqual(oldIds);
		expect(await readDiskBlockIds(dir, 'notes/a.md')).toEqual(oldIds);
		index.cancelUpdate();
	});

	it('外置 metadata - 事务取消 - metadata 文件已落盘并成为孤儿文件', async () => {
		const ws = workspace('ratel-t0-orphan-meta-');
		const dir = ws.mkdir('index');
		const storage = new AtomicTestFileStorage();
		const index = await createDocumentIndex({ folderPath: dir, storage, indexedMetadataKeys: ['path'] });

		await index.beginUpdate();
		await index.upsertItem({
			id: 'notes/a.md#chunk-0',
			vector: deterministicVector('a', DIMENSIONS_512),
			metadata: blockMetadata('notes/a.md', 0),
		});
		// 关键路径:外置 metadata 在 upsertItem 阶段就写盘,不等待 endUpdate。
		expect(storage.writes.filter((write) => write.kind === 'metadata')).toHaveLength(1);
		index.cancelUpdate();

		const files = fs.readdirSync(dir);
		const metadataFiles = files.filter((name) => name !== 'index.json' && name !== 'catalog.json');
		expect(metadataFiles).toHaveLength(1);
		// 索引里没有该块,metadata 文件成为无引用孤儿 —— T1 需要纳入写入/清理统计。
		expect(await readDiskBlockIds(dir, 'notes/a.md')).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 5. 门槛守卫(通过)
// ---------------------------------------------------------------------------

/**
 * 构造「访问私有字段」的检测正则。
 *
 * 关键路径:前缀覆盖点访问、下标访问(单/双引号与模板字符串)与解构赋值三种形式;
 * 正则不带 `g` / `y`,因此 `test` 不读写 `lastIndex`,重复调用无状态。
 *
 * @param field - 私有字段名(由调用方用拼接构造,避免断言自身文本命中)。
 * @returns 检测正则。
 */
function privateAccessPattern(field: string): RegExp {
	return new RegExp(`(?:\\.\\s*|\\[\\s*['"\`]|\\{\\s*)${field}(?![A-Za-z0-9_$])`);
}

/**
 * 判断已安装版本是否落在仓库声明的 caret 范围内。
 *
 * 关键路径:只覆盖仓库实际使用的 `^x.y.z` 声明;`^0.x.y` 的语义是 `<0.(x+1).0`,
 * `^1.x.y` 允许 minor 升级,两者分开判断。
 *
 * @param version - 已安装版本(三段式)。
 * @param range - 声明的范围(带 `^`)。
 * @returns 是否满足。
 */
function satisfiesCaretVersion(version: string, range: string): boolean {
	const versionMatch = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	const rangeMatch = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
	if (!versionMatch || !rangeMatch) return false;
	const major = Number(versionMatch[1]);
	const minor = Number(versionMatch[2]);
	const patch = Number(versionMatch[3]);
	const rangeMajor = Number(rangeMatch[1]);
	const rangeMinor = Number(rangeMatch[2]);
	const rangePatch = Number(rangeMatch[3]);
	if (major !== rangeMajor) return false;
	if (rangeMajor > 0) {
		if (minor !== rangeMinor) return minor > rangeMinor;
		return patch >= rangePatch;
	}
	if (minor !== rangeMinor) return false;
	return patch >= rangePatch;
}

/**
 * 收集依赖目录内的本地补丁痕迹。
 *
 * 关键路径:只检查「显式痕迹」(补丁文件、含项目名的改动标记),不能发现
 * 保持文件名与版本号的原地修改;权威校验是用 lockfile 重装(`npm ci`)。
 *
 * @param packageRoot - 依赖包目录。
 * @returns 命中痕迹的文件绝对路径。
 */
function collectPatchTraces(packageRoot: string): string[] {
	const traces: string[] = [];
	const pending: string[] = [packageRoot];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) break;
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			// 关键路径:嵌套 node_modules 不是该包自身源码,跳过以免扫描整棵依赖树。
			if (entry.name === 'node_modules') continue;
			const fullPath = path.join(current, entry.name);
			if (entry.isDirectory()) {
				pending.push(fullPath);
				continue;
			}
			if (/\.(patch|rej|orig)$/i.test(entry.name)) {
				traces.push(fullPath);
				continue;
			}
			// 关键路径:只读文本类文件,避免把二进制资源当字符串解析;
			// 标记用词边界,避免 `separately` 这类单词里的 `ratel` 误报。
			if (!/\.(?:js|mjs|cjs|ts|json|md|map)$/i.test(entry.name)) continue;
			if (/\bratel\b/i.test(fs.readFileSync(fullPath, 'utf8'))) traces.push(fullPath);
		}
	}
	return traces;
}

describe('门槛守卫', () => {
	it('公开 API - 适配器、Worker 处理器与实验文件都不访问 vectra 私有字段', () => {
		// 关键路径:用拼接构造被禁令牌,避免断言自身文本命中。
		const privateFields = [`_${'data'}`, `_${'update'}`];
		const files = [
			path.join(REPO_ROOT, 'src/adapters/vector-vectra.ts'),
			path.join(REPO_ROOT, 'src/worker/index-processor.ts'),
			path.join(REPO_ROOT, 'tests/helpers/index-reliability-fixture.ts'),
			path.join(REPO_ROOT, 'tests/helpers/index-reliability-production.ts'),
			path.join(REPO_ROOT, 'tests/adapters/vector-vectra-baseline.test.ts'),
			SELF_PATH,
		];
		for (const file of files) {
			const source = fs.readFileSync(file, 'utf8');
			for (const field of privateFields) {
				expect(
					privateAccessPattern(field).test(source),
					`${path.basename(file)} 访问了私有字段 ${field}`,
				).toBe(false);
			}
		}
	});

	it('依赖约束 - vectra 版本与仓库声明一致 - 目录内无本地补丁痕迹(记录性断言)', () => {
		// 关键路径:这是**记录性断言** —— 它能发现版本漂移与显式补丁痕迹,
		// 但不能证明 node_modules 未被修改(原地改文件且不动版本号同样成立);
		// 权威校验是用 lockfile 重装(`npm ci`)后比对 integrity,不在本用例能力范围内。
		const packageRoot = path.join(REPO_ROOT, 'node_modules/vectra');
		const installed = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
			name?: string;
			version?: string;
		};
		const declared = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
			dependencies?: Record<string, string>;
		};
		const range = declared.dependencies?.vectra ?? '';

		expect(installed.name).toBe('vectra');
		expect(installed.version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(range).toMatch(/^\^\d+\.\d+\.\d+$/);
		expect(satisfiesCaretVersion(installed.version ?? '', range)).toBe(true);
		expect(collectPatchTraces(packageRoot)).toEqual([]);
	});
});
