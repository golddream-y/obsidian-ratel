import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AtomicIndexStorage } from '../../src/adapters/atomic-index-storage';
import { VectraStore } from '../../src/adapters/vector-vectra';
import { createShardedStore } from '../../src/adapters/vector-vectra-sharded';
import { archiveLegacySingleFileIndex, ensureShardLayout, readShardLayout } from '../../src/core/index-shard-migration';
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

describe('旧单份索引归档（不再拆分）', () => {
	it('旧单份索引存在 - 改名为 legacy - 不解析也不建分片', async () => {
		// 关键路径(2026-11-07):拆分迁移没有经过真实数据验证,已移除。
		// 升级后一律重建；旧文件只改名保留,便于回滚旧版本插件。
		const root = await mkdtemp(path.join(os.tmpdir(), 'ratel-archive-'));
		roots.push(root);
		await writeLegacyIndex(root);
		const result = await archiveLegacySingleFileIndex({ generationRoot: root });
		expect(result.archived).toBe(true);
		expect(await exists(path.join(root, 'index.json'))).toBe(false);
		expect(await exists(path.join(root, 'index.json.legacy'))).toBe(true);
		// 不建分片:重建由后续索引流程负责。
		expect(await exists(path.join(root, 'shards', 'layout.json'))).toBe(false);
	});

	it('没有旧单份索引 - 不动任何文件', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'ratel-archive-'));
		roots.push(root);
		const result = await archiveLegacySingleFileIndex({ generationRoot: root });
		expect(result.archived).toBe(false);
	});

	it('已有分片布局 - 不归档旧文件', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'ratel-archive-'));
		roots.push(root);
		await ensureShardLayout(root, 8);
		await writeLegacyIndex(root);
		const result = await archiveLegacySingleFileIndex({ generationRoot: root });
		expect(result.archived).toBe(false);
		expect(await exists(path.join(root, 'index.json'))).toBe(true);
	});
});

describe('分片布局只读读取', () => {
	it('已有布局 - 返回片数与块数', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'ratel-migrate-'));
		roots.push(root);
		await ensureShardLayout(root, 8);
		const layout = await readShardLayout(root);
		expect(layout).not.toBeNull();
		expect(layout?.shardCount).toBe(8);
		expect(layout?.blockCount).toBe(0);
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
