/**
 * @file src/adapters/index-write-flush-node.ts
 * @description 共享落盘模块的 Node 适配 — 以排他方式创建临时文件、同步目录项
 * @module src/adapters/index-write-flush-node
 *
 * 关键路径:
 * - 临时文件用 `wx` 打开:目标已存在即失败,避免两个写入者互相覆盖。
 * - 目录以只读打开;平台不支持目录 fsync 的判定由共享模块统一处理,这里不做降级判断。
 * - 本适配只做形状转换,不改变错误语义:错误原样上抛,调用方据此决定重试或重载。
 */

import fsp from 'node:fs/promises';
import type {
	WriteFlushDirectoryHandle,
	WriteFlushFileHandle,
	WriteFlushFileSystem,
} from './index-write-flush';

/** Node 实现的共享落盘文件系统。 */
export const nodeWriteFlushFileSystem: WriteFlushFileSystem = {
	async open(absolutePath: string): Promise<WriteFlushFileHandle> {
		const handle = await fsp.open(absolutePath, 'wx');
		return {
			write: (buffer, offset, length) => handle.write(buffer, offset, length).then((result) => result.bytesWritten),
			sync: () => handle.sync(),
			close: () => handle.close().then(() => undefined),
		};
	},

	async openDirectory(absolutePath: string): Promise<WriteFlushDirectoryHandle> {
		const handle = await fsp.open(absolutePath, 'r');
		return {
			sync: () => handle.sync(),
			close: () => handle.close().then(() => undefined),
		};
	},

	rename: (fromPath, toPath) => fsp.rename(fromPath, toPath),
	unlink: async (absolutePath) => {
		await fsp.rm(absolutePath, { force: true });
	},
};
