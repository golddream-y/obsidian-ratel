/**
 * @file src/core/index-manifest.ts
 * @description 索引清单 — 记录每文件 hash + 全局 embedding 参数,启动期 hash diff 跳过未变更文件
 * @module core/index-manifest
 * @depends fs, path
 *
 * 设计要点:
 * - 独立于 data.json(不走 Obsidian loadData/saveData)
 * - 落在 `.index/ratel-manifest.json`,与向量目录同生命周期(同步工具通常整目录忽略 `.index/`)
 * - 原子写:先写 .tmp 再 rename,避免半写损坏
 * - load 失败返回 null；不能用当前文件内容补造清单来证明旧向量已成功索引
 * - 全局参数(embedModelId/chunkSize/chunkOverlap)变化 → shouldFullRebuild 返回 true
 */
import fs from 'fs';
import path from 'path';

/** 当前清单文件名(位于 `.index/` 内) */
export const INDEX_MANIFEST_FILENAME = 'ratel-manifest.json';

/**
 * 当前分块规则代数 — 分块单位/预算/前缀规则任一变化就 +1。
 *
 * 关键路径:写入清单后,`shouldFullRebuild` 比对该值;不一致即触发一次全量重建,
 * 避免旧规则切出的块与新规则混存(块边界不同,旧块无法被新检索正确利用)。
 */
export const CURRENT_CHUNKER_VERSION = 1;

/** 旧版清单文件名(插件根目录,易被同步删除) */
export const LEGACY_INDEX_MANIFEST_FILENAME = 'index-manifest.json';

/**
 * 解析当前清单绝对路径 — `.index/ratel-manifest.json`。
 *
 * @param indexDir - 向量索引目录(pluginDir/.index)
 */
export function resolveIndexManifestPath(indexDir: string): string {
	return path.join(indexDir, INDEX_MANIFEST_FILENAME);
}

/**
 * 若存在旧版 `pluginDir/index-manifest.json` 且新路径尚无文件,则迁入 `.index/`。
 *
 * @param pluginDir - 插件目录
 * @param indexDir - `.index` 目录
 * @returns 是否执行了迁移
 */
export async function migrateLegacyIndexManifest(
	pluginDir: string,
	indexDir: string,
): Promise<boolean> {
	const nextPath = resolveIndexManifestPath(indexDir);
	const legacyPath = path.join(pluginDir, LEGACY_INDEX_MANIFEST_FILENAME);
	if (fs.existsSync(nextPath)) {
		if (fs.existsSync(legacyPath)) {
			try {
				await fs.promises.unlink(legacyPath);
			} catch {
				// 忽略旧文件清理失败
			}
		}
		return false;
	}
	if (!fs.existsSync(legacyPath)) {
		return false;
	}
	await fs.promises.mkdir(indexDir, { recursive: true });
	await fs.promises.rename(legacyPath, nextPath);
	return true;
}

/** 索引清单条目 — 单个文件在向量索引中的元数据。 */
export interface IndexManifestEntry {
    /** 文件相对 vault 根的路径,作为 key */
    path: string;
    /** sha256(content),内容指纹 */
    hash: string;
    /** 文件最后修改时间戳(ms),快速跳过用 */
    mtime: number;
    /** 该文件被切成的 chunk 数,用于诊断 */
    chunkCount: number;
}

/** 索引清单 — 全局元数据 + 每文件条目。 */
export interface IndexManifestData {
    /** manifest 格式版本 */
    version: 1;
    /** 当前索引使用的 embedding 模型 ID */
    embedModelId: string;
    /** chunkMarkdown 的 chunkSize 参数 */
    chunkSize: number;
    /** chunkMarkdown 的 chunkOverlap 参数 */
    chunkOverlap: number;
    /** 分块规则代数 — 与 CURRENT_CHUNKER_VERSION 不一致即触发全量重建 */
    chunkerVersion?: number;
    /** 最近一次索引完成时间(ms) */
    lastIndexTime: number;
    /** 每文件条目,key = 文件相对路径 */
    entries: Record<string, IndexManifestEntry>;
}

/** 旧清单条目不可作为迁移依据的原因 — 迁移任务据此定位到具体文件。 */
export const LEGACY_MANIFEST_ENTRY_REASONS = [
	'entry-shape-invalid',
	'entry-path-mismatch',
	'entry-hash-invalid',
	'entry-chunk-count-invalid',
	'entry-chunk-count-zero',
] as const;

/** 旧清单条目不可作为迁移依据的原因。 */
export type LegacyManifestEntryReason = (typeof LEGACY_MANIFEST_ENTRY_REASONS)[number];

/** 旧清单条目的解析结论。 */
export type LegacyManifestEntryResult =
	| { readonly ok: true; readonly entry: IndexManifestEntry }
	| { readonly ok: false; readonly reason: LegacyManifestEntryReason };

/**
 * 解析旧清单条目 — T6 迁移前的字段级校验。
 *
 * 关键路径(T6 checkbox 1):
 * - 条目键必须与条目内 `path` 逐字一致;记录内路径不参与任何文件访问,不一致直接拒绝;
 * - `mtime` 只作为辅助信息,非法时按 0 处理,不影响可迁移性;
 * - `chunkCount` 为 0 时**单独标记**(`entry-chunk-count-zero`),不能据此认定空文件 ——
 *   必须回到实际存储检查该路径是否真的有块。调用方按自己的规则处理这一原因。
 *
 * @param key - 清单 `entries` 里的键。
 * @param value - 条目值。
 * @returns 解析结论。
 */
export function parseLegacyManifestEntry(key: string, value: unknown): LegacyManifestEntryResult {
	if (typeof key !== 'string' || key.length === 0) return { ok: false, reason: 'entry-shape-invalid' };
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return { ok: false, reason: 'entry-shape-invalid' };
	}
	const record = value as Record<string, unknown>;
	const entryPath = record['path'];
	if (typeof entryPath !== 'string' || entryPath.length === 0) return { ok: false, reason: 'entry-shape-invalid' };
	if (entryPath !== key) return { ok: false, reason: 'entry-path-mismatch' };
	const hash = record['hash'];
	if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
		return { ok: false, reason: 'entry-hash-invalid' };
	}
	const chunkCount = record['chunkCount'];
	if (typeof chunkCount !== 'number' || !Number.isInteger(chunkCount) || chunkCount < 0) {
		return { ok: false, reason: 'entry-chunk-count-invalid' };
	}
	if (chunkCount === 0) return { ok: false, reason: 'entry-chunk-count-zero' };
	const mtime = record['mtime'];
	return {
		ok: true,
		entry: {
			path: entryPath,
			hash,
			mtime: typeof mtime === 'number' && Number.isFinite(mtime) ? mtime : 0,
			chunkCount,
		},
	};
}

/** 当前 manifest 文件的 diff 结果。 */
export interface ManifestDiff {
    toAdd: Array<{ path: string; content: string; mtime: number }>;
    toUpdate: Array<{ path: string; content: string; mtime: number }>;
    toDelete: string[];
    unchanged: string[];
}

/**
 * 索引清单管理器 — load/save/diff/recordEntry/removeEntry/invalidate。
 *
 * 关键路径:manifest 是启动期 smart reindex 的决策依据,独立文件 IO,
 * 不走 Obsidian loadData/saveData(避免与 data.json 全量序列化混存)。
 */
export class IndexManifest {
    private data: IndexManifestData | null = null;

    constructor(private readonly path: string) {}

    /** 从磁盘读 + JSON 解析;失败返回 null,调用方走全量降级。 */
    async load(): Promise<IndexManifestData | null> {
        try {
            const raw = await fs.promises.readFile(this.path, 'utf8');
            this.data = JSON.parse(raw) as IndexManifestData;
            return this.data;
        } catch {
            // 关键路径:文件不存在或 JSON 损坏,降级全量。
            return null;
        }
    }

    /** 原子写:先写 .tmp 再 rename,避免半写损坏。 */
    async save(data: IndexManifestData): Promise<void> {
        // 关键路径:同目录 rename 是原子操作,防半写状态导致 manifest 损坏。
        const tmpPath = this.path + '.tmp';
        const json = JSON.stringify(data, null, 2);
        await fs.promises.writeFile(tmpPath, json, 'utf8');
        await fs.promises.rename(tmpPath, this.path);
        this.data = data;
    }

    /**
     * 比对当前 manifest 与 vault 文件列表,产出待处理集合。
     *
     * 关键路径:纯 hash 比对,不做 mtime 预过滤(mtime 快速跳过由调用方在算 hash 前完成)。
     * - manifest 无记录 → toAdd
     * - hash 变 → toUpdate
     * - hash 同 → unchanged
     * - manifest 有 vault 无 → toDelete
     *
     * @param data - 已加载的 manifest(由调用方传入,因为调用方需要先 shouldFullRebuild 判断)
     * @param currentFiles - vault 当前文件列表(已算好 hash)
     */
    diff(
        data: IndexManifestData,
        currentFiles: Array<{ path: string; content: string; hash: string; mtime: number }>,
    ): ManifestDiff {
        const toAdd: ManifestDiff['toAdd'] = [];
        const toUpdate: ManifestDiff['toUpdate'] = [];
        const toDelete: string[] = [];
        const unchanged: string[] = [];

        const currentPaths = new Set(currentFiles.map((f) => f.path));

        // 关键路径:先处理 vault 当前文件(add / update / unchanged)。
        for (const file of currentFiles) {
            const entry = data.entries[file.path];
            if (!entry) {
                toAdd.push({ path: file.path, content: file.content, mtime: file.mtime });
            } else if (entry.hash !== file.hash) {
                toUpdate.push({ path: file.path, content: file.content, mtime: file.mtime });
            } else {
                unchanged.push(file.path);
            }
        }

        // 关键路径:manifest 有 vault 无 → delete。
        for (const entryPath of Object.keys(data.entries)) {
            if (!currentPaths.has(entryPath)) {
                toDelete.push(entryPath);
            }
        }

        return { toAdd, toUpdate, toDelete, unchanged };
    }

    /** 记录单个文件索引后的元数据(增量更新 entry)。 */
    recordEntry(
        data: IndexManifestData,
        path: string,
        hash: string,
        mtime: number,
        chunkCount: number,
    ): void {
        data.entries[path] = { path, hash, mtime, chunkCount };
    }

    /** 移除单个文件的 entry(文件删除后调)。 */
    removeEntry(data: IndexManifestData, path: string): void {
        delete data.entries[path];
    }

    /** 清空 entries(模型切换/参数变更触发全量重建时调)。保留全局参数待重新填。 */
    invalidate(data: IndexManifestData): void {
        data.entries = {};
    }

    /**
     * 判断是否需要全量重建。
     *
     * 触发条件:embedModelId / chunkSize / chunkOverlap / chunkerVersion 任一变化。
     * 原因:
     * - 不同 embedding 模型的向量空间不兼容,混入会导致搜索错乱。
     * - 分块规则代数变化(单位/预算/结构前缀)后,旧块的边界与新规则不一致,必须重切。
     *
     * 关键路径:旧清单没有 chunkerVersion 字段,读出来是 undefined,
     * `undefined !== CURRENT_CHUNKER_VERSION` 即成立 → 升级后自动重建一次。
     */
    shouldFullRebuild(
        data: IndexManifestData,
        newEmbedModelId: string,
        newChunkSize: number,
        newChunkOverlap: number,
        newChunkerVersion: number = CURRENT_CHUNKER_VERSION,
    ): boolean {
        return (
            data.embedModelId !== newEmbedModelId ||
            data.chunkSize !== newChunkSize ||
            data.chunkOverlap !== newChunkOverlap ||
            data.chunkerVersion !== newChunkerVersion
        );
    }
}
