import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AtomicIndexStorage } from '../../src/adapters/atomic-index-storage';
import { VectraStore } from '../../src/adapters/vector-vectra';
import { createShardedStore } from '../../src/adapters/vector-vectra-sharded';
import { migrateSingleFileIndex } from '../../src/core/index-shard-migration';

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
