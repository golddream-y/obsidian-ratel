import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AtomicIndexStorage } from '../../src/adapters/atomic-index-storage';
import { VectraStore } from '../../src/adapters/vector-vectra';
import { createShardedStore } from '../../src/adapters/vector-vectra-sharded';
import { ensureShardLayout, migrateSingleFileIndex, readShardLayout } from '../../src/core/index-shard-migration';
import { MIN_SHARDS } from '../../src/core/index-shard-routing';

const roots: string[] = [];

afterEach(async () => {
	while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

async function exists(target: string): Promise<boolean> {
	try {
		await access(target);
		return true;
	}
	catch {
		return false;
	}
}

interface StoredItem {
	id: string;
	vector: number[];
	norm: number;
	metadata: Record<string, unknown>;
}

async function readAllItems(root: string): Promise<StoredItem[]> {
	const shardsDir = path.join(root, 'shards');
	const directories = (await readdir(shardsDir, { withFileTypes: true })).filter((entry) => entry.isDirectory());
	const items: StoredItem[] = [];
	for (const directory of directories) {
		const file = path.join(shardsDir, directory.name, 'index.json');
		const parsed = JSON.parse(await readFile(file, 'utf8')) as { items: StoredItem[] };
		items.push(...parsed.items);
	}
	return items;
}

const PATHS = ['n0.md', 'n1.md', 'n2.md', 'n3.md', 'n4.md', 'n5.md', 'n6.md'];

async function writeLegacyIndex(root: string): Promise<void> {
	const legacy = new VectraStore(root, {
		autoInit: false,
		storage: new AtomicIndexStorage({ generationRoot: root }),
	});
	await legacy.init();
	for (const [index, relativePath] of PATHS.entries()) {
		await legacy.replaceFile({
			path: relativePath,
			commitId: 'c1',
			blocks: [
				{
					id: `${relativePath}#0`,
					vector: [index + 1, 0.1, 0, 0],
					metadata: { path: relativePath, commitId: 'c1', revision: 1 },
				},
			],
		});
	}
}

describe('旧单份布局迁移', () => {
	it('拆分后块集合与旧索引一致 - 向量与范数原样搬迁', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'ratel-migrate-'));
		roots.push(root);
		await writeLegacyIndex(root);
		const result = await migrateSingleFileIndex({ generationRoot: root });
		expect(result.migrated).toBe(true);
		expect(result.shardCount).toBeGreaterThanOrEqual(8);
		const items = await readAllItems(root);
		expect(items).toHaveLength(PATHS.length);
		// 向量与范数原样搬迁,不重新计算。
		expect(items.map((item) => item.id).sort()).toEqual(PATHS.map((p) => `${p}#0`).sort());
		expect(items.every((item) => item.norm > 0)).toBe(true);

		const sharded = createShardedStore({ root, shardCount: result.shardCount });
		await sharded.init();
		const inspected = await sharded.inspectFiles(PATHS);
		for (const relativePath of PATHS) expect(inspected.get(relativePath)).toHaveLength(1);
	});

	it('已存在 shards 布局 - 直接跳过 - 不重复拆分', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'ratel-migrate-'));
		roots.push(root);
		await writeLegacyIndex(root);
		const first = await migrateSingleFileIndex({ generationRoot: root });
		const second = await migrateSingleFileIndex({ generationRoot: root });
		expect(first.migrated).toBe(true);
		expect(second.migrated).toBe(false);
		expect(second.shardCount).toBe(first.shardCount);
	});

	it('写入中途失败 - 保留旧 index.json - 下次可重试', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'ratel-migrate-'));
		roots.push(root);
		await writeLegacyIndex(root);
		await expect(migrateSingleFileIndex({ generationRoot: root, failAfterShard: 2 })).rejects.toThrow();
		expect(await exists(path.join(root, 'index.json'))).toBe(true);
		expect(await exists(path.join(root, 'shards', 'layout.json'))).toBe(false);
		// 重试成功,且旧文件归档不参与后续装配。
		const retry = await migrateSingleFileIndex({ generationRoot: root });
		expect(retry.migrated).toBe(true);
		expect(await exists(path.join(root, 'index.json.legacy'))).toBe(true);
	});
});

describe('分片布局只读读取', () => {
	it('已有布局 - 返回片数与块数', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'ratel-migrate-'));
		roots.push(root);
		await writeLegacyIndex(root);
		const migrated = await migrateSingleFileIndex({ generationRoot: root });
		const layout = await readShardLayout(root);
		expect(layout).not.toBeNull();
		expect(layout?.shardCount).toBe(migrated.shardCount);
		expect(layout?.blockCount).toBe(PATHS.length);
	});

	it('布局缺失 - 返回 null - 不抛错', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'ratel-migrate-'));
		roots.push(root);
		// 未迁移的空目录:既没有 shards/layout.json,也不该因此抛错。
		await expect(readShardLayout(root)).resolves.toBeNull();
	});
});

describe('全新库布局补齐', () => {
	it('无布局的空代际 - 写入合法 layout - 片数与块数如实记录', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'ratel-migrate-'));
		roots.push(root);
		const written = await ensureShardLayout(root, MIN_SHARDS);
		expect(written).toEqual({ shardCount: MIN_SHARDS, blockCount: 0 });
		const layout = await readShardLayout(root);
		expect(layout).toEqual({ shardCount: MIN_SHARDS, blockCount: 0 });
		const raw = JSON.parse(await readFile(path.join(root, 'shards', 'layout.json'), 'utf8')) as Record<string, unknown>;
		expect(raw).toMatchObject({ version: 1, shardCount: MIN_SHARDS, blockCount: 0 });
		expect(typeof raw['migratedAt']).toBe('number');
		// 关键路径:补布局不是迁移,不得产生单份 index.json。
		expect(await exists(path.join(root, 'index.json'))).toBe(false);
	});

	it('已有布局 - 原样返回 - 不覆盖既有片数', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'ratel-migrate-'));
		roots.push(root);
		await ensureShardLayout(root, MIN_SHARDS);
		const before = await readFile(path.join(root, 'shards', 'layout.json'), 'utf8');
		const second = await ensureShardLayout(root, MIN_SHARDS * 2);
		expect(second).toEqual({ shardCount: MIN_SHARDS, blockCount: 0 });
		// 幂等:文件内容逐字不变。
		expect(await readFile(path.join(root, 'shards', 'layout.json'), 'utf8')).toBe(before);
	});

	it('片数非法 - 明确拒绝 - 不落任何布局文件', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'ratel-migrate-'));
		roots.push(root);
		await expect(ensureShardLayout(root, 0)).rejects.toThrow('分片数必须是正整数');
		expect(await exists(path.join(root, 'shards', 'layout.json'))).toBe(false);
	});
});
