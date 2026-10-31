/**
 * @file src/core/index-write-owner.ts
 * @description 写所有权 — renderer 内共享协调器(epoch 交接)与索引根目录 owner 锁(跨进程排他)
 * @module core/index-write-owner
 * @depends node:fs, node:fs/promises, node:os, node:path
 *
 * 设计要点:
 * - 同 renderer 的插件重载走 `globalThis` 上按规范化根目录登记的共享协调器:新实例接管生成新 epoch,
 *   旧 epoch 立即不能再开始提交,新实例必须等旧实例的 closing Promise;旧实例永久挂起时只报占用、不抢写。
 *   closing 不只看「调用过 release」:它还等在途提交全部结算(I2),否则重载打断写入时两个 owner 会同时写盘。
 * - 不同进程走索引根目录下排他创建的 owner 锁:锁记录本机进程身份、实例令牌与协调器版本。
 *   创建、释放、死亡回收全部经过同一个排他恢复门,并在门内重新读取、核对旧令牌,
 *   避免两个回收者依据同一旧快照先后删除后继实例的锁。
 * - 任何情况下都不按「过期时间」抢锁:休眠、心跳停止、租期过期都不能证明旧写入者已退出。
 *   只有「能证明进程已不存在」或「同进程内共享协调器确认该实例令牌已不活跃」才允许回收;
 *   外机锁、空/坏锁、PID 存活但身份不明、无权限探测一律保守报占用。
 * - 锁与门的内容一律原子写入(见「原子写入」小节):目标路径上不会出现 0 字节或半截 JSON,
 *   因此本版本自己不再产出损坏文件;仍可能遇到旧版本或外部损坏留下的坏锁/坏门,
 *   它们**默认继续拒绝写入**,只能由调用方显式调用隔离 API 处理,不自动抢锁。
 * - 删除任何「可能是别人的」文件前都要「比较后再删除」:先原子改名摘走,再核对内容,
 *   不是我们观察到的那一份就原样恢复,避免 read-then-rm 的 TOCTOU 删掉后继实例的活锁/活门。
 * - 错误消息是中文开发向文案,不在此处建 i18n key;错误码稳定,供 T7 映射用户可见文案。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// ==================== 契约常量 ====================

/** 共享协调器的注册键 — 同一 renderer 内所有插件实例必须命中同一个键。 */
export const INDEX_WRITE_OWNER_SYMBOL_KEY = 'ratel.index.write-owner.v2';

/** 共享协调器的注册符号。 */
export const INDEX_WRITE_OWNER_SYMBOL: unique symbol = Symbol.for(INDEX_WRITE_OWNER_SYMBOL_KEY);

/** 协调器版本 — 版本不一致时拒绝接管,不猜测旧实例状态。 */
export const INDEX_WRITE_OWNER_COORDINATOR_VERSION = 2;

/** owner 锁文件名(位于索引根目录下)。 */
export const INDEX_OWNER_LOCK_FILE = 'owner.lock';

/** 恢复门文件名 — 所有锁的创建/释放/回收都经过它。 */
export const INDEX_OWNER_RECOVERY_GATE_FILE = 'owner.recovery.lock';

/** owner 锁记录 schema 版本。 */
export const OWNER_LOCK_SCHEMA_VERSION = 2;

/** 写所有权错误码清单 — 判别式稳定,调用方与测试按码判断,不依赖消息措辞。 */
export const INDEX_WRITE_OWNER_ERROR_CODES = [
	'root-invalid',
	'instance-token-invalid',
	'instance-token-duplicate',
	'coordinator-version-mismatch',
	'predecessor-not-closed',
	'concurrent-takeover',
	'epoch-revoked',
	'lease-released',
	'owner-busy',
	'owner-token-changed',
	'owner-lock-corrupt',
	'owner-lock-foreign-host',
	'owner-lock-version-mismatch',
	'owner-lock-write-failed',
	'owner-lock-permission-denied',
	'owner-lock-no-space',
	'owner-lock-read-only-fs',
	'recovery-gate-busy',
	'quarantine-not-confirmed',
] as const;

/** 写所有权错误码。 */
export type IndexWriteOwnerErrorCode = (typeof INDEX_WRITE_OWNER_ERROR_CODES)[number];

/**
 * fs errno → 稳定错误码的集中映射表。
 *
 * 关键路径:未列出的 errno 一律收敛为 `owner-lock-write-failed`,原始 errno 放进 `detail.errno`,
 * 原始错误对象放进 `cause`;调用方与用户文案只按错误码判断,不需要解析 errno 字符串。
 */
export const OWNER_IO_ERROR_CODE_BY_ERRNO: Readonly<Record<string, IndexWriteOwnerErrorCode>> = {
	EACCES: 'owner-lock-permission-denied',
	EPERM: 'owner-lock-permission-denied',
	ENOSPC: 'owner-lock-no-space',
	EDQUOT: 'owner-lock-no-space',
	EROFS: 'owner-lock-read-only-fs',
};

/** 锁检查结论 — 只描述「现在能不能接管」,不修改磁盘。 */
export const OWNER_LOCK_STATES = [
	'missing',
	'held-by-us',
	'recoverable',
	'held-by-live-owner',
	'foreign-host',
	'version-mismatch',
	'corrupt',
] as const;

/** 锁检查结论。 */
export type OwnerLockState = (typeof OWNER_LOCK_STATES)[number];

/** 锁检查原因 — 与状态配合给出可断言的稳定原因。 */
export const OWNER_LOCK_REASONS = [
	'no-lock',
	'same-token',
	'process-exited',
	'instance-inactive',
	'instance-active',
	'process-alive',
	'no-permission',
	'foreign-host',
	'coordinator-version-mismatch',
	'record-invalid',
	'root-mismatch',
] as const;

/** 锁检查原因。 */
export type OwnerLockReason = (typeof OWNER_LOCK_REASONS)[number];

// ==================== 错误与记录 ====================

/** 构造写所有权错误的选项。 */
export interface IndexWriteOwnerErrorOptions {
	/** 诊断细节;不含笔记正文。 */
	detail?: Record<string, unknown>;
	/** 原始错误(fs errno 等),只作诊断与重试依据。 */
	cause?: unknown;
}

/**
 * 写所有权错误 — 携带稳定错误码与诊断细节。
 *
 * 设计要点:`detail` 只放诊断字段(根目录、实例令牌、epoch、原因),不放笔记内容。
 */
export class IndexWriteOwnerError extends Error {
	/** 稳定错误码。 */
	readonly code: IndexWriteOwnerErrorCode;
	/** 诊断细节;不含笔记正文。 */
	readonly detail: Readonly<Record<string, unknown>>;
	/** 原始错误 — 保留 errno 等底层信息,便于排障与重试判断。 */
	readonly cause?: unknown;

	constructor(code: IndexWriteOwnerErrorCode, message: string, options: IndexWriteOwnerErrorOptions = {}) {
		super(message);
		this.name = 'IndexWriteOwnerError';
		this.code = code;
		this.detail = options.detail ?? {};
		if (options.cause !== undefined) this.cause = options.cause;
	}
}

/** 锁记录的进程身份 — 本机进程身份由 pid + 主机名构成,启动时间只作诊断。 */
export interface OwnerLockProcessIdentity {
	/** 进程号。 */
	readonly pid: number;
	/** 主机名。 */
	readonly hostname: string;
	/** 本进程启动时间(毫秒时间戳);无法确认其他进程时只作诊断。 */
	readonly startTimeMs: number | null;
}

/** 索引根目录 owner 锁记录。 */
export interface OwnerLockRecord {
	/** 记录 schema 版本。 */
	readonly schemaVersion: typeof OWNER_LOCK_SCHEMA_VERSION;
	/** 写入该锁的协调器版本。 */
	readonly coordinatorVersion: number;
	/**
	 * 规范化后的索引根目录**身份 key** — 用于核对锁确实属于该根。
	 *
	 * 关键路径:存 key 而不是 IO 路径 —— darwin/win32 上大小写不敏感的卷必须映射到同一个 key,
	 * 否则同一根目录会因为大小写/符号链接差异被判成 `root-mismatch` 且不可恢复。
	 */
	readonly root: string;
	/** 取得锁的插件实例令牌。 */
	readonly instanceToken: string;
	/** 取得锁时的协调器 epoch;跨进程只作诊断。 */
	readonly epoch: number;
	/** 本机进程身份。 */
	readonly process: OwnerLockProcessIdentity;
	/** 取得锁的墙钟时间 — 只作诊断,绝不用于判断是否过期。 */
	readonly acquiredAt: number;
}

/** 锁检查结果。 */
export interface OwnerLockInspection {
	/** 结论。 */
	readonly state: OwnerLockState;
	/** 结论原因。 */
	readonly reason: OwnerLockReason;
	/** 解析出的记录;无法解析时为 null。 */
	readonly record: OwnerLockRecord | null;
	/** 磁盘原文 — 门内核对旧令牌的依据。 */
	readonly raw: string | null;
}

// ==================== 根目录规范化 ====================

/**
 * 规范化索引根目录 — 返回**可用于 IO** 的绝对真实路径。
 *
 * 关键路径:先 `path.resolve`,再用 `realpath` 消掉符号链接差异(目标不存在时退化为
 * 「最近已存在祖先的 realpath + 剩余片段」,避免父级符号链接造成两个根)。
 * 这里**不**做小写化:大小写敏感卷上把小写路径拿去 IO 会打开/创建另一个目录。
 * 需要身份比较时用 {@link normalizeIndexRootKey}。
 *
 * @param root - 索引根目录(绝对或相对路径)。
 * @returns 解析后的真实绝对路径。
 * @throws {IndexWriteOwnerError} 空路径或含 NUL(`root-invalid`)。
 */
export function normalizeIndexRoot(root: string): string {
	if (typeof root !== 'string' || root.length === 0) {
		throw new IndexWriteOwnerError('root-invalid', '索引根目录必须是非空字符串');
	}
	if (root.includes('\0')) {
		throw new IndexWriteOwnerError('root-invalid', '索引根目录不能包含 NUL 字符');
	}
	const resolved = path.resolve(root);
	const real = realpathIfPossible(resolved);
	// Windows 路径本身大小写不敏感,Node 与系统 API 都接受任意大小写,统一小写不影响 IO。
	return process.platform === 'win32' ? real.toLowerCase() : real;
}

/**
 * 根目录身份 key — 协调器注册表与锁记录比较都用它。
 *
 * 关键路径:darwin/win32 的默认卷大小写不敏感,同一目录用不同大小写写法必须映射到同一个 key;
 * Linux 等大小写敏感平台保持原样,不能把两个真实不同的目录合并。
 *
 * @param root - 索引根目录。
 * @returns 规范化身份 key。
 * @throws {IndexWriteOwnerError} 空路径或含 NUL(`root-invalid`)。
 */
export function normalizeIndexRootKey(root: string): string {
	const normalized = normalizeIndexRoot(root);
	return process.platform === 'darwin' || process.platform === 'win32'
		? normalized.toLowerCase()
		: normalized;
}

/**
 * 尽可能取真实路径;目标尚不存在时逐级向上找最近的已存在祖先。
 *
 * @param target - 已 resolve 的绝对路径。
 * @returns 真实路径;无法解析时原样返回。
 */
function realpathIfPossible(target: string): string {
	try {
		return fs.realpathSync.native(target);
	} catch {
		// 目标尚未创建 —— 继续找最近的已存在祖先。
	}
	const segments: string[] = [];
	let current = target;
	for (;;) {
		const parent = path.dirname(current);
		if (parent === current) return target;
		segments.unshift(path.basename(current));
		current = parent;
		try {
			return path.join(fs.realpathSync.native(current), ...segments);
		} catch {
			continue;
		}
	}
}

// ==================== 原子写入与比较后再删除 ====================

/** 目录 fsync 时视为「平台不支持」的 errno — 这些失败不能让锁操作失败。 */
const DIRECTORY_SYNC_IGNORED_ERRNOS: ReadonlySet<string> = new Set([
	'EINVAL',
	'ENOTSUP',
	'EOPNOTSUPP',
	'ENOSYS',
	'EISDIR',
	'EPERM',
	'EACCES',
	'EBADF',
]);

/** 临时文件计数器 — 与 pid、时间一起保证同目录临时名唯一。 */
let tempFileCounter = 0;

/**
 * 生成同目录唯一临时文件名。
 *
 * @param dir - 目录。
 * @param baseName - 目标文件名,用于排障时一眼看出归属。
 */
function nextTempName(dir: string, baseName: string): string {
	tempFileCounter += 1;
	const random = Math.random().toString(36).slice(2, 8);
	return path.join(
		dir,
		`.${baseName}.${process.pid}.${Date.now().toString(36)}.${tempFileCounter}.${random}.tmp`,
	);
}

/** 静默删除 — 清理失败不得掩盖主错误。 */
async function removeQuietly(filePath: string): Promise<void> {
	try {
		await fsp.rm(filePath, { force: true });
	} catch {
		// 关键路径:临时文件/隔离文件的清理失败只影响空间,不影响正确性,不能覆盖主错误。
	}
}

/** 读取文本文件;不存在时返回 null,其他 IO 错误收敛为稳定错误码。 */
async function readTextOrNull(filePath: string): Promise<string | null> {
	try {
		return await fsp.readFile(filePath, 'utf8');
	} catch (error) {
		if (isErrnoError(error, 'ENOENT')) return null;
		throw toOwnerIoError(error, '读取文件', { path: filePath });
	}
}

/**
 * 目录 fsync — 让 rename/link 产生的目录项落盘。
 *
 * 平台不支持目录 fsync 时静默跳过;磁盘满/只读等真实错误仍然上报。
 */
async function syncDirectory(dir: string): Promise<void> {
	let handle: FileHandle | null = null;
	try {
		handle = await fsp.open(dir, 'r');
		await handle.sync();
	} catch (error) {
		const errno = readErrno(error);
		if (errno === null || !DIRECTORY_SYNC_IGNORED_ERRNOS.has(errno)) {
			throw toOwnerIoError(error, '同步目录', { path: dir });
		}
	} finally {
		if (handle !== null) await handle.close().catch(() => undefined);
	}
}

/**
 * 把内容写入同目录唯一临时文件并落盘(open wx → 写入 → 文件 fsync → close)。
 *
 * @param filePath - 最终目标路径(只用它的目录与文件名生成临时名)。
 * @param payload - 要写入的完整内容。
 * @returns 已落盘的临时文件绝对路径。
 */
async function writeTempFileSynced(filePath: string, payload: string): Promise<string> {
	const dir = path.dirname(filePath);
	const tempPath = nextTempName(dir, path.basename(filePath));
	let handle: FileHandle | null = null;
	try {
		handle = await fsp.open(tempPath, 'wx', 0o600);
		await handle.writeFile(payload, 'utf8');
		await handle.sync();
	} catch (error) {
		if (handle !== null) {
			await handle.close().catch(() => undefined);
			handle = null;
		}
		await removeQuietly(tempPath);
		throw toOwnerIoError(error, '写入临时文件', { path: tempPath });
	} finally {
		if (handle !== null) await handle.close().catch(() => undefined);
	}
	return tempPath;
}

/**
 * 原子且排他地创建文件。
 *
 * 关键路径 —— 原子:内容先写进同目录唯一临时文件并 fsync,再以**目录项操作**进入目标路径;
 * 目标路径永远不会出现「已创建但内容未写」的 0 字节中间态(这正是 B2 报告里
 * `wx` 建空文件再写的窗口)。创建成功后再 fsync 目录,让目录项本身落盘。
 *
 * 关键路径 —— 排他:进入目录项用的是 `link`,不是 `rename`。`link` 在目标已存在时以 EEXIST
 * **原子失败**,两个进程不可能同时成功;`rename` 会覆盖已有文件,排他性就丢了。
 * 平台不支持硬链接时按稳定错误码明确失败(未映射的 errno 收敛为 `owner-lock-write-failed`,
 * 权限类 errno 见 {@link OWNER_IO_ERROR_CODE_BY_ERRNO}),不退化成 `wx` 建空文件再写 ——
 * 那会把已经修掉的空文件窗口重新引回来。
 *
 * @param filePath - 目标路径。
 * @param payload - 完整内容。
 * @returns `created` 表示本次创建成功;`exists` 表示目标已存在且未被动过。
 */
async function createFileAtomically(filePath: string, payload: string): Promise<'created' | 'exists'> {
	const tempPath = await writeTempFileSynced(filePath, payload);
	try {
		await fsp.link(tempPath, filePath);
	} catch (error) {
		if (isErrnoError(error, 'EEXIST')) return 'exists';
		throw toOwnerIoError(error, '创建文件', { path: filePath });
	} finally {
		await removeQuietly(tempPath);
	}
	await syncDirectory(path.dirname(filePath));
	return 'created';
}

/** 比较后再删除的结论。 */
type CompareRemoveOutcome = 'removed' | 'missing' | 'changed';

/**
 * 比较后再删除 — 用「原子改名 + 内容核对」替代 read-then-rm。
 *
 * 关键路径:rename 成功即代表「此刻磁盘上的那一份」已经被摘到本进程独占的隔离名,
 * 后续核对针对的是确定的那一份;内容不是我们观察到的那一份就原样恢复并放弃删除。
 * 这样即使读取之后文件被后继实例替换,也绝不会删除后继实例的活锁/活门(I3)。
 *
 * @param filePath - 待删除文件。
 * @param expectedRaw - 调用方先前读到的原文;只有内容完全一致才真正删除。
 * @returns 删除结论。
 */
async function compareAndRemoveFile(
	filePath: string,
	expectedRaw: string,
): Promise<CompareRemoveOutcome> {
	const dir = path.dirname(filePath);
	const quarantine = nextTempName(dir, `${path.basename(filePath)}.compare`);
	try {
		await fsp.rename(filePath, quarantine);
	} catch (error) {
		if (isErrnoError(error, 'ENOENT')) return 'missing';
		throw toOwnerIoError(error, '摘取待删除文件', { path: filePath });
	}
	const movedRaw = await readTextOrNull(quarantine);
	if (movedRaw === expectedRaw) {
		await removeQuietly(quarantine);
		await syncDirectory(dir);
		return 'removed';
	}
	// 关键路径:期间已被后继实例替换 —— 恢复回去,放弃删除。
	const occupied = await readTextOrNull(filePath);
	if (occupied === null) {
		await fsp.rename(quarantine, filePath).catch(() => undefined);
	}
	// 目标已被第三者占用时保留隔离文件(里面有别人的内容),不删除、不覆盖。
	return 'changed';
}

/**
 * 损坏文件隔离名 — `<file>.corrupt-<时间戳>`,冲突时追加序号。
 *
 * @param filePath - 待隔离文件。
 * @param timestamp - 隔离时间(毫秒)。
 */
function corruptQuarantineName(filePath: string, timestamp: number): string {
	const dir = path.dirname(filePath);
	const base = path.basename(filePath);
	const stamp = new Date(timestamp).toISOString().replace(/[:.]/g, '-');
	const primary = path.join(dir, `${base}.corrupt-${stamp}`);
	if (!fs.existsSync(primary)) return primary;
	for (let index = 1; index < 100; index += 1) {
		const candidate = `${primary}-${index}`;
		if (!fs.existsSync(candidate)) return candidate;
	}
	return `${primary}-${process.pid}`;
}

/**
 * 把文件原子改名到隔离名,并核对摘走的确实是我们观察到的那一份。
 *
 * @param filePath - 待隔离文件。
 * @param expectedRaw - 调用方先前读到的原文。
 * @param timestamp - 隔离时间(毫秒)。
 * @returns 隔离后的路径;文件已消失或内容已变时返回 null(此时不做任何删除)。
 */
async function moveToQuarantine(
	filePath: string,
	expectedRaw: string,
	timestamp: number,
): Promise<string | null> {
	const target = corruptQuarantineName(filePath, timestamp);
	try {
		await fsp.rename(filePath, target);
	} catch (error) {
		if (isErrnoError(error, 'ENOENT')) return null;
		throw toOwnerIoError(error, '隔离损坏文件', { path: filePath });
	}
	const movedRaw = await readTextOrNull(target);
	if (movedRaw !== expectedRaw) {
		// 关键路径:读取之后被替换成别人的文件 —— 恢复原样,不隔离别人的内容。
		const occupied = await readTextOrNull(filePath);
		if (occupied === null) {
			await fsp.rename(target, filePath).catch(() => undefined);
		}
		return null;
	}
	await syncDirectory(path.dirname(filePath));
	return target;
}

// ==================== renderer 内共享协调器 ====================

/** 可注入时钟 — 默认用 `globalThis` 的真实定时器。 */
export interface OwnerClock {
	/** 设定一次性定时器。 */
	setTimeout(handler: () => void, timeoutMs: number): unknown;
	/** 取消定时器。 */
	clearTimeout(handle: unknown): void;
}

/** 默认时钟 — 直接用 `globalThis` 上的定时器,不依赖 `window`,便于子进程复用同一实现。 */
const defaultClock: OwnerClock = {
	setTimeout: (handler, timeoutMs) => globalThis.setTimeout(handler, timeoutMs),
	clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** 协调器快照 — 诊断与测试用。 */
export interface WriteOwnerSnapshot {
	/** 规范化根目录身份 key。 */
	readonly root: string;
	/** 当前活动 epoch;没有 owner 时为 0。 */
	readonly epoch: number;
	/** 当前活动实例令牌;没有 owner 时为 null。 */
	readonly instanceToken: string | null;
	/** 当前 owner 是否已被接管请求撤销。 */
	readonly revoked: boolean;
	/** 当前 owner 是否已释放。 */
	readonly released: boolean;
	/** 是否仍有前任 closing(在途提交)未结算。 */
	readonly closingPending: boolean;
}

/** 一次在途提交的结算凭据。 */
export interface WriteCommitTicket {
	/** 结算这次提交;幂等,重复调用不会重复扣减。 */
	settle(): void;
}

/** 写所有权租约 — 一个插件实例在某个根目录上的写许可。 */
export interface WriteOwnerLease {
	/** 规范化根目录身份 key。 */
	readonly root: string;
	/** 实例令牌。 */
	readonly instanceToken: string;
	/** 本次接管的 epoch。 */
	readonly epoch: number;
	/** 本租约是否仍是当前可写 owner。 */
	isActive(): boolean;
	/**
	 * 断言本租约仍可提交。
	 *
	 * @throws {IndexWriteOwnerError} 已释放(`lease-released`)或已被接管撤销(`epoch-revoked`)。
	 */
	assertWritable(): void;
	/**
	 * 登记一次在途提交 — release 之后的 closing 会等它结算才 resolve。
	 *
	 * 关键路径:磁盘提交必须在开始前登记、结束后结算,否则重载打断写入时新实例会误判
	 * 「旧实例已经关完」并同时写盘(I2)。
	 *
	 * @returns 结算凭据。
	 * @throws {IndexWriteOwnerError} 已释放或已被接管撤销。
	 */
	beginCommit(): WriteCommitTicket;
	/** 释放租约;幂等。closing 要等在途提交全部结算后才 resolve。 */
	release(): Promise<void>;
}

/** 获取租约的选项。 */
export interface WriteOwnerAcquireOptions {
	/** 实例令牌 — 必须非空且在同一根目录内唯一。 */
	instanceToken: string;
	/** 等待前任 closing Promise 的上限(毫秒),默认 5000;超时只报占用,不抢写。 */
	closeTimeoutMs?: number;
	/** 时钟接缝;默认真实定时器。 */
	clock?: OwnerClock;
}

/** 某个根目录的共享写协调器。 */
export interface RootWriteCoordinator {
	/** 规范化根目录身份 key。 */
	readonly root: string;
	/** 协调器版本。 */
	readonly coordinatorVersion: number;
	/** 读取当前快照。 */
	snapshot(): WriteOwnerSnapshot;
	/**
	 * 该实例令牌是否仍持有可写 epoch — owner 锁用它判断同进程锁能否回收。
	 *
	 * @param instanceToken - 待核实的实例令牌。
	 */
	isTokenActive(instanceToken: string): boolean;
	/**
	 * 接管写所有权。
	 *
	 * 关键路径:接管请求立即撤销前任 epoch(旧实例不能开始新提交),然后等待前任 closing Promise;
	 * closing 包含在途提交,等待超时只报占用,不发放新 epoch。
	 *
	 * @param options - 实例令牌与等待上限。
	 * @returns 新租约。
	 * @throws {IndexWriteOwnerError} 令牌非法/重复、前任未关闭或协调器版本不符。
	 */
	acquire(options: WriteOwnerAcquireOptions): Promise<WriteOwnerLease>;
}

/** 单个根目录内的活动 owner。 */
interface ActiveOwner {
	token: string;
	epoch: number;
	revoked: boolean;
	released: boolean;
	/** 已登记、尚未结算的在途提交数。 */
	pendingCommits: number;
	closing: Promise<void>;
	resolveClosing: () => void;
	closingResolved: boolean;
}

/** 默认等待上限(毫秒)。 */
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

/** 租约实现 — 所有可写判断都回到协调器的当前 owner。 */
class Lease implements WriteOwnerLease {
	private readonly coordinator: RootCoordinator;
	private readonly owner: ActiveOwner;

	constructor(coordinator: RootCoordinator, owner: ActiveOwner) {
		this.coordinator = coordinator;
		this.owner = owner;
	}

	get root(): string {
		return this.coordinator.root;
	}

	get instanceToken(): string {
		return this.owner.token;
	}

	get epoch(): number {
		return this.owner.epoch;
	}

	isActive(): boolean {
		return !this.owner.released && !this.owner.revoked && this.coordinator.isActiveOwner(this.owner);
	}

	assertWritable(): void {
		if (this.owner.released) {
			throw new IndexWriteOwnerError('lease-released', `实例 ${this.owner.token} 的写租约已释放`, {
				detail: { root: this.root, epoch: this.owner.epoch },
			});
		}
		if (this.owner.revoked || !this.coordinator.isActiveOwner(this.owner)) {
			throw new IndexWriteOwnerError('epoch-revoked', `实例 ${this.owner.token} 的 epoch 已被新实例接管`, {
				detail: { root: this.root, epoch: this.owner.epoch },
			});
		}
	}

	beginCommit(): WriteCommitTicket {
		// 关键路径:撤销后不允许再开始新提交;已经开始的提交不受影响,由 closing 等它们结算。
		this.assertWritable();
		this.coordinator.registerCommit(this.owner);
		let settled = false;
		return {
			settle: (): void => {
				if (settled) return;
				settled = true;
				this.coordinator.settleCommit(this.owner);
			},
		};
	}

	async release(): Promise<void> {
		if (this.owner.released) return;
		this.coordinator.releaseOwner(this.owner);
	}
}

/** 单个根目录的共享协调器。 */
class RootCoordinator implements RootWriteCoordinator {
	readonly coordinatorVersion = INDEX_WRITE_OWNER_COORDINATOR_VERSION;
	private readonly rootPath: string;
	private epochCounter = 0;
	private active: ActiveOwner | null = null;
	/** 已 detach 但 closing 还没结算的前任(在途提交未完成)。 */
	private pendingClosing: { owner: ActiveOwner; promise: Promise<void> } | null = null;

	constructor(root: string) {
		this.rootPath = root;
	}

	get root(): string {
		return this.rootPath;
	}

	snapshot(): WriteOwnerSnapshot {
		const active = this.active;
		return {
			root: this.rootPath,
			epoch: active === null ? 0 : active.epoch,
			instanceToken: active === null ? null : active.token,
			revoked: active === null ? false : active.revoked,
			released: active === null ? true : active.released,
			closingPending: this.pendingClosing !== null,
		};
	}

	isTokenActive(instanceToken: string): boolean {
		const active = this.active;
		if (active === null) return false;
		return active.token === instanceToken && !active.released && !active.revoked;
	}

	async acquire(options: WriteOwnerAcquireOptions): Promise<WriteOwnerLease> {
		const token = options.instanceToken;
		if (typeof token !== 'string' || token.length === 0) {
			throw new IndexWriteOwnerError('instance-token-invalid', '实例令牌必须是非空字符串');
		}
		const timeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
		const clock = options.clock ?? defaultClock;

		const predecessor = this.active;
		if (predecessor !== null && !predecessor.released) {
			if (predecessor.token === token) {
				throw new IndexWriteOwnerError('instance-token-duplicate', `实例令牌 ${token} 已持有写所有权`, {
					detail: { root: this.rootPath, epoch: predecessor.epoch },
				});
			}
			// 关键路径:接管请求一到达就撤销前任 epoch,旧实例的迟到推理不能开始新提交。
			predecessor.revoked = true;
			const closed = await waitForClosing(predecessor.closing, timeoutMs, clock);
			if (!closed) {
				throw new IndexWriteOwnerError(
					'predecessor-not-closed',
					`前任实例 ${predecessor.token} 尚未关闭(可能仍有在途提交),拒绝接管(只报占用,不抢写)`,
					{ detail: { root: this.rootPath, predecessorEpoch: predecessor.epoch } },
				);
			}
			if (this.active !== null && this.active !== predecessor) {
				// 关键路径:等待期间另一个接管请求已经完成,不能覆盖它 —— 同一根目录只允许一个可写 owner。
				throw new IndexWriteOwnerError(
					'concurrent-takeover',
					'等待前任关闭期间已有其他实例完成接管,本次接管放弃',
					{ detail: { root: this.rootPath, winnerToken: this.active.token } },
				);
			}
			this.active = null;
			this.pendingClosing = null;
		}

		// 前任已经 detach,但在途提交还没结算 —— 新实例必须继续等同一个 closing。
		if (this.active === null && this.pendingClosing !== null) {
			const pending = this.pendingClosing;
			const closed = await waitForClosing(pending.promise, timeoutMs, clock);
			if (!closed) {
				throw new IndexWriteOwnerError(
					'predecessor-not-closed',
					`前任实例 ${pending.owner.token} 仍有在途提交未结算,拒绝接管(只报占用,不抢写)`,
					{ detail: { root: this.rootPath, predecessorEpoch: pending.owner.epoch } },
				);
			}
			if (this.pendingClosing === pending) this.pendingClosing = null;
			// 关键路径:await 期间另一个接管请求可能已经完成 —— 重新读取,不能覆盖赢家。
			const activeAfterWait = this.currentOwner();
			if (activeAfterWait !== null) {
				throw new IndexWriteOwnerError(
					'concurrent-takeover',
					'等待在途提交结算期间已有其他实例完成接管,本次接管放弃',
					{ detail: { root: this.rootPath, winnerToken: activeAfterWait.token } },
				);
			}
		}

		this.epochCounter += 1;
		let resolveClosing: () => void = () => undefined;
		const closing = new Promise<void>((resolve) => {
			resolveClosing = resolve;
		});
		const owner: ActiveOwner = {
			token,
			epoch: this.epochCounter,
			revoked: false,
			released: false,
			pendingCommits: 0,
			closing,
			resolveClosing,
			closingResolved: false,
		};
		this.active = owner;
		return new Lease(this, owner);
	}

	/** 内部使用:owner 是否仍是当前活动 owner。 */
	isActiveOwner(owner: ActiveOwner): boolean {
		return this.active === owner;
	}

	/**
	 * 内部使用:读取当前活动 owner。
	 *
	 * 关键路径:用方法而不是直接读字段,避免 TypeScript 把 `await` 之前的收窄结论
	 * (例如「此刻 active 为 null」)沿用到这里,掩盖等待期间发生的接管。
	 */
	private currentOwner(): ActiveOwner | null {
		return this.active;
	}

	/** 内部使用:登记一次在途提交。 */
	registerCommit(owner: ActiveOwner): void {
		owner.pendingCommits += 1;
	}

	/**
	 * 内部使用:结算一次在途提交。
	 *
	 * 关键路径:已释放的 owner 只有在在途提交全部结算后才 resolve closing,新实例才能接管。
	 */
	settleCommit(owner: ActiveOwner): void {
		if (owner.pendingCommits > 0) owner.pendingCommits -= 1;
		if (owner.pendingCommits === 0 && owner.released) this.finishClosing(owner);
	}

	/** 内部使用:释放 owner 并(在没有在途提交时)结算 closing。 */
	releaseOwner(owner: ActiveOwner): void {
		if (owner.released) return;
		owner.released = true;
		owner.revoked = true;
		if (this.active === owner) this.active = null;
		if (owner.pendingCommits === 0) {
			this.finishClosing(owner);
			return;
		}
		// 关键路径:还有在途提交 —— 保留 closing,让新实例继续等,而不是让两个 owner 同时写盘。
		this.pendingClosing = { owner, promise: owner.closing };
	}

	/** 结算 closing;重复调用安全。 */
	private finishClosing(owner: ActiveOwner): void {
		if (owner.closingResolved) return;
		owner.closingResolved = true;
		owner.resolveClosing();
		if (this.pendingClosing !== null && this.pendingClosing.owner === owner) this.pendingClosing = null;
	}
}

/**
 * 等待 closing Promise,超时返回 false;不按时间做任何写权限判断。
 *
 * @param closing - 前任 closing。
 * @param timeoutMs - 等待上限。
 * @param clock - 时钟接缝(测试可注入,避免真实等待)。
 */
function waitForClosing(closing: Promise<void>, timeoutMs: number, clock: OwnerClock): Promise<boolean> {
	const timeout = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : DEFAULT_CLOSE_TIMEOUT_MS;
	return new Promise<boolean>((resolve) => {
		let settled = false;
		const timer = clock.setTimeout(() => {
			if (settled) return;
			settled = true;
			resolve(false);
		}, timeout);
		void closing.then(() => {
			if (settled) return;
			settled = true;
			clock.clearTimeout(timer);
			resolve(true);
		});
	});
}

// ==================== 全局注册表 ====================

/** `globalThis` 上的注册表形状。 */
interface WriteOwnerRegistry {
	readonly version: number;
	readonly roots: Map<string, RootCoordinator>;
}

/** 带注册符号的 `globalThis` 视图。 */
interface WriteOwnerGlobalScope {
	[INDEX_WRITE_OWNER_SYMBOL]?: WriteOwnerRegistry;
}

/**
 * 取渲染进程全局对象 — 写所有权必须在整个 renderer 内共享。
 *
 * 关键路径:用 `globalThis` 而不是 `window`(plan 字面要求,renderer 内两者等价),
 * 这样不依赖 DOM 全局,同一份实现可以在 Node 子进程里直接验证跨进程行为。
 */
function rendererScope(): WriteOwnerGlobalScope {
	return globalThis as unknown as WriteOwnerGlobalScope;
}

/** 读取全局注册表;版本不一致时拒绝接管。 */
function readRegistry(): WriteOwnerRegistry | null {
	const scope = rendererScope();
	const existing = scope[INDEX_WRITE_OWNER_SYMBOL];
	if (existing === undefined) return null;
	if (existing.version !== INDEX_WRITE_OWNER_COORDINATOR_VERSION) {
		throw new IndexWriteOwnerError(
			'coordinator-version-mismatch',
			`全局写协调器版本 ${existing.version} 与当前版本 ${INDEX_WRITE_OWNER_COORDINATOR_VERSION} 不一致`,
			{ detail: { registeredVersion: existing.version } },
		);
	}
	return existing;
}

/** 取得(必要时创建)全局注册表。 */
function requireRegistry(): WriteOwnerRegistry {
	const existing = readRegistry();
	if (existing !== null) return existing;
	const created: WriteOwnerRegistry = {
		version: INDEX_WRITE_OWNER_COORDINATOR_VERSION,
		roots: new Map<string, RootCoordinator>(),
	};
	rendererScope()[INDEX_WRITE_OWNER_SYMBOL] = created;
	return created;
}

/**
 * 取得某个索引根目录的共享写协调器 — 同一 renderer 内同一根目录永远拿到同一个实例。
 *
 * @param root - 索引根目录。
 * @returns 共享协调器。
 * @throws {IndexWriteOwnerError} 根目录非法或已注册的协调器版本不一致。
 */
export function getWriteOwnerCoordinator(root: string): RootWriteCoordinator {
	const key = normalizeIndexRootKey(root);
	const registry = requireRegistry();
	const existing = registry.roots.get(key);
	if (existing !== undefined) return existing;
	const created = new RootCoordinator(key);
	registry.roots.set(key, created);
	return created;
}

// ==================== 进程探测 ====================

/** 进程探测结果。 */
export type ProcessProbeResult = 'alive' | 'missing' | 'no-permission';

/** 进程探测接缝 — 生产用 `process.kill(pid, 0)`,测试可注入权限失败。 */
export type ProcessProbe = (pid: number) => ProcessProbeResult;

/** 默认探测:信号 0 只做存在性与权限检查,不真正发信号。 */
const defaultProcessProbe: ProcessProbe = (pid: number): ProcessProbeResult => {
	try {
		process.kill(pid, 0);
		return 'alive';
	} catch (error) {
		const code = isRecord(error) ? error['code'] : undefined;
		if (code === 'ESRCH') return 'missing';
		// 关键路径:EPERM 表示进程存在但不可检查,属于「无法证明已退出」,不能回收。
		if (code === 'EPERM') return 'no-permission';
		return 'no-permission';
	}
};

/** 本进程启动时间(毫秒时间戳),只作诊断。 */
function ownProcessStartTime(): number {
	return Math.round(Date.now() - process.uptime() * 1000);
}

// ==================== owner 锁:选项与记录解析 ====================

/** owner 锁操作选项。 */
export interface OwnerLockOptions {
	/** 索引根目录。 */
	root: string;
	/** 当前实例令牌。 */
	instanceToken: string;
	/** 写入锁记录的 epoch;跨进程只作诊断。 */
	epoch?: number;
	/** 进程探测接缝;默认 `process.kill(pid, 0)`。 */
	probeProcess?: ProcessProbe;
	/** 本机主机名;默认 `os.hostname()`。 */
	hostname?: string;
	/** 当前时间来源;默认 `Date.now`。 */
	now?: () => number;
	/**
	 * 同进程实例令牌是否仍活跃;默认查共享协调器。
	 *
	 * 关键路径:同进程锁的身份可以核实(共享协调器知道哪些实例还在),跨进程锁不能。
	 */
	isInstanceActive?: (instanceToken: string) => boolean;
}

/** 解析后的锁上下文 — 所有锁操作共用。 */
interface LockContext {
	/** 可用于 IO 的规范化真实路径。 */
	readonly rootPath: string;
	/** 用于身份比较的规范化 key(darwin/win32 小写)。 */
	readonly rootKey: string;
	readonly instanceToken: string;
	readonly epoch: number;
	readonly probe: ProcessProbe;
	readonly hostname: string;
	readonly now: () => number;
	readonly isInstanceActive: (instanceToken: string) => boolean;
}

/** 把选项收敛为锁上下文,并校验令牌与根目录。 */
function resolveLockContext(options: OwnerLockOptions): LockContext {
	// 关键路径:先校验根目录(空/含 NUL → root-invalid),再校验实例令牌。
	const rootPath = normalizeIndexRoot(options.root);
	const rootKey = normalizeIndexRootKey(options.root);
	if (typeof options.instanceToken !== 'string' || options.instanceToken.length === 0) {
		throw new IndexWriteOwnerError('instance-token-invalid', '实例令牌必须是非空字符串', {
			detail: { root: rootKey },
		});
	}
	const hostname = options.hostname ?? os.hostname();
	const probe = options.probeProcess ?? defaultProcessProbe;
	const now = options.now ?? (() => Date.now());
	return {
		rootPath,
		rootKey,
		instanceToken: options.instanceToken,
		epoch: options.epoch ?? 0,
		probe,
		hostname,
		now,
		isInstanceActive:
			options.isInstanceActive ?? ((token: string) => defaultIsInstanceActive(rootKey, token)),
	};
}

/** 从上下文还原锁选项 — 进出恢复门时复用同一套探测/时间接缝。 */
function lockOptionsOf(context: LockContext): OwnerLockOptions {
	return {
		root: context.rootPath,
		instanceToken: context.instanceToken,
		epoch: context.epoch,
		probeProcess: context.probe,
		hostname: context.hostname,
		now: context.now,
		isInstanceActive: context.isInstanceActive,
	};
}

/** 默认「同进程实例是否活跃」判断 — 查共享协调器;协调器不可用时保守当作活跃。 */
function defaultIsInstanceActive(rootKey: string, instanceToken: string): boolean {
	try {
		return getWriteOwnerCoordinator(rootKey).isTokenActive(instanceToken);
	} catch {
		// 关键路径:无法核实时保守拒绝回收,不能把「查不到」当成「已退出」。
		return true;
	}
}

/** 锁文件绝对路径。 */
function ownerLockPath(context: LockContext): string {
	return path.join(context.rootPath, INDEX_OWNER_LOCK_FILE);
}

/** 恢复门文件绝对路径。 */
function recoveryGatePath(context: LockContext): string {
	return path.join(context.rootPath, INDEX_OWNER_RECOVERY_GATE_FILE);
}

/**
 * 解析锁记录 — 只接受形状完全合法的记录,任何缺失都返回 null(保守当作坏锁)。
 *
 * @param raw - 磁盘原文。
 * @returns 重新构造的记录;非法时为 null。
 */
function parseOwnerLockRecord(raw: string): OwnerLockRecord | null {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(value)) return null;
	if (value['schemaVersion'] !== OWNER_LOCK_SCHEMA_VERSION) return null;
	const coordinatorVersion = value['coordinatorVersion'];
	const root = value['root'];
	const instanceToken = value['instanceToken'];
	const epoch = value['epoch'];
	const acquiredAt = value['acquiredAt'];
	const processIdentity = value['process'];
	if (typeof coordinatorVersion !== 'number' || !Number.isInteger(coordinatorVersion)) return null;
	if (typeof root !== 'string' || root.length === 0) return null;
	if (typeof instanceToken !== 'string' || instanceToken.length === 0) return null;
	if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 0) return null;
	if (typeof acquiredAt !== 'number' || !Number.isFinite(acquiredAt)) return null;
	if (!isRecord(processIdentity)) return null;
	const pid = processIdentity['pid'];
	const hostname = processIdentity['hostname'];
	const startTimeMs = processIdentity['startTimeMs'];
	if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
	if (typeof hostname !== 'string' || hostname.length === 0) return null;
	if (startTimeMs !== null && (typeof startTimeMs !== 'number' || !Number.isFinite(startTimeMs))) {
		return null;
	}
	return {
		schemaVersion: OWNER_LOCK_SCHEMA_VERSION,
		coordinatorVersion,
		root,
		instanceToken,
		epoch,
		process: { pid, hostname, startTimeMs },
		acquiredAt,
	};
}

/** 构造本实例要写入的锁记录。 */
function buildOwnerLockRecord(context: LockContext): OwnerLockRecord {
	return {
		schemaVersion: OWNER_LOCK_SCHEMA_VERSION,
		coordinatorVersion: INDEX_WRITE_OWNER_COORDINATOR_VERSION,
		root: context.rootKey,
		instanceToken: context.instanceToken,
		epoch: context.epoch,
		process: {
			pid: process.pid,
			hostname: context.hostname,
			startTimeMs: ownProcessStartTime(),
		},
		acquiredAt: context.now(),
	};
}

// ==================== owner 锁:检查 ====================

/**
 * 只读检查 owner 锁 — 不修改磁盘,不删除任何文件。
 *
 * 判定顺序:坏记录 → 根目录不符 → 协调器版本 → 外机 → 同令牌 → 同进程 → 进程探测。
 *
 * @param options - 根目录、实例令牌与探测接缝。
 * @returns 检查结果(状态 + 原因 + 原文)。
 */
export async function inspectOwnerLock(options: OwnerLockOptions): Promise<OwnerLockInspection> {
	const context = resolveLockContext(options);
	const raw = await readTextOrNull(ownerLockPath(context));
	return classifyOwnerLock(context, raw);
}

/**
 * 核对锁记录里的根目录是否就是本次根目录。
 *
 * 关键路径(I6):本版本写入时用 {@link normalizeIndexRootKey} 的 key,但旧版本或外部工具可能
 * 存的是非规范化写法(大小写不同、走符号链接)。只做逐字比较会把这些同一目录判成 `root-mismatch`,
 * 让实例认不出自己前任留下的锁。这里对**绝对路径**的记录侧再走一次同一套规范化(大小写 + realpath);
 * 相对路径会随 cwd 漂移,规范化失败或记录是相对路径时保持保守拒绝。
 *
 * @param recordRoot - 锁记录里的根目录字符串。
 * @param expectedKey - 本次根目录的规范化 key。
 */
function recordRootMatches(recordRoot: string, expectedKey: string): boolean {
	if (recordRoot === expectedKey) return true;
	if (!path.isAbsolute(recordRoot) || recordRoot.includes('\0')) return false;
	try {
		return normalizeIndexRootKey(recordRoot) === expectedKey;
	} catch {
		// 关键路径:规范化失败一律当作不匹配,不因为「算不出来」而放宽核对。
		return false;
	}
}

/** 按磁盘原文给出检查结论。 */
function classifyOwnerLock(context: LockContext, raw: string | null): OwnerLockInspection {
	if (raw === null) return { state: 'missing', reason: 'no-lock', record: null, raw: null };
	const record = parseOwnerLockRecord(raw);
	if (record === null) return { state: 'corrupt', reason: 'record-invalid', record: null, raw };
	if (!recordRootMatches(record.root, context.rootKey)) {
		return { state: 'corrupt', reason: 'root-mismatch', record, raw };
	}
	if (record.coordinatorVersion !== INDEX_WRITE_OWNER_COORDINATOR_VERSION) {
		return { state: 'version-mismatch', reason: 'coordinator-version-mismatch', record, raw };
	}
	if (record.process.hostname !== context.hostname) {
		return { state: 'foreign-host', reason: 'foreign-host', record, raw };
	}
	if (record.instanceToken === context.instanceToken) {
		return { state: 'held-by-us', reason: 'same-token', record, raw };
	}
	if (record.process.pid === process.pid) {
		// 关键路径:同进程实例的身份可核实 —— 协调器说它不活跃,它就永远不能再提交。
		return context.isInstanceActive(record.instanceToken)
			? { state: 'held-by-live-owner', reason: 'instance-active', record, raw }
			: { state: 'recoverable', reason: 'instance-inactive', record, raw };
	}
	const probe = context.probe(record.process.pid);
	if (probe === 'missing') return { state: 'recoverable', reason: 'process-exited', record, raw };
	if (probe === 'no-permission') {
		return { state: 'held-by-live-owner', reason: 'no-permission', record, raw };
	}
	return { state: 'held-by-live-owner', reason: 'process-alive', record, raw };
}

// ==================== owner 锁:恢复门 ====================

/** 释放恢复门的结论。 */
export interface RecoveryGateReleaseResult {
	/** 是否真的删除了门文件。 */
	readonly released: boolean;
	/** 结果原因。 */
	readonly reason: 'released' | 'missing' | 'changed';
}

/** 恢复门句柄 — 进入门后所有锁写操作才允许执行。 */
export interface OwnerRecoveryGate {
	/** 规范化根目录身份 key。 */
	readonly root: string;
	/** 门的持有令牌。 */
	readonly token: string;
	/**
	 * 释放门;只删除自己写入的那一份,幂等。
	 *
	 * @returns 释放结论;`changed` 表示门已被后继实例替换,本实例没有删除它。
	 */
	release(): Promise<RecoveryGateReleaseResult>;
}

/** 恢复门记录。 */
interface RecoveryGateRecord {
	readonly schemaVersion: number;
	readonly token: string;
	readonly pid: number;
	readonly hostname: string;
	readonly acquiredAt: number;
}

/** 解析恢复门记录;非法返回 null。 */
function parseRecoveryGateRecord(raw: string): RecoveryGateRecord | null {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(value)) return null;
	const token = value['token'];
	const pid = value['pid'];
	const hostname = value['hostname'];
	const acquiredAt = value['acquiredAt'];
	if (typeof token !== 'string' || token.length === 0) return null;
	if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
	if (typeof hostname !== 'string' || hostname.length === 0) return null;
	if (typeof acquiredAt !== 'number' || !Number.isFinite(acquiredAt)) return null;
	return { schemaVersion: OWNER_LOCK_SCHEMA_VERSION, token, pid, hostname, acquiredAt };
}

/** 恢复门创建的最大尝试次数 — 只在「残门已被清理/门刚消失」时重试。 */
const RECOVERY_GATE_MAX_ATTEMPTS = 3;

/**
 * 进入排他恢复门 — 锁的创建、释放、死亡回收都必须先进入这里。
 *
 * 关键路径:
 * - 门内容原子写入并用 `link` 排他创建,失败即报占用;
 * - 只有在「能证明门持有者进程已退出」(同机 + 探测为 missing)时才清理残门;
 * - 清理残门必须「比较后再删除」:先原子改名摘走,再核对内容,期间被后继实例替换就恢复并放弃(I3);
 * - 门自身不按过期时间抢占,无法证明持有者结束时保守报占用;
 * - 门本身损坏(空文件/非法 JSON)时**不会**被自动清理 —— 那属于无法证明持有者已退出,
 *   只能由调用方显式调用 {@link quarantineCorruptRecoveryGate}。
 *
 * @param options - 根目录与实例令牌。
 * @returns 门句柄。
 * @throws {IndexWriteOwnerError} 门被占用(`recovery-gate-busy`)或写入门失败(`owner-lock-write-failed` 等)。
 */
export async function enterOwnerRecoveryGate(options: OwnerLockOptions): Promise<OwnerRecoveryGate> {
	const context = resolveLockContext(options);
	await ensureRootDirectory(context);
	const gatePath = recoveryGatePath(context);
	const record: RecoveryGateRecord = {
		schemaVersion: OWNER_LOCK_SCHEMA_VERSION,
		token: context.instanceToken,
		pid: process.pid,
		hostname: context.hostname,
		acquiredAt: context.now(),
	};
	const payload = JSON.stringify(record);

	for (let attempt = 0; attempt < RECOVERY_GATE_MAX_ATTEMPTS; attempt += 1) {
		const outcome = await createFileAtomically(gatePath, payload);
		if (outcome === 'created') return buildGateHandle(context, gatePath, payload);
		const stale = await readStaleGate(context, gatePath);
		if (stale === null) continue; // 门刚刚消失,重试创建。
		const removal = await compareAndRemoveFile(gatePath, stale.raw);
		if (removal === 'removed' || removal === 'missing') continue;
		// 关键路径:核对期间门已被后继实例替换 —— 不删除,保守报占用。
		throw new IndexWriteOwnerError(
			'recovery-gate-busy',
			'恢复门在核对期间被替换,放弃清理(不删除后继实例的门)',
			{ detail: { root: context.rootKey, outcome: removal } },
		);
	}
	throw new IndexWriteOwnerError('recovery-gate-busy', '恢复门被占用且多次尝试后仍无法取得', {
		detail: { root: context.rootKey },
	});
}

/** 构造门句柄;释放时按内容核对,只删除自己写入的那一份。 */
function buildGateHandle(
	context: LockContext,
	gatePath: string,
	payload: string,
): OwnerRecoveryGate {
	let released = false;
	return {
		root: context.rootKey,
		token: context.instanceToken,
		async release(): Promise<RecoveryGateReleaseResult> {
			if (released) return { released: false, reason: 'missing' };
			// 关键路径(I5):先核对/删除、后标记已释放 —— 释放途中抛错(如 fs 失败)时门文件还在,
			// 调用方重试仍能删掉它;标记在前会让重试被误判成 `missing`,门却被永久留下。
			const outcome = await compareAndRemoveFile(gatePath, payload);
			released = true;
			if (outcome === 'removed') return { released: true, reason: 'released' };
			if (outcome === 'missing') return { released: false, reason: 'missing' };
			return { released: false, reason: 'changed' };
		},
	};
}

/**
 * 读取一个「可证明持有者已退出」的残门;不可清理时抛占用。
 *
 * @param context - 锁上下文。
 * @param gatePath - 门文件路径。
 * @returns 残门原文;门已消失时返回 null(调用方重试创建)。
 * @throws {IndexWriteOwnerError} 门被存活/身份不明的持有者占用,或内容损坏(`recovery-gate-busy`)。
 */
async function readStaleGate(
	context: LockContext,
	gatePath: string,
): Promise<{ raw: string } | null> {
	const raw = await readTextOrNull(gatePath);
	if (raw === null) return null;
	const record = parseRecoveryGateRecord(raw);
	if (record === null) {
		// 关键路径:门内容损坏时无法证明持有者已退出 —— 不自动清理,交给显式隔离 API。
		throw new IndexWriteOwnerError(
			'recovery-gate-busy',
			'恢复门内容损坏,无法证明持有者已退出,拒绝自动清理',
			{ detail: { root: context.rootKey, reason: 'gate-corrupt' } },
		);
	}
	if (record.hostname !== context.hostname) {
		throw new IndexWriteOwnerError('recovery-gate-busy', '恢复门来自其他机器,拒绝自动清理', {
			detail: { root: context.rootKey, holderPid: record.pid, reason: 'gate-foreign-host' },
		});
	}
	// 关键路径:探测是「读门之后、删除之前」的核对点;测试在此处替换门内容以复现 I3。
	if (context.probe(record.pid) !== 'missing') {
		throw new IndexWriteOwnerError(
			'recovery-gate-busy',
			'恢复门被占用且无法证明持有者已退出',
			{ detail: { root: context.rootKey, holderPid: record.pid, reason: 'gate-holder-alive' } },
		);
	}
	return { raw };
}

/** 确保索引根目录存在;创建失败收敛为稳定错误码。 */
async function ensureRootDirectory(context: LockContext): Promise<void> {
	try {
		await fsp.mkdir(context.rootPath, { recursive: true });
	} catch (error) {
		throw toOwnerIoError(error, '创建索引根目录', { path: context.rootPath });
	}
}

/**
 * 在恢复门内执行一段锁操作。
 *
 * 关键路径(I4):
 * - 门的释放失败**不得覆盖**主错误:主错误优先原样抛出;
 * - 没有主错误时,释放失败就是主错误,并且要把本次已经产生的副作用(新建的锁)回滚掉,
 *   不能留下「调用方以为失败、磁盘上却有一把锁」的泄漏。
 *
 * @param context - 锁上下文。
 * @param work - 门内工作。
 * @param rollback - 门释放失败时回滚本次产出的回调。
 * @returns 工作结果。
 */
async function runInRecoveryGate<T>(
	context: LockContext,
	work: () => Promise<T>,
	rollback?: (value: T) => Promise<void>,
): Promise<T> {
	const gate = await enterOwnerRecoveryGate(lockOptionsOf(context));
	let primary: unknown = null;
	let value: T | undefined;
	let produced = false;
	try {
		value = await work();
		produced = true;
	} catch (error) {
		primary = error;
	}
	try {
		await gate.release();
	} catch (releaseError) {
		if (primary === null) {
			primary = releaseError;
			if (produced && value !== undefined && rollback !== undefined) {
				await rollback(value).catch(() => undefined);
			}
		}
	}
	if (primary !== null) {
		// 关键路径(I4):主错误原样重抛 —— 错误码与 cause 都不能被替换;非 Error 抛出值包成 Error 并保留 cause。
		throw primary instanceof Error
			? primary
			: Object.assign(new Error('写所有权操作抛出非 Error 值'), { cause: primary });
	}
	return value as T;
}

// ==================== owner 锁:创建、接管与释放 ====================

/** 锁句柄。 */
export interface OwnerLockHandle {
	/** 本实例写入(或复用)的锁记录。 */
	readonly record: OwnerLockRecord;
	/** 锁文件原文 — 释放时逐字核对,避免误删后继实例的锁。 */
	readonly raw: string;
	/**
	 * 释放锁;幂等。
	 *
	 * 关键路径:失败(例如恢复门被占用)时抛出稳定错误码,调用方可以重试 —— 锁文件仍然在,
	 * 不会出现「报错说没释放、其实已经删掉」或「报错后无法重试」。
	 */
	release(): Promise<OwnerLockReleaseResult>;
}

/** 释放结果。 */
export interface OwnerLockReleaseResult {
	/** 是否真的删除了锁文件。 */
	readonly released: boolean;
	/** 结果原因。 */
	readonly reason: 'released' | 'missing' | 'not-owner';
}

/**
 * 取得索引根目录 owner 锁。
 *
 * 关键路径:
 * - 无锁 → 进入恢复门 → 门内确认仍无锁 → 原子 + 排他创建;
 * - 已被本实例持有 → 幂等复用,不重写文件;
 * - 可回收(进程已退出 / 同进程实例已不活跃)→ 进入恢复门后接管;
 * - 其余情况(外机、坏锁、版本不符、占用)→ 明确拒绝,不删除任何文件。
 *
 * 使用边界:同一个 renderer 内必须通过 `IndexWriteOwner` 先取 epoch 再取锁。
 * 单独调用本函数只能排除其他进程,无法区分「同进程另一个仍活跃的实例」与「同进程已消失的实例」。
 *
 * @param options - 根目录与实例令牌。
 * @returns 锁句柄。
 * @throws {IndexWriteOwnerError} 见错误码。
 */
export async function acquireOwnerLock(options: OwnerLockOptions): Promise<OwnerLockHandle> {
	const context = resolveLockContext(options);
	const inspection = await inspectOwnerLock(options);

	switch (inspection.state) {
		case 'missing':
			return runInRecoveryGate(
				context,
				async () => {
					const currentRaw = await readTextOrNull(ownerLockPath(context));
					if (currentRaw !== null) {
						throw new IndexWriteOwnerError('owner-token-changed', '恢复门内发现锁已被其他实例创建', {
							detail: { root: context.rootKey },
						});
					}
					return createOwnerLock(context);
				},
				async (handle) => {
					await handle.release().catch(() => undefined);
				},
			);
		case 'held-by-us': {
			if (inspection.record === null || inspection.raw === null) {
				throw new IndexWriteOwnerError('owner-lock-corrupt', 'owner 锁记录与原文不一致', {
					detail: { root: context.rootKey },
				});
			}
			return buildHandle(context, inspection.record, inspection.raw);
		}
		case 'recoverable':
			return recoverOwnerLock({ ...options, expected: inspection });
		case 'foreign-host':
			throw new IndexWriteOwnerError('owner-lock-foreign-host', 'owner 锁来自其他机器,拒绝自动回收', {
				detail: { root: context.rootKey, holderHost: inspection.record?.process.hostname ?? null },
			});
		case 'version-mismatch':
			throw new IndexWriteOwnerError('owner-lock-version-mismatch', 'owner 锁由其他协调器版本写入,拒绝接管', {
				detail: {
					root: context.rootKey,
					lockVersion: inspection.record?.coordinatorVersion ?? null,
				},
			});
		case 'corrupt':
			throw new IndexWriteOwnerError('owner-lock-corrupt', 'owner 锁记录损坏,拒绝自动接管', {
				detail: { root: context.rootKey, reason: inspection.reason },
			});
		case 'held-by-live-owner':
			throw new IndexWriteOwnerError('owner-busy', 'owner 锁被存活实例占用,拒绝接管', {
				detail: {
					root: context.rootKey,
					reason: inspection.reason,
					holderPid: inspection.record?.process.pid ?? null,
				},
			});
	}
}

/**
 * 接管一个已确认可回收的 owner 锁 — 必须在恢复门内执行,门内重新读取并核对旧令牌。
 *
 * @param options - 根目录、实例令牌与进入门前取得的旧检查结果。
 * @returns 新锁句柄。
 * @throws {IndexWriteOwnerError} 旧令牌已变(`owner-token-changed`)、状态已不可回收(`owner-busy`)。
 */
export async function recoverOwnerLock(
	options: OwnerLockOptions & { expected: OwnerLockInspection },
): Promise<OwnerLockHandle> {
	const context = resolveLockContext(options);
	if (options.expected.state !== 'recoverable') {
		throw new IndexWriteOwnerError('owner-busy', '旧检查结果不是可回收状态,拒绝接管', {
			detail: { root: context.rootKey, state: options.expected.state },
		});
	}
	return runInRecoveryGate(
		context,
		async () => {
			const lockPath = ownerLockPath(context);
			const currentRaw = await readTextOrNull(lockPath);
			if (currentRaw === null) {
				throw new IndexWriteOwnerError('owner-token-changed', '恢复门内锁已消失,拒绝接管', {
					detail: { root: context.rootKey },
				});
			}
			// 关键路径:逐字核对进入门前读到的原文,避免两个回收者依据同一旧快照先后删除新锁。
			if (currentRaw !== options.expected.raw) {
				throw new IndexWriteOwnerError('owner-token-changed', '锁令牌在恢复门内已变化,拒绝覆盖后继实例', {
					detail: { root: context.rootKey },
				});
			}
			const current = classifyOwnerLock(context, currentRaw);
			if (current.state !== 'recoverable') {
				throw new IndexWriteOwnerError('owner-busy', '恢复门内复核后状态已不可回收,拒绝接管', {
					detail: { root: context.rootKey, state: current.state, reason: current.reason },
				});
			}
			const removal = await compareAndRemoveFile(lockPath, currentRaw);
			if (removal !== 'removed') {
				throw new IndexWriteOwnerError(
					'owner-token-changed',
					'接管前旧锁已消失或被替换,拒绝继续(不删除后继实例的锁)',
					{ detail: { root: context.rootKey, outcome: removal } },
				);
			}
			return createOwnerLock(context);
		},
		async (handle) => {
			await handle.release().catch(() => undefined);
		},
	);
}

/** 原子 + 排他创建锁文件并返回句柄;已存在时报令牌冲突。 */
async function createOwnerLock(context: LockContext): Promise<OwnerLockHandle> {
	const record = buildOwnerLockRecord(context);
	const raw = JSON.stringify(record);
	const outcome = await createFileAtomically(ownerLockPath(context), raw);
	if (outcome === 'exists') {
		throw new IndexWriteOwnerError('owner-token-changed', '创建 owner 锁时目标已存在', {
			detail: { root: context.rootKey },
		});
	}
	return buildHandle(context, record, raw);
}

/** 构造句柄;释放时重新进入恢复门并核对令牌。 */
function buildHandle(context: LockContext, record: OwnerLockRecord, raw: string): OwnerLockHandle {
	return {
		record,
		raw,
		release: () => releaseOwnerLock(context, record, raw),
	};
}

/** 释放锁:门内核对令牌与原文,只删除自己的锁。 */
async function releaseOwnerLock(
	context: LockContext,
	record: OwnerLockRecord,
	raw: string,
): Promise<OwnerLockReleaseResult> {
	return runInRecoveryGate(context, async () => {
		const lockPath = ownerLockPath(context);
		const currentRaw = await readTextOrNull(lockPath);
		if (currentRaw === null) return { released: false, reason: 'missing' } as const;
		const current = parseOwnerLockRecord(currentRaw);
		// 关键路径:令牌或原文不符说明锁已属于后继实例,绝不删除。
		if (current === null || current.instanceToken !== record.instanceToken || currentRaw !== raw) {
			return { released: false, reason: 'not-owner' } as const;
		}
		const removal = await compareAndRemoveFile(lockPath, currentRaw);
		if (removal === 'removed') return { released: true, reason: 'released' } as const;
		if (removal === 'missing') return { released: false, reason: 'missing' } as const;
		return { released: false, reason: 'not-owner' } as const;
	});
}

// ==================== 损坏锁/门的显式隔离 ====================

/** 隔离损坏文件的选项。 */
export interface QuarantineOptions extends OwnerLockOptions {
	/**
	 * 显式确认。
	 *
	 * 关键路径:spec 要求「无法确认恢复门持有者已退出时拒绝强抢」,所以隔离必须由调用方
	 * 明确确认后才能执行;缺省或 false 直接报 `quarantine-not-confirmed`。
	 */
	confirm: boolean;
}

/** 隔离结论。 */
export interface QuarantineResult {
	/** 是否真的把文件改名隔离了。 */
	readonly quarantined: boolean;
	/** 结论原因。 */
	readonly reason: 'quarantined' | 'missing' | 'not-corrupt' | 'changed';
	/** 隔离后的路径;未隔离时为 null。 */
	readonly quarantinedPath: string | null;
}

/** 校验显式确认。 */
function requireConfirm(options: QuarantineOptions, action: string): void {
	if (options.confirm !== true) {
		throw new IndexWriteOwnerError(
			'quarantine-not-confirmed',
			`${action}必须显式确认(confirm: true),不自动清理损坏文件`,
			{ detail: { root: options.root } },
		);
	}
}

/**
 * 显式隔离损坏的 owner 锁 — 唯一能让「坏锁」不再永久占用根目录的入口。
 *
 * 关键路径:
 * - 只在恢复门内执行,和所有锁写操作串行;
 * - 门内重新读取并复核「仍然损坏」,不是损坏就什么都不做(尤其不会碰别人的有效锁);
 * - 改名到 `owner.lock.corrupt-<时间戳>` 而不是删除,保留现场供排障;
 * - 原子写之后本版本自己不会再产出半截文件,所以这里的损坏只可能来自旧版本或外部损坏,
 *   隔离它不会掩盖本版本的写入缺陷。
 *
 * 前置条件:恢复门必须可用。若恢复门本身损坏,先调用 {@link quarantineCorruptRecoveryGate}。
 *
 * @param options - 根目录、实例令牌与 confirm。
 * @returns 隔离结论。
 * @throws {IndexWriteOwnerError} 未确认(`quarantine-not-confirmed`)或恢复门不可用。
 */
export async function quarantineCorruptOwnerLock(options: QuarantineOptions): Promise<QuarantineResult> {
	requireConfirm(options, '隔离损坏的 owner 锁');
	const context = resolveLockContext(options);
	return runInRecoveryGate(context, async () => {
		const lockPath = ownerLockPath(context);
		const raw = await readTextOrNull(lockPath);
		if (raw === null) return { quarantined: false, reason: 'missing', quarantinedPath: null } as const;
		const inspection = classifyOwnerLock(context, raw);
		if (inspection.state !== 'corrupt') {
			return { quarantined: false, reason: 'not-corrupt', quarantinedPath: null } as const;
		}
		const moved = await moveToQuarantine(lockPath, raw, context.now());
		if (moved === null) {
			return { quarantined: false, reason: 'changed', quarantinedPath: null } as const;
		}
		return { quarantined: true, reason: 'quarantined', quarantinedPath: moved } as const;
	});
}

/**
 * 显式隔离损坏的恢复门 — 门本身坏了就无法进门,所以这里不依赖恢复门。
 *
 * 关键路径:只对「解析失败」的门生效;持有者存活或内容合法的门一律拒绝(`not-corrupt`)。
 * 改名前后核对内容,期间被后继实例替换就恢复,绝不删除别人的活门。
 *
 * @param options - 根目录、实例令牌与 confirm。
 * @returns 隔离结论。
 * @throws {IndexWriteOwnerError} 未确认(`quarantine-not-confirmed`)。
 */
export async function quarantineCorruptRecoveryGate(
	options: QuarantineOptions,
): Promise<QuarantineResult> {
	requireConfirm(options, '隔离损坏的恢复门');
	const context = resolveLockContext(options);
	const gatePath = recoveryGatePath(context);
	const raw = await readTextOrNull(gatePath);
	if (raw === null) return { quarantined: false, reason: 'missing', quarantinedPath: null };
	if (parseRecoveryGateRecord(raw) !== null) {
		return { quarantined: false, reason: 'not-corrupt', quarantinedPath: null };
	}
	const moved = await moveToQuarantine(gatePath, raw, context.now());
	if (moved === null) return { quarantined: false, reason: 'changed', quarantinedPath: null };
	return { quarantined: true, reason: 'quarantined', quarantinedPath: moved };
}

// ==================== 门面:协调器 + 锁 ====================

/** 写所有权门面选项。 */
export interface IndexWriteOwnerOptions {
	/** 索引根目录。 */
	root: string;
	/** 插件实例令牌。 */
	instanceToken: string;
	/** 等待前任 closing Promise 的上限(毫秒)。 */
	closeTimeoutMs?: number;
	/** 进程探测接缝(测试用)。 */
	probeProcess?: ProcessProbe;
	/** 本机主机名(测试用)。 */
	hostname?: string;
	/** 当前时间来源(测试用)。 */
	now?: () => number;
	/** 时钟接缝(测试用);默认真实定时器。 */
	clock?: OwnerClock;
}

/**
 * 写所有权门面 — 同时持有 renderer 内 epoch 租约与索引根目录 owner 锁。
 *
 * 关键路径:先做 renderer 内交接(等前任 closing,包含在途提交),再取跨进程锁;锁取不到时立即释放租约,
 * 不留「有 epoch 但没锁」的半接管状态。
 *
 * @example
 *   const owner = await IndexWriteOwner.acquire({ root, instanceToken });
 *   owner.assertWritable();
 *   const ticket = owner.beginCommit();
 *   // ... 磁盘提交 ...
 *   ticket.settle();
 *   await owner.release();
 */
export class IndexWriteOwner {
	private readonly lease: WriteOwnerLease;
	private readonly lock: OwnerLockHandle;
	private readonly rootPath: string;
	private releaseResult: OwnerLockReleaseResult | null = null;

	private constructor(rootPath: string, lease: WriteOwnerLease, lock: OwnerLockHandle) {
		this.rootPath = rootPath;
		this.lease = lease;
		this.lock = lock;
	}

	/**
	 * 取得写所有权。
	 *
	 * @param options - 根目录、实例令牌与探测接缝。
	 * @returns 已同时持有租约与锁的门面实例。
	 * @throws {IndexWriteOwnerError} 前任未关闭、锁被占用或锁记录不可信。
	 */
	static async acquire(options: IndexWriteOwnerOptions): Promise<IndexWriteOwner> {
		const rootPath = normalizeIndexRoot(options.root);
		const coordinator = getWriteOwnerCoordinator(options.root);
		const lease = await coordinator.acquire({
			instanceToken: options.instanceToken,
			closeTimeoutMs: options.closeTimeoutMs,
			clock: options.clock,
		});
		try {
			const lock = await acquireOwnerLock({
				root: rootPath,
				instanceToken: options.instanceToken,
				epoch: lease.epoch,
				probeProcess: options.probeProcess,
				hostname: options.hostname,
				now: options.now,
			});
			return new IndexWriteOwner(rootPath, lease, lock);
		} catch (error) {
			// 关键路径:锁没拿到就必须撤销 epoch,不留「有写许可但没有锁」的半接管状态。
			await lease.release();
			throw error;
		}
	}

	/** 可用于 IO 的规范化根目录。 */
	get root(): string {
		return this.rootPath;
	}

	/** 根目录身份 key(协调器与锁记录用)。 */
	get rootKey(): string {
		return this.lease.root;
	}

	/** 实例令牌。 */
	get instanceToken(): string {
		return this.lease.instanceToken;
	}

	/** 本次接管的 epoch。 */
	get epoch(): number {
		return this.lease.epoch;
	}

	/**
	 * 断言仍可提交 — 所有写入口在开始提交前必须调用。
	 *
	 * @throws {IndexWriteOwnerError} 已释放或 epoch 已被接管。
	 */
	assertWritable(): void {
		this.lease.assertWritable();
	}

	/**
	 * 登记一次在途提交 — release 之后的 closing 会等它结算。
	 *
	 * @returns 结算凭据。
	 * @throws {IndexWriteOwnerError} 已释放或 epoch 已被接管。
	 */
	beginCommit(): WriteCommitTicket {
		return this.lease.beginCommit();
	}

	/** 当前锁记录(诊断用)。 */
	snapshot(): OwnerLockRecord {
		return this.lock.record;
	}

	/**
	 * 释放锁与租约;幂等且可重试。
	 *
	 * 关键路径(I5):锁释放失败(例如恢复门被占用)时**不**标记为已释放,
	 * 调用方可以在门空闲后再次调用本方法;第一次成功后结果被缓存,重复调用返回同一结论。
	 *
	 * @returns 释放结论。
	 * @throws {IndexWriteOwnerError} 锁释放失败;此时 epoch 已被撤销,可安全重试。
	 */
	async release(): Promise<OwnerLockReleaseResult> {
		if (this.releaseResult !== null) return this.releaseResult;
		let result: OwnerLockReleaseResult;
		try {
			result = await this.lock.release();
		} catch (error) {
			// 关键路径:撤销 epoch 但保留重试能力 —— 锁文件还在,下次 release 仍会核对令牌后删除。
			await this.lease.release();
			throw error;
		}
		await this.lease.release();
		this.releaseResult = result;
		return result;
	}
}

// ==================== 通用工具 ====================

/** 判断是否为普通对象(排除数组与 null)。 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 判断是否为指定 errno 错误。 */
function isErrnoError(error: unknown, code: string): boolean {
	return isRecord(error) && error['code'] === code;
}

/** 读取 errno 字符串;不是 errno 错误时返回 null。 */
function readErrno(error: unknown): string | null {
	if (!isRecord(error)) return null;
	const code = error['code'];
	return typeof code === 'string' ? code : null;
}

/**
 * 把 fs 错误收敛为稳定错误码 — 映射表集中声明在 {@link OWNER_IO_ERROR_CODE_BY_ERRNO}。
 *
 * @param error - 原始错误。
 * @param action - 中文动作描述,用于消息与诊断。
 * @param detail - 额外诊断字段。
 * @returns 带稳定错误码的新错误;原始错误保留在 `cause`。
 */
export function toOwnerIoError(
	error: unknown,
	action: string,
	detail: Record<string, unknown>,
): IndexWriteOwnerError {
	const errno = readErrno(error);
	const mapped = errno === null ? undefined : OWNER_IO_ERROR_CODE_BY_ERRNO[errno];
	const code: IndexWriteOwnerErrorCode = mapped ?? 'owner-lock-write-failed';
	return new IndexWriteOwnerError(code, `${action}失败${errno === null ? '' : `（${errno}）`}`, {
		detail: { ...detail, errno, action },
		cause: error,
	});
}
