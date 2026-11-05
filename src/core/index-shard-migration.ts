/**
 * @file src/core/index-shard-migration.ts
 * @description 旧单份 `index.json` → 分片布局的一次性拆分迁移。
 * @module core/index-shard-migration
 * @depends node:fs/promises、node:path、core/index-shard-routing
 *
 * 设计要点:
 * - 向量与范数原样搬迁,不重新嵌入;
 * - 全部片写成功并落 `shards/layout.json` 后才把旧文件改名为 `index.json.legacy`;
 * - 任一失败保留旧布局可用(fail-closed),不写 layout,下次启动重试。
 */

import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { shardCountForBlocks, shardDirectoryName, shardIdForPath } from './index-shard-routing';

/** 迁移结果。 */
export interface ShardMigrationResult {
	/** 本次是否真的拆分了旧布局。 */
	migrated: boolean;
	/** 生效片数;未迁移时取自既有 `layout.json`。 */
	shardCount: number;
	/** 搬迁的块数。 */
	blockCount: number;
}

/** 迁移选项。 */
export interface ShardMigrationOptions {
	/** 代际目录绝对路径 — 旧 `index.json` 与 `shards/` 都在这层。 */
	generationRoot: string;
	/** 测试注入:已写片数达到该值后抛错,用于验证失败保留旧布局。 */
	failAfterShard?: number;
}

/** vectra 索引文件结构 — 迁移只做分桶,其余字段原样保留。 */
interface VectraIndexFile {
	version?: number;
	metadata_config?: Record<string, unknown>;
	items?: VectraIndexItem[];
}

/** vectra 索引条目 — `norm` 必须原样保留,否则查询分数会变。 */
interface VectraIndexItem {
	id: string;
	vector: number[];
	norm?: number;
	metadata?: Record<string, unknown>;
}

/** `shards/layout.json` — 记录片数与块数,作为「已迁移」的唯一标记。 */
interface ShardLayoutFile {
	version: 1;
	shardCount: number;
	blockCount: number;
	migratedAt: number;
}

/**
 * 把单份 `index.json` 一次性拆成 `shards/<hh>/index.json`。
 *
 * 关键路径:已存在 `shards/layout.json` 即视为已迁移,直接返回不再拆分;
 * 拆分按 `metadata.path` 路由,同一路径的所有块落在同一片。
 *
 * @param options - 代际根目录与故障注入点。
 * @returns 迁移结论、片数与块数。
 * @throws {Error} 写入中断或旧索引不可解析;此时旧布局保持可用。
 */
export async function migrateSingleFileIndex(options: ShardMigrationOptions): Promise<ShardMigrationResult> {
	const generationRoot = path.resolve(options.generationRoot);
	const legacyPath = path.join(generationRoot, 'index.json');
	const shardsRoot = path.join(generationRoot, 'shards');
	const layoutPath = path.join(shardsRoot, 'layout.json');

	const layout = await readLayout(layoutPath);
	// 已迁移时如实返回 layout 里记录的块数;恒返回 0 会让诊断读数与基准失真。
	if (layout !== null) return { migrated: false, shardCount: layout.shardCount, blockCount: layout.blockCount };
	if (!(await exists(legacyPath))) return { migrated: false, shardCount: 0, blockCount: 0 };

	const legacy = JSON.parse(await readFile(legacyPath, 'utf8')) as VectraIndexFile;
	const items = Array.isArray(legacy.items) ? legacy.items : [];
	const shardCount = shardCountForBlocks(items.length);
	const buckets = new Map<number, VectraIndexItem[]>();
	for (const item of items) {
		// 关键路径:只按字符串路径路由;非字符串元数据无法可靠归属,按空路径归片(不抛错,保留旧布局可用)。
		const rawPath = item.metadata?.['path'];
		const relativePath = typeof rawPath === 'string' ? rawPath : '';
		const shardId = shardIdForPath(relativePath, shardCount);
		const bucket = buckets.get(shardId);
		if (bucket === undefined) buckets.set(shardId, [item]);
		else bucket.push(item);
	}

	const ordered = [...buckets.entries()].sort((left, right) => left[0] - right[0]);
	let written = 0;
	for (const [shardId, bucket] of ordered) {
		if (options.failAfterShard !== undefined && written >= options.failAfterShard) {
			throw new Error(`迁移中断:已写 ${written} 片`);
		}
		const directory = path.join(shardsRoot, shardDirectoryName(shardId));
		await mkdir(directory, { recursive: true });
		await writeAtomic(
			path.join(directory, 'index.json'),
			JSON.stringify({
				version: legacy.version ?? 1,
				metadata_config: legacy.metadata_config ?? {},
				items: bucket,
			}),
		);
		written += 1;
	}

	await mkdir(shardsRoot, { recursive: true });
	const layoutFile: ShardLayoutFile = {
		version: 1,
		shardCount,
		blockCount: items.length,
		migratedAt: Date.now(),
	};
	await writeAtomic(layoutPath, JSON.stringify(layoutFile));
	// 关键路径:layout 落盘后才归档旧文件;此前失败一律保留旧布局。
	await rename(legacyPath, `${legacyPath}.legacy`);
	return { migrated: true, shardCount, blockCount: items.length };
}

/**
 * 确保代际目录存在分片布局标记 — 全新库首次装配时写入 `shards/layout.json`。
 *
 * 关键路径:
 * - **幂等**:已有合法布局时原样返回,不覆盖既有片数 —— 片数只允许通过重分布改变,
 *   装配侧重试或并发装配都不应改写它;
 * - **成功装配后才写**:调用方必须先构造好分片存储再调用本函数,写入失败时不会留下
 *   「有 layout 无存储」的假迁移状态;
 * - **原子写入**:同目录临时文件 + rename,中断不会留下半截 JSON;
 * - 块数固定为 0:全新库还没有向量,块数只是诊断读数,不参与片数判定。
 *
 * @param generationRoot - 代际根目录(与 `index.json`、`shards/` 同一层)。
 * @param shardCount - 期望片数;必须为正整数(由 `shardCountForBlocks` 派生)。
 * @returns 生效的片数与块数;已存在布局时返回既有值。
 * @throws {Error} 片数非法或写入磁盘失败。
 */
export async function ensureShardLayout(
	generationRoot: string,
	shardCount: number,
): Promise<{ shardCount: number; blockCount: number }> {
	const shardsRoot = path.join(path.resolve(generationRoot), 'shards');
	const layoutPath = path.join(shardsRoot, 'layout.json');
	// 关键路径:先读已有布局 —— 已存在就不覆盖,避免重试把更大的片数改小。
	const existing = await readLayout(layoutPath);
	if (existing !== null) return { shardCount: existing.shardCount, blockCount: existing.blockCount };
	if (!Number.isInteger(shardCount) || shardCount <= 0) throw new Error(`分片数必须是正整数:${shardCount}`);
	await mkdir(shardsRoot, { recursive: true });
	const layoutFile: ShardLayoutFile = {
		version: 1,
		shardCount,
		blockCount: 0,
		migratedAt: Date.now(),
	};
	await writeAtomic(layoutPath, JSON.stringify(layoutFile));
	return { shardCount, blockCount: 0 };
}

/**
 * 只读读取分片布局 — 供会话装配判断本轮该用分片存储还是退回单份存储。
 *
 * 关键路径:缺失或非法时返回 null 而不抛错。layout 只是「是否已迁移」的标记,
 * 一个坏文件不该让索引会话打不开;调用方拿 null 后按旧布局继续装配。
 *
 * @param generationRoot - 代际根目录(与 `index.json`、`shards/` 同一层)。
 * @returns 片数与块数;未迁移或 layout 不可解析时为 null。
 */
export async function readShardLayout(generationRoot: string): Promise<{ shardCount: number; blockCount: number } | null> {
	const layout = await readLayout(path.join(path.resolve(generationRoot), 'shards', 'layout.json'));
	if (layout === null) return null;
	return { shardCount: layout.shardCount, blockCount: layout.blockCount };
}

/** 读取已有布局;不存在或不可解析都视为未迁移。 */
async function readLayout(layoutPath: string): Promise<ShardLayoutFile | null> {
	if (!(await exists(layoutPath))) return null;
	try {
		const parsed = JSON.parse(await readFile(layoutPath, 'utf8')) as Partial<ShardLayoutFile>;
		if (typeof parsed.shardCount !== 'number' || parsed.shardCount <= 0) return null;
		return {
			version: 1,
			shardCount: parsed.shardCount,
			// 块数只做诊断读数:缺失或非法按 0 处理,不据此判定「未迁移」。
			blockCount: typeof parsed.blockCount === 'number' && Number.isFinite(parsed.blockCount) && parsed.blockCount >= 0
				? parsed.blockCount
				: 0,
			migratedAt: parsed.migratedAt ?? 0,
		};
	}
	catch {
		return null;
	}
}

/** 同目录临时文件 + rename,避免半截 JSON 被下一次装配读到。 */
async function writeAtomic(target: string, content: string): Promise<void> {
	const temporary = `${target}.tmp-${process.pid}`;
	await writeFile(temporary, content, 'utf8');
	await rename(temporary, target);
}

/** 判断路径是否存在。 */
async function exists(target: string): Promise<boolean> {
	try {
		await access(target);
		return true;
	}
	catch {
		return false;
	}
}

/** 只读诊断 — 列出已有分片目录名,供测试与后续装配核对。 */
export async function listShardDirectories(generationRoot: string): Promise<string[]> {
	const shardsRoot = path.join(path.resolve(generationRoot), 'shards');
	if (!(await exists(shardsRoot))) return [];
	const entries = await readdir(shardsRoot, { withFileTypes: true });
	return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}
