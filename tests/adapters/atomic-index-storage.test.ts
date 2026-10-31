/**
 * @file tests/adapters/atomic-index-storage.test.ts
 * @description 原子索引存储 — 委托语义、原子替换、路径限定与四类故障注入下的磁盘最终状态
 * @module tests/adapters/atomic-index-storage
 * @depends src/adapters/atomic-index-storage, node:fs, node:os, node:path
 *
 * 关键路径:
 * - 所有磁盘操作落在系统临时目录,测试结束(含失败路径)一律清理,不读写真实 Vault。
 * - 故障注入通过适配器的 `fileSystem` 接缝完成,不使用 `vi.mock` 改写全局 `node:fs`;
 *   断言对象是**重新读回的真实磁盘内容**,不是注入层返回的中间状态。
 * - 每个故障用例都要求「完整旧版或完整新版」,只断言抛错不算通过。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { access, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
	ATOMIC_STORAGE_ERROR_CODES,
	ATOMIC_WRITE_OUTCOMES,
	AtomicIndexStorage,
	AtomicStorageError,
} from '../../src/adapters/atomic-index-storage';
import type {
	AtomicDirectoryHandle,
	AtomicWriteFileSystem,
	AtomicWriteHandle,
} from '../../src/adapters/atomic-index-storage';
import { IndexValidationError } from '../../src/core/index-persistence-types';

// ==================== 夹具 ====================

/** 旧版本与新版本文档 — 用于判定磁盘最终是完整旧版还是完整新版。 */
const OLD_DOCUMENT = { version: 1, payload: '旧版本', chunks: ['a', 'b'] };
const NEW_DOCUMENT = { version: 2, payload: '新版本', chunks: ['c', 'd', 'e'] };

/** 故障注入计划 — 返回 Error 表示抛错,返回 number 表示只写入该字节数(短写)。 */
interface FaultPlan {
	openFile?: (call: number) => Error | null;
	write?: (call: number, length: number) => Error | number | null;
	sync?: (call: number) => Error | null;
	close?: (call: number) => Error | null;
	rename?: (from: string, to: string) => Error | null;
	/** rename 已生效后抛错 — 模拟「磁盘已是完整新版,但调用方收到 EIO」。 */
	renameAfterEffect?: (from: string, to: string) => Error | null;
	openDirectory?: (call: number) => Error | null;
	directorySync?: (call: number) => Error | null;
	removeFile?: (call: number, target: string) => Error | null;
}

/** 记录故障注入层的调用次数,便于断言「走到了哪一步」。 */
interface FaultCounters {
	openFile: number;
	write: number;
	sync: number;
	close: number;
	rename: number;
	openDirectory: number;
	directorySync: number;
	removeFile: number;
}

/**
 * 构造带故障注入的文件系统接缝 — 正常路径与生产实现同构,仅按计划注入错误。
 *
 * @param plan - 各步骤的故障计划。
 * @returns 文件系统接缝与调用计数器。
 */
function createFaultFileSystem(plan: FaultPlan = {}): {
	fileSystem: AtomicWriteFileSystem;
	counters: FaultCounters;
} {
	const counters: FaultCounters = {
		openFile: 0,
		write: 0,
		sync: 0,
		close: 0,
		rename: 0,
		openDirectory: 0,
		directorySync: 0,
		removeFile: 0,
	};

	const fileSystem: AtomicWriteFileSystem = {
		async openFile(absolutePath: string): Promise<AtomicWriteHandle> {
			counters.openFile += 1;
			const failure = plan.openFile?.(counters.openFile);
			if (failure) throw failure;
			const handle = await open(absolutePath, 'wx');
			return {
				async write(buffer: Uint8Array, offset: number, length: number): Promise<number> {
					counters.write += 1;
					const fault = plan.write?.(counters.write, length);
					if (fault instanceof Error) throw fault;
					if (typeof fault === 'number') {
						// 关键路径:模拟底层短写 — 只提交前 fault 个字节。
						if (fault <= 0) return 0;
						const partial = buffer.subarray(offset, offset + Math.min(fault, length));
						const result = await handle.write(partial, 0, partial.byteLength);
						return result.bytesWritten;
					}
					const result = await handle.write(buffer, offset, length);
					return result.bytesWritten;
				},
				async sync(): Promise<void> {
					counters.sync += 1;
					const failure = plan.sync?.(counters.sync);
					if (failure) throw failure;
					await handle.sync();
				},
				async close(): Promise<void> {
					counters.close += 1;
					const failure = plan.close?.(counters.close);
					await handle.close();
					if (failure) throw failure;
				},
			};
		},
		async openDirectory(absolutePath: string): Promise<AtomicDirectoryHandle> {
			counters.openDirectory += 1;
			const failure = plan.openDirectory?.(counters.openDirectory);
			if (failure) throw failure;
			const handle = await open(absolutePath, 'r');
			return {
				async sync(): Promise<void> {
					counters.directorySync += 1;
					const fault = plan.directorySync?.(counters.directorySync);
					if (fault) throw fault;
					await handle.sync();
				},
				close: () => handle.close(),
			};
		},
		async rename(from: string, to: string): Promise<void> {
			counters.rename += 1;
			const failure = plan.rename?.(from, to);
			if (failure) throw failure;
			await rename(from, to);
			const afterEffectFailure = plan.renameAfterEffect?.(from, to);
			if (afterEffectFailure) throw afterEffectFailure;
		},
		async removeFile(absolutePath: string): Promise<void> {
			counters.removeFile += 1;
			const failure = plan.removeFile?.(counters.removeFile, absolutePath);
			if (failure) throw failure;
			await rm(absolutePath, { force: true });
		},
	};

	return { fileSystem, counters };
}

/** 构造带错误码的底层 IO 错误(模拟 ENOSPC / EACCES / EIO)。 */
function ioError(code: string, message: string): Error {
	const error = new Error(`${code}: ${message}`);
	Object.assign(error, { code });
	return error;
}

/**
 * 无磁盘副作用的内存接缝 — 只用于验证写入记录上界,不产生真实文件。
 *
 * 关键路径:路径包含性校验仍走真实 `assertPathWithinRoot`,只有写入动作被替换。
 */
function createMemoryFileSystem(): AtomicWriteFileSystem {
	return {
		async openFile(): Promise<AtomicWriteHandle> {
			return {
				async write(_buffer: Uint8Array, _offset: number, length: number): Promise<number> {
					return length;
				},
				sync: async () => undefined,
				close: async () => undefined,
			};
		},
		async openDirectory(): Promise<AtomicDirectoryHandle> {
			return { sync: async () => undefined, close: async () => undefined };
		},
		async rename(): Promise<void> {
			// 内存接缝:不落盘。
		},
		async removeFile(): Promise<void> {
			// 内存接缝:不落盘。
		},
	};
}

let tmpRoot = '';
let generationRoot = '';

beforeEach(async () => {
	tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'ratel-atomic-storage-'));
	generationRoot = path.join(tmpRoot, 'generations', 'gen-1');
	await mkdir(generationRoot, { recursive: true });
});

afterEach(async () => {
	await rm(tmpRoot, { recursive: true, force: true });
});

/** 读取目标 JSON — 解析失败即视为半截文件,直接让用例失败。 */
async function readDocument(filePath: string): Promise<unknown> {
	const raw = await readFile(filePath, 'utf8');
	return JSON.parse(raw) as unknown;
}

/** 列出代际根内的普通文件名(含临时文件)。 */
async function listEntries(): Promise<string[]> {
	const entries = await readdir(generationRoot);
	return entries.sort();
}

// ==================== 委托语义 ====================

describe('AtomicIndexStorage 委托语义', () => {
	it('委托文件操作 - 创建目录、写入、读取、列举与删除 - 与本地文件系统语义一致', async () => {
		const storage = new AtomicIndexStorage({ generationRoot });
		const filePath = path.join(generationRoot, 'nested', 'note.txt');

		await storage.createFolder(path.dirname(filePath));
		await storage.createFile(filePath, 'hello');
		await expect(storage.readFile(filePath)).resolves.toEqual(Buffer.from('hello', 'utf8'));
		await expect(storage.pathExists(filePath)).resolves.toBe(true);

		const details = await storage.getDetails(filePath);
		expect(details.isFolder).toBe(false);
		expect(details.name).toBe('note.txt');

		const listed = await storage.listFiles(path.dirname(filePath));
		expect(listed.map((entry) => entry.name)).toEqual(['note.txt']);

		await storage.deleteFile(filePath);
		await expect(storage.pathExists(filePath)).resolves.toBe(false);
		await storage.deleteFolder(path.dirname(filePath));
		await expect(storage.pathExists(path.dirname(filePath))).resolves.toBe(false);
	});

	it('委托创建文件 - 目标已存在 - 以排他创建失败而不是静默覆盖', async () => {
		const storage = new AtomicIndexStorage({ generationRoot });
		const filePath = path.join(generationRoot, 'index.json');
		await storage.createFile(filePath, 'first');
		await expect(storage.createFile(filePath, 'second')).rejects.toThrow();
		await expect(storage.readFile(filePath)).resolves.toEqual(Buffer.from('first', 'utf8'));
	});
});

// ==================== 代际根保护 ====================

describe('AtomicIndexStorage 代际根保护', () => {
	it('代际根保护 - 递归删除代际根 - 以 generation-root-deletion 拒绝且根内数据保持完整', async () => {
		const storage = new AtomicIndexStorage({ generationRoot });
		const filePath = path.join(generationRoot, 'index.json');
		await storage.upsertFile(filePath, JSON.stringify(OLD_DOCUMENT));

		const error = await storage.deleteFolder(generationRoot).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(AtomicStorageError);
		if (!(error instanceof AtomicStorageError)) throw new Error('未抛出存储错误');
		expect(error.code).toBe('generation-root-deletion');

		// 关键路径:拒绝必须发生在磁盘操作之前,代际目录与其内容都不能被删掉。
		await expect(readDocument(filePath)).resolves.toEqual(OLD_DOCUMENT);
		await expect(listEntries()).resolves.toEqual(['index.json']);
	});

	it('代际根保护 - 把代际根当作文件写入目标 - 以 path-escape 拒绝且根外没有临时文件', async () => {
		const storage = new AtomicIndexStorage({ generationRoot });

		await expect(storage.upsertFile(generationRoot, '{}')).rejects.toMatchObject({
			code: 'path-escape',
		});

		// 关键路径:临时路径若按 `${target}.tmp-…` 拼接会落到代际根的父目录,必须没有残留。
		const parentEntries = await readdir(path.dirname(generationRoot));
		expect(parentEntries.filter((name) => name.includes('.tmp-'))).toEqual([]);
		await expect(readdir(generationRoot)).resolves.toEqual([]);
	});
});

// ==================== 原子替换 ====================

describe('AtomicIndexStorage 原子替换', () => {
	it('原子替换 - 目标不存在时首次写入 - 落盘完整内容且无临时文件残留', async () => {
		const storage = new AtomicIndexStorage({ generationRoot });
		const filePath = path.join(generationRoot, 'index.json');

		await storage.upsertFile(filePath, JSON.stringify(OLD_DOCUMENT));

		await expect(readDocument(filePath)).resolves.toEqual(OLD_DOCUMENT);
		await expect(listEntries()).resolves.toEqual(['index.json']);
		expect(storage.getLastWriteOutcome(filePath)?.outcome).toBe('renamed');
	});

	it('原子替换 - 目标已有旧版本 - 读回为完整新版且旧内容不再存在', async () => {
		const storage = new AtomicIndexStorage({ generationRoot });
		const filePath = path.join(generationRoot, 'index.json');
		await storage.upsertFile(filePath, JSON.stringify(OLD_DOCUMENT));

		await storage.upsertFile(filePath, JSON.stringify(NEW_DOCUMENT));

		await expect(readDocument(filePath)).resolves.toEqual(NEW_DOCUMENT);
		await expect(listEntries()).resolves.toEqual(['index.json']);
	});

	it('原子替换 - 同一目标并发写入 - 最终文件是某一次完整内容而非交错', async () => {
		const storage = new AtomicIndexStorage({ generationRoot });
		const filePath = path.join(generationRoot, 'index.json');
		const documents = Array.from({ length: 8 }, (_unused, index) => ({
			version: index,
			payload: `写入者-${index}`,
			chunks: Array.from({ length: index + 1 }, (_chunk, position) => `chunk-${position}`),
		}));

		await Promise.all(
			documents.map((document) => storage.upsertFile(filePath, JSON.stringify(document))),
		);

		const finalDocument = await readDocument(filePath);
		expect(documents).toContainEqual(finalDocument);
		await expect(listEntries()).resolves.toEqual(['index.json']);
	});
});

// ==================== 路径限定 ====================

describe('AtomicIndexStorage 路径限定', () => {
	it('路径限定 - 目标位于代际根之外 - 以 path-escape 拒绝且不写盘', async () => {
		const storage = new AtomicIndexStorage({ generationRoot });
		const outsidePath = path.join(tmpRoot, 'outside.json');

		await expect(storage.upsertFile(outsidePath, '{}')).rejects.toBeInstanceOf(IndexValidationError);
		await expect(storage.upsertFile(outsidePath, '{}')).rejects.toMatchObject({ code: 'path-escape' });
		// 关键路径:连存在性查询也限定在代际根内,不能拿越界路径去探测磁盘。
		await expect(storage.pathExists(outsidePath)).rejects.toMatchObject({ code: 'path-escape' });
		await expect(access(outsidePath)).rejects.toThrow();
	});

	it('路径限定 - 通过 .. 段回到根外 - 以 path-escape 拒绝', async () => {
		const storage = new AtomicIndexStorage({ generationRoot });
		const escaping = path.join(generationRoot, '..', 'gen-1', '..', '..', 'outside.json');
		await expect(storage.upsertFile(escaping, '{}')).rejects.toMatchObject({ code: 'path-escape' });
	});

	it('路径限定 - 相对路径 - 以 path-not-absolute 拒绝', async () => {
		const storage = new AtomicIndexStorage({ generationRoot });
		await expect(storage.upsertFile('index.json', '{}')).rejects.toMatchObject({
			code: 'path-not-absolute',
		});
	});

	it('路径限定 - 经由符号链接逃出代际根 - 以 path-symlink-escape 拒绝', async () => {
		const outsideRoot = path.join(tmpRoot, 'outside');
		await mkdir(outsideRoot, { recursive: true });
		await symlink(outsideRoot, path.join(generationRoot, 'escape-link'), 'dir');
		const storage = new AtomicIndexStorage({ generationRoot });

		await expect(
			storage.upsertFile(path.join(generationRoot, 'escape-link', 'index.json'), '{}'),
		).rejects.toMatchObject({ code: 'path-symlink-escape' });
		await expect(readdir(outsideRoot)).resolves.toEqual([]);
	});
});

// ==================== 故障注入 ====================

describe('AtomicIndexStorage 故障注入', () => {
	it('短写 - 底层每次只写入部分字节 - 循环补齐后落盘完整新版', async () => {
		const { fileSystem, counters } = createFaultFileSystem({ write: () => 7 });
		const storage = new AtomicIndexStorage({ generationRoot, fileSystem });
		const filePath = path.join(generationRoot, 'index.json');
		await storage.upsertFile(filePath, JSON.stringify(OLD_DOCUMENT));

		await storage.upsertFile(filePath, JSON.stringify(NEW_DOCUMENT));

		await expect(readDocument(filePath)).resolves.toEqual(NEW_DOCUMENT);
		expect(counters.write).toBeGreaterThan(1);
		expect(storage.getLastWriteOutcome(filePath)?.outcome).toBe('renamed');
	});

	it('短写 - 底层返回零字节 - 抛错且磁盘保留完整旧版、临时文件被清理', async () => {
		const filePath = path.join(generationRoot, 'index.json');
		const baseline = new AtomicIndexStorage({ generationRoot });
		await baseline.upsertFile(filePath, JSON.stringify(OLD_DOCUMENT));

		const { fileSystem } = createFaultFileSystem({ write: () => 0 });
		const storage = new AtomicIndexStorage({ generationRoot, fileSystem });

		await expect(storage.upsertFile(filePath, JSON.stringify(NEW_DOCUMENT))).rejects.toMatchObject({
			code: 'write-failed',
		});
		await expect(readDocument(filePath)).resolves.toEqual(OLD_DOCUMENT);
		await expect(listEntries()).resolves.toEqual(['index.json']);
		expect(storage.getLastWriteOutcome(filePath)?.outcome).toBe('failed-before-rename');
	});

	it('磁盘满 - 写入抛 ENOSPC - 磁盘保留完整旧版、无临时文件残留并记录提交前失败', async () => {
		const filePath = path.join(generationRoot, 'index.json');
		const baseline = new AtomicIndexStorage({ generationRoot });
		await baseline.upsertFile(filePath, JSON.stringify(OLD_DOCUMENT));

		const { fileSystem } = createFaultFileSystem({
			write: () => ioError('ENOSPC', 'no space left on device'),
		});
		const storage = new AtomicIndexStorage({ generationRoot, fileSystem });

		const error = await storage
			.upsertFile(filePath, JSON.stringify(NEW_DOCUMENT))
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(AtomicStorageError);
		if (!(error instanceof AtomicStorageError)) throw new Error('未抛出存储错误');
		expect(error.code).toBe('write-failed');
		expect((error.cause as { code?: string } | undefined)?.code).toBe('ENOSPC');

		await expect(readDocument(filePath)).resolves.toEqual(OLD_DOCUMENT);
		await expect(listEntries()).resolves.toEqual(['index.json']);
		expect(storage.getLastWriteOutcome(filePath)?.outcome).toBe('failed-before-rename');
	});

	it('rename 失败 - 抛 EACCES - 磁盘保留完整旧版、临时文件被清理并记录提交前失败', async () => {
		const filePath = path.join(generationRoot, 'index.json');
		const baseline = new AtomicIndexStorage({ generationRoot });
		await baseline.upsertFile(filePath, JSON.stringify(OLD_DOCUMENT));

		const { fileSystem, counters } = createFaultFileSystem({
			rename: () => ioError('EACCES', 'permission denied'),
		});
		const storage = new AtomicIndexStorage({ generationRoot, fileSystem });

		await expect(storage.upsertFile(filePath, JSON.stringify(NEW_DOCUMENT))).rejects.toMatchObject({
			code: 'write-failed',
		});
		expect(counters.rename).toBe(1);
		await expect(readDocument(filePath)).resolves.toEqual(OLD_DOCUMENT);
		await expect(listEntries()).resolves.toEqual(['index.json']);
		// 关键路径:EACCES 属于「确定未生效」,可以安全归入提交前失败。
		expect(storage.getLastWriteOutcome(filePath)?.outcome).toBe('failed-before-rename');
	});

	it('rename 失败 - 抛 EIO 且未执行 - 归入 rename 后状态不明而不是提交前失败', async () => {
		const filePath = path.join(generationRoot, 'index.json');
		const baseline = new AtomicIndexStorage({ generationRoot });
		await baseline.upsertFile(filePath, JSON.stringify(OLD_DOCUMENT));

		const { fileSystem, counters } = createFaultFileSystem({
			rename: () => ioError('EIO', 'i/o error'),
		});
		const storage = new AtomicIndexStorage({ generationRoot, fileSystem });

		const error = await storage
			.upsertFile(filePath, JSON.stringify(NEW_DOCUMENT))
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(AtomicStorageError);
		if (!(error instanceof AtomicStorageError)) throw new Error('未抛出存储错误');
		// 关键路径:EIO 下 rename 可能已生效,不能声称旧版仍在磁盘。
		expect(error.code).toBe('unknown-after-rename');
		expect(counters.rename).toBe(1);
		expect(storage.getLastWriteOutcome(filePath)?.outcome).toBe('unknown-after-rename');
		// 注入层未真正执行 rename,因此磁盘仍是完整旧版 —— 但结论只能是「状态不明」。
		await expect(readDocument(filePath)).resolves.toEqual(OLD_DOCUMENT);
		await expect(listEntries()).resolves.toEqual(['index.json']);
	});

	it('rename 失败 - 抛 EIO 但磁盘已生效 - 归入 rename 后状态不明且磁盘是完整新版', async () => {
		const filePath = path.join(generationRoot, 'index.json');
		const baseline = new AtomicIndexStorage({ generationRoot });
		await baseline.upsertFile(filePath, JSON.stringify(OLD_DOCUMENT));

		const { fileSystem } = createFaultFileSystem({
			renameAfterEffect: () => ioError('EIO', 'i/o error after rename'),
		});
		const storage = new AtomicIndexStorage({ generationRoot, fileSystem });

		const error = await storage
			.upsertFile(filePath, JSON.stringify(NEW_DOCUMENT))
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(AtomicStorageError);
		if (!(error instanceof AtomicStorageError)) throw new Error('未抛出存储错误');
		expect(error.code).toBe('unknown-after-rename');

		// 关键路径:这正是「状态不明」的真实含义 —— 磁盘可能已经是完整新版。
		await expect(readDocument(filePath)).resolves.toEqual(NEW_DOCUMENT);
		expect(storage.getLastWriteOutcome(filePath)?.outcome).toBe('unknown-after-rename');
		await expect(listEntries()).resolves.toEqual(['index.json']);
	});

	it('目录同步失败 - 抛 EIO - 磁盘已是完整新版且记录为 rename 后状态不明', async () => {
		const filePath = path.join(generationRoot, 'index.json');
		const baseline = new AtomicIndexStorage({ generationRoot });
		await baseline.upsertFile(filePath, JSON.stringify(OLD_DOCUMENT));

		const { fileSystem, counters } = createFaultFileSystem({
			directorySync: () => ioError('EIO', 'i/o error'),
		});
		const storage = new AtomicIndexStorage({ generationRoot, fileSystem });

		const error = await storage
			.upsertFile(filePath, JSON.stringify(NEW_DOCUMENT))
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(AtomicStorageError);
		if (!(error instanceof AtomicStorageError)) throw new Error('未抛出存储错误');
		expect(error.code).toBe('unknown-after-rename');

		// 关键路径:rename 已生效,磁盘必须是完整新版,不能按「旧版仍在」继续搜索。
		expect(counters.directorySync).toBe(1);
		await expect(readDocument(filePath)).resolves.toEqual(NEW_DOCUMENT);
		expect(storage.getLastWriteOutcome(filePath)?.outcome).toBe('unknown-after-rename');
	});

	it('目录同步不受支持 - 打开目录抛 EPERM - 视为成功且磁盘为完整新版', async () => {
		const filePath = path.join(generationRoot, 'index.json');
		const { fileSystem } = createFaultFileSystem({
			openDirectory: () => ioError('EPERM', 'operation not permitted'),
		});
		const storage = new AtomicIndexStorage({ generationRoot, fileSystem });

		await storage.upsertFile(filePath, JSON.stringify(NEW_DOCUMENT));

		await expect(readDocument(filePath)).resolves.toEqual(NEW_DOCUMENT);
		expect(storage.getLastWriteOutcome(filePath)?.outcome).toBe('renamed');
	});

	it.each(['EINVAL', 'ENOTSUP'])(
		'目录同步不受支持 - 目录句柄 sync 抛 %s - 与打开目录同一判定,视为成功',
		async (code) => {
			const filePath = path.join(generationRoot, 'index.json');
			const { fileSystem, counters } = createFaultFileSystem({
				directorySync: () => ioError(code, 'directory fsync unsupported'),
			});
			const storage = new AtomicIndexStorage({ generationRoot, fileSystem });

			await storage.upsertFile(filePath, JSON.stringify(NEW_DOCUMENT));

			// 关键路径:sync() 与 openDirectory 必须共用同一「平台不支持」判定,
			// 否则 rename 已生效的写入会被误报成 rename 后状态不明。
			expect(counters.directorySync).toBe(1);
			await expect(readDocument(filePath)).resolves.toEqual(NEW_DOCUMENT);
			expect(storage.getLastWriteOutcome(filePath)?.outcome).toBe('renamed');
		},
	);

	it('目录同步失败 - 打开目录抛 EACCES - 不再当作平台不支持,归入 rename 后状态不明', async () => {
		const filePath = path.join(generationRoot, 'index.json');
		const { fileSystem } = createFaultFileSystem({
			openDirectory: () => ioError('EACCES', 'permission denied'),
		});
		const storage = new AtomicIndexStorage({ generationRoot, fileSystem });

		const error = await storage
			.upsertFile(filePath, JSON.stringify(NEW_DOCUMENT))
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(AtomicStorageError);
		if (!(error instanceof AtomicStorageError)) throw new Error('未抛出存储错误');
		// 关键路径:权限问题不是平台能力缺失,必须暴露为 rename 后状态不明而不是静默成功。
		expect(error.code).toBe('unknown-after-rename');
		await expect(readDocument(filePath)).resolves.toEqual(NEW_DOCUMENT);
	});

	it('目录同步失败 - 打开目录抛 EIO - 磁盘已是完整新版且记录为 rename 后状态不明', async () => {
		const filePath = path.join(generationRoot, 'index.json');
		const baseline = new AtomicIndexStorage({ generationRoot });
		await baseline.upsertFile(filePath, JSON.stringify(OLD_DOCUMENT));

		// 关键路径:打开目录本身也可能因 EIO/EMFILE 失败,不能与「平台不支持」混为一谈。
		const { fileSystem } = createFaultFileSystem({
			openDirectory: () => ioError('EIO', 'i/o error'),
		});
		const storage = new AtomicIndexStorage({ generationRoot, fileSystem });

		const error = await storage
			.upsertFile(filePath, JSON.stringify(NEW_DOCUMENT))
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(AtomicStorageError);
		if (!(error instanceof AtomicStorageError)) throw new Error('未抛出存储错误');
		expect(error.code).toBe('unknown-after-rename');

		await expect(readDocument(filePath)).resolves.toEqual(NEW_DOCUMENT);
		expect(storage.getLastWriteOutcome(filePath)?.outcome).toBe('unknown-after-rename');
	});

	it('关闭失败 - 关闭临时文件抛错 - 视为提交前失败且旧版完整', async () => {
		const filePath = path.join(generationRoot, 'index.json');
		const baseline = new AtomicIndexStorage({ generationRoot });
		await baseline.upsertFile(filePath, JSON.stringify(OLD_DOCUMENT));

		const { fileSystem } = createFaultFileSystem({
			close: () => ioError('EIO', 'close failed'),
		});
		const storage = new AtomicIndexStorage({ generationRoot, fileSystem });

		await expect(storage.upsertFile(filePath, JSON.stringify(NEW_DOCUMENT))).rejects.toMatchObject({
			code: 'write-failed',
		});
		await expect(readDocument(filePath)).resolves.toEqual(OLD_DOCUMENT);
		await expect(listEntries()).resolves.toEqual(['index.json']);
	});

	it('清理失败 - 写入失败且临时文件删除也失败 - 抛出的仍是原始写入错误', async () => {
		const filePath = path.join(generationRoot, 'index.json');
		const baseline = new AtomicIndexStorage({ generationRoot });
		await baseline.upsertFile(filePath, JSON.stringify(OLD_DOCUMENT));

		const { fileSystem, counters } = createFaultFileSystem({
			write: () => ioError('ENOSPC', 'no space left on device'),
			removeFile: () => ioError('EACCES', 'cannot remove temp file'),
		});
		const storage = new AtomicIndexStorage({ generationRoot, fileSystem });

		const error = await storage
			.upsertFile(filePath, JSON.stringify(NEW_DOCUMENT))
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(AtomicStorageError);
		if (!(error instanceof AtomicStorageError)) throw new Error('未抛出存储错误');
		expect(error.code).toBe('write-failed');
		// 关键路径:清理失败不能遮蔽原始写入错误。
		expect((error.cause as { code?: string } | undefined)?.code).toBe('ENOSPC');
		expect(counters.removeFile).toBe(1);

		await expect(readDocument(filePath)).resolves.toEqual(OLD_DOCUMENT);
		// 清理失败会留下临时文件,但目标文件必须是完整旧版,不存在半截 JSON。
		const entries = await listEntries();
		expect(entries).toContain('index.json');
	});

	it('写入失败 - 磁盘满 - 记录为提交前失败且磁盘保持完整旧版', async () => {
		const filePath = path.join(generationRoot, 'index.json');
		const baseline = new AtomicIndexStorage({ generationRoot });
		await baseline.upsertFile(filePath, JSON.stringify(OLD_DOCUMENT));

		const { fileSystem } = createFaultFileSystem({
			write: () => ioError('ENOSPC', 'no space left on device'),
		});
		const storage = new AtomicIndexStorage({ generationRoot, fileSystem });

		// 关键路径:调用方不依赖错误的文案或类型 —— vectra 的 endUpdate 会把底层错误重新包装,
		// 原始类型与文案都会丢失,因此只断言「确实失败」,再用适配器自记的写入结果判定磁盘状态。
		await expect(storage.upsertFile(filePath, JSON.stringify(NEW_DOCUMENT))).rejects.toBeInstanceOf(Error);
		expect(storage.getLastWriteOutcome(filePath)).toMatchObject({
			outcome: 'failed-before-rename',
			path: filePath,
		});
		await expect(readDocument(filePath)).resolves.toEqual(OLD_DOCUMENT);
	});
});

// ==================== 契约常量 ====================

describe('AtomicIndexStorage 契约常量', () => {
	it('写入结果清单 - 覆盖三种判别式 - 保证调用方可穷举处理', () => {
		expect([...ATOMIC_WRITE_OUTCOMES]).toEqual([
			'renamed',
			'failed-before-rename',
			'unknown-after-rename',
		]);
	});
});

// ==================== 显式落盘 ====================

describe('AtomicIndexStorage 显式落盘', () => {
	it('显式落盘 - 已提交的文件 - 同步成功且内容不变', async () => {
		const storage = new AtomicIndexStorage({ generationRoot });
		const filePath = path.join(generationRoot, 'index.json');
		await storage.upsertFile(filePath, JSON.stringify(NEW_DOCUMENT));

		await expect(storage.flushPath(filePath)).resolves.toBeUndefined();
		// 关键路径:flush 只做持久化,不得改动内容。
		await expect(readDocument(filePath)).resolves.toEqual(NEW_DOCUMENT);
	});

	it('显式落盘 - 代际根目录 - 同步成功或按平台降级为成功', async () => {
		const storage = new AtomicIndexStorage({ generationRoot });
		// 关键路径:Windows 无法打开目录句柄,与写入路径共用同一降级判定,不能因此报错。
		await expect(storage.flushPath(generationRoot)).resolves.toBeUndefined();
	});

	it('显式落盘 - 目标越出代际根 - 以 path-escape 拒绝', async () => {
		const storage = new AtomicIndexStorage({ generationRoot });
		await expect(storage.flushPath(path.join(tmpRoot, 'outside.json'))).rejects.toMatchObject({
			code: 'path-escape',
		});
	});

	it('显式落盘 - 目标不存在 - 抛错且不误报成功', async () => {
		const storage = new AtomicIndexStorage({ generationRoot });
		await expect(
			storage.flushPath(path.join(generationRoot, 'missing.json')),
		).rejects.toBeInstanceOf(Error);
	});
});
