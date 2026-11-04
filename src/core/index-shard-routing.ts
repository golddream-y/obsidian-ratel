/**
 * @file src/core/index-shard-routing.ts
 * @description 分片向量索引的路由纯函数 — 片数计算、路径到分片、分片目录名。
 * @module core/index-shard-routing
 * @depends node:crypto
 *
 * 设计要点:
 * - 分片数只影响存储布局,不参与配置指纹:改片数靠重分布完成,不触发重嵌入。
 * - 分片键与 journal 的 `pathHash` 同源(规范化相对路径的 SHA-256),
 *   保证同一路径的所有块永远落在同一分片,删除/替换无需跨片扫描。
 * - 本文件保持纯函数:无 IO、无状态,便于装配侧与迁移侧共用同一套语义。
 */

import { createHash } from 'node:crypto';

/** 分片数下限 — 小库用更少分片,避免扇出与文件数压过收益。 */
export const MIN_SHARDS = 8;

/** 分片数上限 — 再大时查询扇出与文件数代价高过分片收益。 */
export const MAX_SHARDS = 64;

/** 每片目标块数 — 决定片数的主要输入。 */
const BLOCKS_PER_SHARD = 2_048;

/**
 * 按总块数计算分片数:2 的幂,夹在 [MIN_SHARDS, MAX_SHARDS]。
 *
 * 关键路径:片数只影响存储布局,不参与配置指纹;改片数通过重分布完成,不重嵌入。
 * 例:19 784 块 → ceil(19784 / 2048) = 10 → 从 8 倍增到 16。
 *
 * @param totalBlocks - 索引内总块数。
 * @returns 分片数,必为 [MIN_SHARDS, MAX_SHARDS] 内的 2 的幂。
 */
export function shardCountForBlocks(totalBlocks: number): number {
	const safeBlocks = Number.isFinite(totalBlocks) && totalBlocks > 0 ? totalBlocks : 0;
	const wanted = Math.ceil(safeBlocks / BLOCKS_PER_SHARD);
	let count = MIN_SHARDS;
	while (count < MAX_SHARDS && count < wanted) count *= 2;
	return Math.min(MAX_SHARDS, count);
}

/**
 * 路径到分片号:取 sha256 首字节对片数取模。
 *
 * 关键路径:与 journal 的 `pathHash` 同源(同样规范化路径分隔符),
 * 保证同一路径的所有块永远落在同一片,删除/替换不需要跨片扫描。
 *
 * @param relativePath - vault 相对路径。
 * @param shardCount - 分片数,必须是正整数。
 * @returns 分片号,落在 [0, shardCount)。
 * @throws {Error} 分片数不是正整数。
 */
export function shardIdForPath(relativePath: string, shardCount: number): number {
	if (!Number.isInteger(shardCount) || shardCount <= 0) {
		throw new Error(`分片数必须是正整数:${shardCount}`);
	}
	const normalized = relativePath
		.split(/[\\/]+/)
		.filter((segment) => segment.length > 0)
		.join('/');
	const digest = createHash('sha256').update(normalized, 'utf8').digest();
	return digest[0]! % shardCount;
}

/**
 * 分片目录名 — 两位小写十六进制,与片号一一对应。
 *
 * @param shardId - 分片号。
 * @returns 目录名,如 0 → `00`、15 → `0f`。
 */
export function shardDirectoryName(shardId: number): string {
	return shardId.toString(16).padStart(2, '0');
}
