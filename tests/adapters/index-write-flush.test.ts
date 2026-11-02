/**
 * @file tests/adapters/index-write-flush.test.ts
 * @description 共享落盘模块 — 正常提交、提交前失败、目录 fsync 平台降级与真实错误上抛
 * @module tests/adapters/index-write-flush
 * @depends src/adapters/index-write-flush, node:fs/promises, node:os, node:path
 *
 * 关键路径:
 * - 所有磁盘操作落在系统临时目录,测试结束(含失败路径)一律清理,不读写真实 Vault。
 * - 文件系统接缝用 `node:fs/promises` 的真实适配,故障注入只包装真实句柄的单个调用;
 *   不使用 `vi.mock` 改写 `node:fs`,断言对象是**重新读回的真实磁盘内容**。
 * - 提交前失败用例要求目标仍是完整旧版(或仍不存在),只断言抛错不算通过。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	access,
	mkdtemp,
	open as openNodeFile,
	readFile,
	readdir,
	rename as renameNode,
	rm,
	unlink,
	writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
	WRITE_FLUSH_TEMP_FILE_MARKER,
	syncDirectory,
	writeFileAtomic,
} from '../../src/adapters/index-write-flush';
import type {
	WriteFlushDirectoryHandle,
	WriteFlushFileHandle,
	WriteFlushFileSystem,
} from '../../src/adapters/index-write-flush';

// ==================== 夹具 ====================

/** 旧版本与新版本文档 — 用于判定磁盘最终是完整旧版还是完整新版。 */
const OLD_PAYLOAD = '{"version":1,"payload":"旧版本"}';
const NEW_PAYLOAD = '{"version":2,"payload":"新版本"}';
const NEW_BYTES = Buffer.from(NEW_PAYLOAD, 'utf8');

/** 每次用例独立的真实临时目录与目标文件。 */
let workspace = '';
let target = '';

beforeEach(async () => {
	workspace = await mkdtemp(path.join(os.tmpdir(), 'ratel-index-write-flush-'));
	target = path.join(workspace, 'index.json');
});

afterEach(async () => {
	if (workspace !== '') await rm(workspace, { recursive: true, force: true });
});

/** 构造错误并附带 Node 风格的 errno `code`。 */
function errnoError(code: string, message = `模拟 ${code}`): Error & { code: string } {
	return Object.assign(new Error(message), { code });
}

/** 生产同构的真实文件系统适配 — 仅用 `node:fs/promises`,不做任何语义替换。 */
function createNodeFileSystem(): WriteFlushFileSystem {
	return {
		async open(absolutePath: string): Promise<WriteFlushFileHandle> {
			const handle = await openNodeFile(absolutePath, 'wx');
			return {
				async write(buffer: Uint8Array, offset: number, length: number): Promise<number> {
					const result = await handle.write(buffer, offset, length);
					return result.bytesWritten;
				},
				sync: () => handle.sync(),
				close: () => handle.close(),
			};
		},
		async openDirectory(absolutePath: string): Promise<WriteFlushDirectoryHandle> {
			const handle = await openNodeFile(absolutePath, 'r');
			return { sync: () => handle.sync(), close: () => handle.close() };
		},
		rename: (fromPath: string, toPath: string) => renameNode(fromPath, toPath),
		unlink: (absolutePath: string) => unlink(absolutePath),
	};
}

/** 故障注入计划 — 返回 Error 表示抛错,返回 number 表示只写入该字节数(真实短写)。 */
interface FaultPlan {
	write?: (call: number, length: number) => Error | number | null;
	openDirectory?: (call: number) => Error | null;
	directorySync?: (call: number) => Error | null;
	rename?: (fromPath: string, toPath: string) => Error | null;
}

/** 记录故障注入层走到了哪一步。 */
interface FaultCounters {
	open: number;
	write: number;
	rename: number;
	unlink: number;
	openDirectory: number;
	directorySync: number;
	fileClose: number;
	directoryClose: number;
}

/**
 * 包装真实 node 适配并注入单步故障 — 正常路径原样委托,保持磁盘语义真实。
 *
 * @param plan - 各步骤的故障计划。
 * @returns 文件系统接缝、调用计数器与打开过的路径(临时路径观测点)。
 */
function createFaultFileSystem(plan: FaultPlan = {}): {
	fileSystem: WriteFlushFileSystem;
	counters: FaultCounters;
	openedPaths: string[];
} {
	const base = createNodeFileSystem();
	const counters: FaultCounters = {
		open: 0,
		write: 0,
		rename: 0,
		unlink: 0,
		openDirectory: 0,
		directorySync: 0,
		fileClose: 0,
		directoryClose: 0,
	};
	const openedPaths: string[] = [];
	const fileSystem: WriteFlushFileSystem = {
		async open(absolutePath: string): Promise<WriteFlushFileHandle> {
			counters.open += 1;
			openedPaths.push(absolutePath);
			const handle = await base.open(absolutePath);
			return {
				async write(buffer: Uint8Array, offset: number, length: number): Promise<number> {
					counters.write += 1;
					const fault = plan.write?.(counters.write, length) ?? null;
					if (fault instanceof Error) throw fault;
					if (typeof fault === 'number') {
						return fault > 0 ? handle.write(buffer, offset, Math.min(fault, length)) : 0;
					}
					return handle.write(buffer, offset, length);
				},
				sync: () => handle.sync(),
				async close(): Promise<void> {
					counters.fileClose += 1;
					await handle.close();
				},
			};
		},
		async openDirectory(absolutePath: string): Promise<WriteFlushDirectoryHandle> {
			counters.openDirectory += 1;
			const fault = plan.openDirectory?.(counters.openDirectory) ?? null;
			if (fault !== null) throw fault;
			const handle = await base.openDirectory(absolutePath);
			return {
				async sync(): Promise<void> {
					counters.directorySync += 1;
					const syncFault = plan.directorySync?.(counters.directorySync) ?? null;
					if (syncFault !== null) throw syncFault;
					await handle.sync();
				},
				async close(): Promise<void> {
					counters.directoryClose += 1;
					await handle.close();
				},
			};
		},
		async rename(fromPath: string, toPath: string): Promise<void> {
			counters.rename += 1;
			const fault = plan.rename?.(fromPath, toPath) ?? null;
			if (fault !== null) throw fault;
			await base.rename(fromPath, toPath);
		},
		async unlink(absolutePath: string): Promise<void> {
			counters.unlink += 1;
			await base.unlink(absolutePath);
		},
	};
	return { fileSystem, counters, openedPaths };
}

// ==================== writeFileAtomic ====================

describe('writeFileAtomic', () => {
	it('正常写入 - 内容正确、目标存在、临时文件不残留', async () => {
		const { fileSystem, counters, openedPaths } = createFaultFileSystem();

		await writeFileAtomic(fileSystem, target, NEW_BYTES);

		expect(await readFile(target, 'utf8')).toBe(NEW_PAYLOAD);
		// 目录内只剩目标文件 — 临时文件既不在提交后残留,也不在 rename 前被留下。
		expect(await readdir(workspace)).toEqual(['index.json']);
		expect(counters.rename).toBe(1);
		expect(counters.directorySync).toBe(1);
		// 临时路径与目标同目录,并带共享标记,供残留清理按约定识别。
		const tempPath = openedPaths[0] ?? '';
		expect(path.dirname(tempPath)).toBe(workspace);
		expect(path.basename(tempPath).startsWith(`index.json${WRITE_FLUSH_TEMP_FILE_MARKER}`)).toBe(true);
	});

	it('写入中途抛错且目标已有旧内容 - 旧内容不变、临时文件清理、错误原样抛出', async () => {
		await writeFile(target, OLD_PAYLOAD, 'utf8');
		const fault = errnoError('EIO', '模拟写入中途失败');
		// 第一次真实短写 3 字节,第二次抛错:模拟「临时文件只写了一部分」。
		const { fileSystem, counters } = createFaultFileSystem({
			write: (call) => (call === 1 ? 3 : fault),
		});

		await expect(writeFileAtomic(fileSystem, target, NEW_BYTES)).rejects.toBe(fault);

		expect(await readFile(target, 'utf8')).toBe(OLD_PAYLOAD);
		expect(await readdir(workspace)).toEqual(['index.json']);
		expect(counters.rename).toBe(0);
		expect(counters.unlink).toBe(1);
		expect(counters.fileClose).toBe(1);
	});

	it('写入中途抛错且目标不存在 - 目标仍不存在、临时文件清理、错误原样抛出', async () => {
		const fault = errnoError('EIO', '模拟写入中途失败');
		const { fileSystem, counters } = createFaultFileSystem({
			write: () => fault,
		});

		await expect(writeFileAtomic(fileSystem, target, NEW_BYTES)).rejects.toBe(fault);

		await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
		expect(await readdir(workspace)).toEqual([]);
		expect(counters.rename).toBe(0);
		expect(counters.unlink).toBe(1);
	});

	it.each(['EINVAL', 'ENOTSUP'] as const)(
		'目录 fsync 返回 %s - 整体成功且内容为新版',
		async (code) => {
			const { fileSystem, counters } = createFaultFileSystem({
				directorySync: () => errnoError(code),
			});

			await writeFileAtomic(fileSystem, target, NEW_BYTES);

			expect(await readFile(target, 'utf8')).toBe(NEW_PAYLOAD);
			expect(await readdir(workspace)).toEqual(['index.json']);
			expect(counters.directorySync).toBe(1);
			// 降级路径也必须关闭目录句柄。
			expect(counters.directoryClose).toBe(1);
		},
	);

	it('打开目录句柄返回 EINVAL - 视为平台不支持并整体成功', async () => {
		const { fileSystem, counters } = createFaultFileSystem({
			openDirectory: () => errnoError('EINVAL'),
		});

		await writeFileAtomic(fileSystem, target, NEW_BYTES);

		expect(await readFile(target, 'utf8')).toBe(NEW_PAYLOAD);
		expect(counters.openDirectory).toBe(1);
		expect(counters.directorySync).toBe(0);
	});

	it('目录同步失败 - 提交点回调已触发且目标已可见新版', async () => {
		const fault = errnoError('EACCES', '模拟目录无权限');
		const { fileSystem } = createFaultFileSystem({
			directorySync: () => fault,
		});
		const commitPoints: string[] = [];

		await expect(
			writeFileAtomic(fileSystem, target, NEW_BYTES, {
				onCommitted: () => commitPoints.push('renamed'),
			}),
		).rejects.toBe(fault);

		// 关键路径:目录同步失败发生在提交之后,调用方据此判定「不能假设旧内容仍在」。
		expect(commitPoints).toEqual(['renamed']);
		expect(await readFile(target, 'utf8')).toBe(NEW_PAYLOAD);
	});

	it('自定义临时路径 - 使用调用方路径完成提交且目标内容正确', async () => {
		const customTempPath = path.join(workspace, 'custom.tmp-index');
		const { fileSystem, openedPaths } = createFaultFileSystem();

		await writeFileAtomic(fileSystem, target, NEW_BYTES, {
			createTempPath: () => customTempPath,
		});

		expect(openedPaths).toEqual([customTempPath]);
		expect(await readFile(target, 'utf8')).toBe(NEW_PAYLOAD);
		expect(await readdir(workspace)).toEqual(['index.json']);
	});

	it('目录 fsync 返回 EACCES - 整体失败且错误原样抛出', async () => {
		const fault = errnoError('EACCES', '模拟目录无权限');
		const { fileSystem } = createFaultFileSystem({
			directorySync: () => fault,
		});

		await expect(writeFileAtomic(fileSystem, target, NEW_BYTES)).rejects.toBe(fault);

		// rename 已提交:目标已是完整新版,只是目录项持久性未证明,调用方不能假设旧版仍在。
		expect(await readFile(target, 'utf8')).toBe(NEW_PAYLOAD);
		expect(await readdir(workspace)).toEqual(['index.json']);
	});
});

// ==================== syncDirectory ====================

describe('syncDirectory', () => {
	it('目录可同步 - 成功且句柄已关闭', async () => {
		const { fileSystem, counters } = createFaultFileSystem();

		await syncDirectory(fileSystem, workspace);

		expect(counters.openDirectory).toBe(1);
		expect(counters.directorySync).toBe(1);
		expect(counters.directoryClose).toBe(1);
	});

	it.each(['EINVAL', 'ENOTSUP'] as const)(
		'目录 fsync 返回 %s - 降级成功且句柄已关闭',
		async (code) => {
			const { fileSystem, counters } = createFaultFileSystem({
				directorySync: () => errnoError(code),
			});

			await expect(syncDirectory(fileSystem, workspace)).resolves.toBeUndefined();

			expect(counters.directorySync).toBe(1);
			expect(counters.directoryClose).toBe(1);
		},
	);

	it('打开目录返回 EINVAL - 降级成功且不尝试 sync', async () => {
		const { fileSystem, counters } = createFaultFileSystem({
			openDirectory: () => errnoError('EINVAL'),
		});

		await expect(syncDirectory(fileSystem, workspace)).resolves.toBeUndefined();

		expect(counters.openDirectory).toBe(1);
		expect(counters.directorySync).toBe(0);
	});

	it('目录 fsync 返回 EACCES - 失败且错误原样抛出', async () => {
		const fault = errnoError('EACCES', '模拟目录无权限');
		const { fileSystem, counters } = createFaultFileSystem({
			directorySync: () => fault,
		});

		await expect(syncDirectory(fileSystem, workspace)).rejects.toBe(fault);

		expect(counters.directoryClose).toBe(1);
	});

	it('打开目录返回 EACCES - 失败且错误原样抛出', async () => {
		const fault = errnoError('EACCES', '模拟目录无权限');
		const { fileSystem, counters } = createFaultFileSystem({
			openDirectory: () => fault,
		});

		await expect(syncDirectory(fileSystem, workspace)).rejects.toBe(fault);

		expect(counters.directorySync).toBe(0);
	});
});
