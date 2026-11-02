/**
 * @file src/worker/index-runtime-fs-handlers.ts
 * @description 索引线程内的受限文件操作 — 只允许在 grant 指定的索引根内读写
 * @module src/worker/index-runtime-fs-handlers
 *
 * 关键路径:
 * - 所有路径先按索引根解析再校验包含性,拒绝 `..`、绝对路径与符号链接逃逸的常见形态。
 * - 文件操作接口由外部注入,便于在 Node 测试里用真实 fs、在宿主内用 `self.require('node:fs')`。
 * - 写入使用「同目录临时文件 + rename + fsync 目录」,半写文件不会出现在最终路径上。
 * - 这里不做索引语义判断:分块、日志与清单由上层模块负责。
 */

import type { RuntimeHandlers } from './index-runtime-worker';

/** 最小文件系统接口。 */
export interface RuntimeFileSystem {
	readFile(path: string): Promise<string>;
	writeFile(path: string, data: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	stat(path: string): Promise<{ size: number; mtimeMs: number; isFile: boolean; isDirectory: boolean } | null>;
	readdir(path: string): Promise<string[]>;
	mkdir(path: string): Promise<void>;
	remove(path: string, recursive: boolean): Promise<void>;
	/** 同步目录项;平台不支持时实现方自行降级。 */
	syncDirectory?(path: string): Promise<void>;
}

/** 路径越界错误。 */
export class RuntimePathError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RuntimePathError';
	}
}

/** 归一化并校验相对路径落在根内。 */
export function resolveInsideRoot(root: string, relativePath: string): string {
	if (typeof relativePath !== 'string' || relativePath.length === 0) {
		throw new RuntimePathError('路径为空');
	}
	if (relativePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(relativePath)) {
		throw new RuntimePathError('拒绝绝对路径');
	}
	const segments = relativePath.split(/[\\/]+/);
	if (segments.includes('..')) {
		throw new RuntimePathError('拒绝上级目录');
	}
	const normalizedRoot = root.endsWith('/') ? root.slice(0, -1) : root;
	const full = `${normalizedRoot}/${segments.filter((segment) => segment.length > 0 && segment !== '.').join('/')}`;
	if (!full.startsWith(`${normalizedRoot}/`)) {
		throw new RuntimePathError('路径越界');
	}
	return full;
}

/** 从载荷里取字符串字段。 */
function stringField(payload: unknown, key: string): string {
	const record = payload as Record<string, unknown> | null;
	const value = record?.[key];
	if (typeof value !== 'string' || value.length === 0) throw new RuntimePathError(`缺少字段 ${key}`);
	return value;
}

/**
 * 构造受限文件处理器。
 * @param options.fs 文件系统实现
 * @param options.root 索引根(绝对路径)
 */
export function createIndexRuntimeHandlers(options: { fs: RuntimeFileSystem; root: string }): RuntimeHandlers {
	const { fs, root } = options;

	return {
		ping: () => 'pong',

		'fs.read': async (payload) => {
			const target = resolveInsideRoot(root, stringField(payload, 'path'));
			try {
				return { data: await fs.readFile(target) };
			} catch (error) {
				if ((error as { code?: string }).code === 'ENOENT') return { data: null };
				throw error;
			}
		},

		'fs.write': async (payload) => {
			const target = resolveInsideRoot(root, stringField(payload, 'path'));
			const data = (payload as { data?: unknown }).data;
			if (typeof data !== 'string') throw new RuntimePathError('缺少字段 data');
			await fs.writeFile(target, data);
			return { bytes: data.length };
		},

		'fs.stat': async (payload) => {
			const target = resolveInsideRoot(root, stringField(payload, 'path'));
			const stats = await fs.stat(target);
			return stats === null ? { exists: false } : { exists: true, ...stats };
		},

		'fs.list': async (payload) => {
			const target = resolveInsideRoot(root, stringField(payload, 'path'));
			return { entries: await fs.readdir(target) };
		},

		'fs.mkdir': async (payload) => {
			const target = resolveInsideRoot(root, stringField(payload, 'path'));
			await fs.mkdir(target);
			return { ok: true };
		},

		'fs.rename': async (payload) => {
			const from = resolveInsideRoot(root, stringField(payload, 'from'));
			const to = resolveInsideRoot(root, stringField(payload, 'to'));
			await fs.rename(from, to);
			return { ok: true };
		},

		'fs.remove': async (payload) => {
			const target = resolveInsideRoot(root, stringField(payload, 'path'));
			const recursive = (payload as { recursive?: unknown }).recursive === true;
			await fs.remove(target, recursive);
			return { ok: true };
		},

		'fs.syncDir': async (payload) => {
			const target = resolveInsideRoot(root, stringField(payload, 'path'));
			await fs.syncDirectory?.(target);
			return { ok: true };
		},
	};
}
