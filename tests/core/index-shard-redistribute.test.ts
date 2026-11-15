/**
 * @file tests/core/index-shard-redistribute.test.ts
 * @description 分片重分布 — 只搬向量、按路径重分组、幂等与中断清理
 * @module tests/core/index-shard-redistribute
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { redistributeShardsIfNeeded } from '../../src/core/index-shard-redistribute';
import { shardDirectoryName, shardIdForPath, shardCountForBlocks } from '../../src/core/index-shard-routing';

/** 造一个代际:给定片数与每片块数,块路径均匀分布以便验证重分组。 */
async function makeGeneration(shardCount: number, blocksPerShard: number): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), 'ratel-shard-redist-'));
	const shardsRoot = path.join(root, 'shards');
	await mkdir(shardsRoot, { recursive: true });
	await writeFile(
		path.join(shardsRoot, 'layout.json'),
		JSON.stringify({ version: 1, shardCount, blockCount: 0, migratedAt: 1 }),
	);
	for (let shardId = 0; shardId < shardCount; shardId += 1) {
		const dir = path.join(shardsRoot, shardDirectoryName(shardId));
		await mkdir(dir, { recursive: true });
		const items = Array.from({ length: blocksPerShard }, (_, index) => ({
			id: `s${shardId}-b${index}`,
			metadata: { path: `notes/${shardId}/${index}.md` },
			vector: [0.1, 0.2, 0.3],
			norm: 1,
		}));
		await writeFile(
			path.join(dir, 'index.json'),
			JSON.stringify({ version: 1, metadata_config: {}, items }),
		);
	}
	return root;
}

describe('分片重分布', () => {
	it('块数超过当前片容量 - 扩到目标片数 - 块总数不变且按路径重新分组', async () => {
		// 8 片 × 3000 块 = 24000 块;目标 = shardCountForBlocks(24000) = 16 片。
		const root = await makeGeneration(8, 3000);
		try {
			const result = await redistributeShardsIfNeeded(root);
			expect(result).toMatchObject({ from: 8, blocks: 24000 });
			expect(result?.to).toBe(shardCountForBlocks(24000));

			const shardsRoot = path.join(root, 'shards');
			const layout = JSON.parse(await readFile(path.join(shardsRoot, 'layout.json'), 'utf8')) as { shardCount: number; blockCount: number };
			expect(layout.shardCount).toBe(result?.to);
			expect(layout.blockCount).toBe(24000);

			const seen = new Set<string>();
			for (let shardId = 0; shardId < layout.shardCount; shardId += 1) {
				const file = JSON.parse(await readFile(path.join(shardsRoot, shardDirectoryName(shardId), 'index.json'), 'utf8')) as { items: Array<{ id: string; metadata: { path: string } }> };
				for (const item of file.items) {
					expect(seen.has(item.id)).toBe(false);
					seen.add(item.id);
					// 关键路径:每条记录都必须落在按新片数算出的分片里,否则检索会漏。
					expect(shardIdForPath(item.metadata.path, layout.shardCount)).toBe(shardId);
				}
			}
			expect(seen.size).toBe(24000);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('块数未超过当前片容量 - 不重分布 - 原目录不被改写', async () => {
		const root = await makeGeneration(8, 10);
		try {
			const before = await readFile(path.join(root, 'shards', shardDirectoryName(0), 'index.json'), 'utf8');
			expect(await redistributeShardsIfNeeded(root)).toBeNull();
			expect(await readFile(path.join(root, 'shards', shardDirectoryName(0), 'index.json'), 'utf8')).toBe(before);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('已有上次中断的 shards.next - 打开时清理 - 不参与读取', async () => {
		const root = await makeGeneration(8, 3000);
		try {
			const stale = path.join(root, 'shards.next', shardDirectoryName(0));
			await mkdir(stale, { recursive: true });
			await writeFile(path.join(stale, 'index.json'), JSON.stringify({ version: 1, metadata_config: {}, items: [] }));

			const result = await redistributeShardsIfNeeded(root);
			expect(result?.blocks).toBe(24000);
			// 交换后 next 已被消费,不应残留。
			await expect(readFile(path.join(root, 'shards.next', 'layout.json'), 'utf8')).rejects.toThrow();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('交换到一半崩溃留下 shards.prev - 打开时先回退 - 仍能正常读取', async () => {
		const root = await makeGeneration(8, 3000);
		try {
			// 模拟崩溃现场:shards 已被改名为 shards.prev,shards.next 尚未补位。
			await rename(path.join(root, 'shards'), path.join(root, 'shards.prev'));
			const result = await redistributeShardsIfNeeded(root);
			// 回退后重新读到 8 片,再按块数扩容。
			expect(result).toMatchObject({ from: 8, blocks: 24000 });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('未分片的代际 - 直接跳过 - 不创建分片目录', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'ratel-shard-plain-'));
		try {
			expect(await redistributeShardsIfNeeded(root)).toBeNull();
			await expect(readFile(path.join(root, 'shards', 'layout.json'), 'utf8')).rejects.toThrow();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
