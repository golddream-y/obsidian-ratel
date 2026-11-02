/**
 * @file src/adapters/index-write-flush.ts
 * @description 共享落盘模块 — 统一「同目录唯一临时文件 → 全量写入 → 刷文件 → rename → 刷父目录」的提交语义与平台降级判定
 * @module adapters/index-write-flush
 * @depends node:path, node:crypto
 *
 * 设计要点:
 * - 只负责「把一份字节安全地替换到目标路径」,不关心业务格式与目录布局;文件系统以最小接缝注入,
 *   生产与测试共用同一套提交顺序。迁移侧(`core/index-generations`)与运行期写入口
 *   (`adapters/atomic-index-storage`)目前各写一份,本模块是两者后续接线的唯一实现。
 * - 失败语义分两段:rename **之前**失败 ⇒ 目标保持旧内容(或不存在),临时文件已清理;
 *   rename **之后**失败(只可能是目录同步)⇒ 目标已是完整新内容,但目录项持久性未证明。
 *   调用方需要区分两段时用 `onCommitted` 提交点回调;错误本身始终原样抛出,不包装、不吞。
 * - 目录 fsync 在 Windows 等平台不可用,按错误码降级为成功;其余错误(`EACCES`/`EIO` 等)
 *   一律上抛,避免把真实权限或 IO 故障伪装成「平台不支持」。`syncDirectory` 与写入路径共用同一判定。
 * - rename 之后**不再重新打开目标文件刷一次**:数据在临时文件句柄上已经 fsync,rename 不改变 inode,
 *   重新按路径打开刷的是同一份数据,只是多一次无收益的 IO。
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';

// ==================== 契约常量 ====================

/**
 * 原子写临时文件名标记 — 与 `src/adapters/atomic-index-storage.ts` 的 `ATOMIC_TEMP_FILE_MARKER` 同值。
 *
 * 关键路径:残留判定(如 T3 日志清理)按这个中缀识别「原子写残留」,不能各自复刻命名;
 * 接线后两处只保留一份,当前保持逐字一致。
 */
export const WRITE_FLUSH_TEMP_FILE_MARKER = '.tmp-';

/**
 * 目录 fsync 不被平台支持的错误码 — 视为成功,不改变写入结果。
 *
 * 关键路径:只收「平台不支持/无意义」的码。`EACCES` 是权限问题、`EBADF` 是句柄问题,
 * 都不能当作平台能力缺失,否则真实故障会被静默吞掉。`EPERM` 是 Windows 打开目录句柄的典型错误。
 */
export const DIRECTORY_SYNC_UNSUPPORTED_CODES: ReadonlySet<string> = new Set([
	'EPERM',
	'EISDIR',
	'EINVAL',
	'ENOTSUP',
	'ENOSYS',
]);

// ==================== 文件系统接缝 ====================

/** 写入临时文件用的句柄。 */
export interface WriteFlushFileHandle {
	/**
	 * 写入一段字节。
	 *
	 * @param buffer - 源缓冲区。
	 * @param offset - 源缓冲区内的起始偏移。
	 * @param length - 本次最多写入的字节数。
	 * @returns 实际写入的字节数;允许小于请求长度(短写)。
	 */
	write(buffer: Uint8Array, offset: number, length: number): Promise<number>;
	/** 把文件内容刷到持久存储。 */
	sync(): Promise<void>;
	/** 关闭句柄。 */
	close(): Promise<void>;
}

/** 同步目录项用的句柄。 */
export interface WriteFlushDirectoryHandle {
	/** 同步目录项。 */
	sync(): Promise<void>;
	/** 关闭句柄。 */
	close(): Promise<void>;
}

/**
 * 落盘所需的文件系统最小接缝 — 生产注入 `node:fs/promises` 适配,测试注入同构包装。
 *
 * 关键路径:只暴露提交路径真正用到的能力;`open` 必须承诺以 `wx` 排他创建,
 * 这样两个并发写入者不会复用同一临时文件,`open` 失败也不会被误判成「自己的临时文件」。
 */
export interface WriteFlushFileSystem {
	/**
	 * 以 `wx` 排他创建并打开文件(目标已存在时必须失败,不能覆盖)。
	 *
	 * @param absolutePath - 临时文件绝对路径。
	 * @returns 可写句柄。
	 */
	open(absolutePath: string): Promise<WriteFlushFileHandle>;
	/**
	 * 以只读方式打开目录,用于 fsync 目录项。
	 *
	 * @param absolutePath - 目录绝对路径。
	 * @returns 可同步句柄。
	 */
	openDirectory(absolutePath: string): Promise<WriteFlushDirectoryHandle>;
	/** 同目录原子替换(rename)。 */
	rename(fromPath: string, toPath: string): Promise<void>;
	/** 删除文件(临时文件清理)。 */
	unlink(absolutePath: string): Promise<void>;
}

// ==================== 选项 ====================

/** `writeFileAtomic` 的可选行为。 */
export interface WriteFileAtomicOptions {
	/**
	 * rename 后是否同步父目录项;默认 true。
	 *
	 * 关键路径:目录项持久性只能由父目录 fsync 证明;平台不支持时仍按成功降级,
	 * 关闭此开关只应出现在调用方明确接受「rename 可见但目录项未刷盘」的场景。
	 */
	syncParentDirectory?: boolean;
	/**
	 * 自定义临时文件路径生成器;默认同目录 `<目标名>.tmp-<pid>-<序号>-<uuid>`。
	 *
	 * 关键路径:调用方若还要做路径包含性校验(如限定在代际根内),必须在这里生成并校验,
	 * 不能只校验目标路径 —— 目标就是目录边界时,按 `dirname` 生成的临时路径可能落到边界外。
	 *
	 * @param targetPath - 目标文件绝对路径。
	 * @returns 同目录临时文件绝对路径。
	 */
	createTempPath?: (targetPath: string) => string | Promise<string>;
	/**
	 * rename 成功后的提交点通知 —— 此时目标已是完整新内容,目录项持久性尚未证明。
	 *
	 * 关键路径:运行期写入口要区分「提交前失败(可安全重试)」与「提交后失败(必须先重载核对)」,
	 * 而错误本身会原样抛出、不携带阶段信息;需要该判定的调用方在这里置位。
	 * 回调必须是同步且不抛错的,抛错会被当作提交后异常继续上抛。
	 */
	onCommitted?: () => void;
}

// ==================== 平台判定 ====================

/**
 * 判断错误是否为「平台不支持目录 fsync」。
 *
 * @param error - 任意抛出值。
 * @returns 命中 {@link DIRECTORY_SYNC_UNSUPPORTED_CODES} 时为 true。
 */
export function isDirectorySyncUnsupportedError(error: unknown): boolean {
	const code = readErrorCode(error);
	return code !== null && DIRECTORY_SYNC_UNSUPPORTED_CODES.has(code);
}

// ==================== 对外接口 ====================

/**
 * 原子替换目标文件内容 —— 同目录唯一临时文件 → 全量写入 → 刷文件 → 关闭 → rename → 刷父目录。
 *
 * 关键路径:
 * 1. 临时文件由 `open` 以 `wx` 排他创建,避免覆盖他人临时文件,也避免失败清理时误删;
 * 2. 循环写入直到全部字节写入(允许底层短写),再对**临时文件句柄** `sync()`;
 * 3. 关闭句柄后同目录 `rename` 覆盖目标 —— 这是唯一提交点;
 * 4. rename 后同步父目录项;平台不支持目录 fsync 时降级成功,其它错误上抛;
 * 5. rename 之前失败清理临时文件且不遮蔽原始错误;rename 之后失败不复原目标,也不删目标。
 *
 * @param fileSystem - 文件系统接缝。
 * @param targetPath - 目标文件绝对路径。
 * @param bytes - 要写入的完整字节。
 * @param options - 目录同步开关、临时路径生成器与提交点回调。
 * @throws {Error} 写入、刷盘、rename 或目录同步失败时抛原始错误,不包装;
 *   rename 后失败意味着目标已是新内容,调用方不能假设旧内容仍在。
 * @example
 *   await writeFileAtomic(nodeFileSystem, targetPath, Buffer.from(json, 'utf8'));
 */
export async function writeFileAtomic(
	fileSystem: WriteFlushFileSystem,
	targetPath: string,
	bytes: Uint8Array,
	options: WriteFileAtomicOptions = {},
): Promise<void> {
	const tempPath = options.createTempPath
		? await options.createTempPath(targetPath)
		: createDefaultTempPath(targetPath);

	// 关键路径:只有「临时文件确实由本次成功创建」才允许清理 —— open 失败(如 EEXIST)时
	// 无法证明路径归属,删掉可能属于别人的文件。
	let tempCreated = false;
	let committed = false;
	try {
		const handle = await fileSystem.open(tempPath);
		tempCreated = true;
		await writeAndClose(handle, bytes);
		await fileSystem.rename(tempPath, targetPath);
		committed = true;
		options.onCommitted?.();
		if (options.syncParentDirectory !== false) {
			await syncDirectory(fileSystem, path.dirname(targetPath));
		}
	} catch (error) {
		if (tempCreated && !committed) await removeQuietly(fileSystem, tempPath);
		throw error;
	}
}

/**
 * 同步目录项 —— 打开目录 → `sync()` → 关闭;平台不支持目录 fsync 时降级为成功。
 *
 * 关键路径:打开目录与目录 `sync()` 必须共用同一套「平台不支持」判定 ——
 * 只在打开处降级会让 `sync()` 的 EINVAL/ENOTSUP 被误报成写入失败。
 * 降级发生在 `sync()` 时仍然关闭句柄,不把句柄泄漏给调用方。
 *
 * @param fileSystem - 文件系统接缝。
 * @param directoryPath - 目录绝对路径;文件同步走写入路径的句柄,不要传文件路径。
 * @throws {Error} 打开或同步目录失败,且错误码不属于平台不支持集合时抛原始错误。
 * @example
 *   await syncDirectory(nodeFileSystem, path.dirname(targetPath));
 */
export async function syncDirectory(
	fileSystem: WriteFlushFileSystem,
	directoryPath: string,
): Promise<void> {
	let handle: WriteFlushDirectoryHandle;
	try {
		handle = await fileSystem.openDirectory(directoryPath);
	} catch (error) {
		// 关键路径:Windows 等平台打不开目录句柄;这是能力缺失,不是写入失败。
		if (isDirectorySyncUnsupportedError(error)) return;
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
		// 关键路径:平台不支持目录同步时按成功降级;此时关闭失败不改变「已降级」的结论
		// (与既有两处实现保持一致),但句柄已经尝试关闭。
		if (isDirectorySyncUnsupportedError(syncError)) return;
		throw syncError;
	}
	if (closeError !== null) throw closeError;
}

// ==================== 内部实现 ====================

/** 进程内临时文件序号 — 同一毫秒内的多次写入也靠它区分。 */
let tempSequence = 0;

/**
 * 生成默认的同目录唯一临时路径。
 *
 * 关键路径:临时名必须唯一 —— 固定名会让两个写入者互相覆盖,中断后也无法区分残留归属;
 * 用 pid + 进程内序号 + uuid 保证同一目录内的并发写入互不干扰。
 *
 * @param targetPath - 目标文件绝对路径。
 * @returns 同目录临时文件绝对路径。
 */
function createDefaultTempPath(targetPath: string): string {
	tempSequence += 1;
	const fileName = `${path.basename(targetPath)}${WRITE_FLUSH_TEMP_FILE_MARKER}${process.pid}-${tempSequence}-${randomUUID()}`;
	return path.join(path.dirname(targetPath), fileName);
}

/** 写入全部字节、刷盘并关闭;关闭失败不遮蔽写入失败。 */
async function writeAndClose(handle: WriteFlushFileHandle, bytes: Uint8Array): Promise<void> {
	let primaryError: Error | null = null;
	try {
		await writeAll(handle, bytes);
		await handle.sync();
	} catch (error) {
		primaryError = toError(error);
	}
	const closeError = await closeQuietly(handle);
	// 关键路径:两者都失败时保留先发生的那个;写入失败才是调用方需要处理的根因。
	if (primaryError === null && closeError !== null) primaryError = closeError;
	if (primaryError !== null) throw primaryError;
}

/** 循环写入直到全部字节写入;底层短写是正常现象,零推进才是实现违约。 */
async function writeAll(handle: WriteFlushFileHandle, bytes: Uint8Array): Promise<void> {
	let offset = 0;
	while (offset < bytes.byteLength) {
		const written = await handle.write(bytes, offset, bytes.byteLength - offset);
		if (!Number.isInteger(written) || written <= 0) {
			throw new Error(`写入临时文件未推进(offset=${offset}, written=${String(written)})`);
		}
		offset += written;
	}
}

/** 清理临时文件;失败只吞掉,不遮蔽原始错误。 */
async function removeQuietly(fileSystem: WriteFlushFileSystem, tempPath: string): Promise<void> {
	try {
		await fileSystem.unlink(tempPath);
	} catch {
		// 关键路径:清理失败不能遮蔽原始错误;残留临时文件由按命名约定识别的清理流程回收。
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

/** 读取错误对象上的 `code` 字段,集中做一次结构守卫。 */
function readErrorCode(error: unknown): string | null {
	if (typeof error !== 'object' || error === null) return null;
	const code = (error as { code?: unknown }).code;
	return typeof code === 'string' ? code : null;
}
