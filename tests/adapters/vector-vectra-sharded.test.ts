import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createShardedStore } from '../../src/adapters/vector-vectra-sharded';

const roots: string[] = [];

afterEach(async () => {
	while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

function block(id: string, vector: number[]) {
	return {
		id,
		vector,
		metadata: { path: id.split('#')[0]!, commitId: 'c1', revision: 1, docId: id, documentId: id },
	};
}

async function makeStore(shardCount = 8) {
	const root = await mkdtemp(path.join(os.tmpdir(), 'ratel-shard-'));
	roots.push(root);
	const store = createShardedStore({ root, shardCount });
	await store.init();
	return { root, store, shardCount };
}

function shardIndexFile(root: string, store: ReturnType<typeof createShardedStore>, relativePath: string): string {
	return path.join(root, 'shards', store.shardDirectoryOf(store.shardIdOf(relativePath)), 'index.json');
}

describe('分片存储 - 写入隔离', () => {
	it('两个不同分片的路径 - 只写各自分片 - 互不改写', async () => {
		const { root, store, shardCount } = await makeStore(8);
		await store.replaceFile({ path: 'a.md', commitId: 'c1', blocks: [block('a.md#0', [1, 0, 0, 0])] });
		const shardOfA = store.shardIdOf('a.md');
		const shardOfB = (shardOfA + 1) % shardCount;
		// 目标路径必须真的落在 shardOfB 上,否则用例断言的是另一片。
		let target = '';
		for (let index = 0; index < 10_000; index += 1) {
			const candidate = `b-${index}.md`;
			if (store.shardIdOf(candidate) === shardOfB) {
				target = candidate;
				break;
			}
		}
		expect(target).not.toBe('');
		await store.replaceFile({ path: target, commitId: 'c1', blocks: [block(`${target}#0`, [0, 1, 0, 0])] });

		const aFile = shardIndexFile(root, store, 'a.md');
		const bFile = shardIndexFile(root, store, target);
		const aBefore = await stat(aFile);
		await store.replaceFile({ path: target, commitId: 'c2', blocks: [block(`${target}#0`, [0, 1, 1, 0])] });
		const aAfter = await stat(aFile);
		expect(aAfter.mtimeMs).toBe(aBefore.mtimeMs);
		expect((await stat(bFile)).size).toBeGreaterThan(0);
	});

	it('批量写入 - 批内不落盘 - 批末每片只提交一次', async () => {
		const { root, store } = await makeStore(4);
		await store.replaceFile({ path: 'p0.md', commitId: 'c1', blocks: [block('p0.md#0', [1, 0, 0, 0])] });
		const file = shardIndexFile(root, store, 'p0.md');
		const before = await stat(file);
		await store.beginWriteBatch();
		const paths = ['p0.md', 'p1.md', 'p2.md', 'p3.md', 'p4.md', 'p5.md'];
		for (const p of paths) {
			await store.replaceFile({ path: p, commitId: 'c1', blocks: [block(`${p}#0`, [1, 1, 0, 0])] });
		}
		expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
		await store.endWriteBatch();
		expect((await stat(file)).mtimeMs).toBeGreaterThan(before.mtimeMs);
		expect((await store.inspectFiles(paths)).size).toBe(paths.length);
	});

	it('批内首次写入尚未加载的分片 - 该片也纳入批量提交', async () => {
		const { root, store } = await makeStore(8);
		await store.beginWriteBatch();
		// 先记为基线:批内首次写到某片时,该片索引不应立刻落盘。
		const fresh = 'fresh.md';
		const file = shardIndexFile(root, store, fresh);
		const before = await stat(file);
		await store.replaceFile({ path: fresh, commitId: 'c1', blocks: [block('fresh.md#0', [0, 0, 1, 0])] });
		expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
		await store.endWriteBatch();
		expect((await stat(file)).mtimeMs).toBeGreaterThan(before.mtimeMs);
		expect(await store.inspectFile(fresh)).toHaveLength(1);
	});

	it('删除路径 - 只影响该路径所在分片', async () => {
		const { store } = await makeStore(8);
		await store.replaceFile({ path: 'x.md', commitId: 'c1', blocks: [block('x.md#0', [1, 0, 0, 0])] });
		await store.replaceFile({ path: 'y.md', commitId: 'c1', blocks: [block('y.md#0', [0, 1, 0, 0])] });
		expect(await store.deleteByPath('x.md')).toBe(1);
		expect(await store.inspectFile('x.md')).toHaveLength(0);
		expect(await store.inspectFile('y.md')).toHaveLength(1);
	});
});
