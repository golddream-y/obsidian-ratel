/**
 * @file src/core/incremental-manifest-update.ts
 * @description 增量索引后更新 manifest 的组合操作 — hash content + 更新 entry + 保存
 * @module core/incremental-manifest-update
 * @depends core/index-manifest, utils/hash
 *
 * 设计要点:
 * - 组合 IndexManifest.load / recordEntry / save 三个步骤,供 IndexProcessor 增量索引后调用
 * - 保留旧 chunkCount(增量不重算 chunk 数,仅更新 hash + mtime)
 * - manifest 文件不存在时 load 返回 null,本函数静默跳过不抛错(降级全量由调用方决定)
 */

import type { IndexManifest } from './index-manifest';
import { sha256 } from '../utils/hash';

/**
 * 增量索引后更新 manifest 条目 — 计算 content 的 hash,更新 entry 的 hash + mtime,保留旧 chunkCount。
 *
 * 关键路径:
 * - manifest 文件不存在时 load 返回 null,本函数直接 return(不抛错,降级全量由调用方处理)
 * - 已有 entry 保留旧 chunkCount(增量索引不重算 chunk 数,仅更新内容指纹)
 * - 新文件 chunkCount 默认 0(后续 IndexProcessor 实际写入时更新为真实 chunk 数)
 *
 * @param manifest - IndexManifest 实例(绑定磁盘路径)
 * @param filePath - 文件相对 vault 根的路径
 * @param content - 文件最新内容
 */
export async function updateManifestAfterIncremental(
	manifest: IndexManifest,
	filePath: string,
	content: string,
): Promise<void> {
	const data = await manifest.load();
	// 关键路径:manifest 不存在时静默跳过,降级全量由调用方决定
	if (!data) return;

	const hash = await sha256(content);
	const oldEntry = data.entries[filePath];
	const chunkCount = oldEntry?.chunkCount ?? 0;

	manifest.recordEntry(data, filePath, hash, Date.now(), chunkCount);
	await manifest.save(data);
}
