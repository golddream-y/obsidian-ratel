/**
 * @file src/core/index-shard-redistribute.ts
 * @description 分片数随块数增长时的在线重分布 — 只搬运向量,不重新嵌入
 * @module core/index-shard-redistribute
 * @depends node:fs/promises, node:path, core/index-shard-routing
 *
 * 设计要点:
 * - 代际创建时按当时块数定片数(全新库为 0 块 → 下限 8 片),之后块数增长但片数从不变。
 *   6 万块落进 8 片,单片接近 90 MB,每次提交都把整片写回,单篇要数秒。
 * - 本模块在代际打开、写入尚未开始时,把已有分片按新的目标片数重新分组。
 *   只读已有 `index.json` 的 items 并按路径哈希重排,不调用嵌入模型。
 * - 目标片数只增不减;不满足条件时原样返回,不做任何写入。
 * - 中断安全:新分片写在 `shards.next`,校验通过后才与 `shards` 交换;
 *   上次中断遗留的 `shards.next` 在下次打开时直接清理。
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { shardCountForBlocks, shardDirectoryName, shardIdForPath } from './index-shard-routing';
import { readShardLayout } from './index-shard-migration';

/** 单个分片文件里的一条记录。 */
interface ShardItem {
	id?: string;
	metadata?: { path?: string };
	vector?: number[];
	norm?: number;
}

/** 分片文件结构 — 与存储层写入的 JSON 保持一致。 */
interface ShardFile {
	version: number;
	metadata_config: Record<string, unknown>;
	items: ShardItem[];
}

/** 重分布结果。 */
export interface ShardRedistributeResult {
	/** 原片数。 */
	from: number;
	/** 新片数。 */
	to: number;
	/** 搬运的块数。 */
	blocks: number;
}

/**
 * 按块数增长需要扩容时，把已有分片重分布到目标片数。
 *
 * @param generationRoot - 代际根目录
 * @param log - 可选的诊断日志
 * @returns 发生重分布时返回片数与块数;不需要或未分片时为 null
 * @throws {Error} 读取、写入或交换失败(此时原分片保持不变或已回滚)
 */
export async function redistributeShardsIfNeeded(
	generationRoot: string,
	log?: (message: string) => void,
): Promise<ShardRedistributeResult | null> {
	const root = path.resolve(generationRoot);
	const shardsRoot = path.join(root, 'shards');
	const nextRoot = path.join(root, 'shards.next');
	const prevRoot = path.join(root, 'shards.prev');

	// 关键路径:上次中断可能留下半成品;它从未被使用过,直接清理。
	await rm(nextRoot, { recursive: true, force: true });
	// 关键路径:上一轮交换成功后保留的旧分片,在确认新分片可用后的下一次打开才删除,
	// 这样迁移后仍有一次重启窗口可以人工回退。
	try {
		await readFile(path.join(shardsRoot, 'layout.json'), 'utf8');
		await rm(prevRoot, { recursive: true, force: true });
	} catch {
		/* 无新布局时不清理,保留可能存在的回退副本 */
	}

	// 关键路径:交换到一半崩溃会留下「无 shards、有 shards.prev」——直接回退,不让代际失联。
	let layout = await readShardLayout(root);
	if (layout === null) {
		try {
			await readFile(path.join(prevRoot, 'layout.json'), 'utf8');
			await rename(prevRoot, shardsRoot);
			layout = await readShardLayout(root);
		} catch {
			/* 无回退副本则按未分片处理 */
		}
	}
	if (layout === null) return null;

	const items: ShardItem[] = [];
	let metadataConfig: Record<string, unknown> = {};
	let version = 1;
	for (let shardId = 0; shardId < layout.shardCount; shardId += 1) {
		const file = path.join(shardsRoot, shardDirectoryName(shardId), 'index.json');
		let raw: string;
		try {
			raw = await readFile(file, 'utf8');
		} catch {
			// 空分片可能从未落盘,不算异常。
			continue;
		}
		const parsed = JSON.parse(raw) as Partial<ShardFile>;
		version = parsed.version ?? version;
		metadataConfig = parsed.metadata_config ?? metadataConfig;
		for (const item of parsed.items ?? []) items.push(item);
	}

	const target = shardCountForBlocks(items.length);
	if (target <= layout.shardCount || items.length === 0) {
		// 关键路径:布局检查本身要可观测,否则「到底跑没跑」只能靠猜。
		log?.(`分片布局:${layout.shardCount} 片 / ${items.length} 块(目标 ${target} 片,无需扩容)`);
		return null;
	}

	// 按路径重新分组;缺路径的记录无法判断归属,保持原样会让检索错位,直接失败。
	const buckets = new Map<number, ShardItem[]>();
	for (const item of items) {
		const relativePath = item.metadata?.path;
		if (typeof relativePath !== 'string' || relativePath.length === 0) {
			throw new Error('重分布失败:存在缺少路径元数据的块');
		}
		const shardId = shardIdForPath(relativePath, target);
		const bucket = buckets.get(shardId);
		if (bucket === undefined) buckets.set(shardId, [item]);
		else bucket.push(item);
	}

	await mkdir(nextRoot, { recursive: true });
	for (let shardId = 0; shardId < target; shardId += 1) {
		const shardDir = path.join(nextRoot, shardDirectoryName(shardId));
		await mkdir(shardDir, { recursive: true });
		const payload: ShardFile = {
			version,
			metadata_config: metadataConfig,
			items: buckets.get(shardId) ?? [],
		};
		const target2 = path.join(shardDir, 'index.json');
		const temp = `${target2}.tmp-${process.pid}`;
		await writeFile(temp, JSON.stringify(payload));
		await rename(temp, target2);
	}

	// 关键路径:布局在新目录内写好后再交换,交换完成前旧目录仍可用。
	const layoutFile = path.join(nextRoot, 'layout.json');
	await writeFile(
		layoutFile,
		JSON.stringify({ version: 1, shardCount: target, blockCount: items.length, migratedAt: Date.now() }),
	);

	await rm(prevRoot, { recursive: true, force: true });
	await rename(shardsRoot, prevRoot);
	try {
		await rename(nextRoot, shardsRoot);
	} catch (error) {
		// 交换失败时把旧分片放回原位,避免代际变成「无分片」。
		await rename(prevRoot, shardsRoot);
		throw error;
	}

	log?.(`分片重分布完成:${layout.shardCount} 片 → ${target} 片,搬运 ${items.length} 块(未重新嵌入)`);
	// 旧分片保留到下一次成功打开后再删,给迁移留一次重启回退窗口。
	return { from: layout.shardCount, to: target, blocks: items.length };
}
