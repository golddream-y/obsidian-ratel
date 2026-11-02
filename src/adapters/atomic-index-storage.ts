/**
 * @file src/adapters/atomic-index-storage.ts
 * @description 原子索引存储 — 通过 vectra 公开 `FileStorage` 扩展点提供同目录临时文件 + rename 的原子替换与显式 flush
 * @module adapters/atomic-index-storage
 * @depends node:fs/promises, node:path, node:crypto, vectra, core/index-persistence-types
 *
 * 设计要点:
 * - 生产打包使用 esbuild `browser` 条件,vectra 的 browser 入口**不导出** `LocalFileStorage`,
 *   因此本文件自带等价实现(逐方法对齐 `LocalFileStorage` 语义),而不是继承上游类。
 * - 不给内层实现传 rootFolder:T0 已实测 vectra 传给 storage 的始终是绝对路径,
 *   带 root 会被 `path.join(root, 绝对路径)` 二次拼接成错误路径(见 T0 证据第 7 节第 4 条)。
 * - 所有路径限定在所属代际目录内,代际根自身既不是写入目标也不是递归删除目标;
 *   `upsertFile` 走唯一临时文件 → 写入 → 文件 sync → 关闭 → 同目录 rename → 目录 sync。
 * - 提交结果由本适配器自己记录:`endUpdate` 会把错误包成 `Error saving index: ...` 并丢失原始类型,
 *   调用方只能靠 `getLastWriteOutcome` 区分「提交前失败」与「rename 后状态不明」。
 * - 提交之外的持久化由调用方显式 `flushPath` 强制落盘(例如 T3 写 receipt 之后),不依赖进程退出。
 */

import { writeFileAtomic, type WriteFlushFileSystem } from './index-write-flush';
import { randomUUID } from 'node:crypto';
import { access, mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { FileStorageUtilities } from 'vectra';
import type { FileDetails, FileStorage, ListFilesFilter } from 'vectra';
import { assertPathWithinRoot } from '../core/index-persistence-types';

// ==================== 契约常量 ====================

/**
 * 单次写入的最终结果。
 *
 * 关键路径:
 * - `failed-before-rename`:rename 未执行或确定未生效,磁盘仍是完整旧版(或不存在);
 * - `unknown-after-rename`:rename 可能已生效,磁盘可能是完整新版,但调用方收到了错误,
 *   必须重载后核对,不能假设旧版仍在。
 */
export const ATOMIC_WRITE_OUTCOMES = ['renamed', 'failed-before-rename', 'unknown-after-rename'] as const;

/** 单次写入的最终结果。 */
export type AtomicWriteOutcome = (typeof ATOMIC_WRITE_OUTCOMES)[number];

/**
 * 原子存储错误码。
 *
 * 与 `AtomicWriteOutcome` 的映射关系(两套命名不是同义词,调用方按错误码分流):
 * - `renamed` → 不抛错;
 * - `failed-before-rename` → `write-failed`(磁盘仍是完整旧版,可安全重试);
 * - `unknown-after-rename` → `unknown-after-rename`(磁盘可能是新版,必须先重载核对);
 * - `generation-root-deletion` → 拒绝删除代际根目录,未发生任何磁盘变更。
 */
export const ATOMIC_STORAGE_ERROR_CODES = [
	'write-failed',
	'unknown-after-rename',
	'generation-root-deletion',
] as const;

/** 原子存储错误码。 */
export type AtomicStorageErrorCode = (typeof ATOMIC_STORAGE_ERROR_CODES)[number];

// ==================== 错误与记录 ====================

/**
 * 原子存储错误 — 携带错误码、目标路径与原始错误。
 *
 * 设计要点:
 * - `code` 区分「提交前失败」与「rename 后状态不明」,这是重载决策的唯一依据;
 * - `cause` 保留底层 IO 错误(ENOSPC/EACCES/EIO),便于日志定位。
 */
export class AtomicStorageError extends Error {
	/** 稳定错误码。 */
	readonly code: AtomicStorageErrorCode;
	/** 目标文件绝对路径。 */
	readonly path: string;
	/** 底层原始错误。 */
	readonly cause: unknown;

	constructor(
		code: AtomicStorageErrorCode,
		message: string,
		options: { path: string; cause?: unknown },
	) {
		super(message);
		this.name = 'AtomicStorageError';
		this.code = code;
		this.path = options.path;
		this.cause = options.cause ?? null;
	}
}

/**
 * 一次写入的诊断记录 — 只用于判定提交状态,不参与持久化。
 *
 * 关键路径:`writeSeq` 是本适配器观测到的单调序号,不是磁盘提交顺序的证明:
 * 记录在 rename 与目录同步之后追加,并发写同一路径时最后追加的记录不一定对应最后一次 rename。
 */
export interface AtomicWriteRecord {
	/** 目标文件绝对路径。 */
	readonly path: string;
	/** 本次写入的字节数。 */
	readonly bytes: number;
	/** 写入结果。 */
	readonly outcome: AtomicWriteOutcome;
	/** 失败时的原始错误;成功时为 null。 */
	readonly error: unknown;
	/** 本适配器内单调递增的写入序号 — `getLastWriteOutcome` 按它取该路径最大者。 */
	readonly writeSeq: number;
}

// ==================== 文件系统接缝 ====================

/** 已排他创建的临时文件句柄。 */
export interface AtomicWriteHandle {
	/**
	 * 写入一段字节。
	 *
	 * @returns 实际写入的字节数;允许小于请求长度(短写)。
	 */
	write(buffer: Uint8Array, offset: number, length: number): Promise<number>;
	/** 把文件内容刷到持久存储。 */
	sync(): Promise<void>;
	/** 关闭句柄。 */
	close(): Promise<void>;
}

/** 用于同步目录项的句柄。 */
export interface AtomicDirectoryHandle {
	/** 同步目录项。 */
	sync(): Promise<void>;
	/** 关闭句柄。 */
	close(): Promise<void>;
}

/**
 * 原子写入所需的文件系统接缝 — 生产使用 node 实现,测试注入故障。
 *
 * 关键路径:只覆盖写入路径;其余读/列举/删除方法与 `flushPath` 直接使用 `node:fs/promises`,
 * 因此故障注入不会改变「重新读回的真实磁盘内容」这一断言对象。
 */
export interface AtomicWriteFileSystem {
	/** 以 `wx` 排他创建并打开文件。 */
	openFile(absolutePath: string): Promise<AtomicWriteHandle>;
	/** 以只读方式打开目录,用于 fsync 目录项。 */
	openDirectory(absolutePath: string): Promise<AtomicDirectoryHandle>;
	/** 同目录原子替换。 */
	rename(from: string, to: string): Promise<void>;
	/** 删除文件(临时文件清理)。 */
	removeFile(absolutePath: string): Promise<void>;
}

/** 生产用 node 实现。 */
const nodeAtomicWriteFileSystem: AtomicWriteFileSystem = {
	async openFile(absolutePath: string): Promise<AtomicWriteHandle> {
		const handle = await open(absolutePath, 'wx');
		return {
			async write(buffer: Uint8Array, offset: number, length: number): Promise<number> {
				const result = await handle.write(buffer, offset, length);
				return result.bytesWritten;
			},
			sync: () => handle.sync(),
			close: () => handle.close(),
		};
	},
	async openDirectory(absolutePath: string): Promise<AtomicDirectoryHandle> {
		const handle = await open(absolutePath, 'r');
		return {
			sync: () => handle.sync(),
			close: () => handle.close(),
		};
	},
	rename: (from: string, to: string) => rename(from, to),
	async removeFile(absolutePath: string): Promise<void> {
		await rm(absolutePath, { force: true });
	},
};

// ==================== 写入记录上界 ====================

/**
 * 单路径保留的写入记录条数。
 *
 * 关键路径:记录只服务于 `getLastWriteOutcome`,不需要无限历史;保留少量连续记录便于诊断重试序列。
 */
const WRITE_RECORDS_PER_PATH_LIMIT = 8;

/** 全局写入记录上限 — 防止长期运行时代际内路径数量增长导致无界内存。 */
const WRITE_RECORDS_GLOBAL_LIMIT = 1024;

// ==================== 临时文件命名约定(跨模块共享) ====================

/**
 * 原子写临时文件名标记 — `createTempPath` 生成的同目录临时文件都带这个中缀。
 *
 * 关键路径:消费者(如 T3 日志)必须用它判定「原子写残留」,不能各自复刻命名;
 * 改名时改这一处即可,避免残留文件被当成真实数据解析。
 */
export const ATOMIC_TEMP_FILE_MARKER = '.tmp-';

/**
 * 判断文件名是否为原子写残留的临时文件。
 *
 * 关键路径:`upsertFile` 崩溃可能留下 `<目标名>.tmp-<pid>-<序号>-<uuid>`,
 * 这类文件不属于任何数据契约,只能按命名约定识别。
 *
 * @param name - 单段文件名(不含目录)。
 * @returns 命中临时文件命名时为 true。
 */
export function isAtomicTempLeftoverName(name: string): boolean {
	return name.includes(ATOMIC_TEMP_FILE_MARKER);
}

// ==================== 适配器 ====================

/** `AtomicIndexStorage` 构造选项。 */
export interface AtomicIndexStorageOptions {
	/** 所属代际目录绝对路径;所有文件操作必须落在其内,且该目录自身不可被递归删除。 */
	generationRoot: string;
	/** rename 后是否同步父目录项;默认 true,平台不支持时自动降级。 */
	syncDirectory?: boolean;
	/** 文件系统接缝;仅故障注入测试使用,生产不传。 */
	fileSystem?: AtomicWriteFileSystem;
}

/**
 * 原子索引存储 — vectra `FileStorage` 的实现。
 *
 * 设计要点:
 * - 读/写/删除/列举全部先做代际根包含性校验(含符号链接解析);
 * - `upsertFile` 是同目录临时文件 + rename 的原子替换,失败时清理临时文件且不遮蔽原始错误;
 * - 代际根自身不是写入目标也不是递归删除目标,避免把整代索引当普通目录删掉;
 * - 每次写入的结果记录在实例内(有上界),供调用方在 vectra 包装错误后仍能判定磁盘状态。
 *
 * @example
 *   const storage = new AtomicIndexStorage({ generationRoot });
 *   await storage.upsertFile(path.join(generationRoot, 'index.json'), json);
 *   storage.getLastWriteOutcome(indexPath); // { outcome: 'renamed', writeSeq: 1, ... }
 */
export class AtomicIndexStorage implements FileStorage {
	private readonly generationRoot: string;
	private readonly fileSystem: AtomicWriteFileSystem;
	private readonly syncDirectoryEnabled: boolean;
	private records: AtomicWriteRecord[] = [];
	private sequence = 0;
	private writeSeq = 0;

	/**
	 * @param options - 代际根目录、目录同步开关与可选文件系统接缝。
	 * @throws {Error} 未提供代际根目录。
	 */
	constructor(options: AtomicIndexStorageOptions) {
		if (
			typeof options !== 'object' ||
			options === null ||
			typeof options.generationRoot !== 'string' ||
			options.generationRoot.length === 0
		) {
			throw new Error('AtomicIndexStorage 需要代际根目录绝对路径');
		}
		this.generationRoot = path.resolve(options.generationRoot);
		this.fileSystem = options.fileSystem ?? nodeAtomicWriteFileSystem;
		this.syncDirectoryEnabled = options.syncDirectory !== false;
	}

	// --- 诊断 ---

	/**
	 * 读取当前保留的写入记录(按追加顺序)。
	 *
	 * @returns 写入记录副本;条数受单路径与全局环形上限约束。
	 */
	getWriteRecords(): readonly AtomicWriteRecord[] {
		return [...this.records];
	}

	/**
	 * 读取指定目标最近一次写入结果。
	 *
	 * 关键路径:按该路径的**最大 `writeSeq`** 返回,不依赖数组末尾 — 记录在目录同步之后追加,
	 * 并发写同一路径时最后追加的记录可能不是最后一次 rename 的结论。
	 * 同一路径假定单写者:跨进程或同进程并发写同一路径时,调用方必须重载核对,不能只信此记录。
	 *
	 * @param filePath - 目标文件路径。
	 * @returns 该路径 writeSeq 最大的记录;该路径尚未写入过时为 null。
	 */
	getLastWriteOutcome(filePath: string): AtomicWriteRecord | null {
		const resolved = path.resolve(filePath);
		let latest: AtomicWriteRecord | null = null;
		for (const record of this.records) {
			if (record.path !== resolved) continue;
			if (latest === null || record.writeSeq > latest.writeSeq) latest = record;
		}
		return latest;
	}

	/**
	 * 清空写入记录。
	 *
	 * 关键路径:只清空记录,不重置 `writeSeq` — 序号必须保持单调,否则清空后新旧记录无法比较。
	 */
	clearWriteRecords(): void {
		this.records = [];
	}

	// --- FileStorage:创建与删除 ---

	/**
	 * 以排他方式创建新文件。
	 *
	 * 关键路径:vectra 只在首次创建索引文件时调用;已有文件必须失败,不能静默覆盖。
	 * 目标为代际根时由文件系统以 EISDIR 拒绝,不会产生半截文件。
	 *
	 * @param filePath - 目标文件绝对路径。
	 * @param content - 文件内容。
	 */
	async createFile(filePath: string, content: Buffer | string): Promise<void> {
		const target = await this.resolveContainedPath(filePath);
		await writeFile(target, content, { flag: 'wx' });
	}

	/**
	 * 创建目录(含缺失的父目录)。
	 *
	 * @param folderPath - 目录绝对路径。
	 */
	async createFolder(folderPath: string): Promise<void> {
		const target = await this.resolveContainedPath(folderPath);
		await mkdir(target, { recursive: true });
	}

	/**
	 * 删除文件。
	 *
	 * @param filePath - 目标文件绝对路径。
	 */
	async deleteFile(filePath: string): Promise<void> {
		const target = await this.resolveContainedPath(filePath);
		await unlink(target);
	}

	/**
	 * 递归删除目录。
	 *
	 * 关键路径:代际根就是全部索引数据的容器,递归删除它等于抹掉整个代际 —
	 * 即使调用方误传也必须拒绝,不能依赖调用方自觉。
	 *
	 * @param folderPath - 目录绝对路径。
	 * @throws {AtomicStorageError} 目标是代际根(`generation-root-deletion`)。
	 */
	async deleteFolder(folderPath: string): Promise<void> {
		const target = await this.resolveContainedPath(folderPath);
		if (target === this.generationRoot) {
			throw new AtomicStorageError(
				'generation-root-deletion',
				`拒绝删除代际根目录:${target}`,
				{ path: target },
			);
		}
		await rm(target, { recursive: true });
	}

	// --- FileStorage:查询 ---

	/**
	 * 读取文件或目录详情。
	 *
	 * @param fileOrFolderPath - 目标绝对路径。
	 * @returns 名称、路径、是否目录与已知文件类型。
	 */
	async getDetails(fileOrFolderPath: string): Promise<FileDetails> {
		const target = await this.resolveContainedPath(fileOrFolderPath);
		const stats = await stat(target);
		return {
			name: path.basename(target),
			path: target,
			isFolder: stats.isDirectory(),
			fileType: stats.isFile() ? FileStorageUtilities.getFileType(target) : undefined,
		};
	}

	/**
	 * 列出目录内的条目。
	 *
	 * 关键路径:上游 `LocalFileStorage.listFiles` 忽略 `filter` 参数、始终返回全部条目;
	 * 这里按 `files` / `folders` 真正过滤,结果只会比上游更少,不会多出条目。
	 * 依赖「filter 被忽略」的调用方会看到更少条目,本适配器不复制该上游缺陷。
	 *
	 * @param folderPath - 目录绝对路径。
	 * @param filter - `files` / `folders` / `all`,默认 `all`。
	 * @returns 条目详情数组。
	 */
	async listFiles(folderPath: string, filter: ListFilesFilter = 'all'): Promise<FileDetails[]> {
		const folder = await this.resolveContainedPath(folderPath);
		const entries = await readdir(folder, { withFileTypes: true });
		const details: FileDetails[] = [];
		for (const entry of entries) {
			const isFolder = entry.isDirectory();
			if (filter === 'files' && isFolder) continue;
			if (filter === 'folders' && !isFolder) continue;
			const entryPath = path.join(folder, entry.name);
			details.push({
				name: entry.name,
				path: entryPath,
				isFolder,
				fileType: entry.isFile() ? FileStorageUtilities.getFileType(entry.name) : undefined,
			});
		}
		return details;
	}

	/**
	 * 判断路径是否存在。
	 *
	 * @param fileOrFolderPath - 目标绝对路径。
	 * @returns 存在为 true;不存在或不可访问为 false。
	 */
	async pathExists(fileOrFolderPath: string): Promise<boolean> {
		const target = await this.resolveContainedPath(fileOrFolderPath);
		try {
			await access(target);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * 读取文件内容。
	 *
	 * @param filePath - 目标文件绝对路径。
	 * @returns 文件字节。
	 */
	async readFile(filePath: string): Promise<Buffer> {
		const target = await this.resolveContainedPath(filePath);
		return readFile(target);
	}

	// --- FileStorage:原子替换 ---

	/**
	 * 原子替换文件内容。
	 *
	 * 关键路径:
	 * 1. 同目录唯一临时文件以 `wx` 排他创建,避免覆盖他人临时文件;
	 * 2. 循环写入直到全部字节落盘(允许底层短写)→ 文件 `sync()` → 关闭;
	 * 3. 同目录 `rename` 覆盖目标(原子提交点)→ 同步父目录项;
	 * 4. 提交前失败清理临时文件且不遮蔽原始错误;rename 抛错时按错误码区分「确定未生效」与「可能已生效」。
	 *
	 * @param filePath - 目标文件绝对路径。
	 * @param content - 新内容。
	 * @throws {AtomicStorageError} 提交前失败(`write-failed`)或 rename 后状态不明(`unknown-after-rename`)。
	 */
	async upsertFile(filePath: string, content: Buffer | string): Promise<void> {
		const target = await this.resolveContainedPath(filePath);
		const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
		// 关键路径:临时路径生成后必须再次校验包含性(目标为代际根时会落到根外)。
		const tempPath = await this.createTempPath(target);
		let committed = false;
		let renameAttempted = false;
		// 关键路径:rename 是否发出过决定「提交后状态不明」的判定,共享模块不暴露该阶段,
		// 因此在这里包装一次 rename 记录尝试。
		const flushFileSystem = this.sharedFlushFileSystem({
			onRenameAttempt: () => { renameAttempted = true; },
		});
		try {
			// 关键路径:提交语义与其余写入口共用一份实现(唯一临时名、短写循环、父目录 fsync、
			// 平台不支持目录同步时降级);错误仍原样抛出,由本层补上阶段与写入记录。
			await writeFileAtomic(flushFileSystem, target, buffer, {
				createTempPath: () => tempPath,
				onCommitted: () => { committed = true; },
			});
		} catch (error) {
			const unknown = committed || (renameAttempted && isRenameOutcomeUnknown(error));
			const outcome: AtomicWriteOutcome = unknown ? 'unknown-after-rename' : 'failed-before-rename';
			this.appendRecord(target, buffer.byteLength, outcome, error);
			if (unknown) {
				throw new AtomicStorageError(
					'unknown-after-rename',
					`原子替换后状态不明(rename 可能已生效):${path.basename(target)}`,
					{ path: target, cause: error },
				);
			}
			throw new AtomicStorageError(
				'write-failed',
				`原子替换失败(rename 前):${path.basename(target)}`,
				{ path: target, cause: error },
			);
		}
		this.appendRecord(target, buffer.byteLength, 'renamed', null);
	}

	/** 把注入的文件系统接成共享落盘模块的形状 — 只做名称与返回类型转换。 */
	private sharedFlushFileSystem(hooks: { onRenameAttempt?: () => void } = {}): WriteFlushFileSystem {
		return {
			open: (absolutePath) => this.fileSystem.openFile(absolutePath),
			openDirectory: (absolutePath) => this.fileSystem.openDirectory(absolutePath),
			rename: async (from, to) => {
				hooks.onRenameAttempt?.();
				await this.fileSystem.rename(from, to);
			},
			unlink: (absolutePath) => this.fileSystem.removeFile(absolutePath),
		};
	}

	/**
	 * 显式把目标文件或目录刷到持久存储。
	 *
	 * 关键路径:vectra 只保证 rename 的原子性;调用方写完 receipt 之类的关键文件后必须显式 flush,
	 * 不能依赖进程退出时的缓冲区回写。平台不支持目录 fsync 时与写入路径同样降级为成功。
	 *
	 * @param targetPath - 代际根内的文件或目录绝对路径。
	 * @throws {IndexValidationError} 路径越界。
	 * @throws {Error} 同步失败(平台不支持目录同步的错误码除外)。
	 */
	async flushPath(targetPath: string): Promise<void> {
		const target = await this.resolveContainedPath(targetPath);
		const stats = await stat(target);
		let handle: FileHandle;
		try {
			handle = await open(target, 'r');
		} catch (error) {
			// 关键路径:Windows 打不开目录句柄;与写入路径共用同一降级判定。
			if (stats.isDirectory() && isDirectorySyncUnsupported(error)) return;
			throw error;
		}
		let syncError: Error | null = null;
		try {
			await handle.sync();
		} catch (error) {
			syncError = toError(error);
		}
		const closeError = await closeQuietly(handle);
		if (syncError !== null) {
			if (isDirectorySyncUnsupported(syncError)) return;
			throw syncError;
		}
		if (closeError !== null) throw closeError;
	}

	// --- 内部实现 ---

	/** 路径包含性校验(含符号链接解析)。 */
	private async resolveContainedPath(fileOrFolderPath: string): Promise<string> {
		return assertPathWithinRoot(fileOrFolderPath, this.generationRoot);
	}

	/**
	 * 生成同目录唯一临时文件路径,并再次校验包含性。
	 *
	 * 关键路径:临时路径由目录名 + 文件名拼接产生,不能只依赖目标路径已通过校验 —
	 * 目标就是代际根时,`dirname` 会把临时文件放到根外,因此生成后必须重新校验。
	 */
	private async createTempPath(targetPath: string): Promise<string> {
		this.sequence += 1;
		const directory = path.dirname(targetPath);
		const fileName = `${path.basename(targetPath)}.tmp-${process.pid}-${this.sequence}-${randomUUID()}`;
		return assertPathWithinRoot(path.join(directory, fileName), this.generationRoot);
	}

	/** 写入全部字节、刷盘并关闭;关闭失败不遮蔽写入失败。 */
	private async writeAndClose(handle: AtomicWriteHandle, buffer: Uint8Array): Promise<void> {
		let primaryError: Error | null = null;
		try {
			await this.writeAll(handle, buffer);
			await handle.sync();
		} catch (error) {
			primaryError = toError(error);
		}
		const closeError = await closeQuietly(handle);
		if (primaryError === null && closeError !== null) primaryError = closeError;
		if (primaryError !== null) throw primaryError;
	}

	/** 循环写入直到全部字节落盘。 */
	private async writeAll(handle: AtomicWriteHandle, buffer: Uint8Array): Promise<void> {
		let offset = 0;
		while (offset < buffer.byteLength) {
			const written = await handle.write(buffer, offset, buffer.byteLength - offset);
			if (!Number.isInteger(written) || written <= 0) {
				throw new Error(`写入临时文件未推进(offset=${offset}, written=${String(written)})`);
			}
			offset += written;
		}
	}

	/**
	 * 同步父目录项;平台不支持时降级为成功。
	 *
	 * 关键路径:打开目录与目录 `sync()` 必须用同一套「平台不支持」判定 —
	 * 只在打开处降级会让 `sync()` 的 EINVAL/ENOTSUP 被误报成 rename 后状态不明。
	 */
	private async syncParentDirectory(directoryPath: string): Promise<void> {
		if (!this.syncDirectoryEnabled) return;
		let handle: AtomicDirectoryHandle;
		try {
			handle = await this.fileSystem.openDirectory(directoryPath);
		} catch (error) {
			// 关键路径:Windows 等平台不支持目录 fsync,不能把已成功的写入报成失败。
			if (isDirectorySyncUnsupported(error)) return;
			throw error;
		}
		let syncError: Error | null = null;
		try {
			await handle.sync();
		} catch (error) {
			syncError = toError(error);
		}
		const closeError = await closeQuietly(handle);
		if (syncError !== null) {
			if (isDirectorySyncUnsupported(syncError)) return;
			throw syncError;
		}
		if (closeError !== null) throw closeError;
	}

	/** 清理临时文件;失败只记录到控制流之外,不抛出。 */
	private async removeTempQuietly(tempPath: string): Promise<void> {
		try {
			await this.fileSystem.removeFile(tempPath);
		} catch {
			// 关键路径:清理失败不能遮蔽原始错误;残留临时文件由 T3 的清理流程回收。
		}
	}

	/** 追加一条写入记录,并维持单路径与全局环形上限。 */
	private appendRecord(
		target: string,
		bytes: number,
		outcome: AtomicWriteOutcome,
		error: unknown,
	): void {
		this.writeSeq += 1;
		this.records.push({ path: target, bytes, outcome, error, writeSeq: this.writeSeq });
		// 关键路径:先按路径裁剪,再按全局上限裁剪,保证两个上界同时生效。
		let samePathCount = 0;
		for (let index = this.records.length - 1; index >= 0; index -= 1) {
			const record = this.records[index];
			if (record === undefined || record.path !== target) continue;
			samePathCount += 1;
			if (samePathCount > WRITE_RECORDS_PER_PATH_LIMIT) this.records.splice(index, 1);
		}
		while (this.records.length > WRITE_RECORDS_GLOBAL_LIMIT) this.records.shift();
	}
}

/** 关闭句柄;返回错误而不是抛出,便于保留主错误。 */
async function closeQuietly(handle: { close(): Promise<void> }): Promise<Error | null> {
	try {
		await handle.close();
		return null;
	} catch (error) {
		return toError(error);
	}
}

/** 把任意抛出值收敛为 Error,避免向上抛出非错误对象。 */
function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

/**
 * 读取错误对象上的 `code` 字段。
 *
 * 关键路径:Node 的 IO 错误是 `Error` 子类,`code` 不在类型上;集中做一次结构守卫,
 * 避免各处散落 `(error as { code?: unknown }).code` 断言。
 */
function getErrorCode(error: unknown): string | null {
	if (typeof error !== 'object' || error === null) return null;
	const code = (error as { code?: unknown }).code;
	return typeof code === 'string' ? code : null;
}

/**
 * 目录 fsync 不被平台支持的错误码 — 视为成功,不改变写入结果。
 *
 * 关键路径:只收「平台不支持/无意义」的码。`EACCES` 是权限问题、`EBADF` 是句柄问题,
 * 都不能当作平台能力缺失;否则真实故障会被静默吞掉。
 */
const DIRECTORY_SYNC_UNSUPPORTED_CODES: ReadonlySet<string> = new Set([
	'EPERM',
	'EISDIR',
	'EINVAL',
	'ENOTSUP',
	'ENOSYS',
]);

/** 判断是否为「平台不支持目录 fsync」。 */
function isDirectorySyncUnsupported(error: unknown): boolean {
	const code = getErrorCode(error);
	return code !== null && DIRECTORY_SYNC_UNSUPPORTED_CODES.has(code);
}

/**
 * rename 抛错时「确定未生效」的错误码 — 只有这些码可以安全归入 `failed-before-rename`。
 *
 * 关键路径:`EIO` 与未知错误码不在集合内:此时 rename 可能已生效,磁盘可能已是完整新版,
 * 归入提交前失败会让调用方按「旧版仍在」继续搜索,产生与磁盘不一致的结果。
 */
const RENAME_NOT_APPLIED_CODES: ReadonlySet<string> = new Set([
	'EACCES',
	'EPERM',
	'ENOSPC',
	'ENOENT',
	'EROFS',
	'EXDEV',
	'EINVAL',
	'ENOTDIR',
	'EISDIR',
	'ENAMETOOLONG',
	'EDQUOT',
	'EMFILE',
	'ENFILE',
	'ELOOP',
	'EBUSY',
	'EEXIST',
]);

/** 判断 rename 抛错是否属于「可能已生效」。 */
function isRenameOutcomeUnknown(error: unknown): boolean {
	const code = getErrorCode(error);
	return code === null || !RENAME_NOT_APPLIED_CODES.has(code);
}
