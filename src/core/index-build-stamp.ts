/**
 * @file src/core/index-build-stamp.ts
 * @description 索引构建戳 — 记录「当前索引是由哪套规则切出来的」，供清单丢失时判断索引是否仍可用。
 * @module core/index-build-stamp
 * @depends fs, path
 *
 * 设计要点:
 * - 清单(ratel-manifest)记录每文件 hash,但清单本身可能被同步工具删掉;
 * - 清单一旦丢失,启动逻辑只能"索引在 → 只补清单",无法判断索引是不是旧规则切的;
 * - 因此在索引目录里额外落一个构建戳:与当前设置/模型不一致就说明索引过期,必须重建。
 * - 与清单同生命周期(都在 `.index/`),按目录整体忽略/清理。
 */

import fs from 'fs';
import path from 'path';

/** 构建戳文件名(位于 `.index/` 内) */
export const BUILD_STAMP_FILENAME = 'build-stamp.json';

/** 构建戳内容 — 决定索引内容形态的全部输入。 */
export interface IndexBuildStamp {
	/** 分块规则代数 — 与 `CURRENT_CHUNKER_VERSION` 比对 */
	chunkerVersion: number;
	/** 切分时使用的块大小(token) */
	chunkSize: number;
	/** 切分时使用的块间重叠(token) */
	chunkOverlap: number;
	/** 生成向量所用的 embedding 模型标识 */
	embedModelId: string;
}

/**
 * 解析构建戳路径。
 *
 * @param indexDir - 向量索引目录(pluginDir/.index)
 * @returns 构建戳绝对路径
 */
export function resolveBuildStampPath(indexDir: string): string {
	return path.join(indexDir, BUILD_STAMP_FILENAME);
}

/**
 * 构建戳读取结论 — T6 迁移需要区分「戳缺失」与「戳损坏」。
 *
 * 关键路径(spec §5、T6 checkbox 1):旧索引**可能没有构建戳**(更早的版本不写),
 * 缺失本身不构成不兼容;但戳**存在却无法解析**说明索引形态不可证明,必须按不兼容处理。
 */
export const BUILD_STAMP_READ_RESULTS = ['present', 'missing', 'unreadable'] as const;

/** 构建戳读取结论。 */
export type BuildStampReadResult = (typeof BUILD_STAMP_READ_RESULTS)[number];

/** 构建戳读取结论与内容。 */
export interface BuildStampReadOutcome {
	/** 读取结论。 */
	result: BuildStampReadResult;
	/** `present` 时的戳内容;其余情况为 null。 */
	stamp: IndexBuildStamp | null;
}

/**
 * 读取构建戳并区分「缺失」与「不可解析」。
 *
 * 关键路径:`readBuildStamp` 把两种情况都收敛成 null,调用方无法区分;
 * 迁移必须区分,否则缺戳的有效旧索引会被误判为不可迁移。
 *
 * @param indexDir - 向量索引目录。
 * @returns 读取结论与内容。
 */
export async function readBuildStampOutcome(indexDir: string): Promise<BuildStampReadOutcome> {
	let raw: string;
	try {
		raw = await fs.promises.readFile(resolveBuildStampPath(indexDir), 'utf8');
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return { result: code === 'ENOENT' ? 'missing' : 'unreadable', stamp: null };
	}
	const stamp = parseBuildStamp(raw);
	return stamp === null ? { result: 'unreadable', stamp: null } : { result: 'present', stamp };
}

/**
 * 解析构建戳文本 — 字段缺失或类型不符返回 null。
 *
 * @param raw - 文件内容。
 * @returns 构建戳;不可解析时为 null。
 */
export function parseBuildStamp(raw: string): IndexBuildStamp | null {
	try {
		const parsed = JSON.parse(raw) as Partial<IndexBuildStamp>;
		if (
			typeof parsed.chunkerVersion !== 'number' ||
			typeof parsed.chunkSize !== 'number' ||
			typeof parsed.chunkOverlap !== 'number' ||
			typeof parsed.embedModelId !== 'string'
		) {
			return null;
		}
		return {
			chunkerVersion: parsed.chunkerVersion,
			chunkSize: parsed.chunkSize,
			chunkOverlap: parsed.chunkOverlap,
			embedModelId: parsed.embedModelId,
		};
	} catch {
		return null;
	}
}

/**
 * 读取构建戳。
 *
 * 关键路径:文件不存在或 JSON 损坏都返回 null —— 调用方据此判定"无法证明索引有效"。
 * 需要区分「缺失」与「损坏」时用 `readBuildStampOutcome`。
 *
 * @param indexDir - 向量索引目录
 * @returns 构建戳;不存在或无法解析时为 null
 */
export async function readBuildStamp(indexDir: string): Promise<IndexBuildStamp | null> {
	return (await readBuildStampOutcome(indexDir)).stamp;
}

/**
 * 写入构建戳(原子写:先写 .tmp 再 rename)。
 *
 * @param indexDir - 向量索引目录
 * @param stamp - 本次构建使用的规则
 */
export async function writeBuildStamp(indexDir: string, stamp: IndexBuildStamp): Promise<void> {
	await fs.promises.mkdir(indexDir, { recursive: true });
	const target = resolveBuildStampPath(indexDir);
	const tmp = `${target}.tmp`;
	await fs.promises.writeFile(tmp, JSON.stringify(stamp, null, 2), 'utf8');
	await fs.promises.rename(tmp, target);
}

/**
 * 判断已落盘的构建戳是否与当前规则一致。
 *
 * 关键路径:null(戳缺失/损坏)一律视为不一致 —— 无法证明索引有效就必须重建,
 * 宁可多一次全量,也不让旧规则的块冒充当前索引。
 *
 * @param stamp - 已落盘的构建戳
 * @param current - 当前设置推导出的规则
 * @returns 完全一致返回 true
 */
export function isBuildStampCurrent(
	stamp: IndexBuildStamp | null,
	current: IndexBuildStamp,
): boolean {
	if (!stamp) return false;
	return (
		stamp.chunkerVersion === current.chunkerVersion &&
		stamp.chunkSize === current.chunkSize &&
		stamp.chunkOverlap === current.chunkOverlap &&
		stamp.embedModelId === current.embedModelId
	);
}
