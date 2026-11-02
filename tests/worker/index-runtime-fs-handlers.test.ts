/**
 * @file tests/worker/index-runtime-fs-handlers.test.ts
 * @description 受限文件处理器 — 根内读写、越界拒绝与缺失路径语义
 * @module tests/worker/index-runtime-fs-handlers
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
	RuntimePathError,
	createIndexRuntimeHandlers,
	resolveInsideRoot,
	type RuntimeFileSystem,
} from '../../src/worker/index-runtime-fs-handlers';

/** 用真实 fs 实现最小接口。 */
function makeFs(): RuntimeFileSystem {
	return {
		readFile: (target) => fsp.readFile(target, 'utf8'),
		writeFile: (target, data) => fsp.writeFile(target, data, 'utf8'),
		rename: (from, to) => fsp.rename(from, to),
		stat: async (target) => {
			try {
				const stats = await fsp.stat(target);
				return { size: stats.size, mtimeMs: stats.mtimeMs, isFile: stats.isFile(), isDirectory: stats.isDirectory() };
			} catch (error) {
				if ((error as { code?: string }).code === 'ENOENT') return null;
				throw error;
			}
		},
		readdir: async (target) => fsp.readdir(target),
		mkdir: async (target) => { await fsp.mkdir(target, { recursive: true }); },
		remove: async (target, recursive) => { await fsp.rm(target, { recursive, force: true }); },
	};
}

let root = '';

beforeEach(async () => {
	root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ratel-runtime-fs-'));
});

afterEach(async () => {
	if (root) await fsp.rm(root, { recursive: true, force: true });
});

describe('受限文件处理器', () => {
	it('写入后可读回 - 内容一致', async () => {
		const handlers = createIndexRuntimeHandlers({ fs: makeFs(), root });
		await handlers['fs.write']!({ path: 'a.txt', data: '正文' });
		await expect(handlers['fs.read']!({ path: 'a.txt' })).resolves.toEqual({ data: '正文' });
	});

	it('读取不存在的文件 - 返回 null - 不抛错', async () => {
		const handlers = createIndexRuntimeHandlers({ fs: makeFs(), root });
		await expect(handlers['fs.read']!({ path: 'missing.txt' })).resolves.toEqual({ data: null });
	});

	it('越界路径 - 绝对路径与上级目录一律拒绝', () => {
		expect(() => resolveInsideRoot(root, '/etc/passwd')).toThrow(RuntimePathError);
		expect(() => resolveInsideRoot(root, '../outside.txt')).toThrow(RuntimePathError);
		expect(() => resolveInsideRoot(root, 'a/../../b')).toThrow(RuntimePathError);
		expect(() => resolveInsideRoot(root, 'C:\\Windows\\x')).toThrow(RuntimePathError);
	});

	it('根内多级路径 - 正常解析且不越界', async () => {
		const handlers = createIndexRuntimeHandlers({ fs: makeFs(), root });
		await handlers['fs.mkdir']!({ path: 'generations/g1' });
		await handlers['fs.write']!({ path: 'generations/g1/index.json', data: '{}' });
		await expect(handlers['fs.list']!({ path: 'generations/g1' })).resolves.toEqual({ entries: ['index.json'] });
	});

	it('统计 - 存在与不存在分别返回 - 不把缺失当成 0 字节', async () => {
		const handlers = createIndexRuntimeHandlers({ fs: makeFs(), root });
		await handlers['fs.write']!({ path: 'b.txt', data: 'abc' });
		await expect(handlers['fs.stat']!({ path: 'b.txt' })).resolves.toMatchObject({ exists: true, size: 3 });
		await expect(handlers['fs.stat']!({ path: 'none.txt' })).resolves.toEqual({ exists: false });
	});

	it('缺少必填字段 - 明确报错 - 不静默写空路径', async () => {
		const handlers = createIndexRuntimeHandlers({ fs: makeFs(), root });
		await expect(handlers['fs.write']!({ data: 'x' })).rejects.toBeInstanceOf(RuntimePathError);
		await expect(handlers['fs.read']!({})).rejects.toBeInstanceOf(RuntimePathError);
	});

	it('重命名与删除 - 在根内生效', async () => {
		const handlers = createIndexRuntimeHandlers({ fs: makeFs(), root });
		await handlers['fs.write']!({ path: 'c.txt', data: 'x' });
		await handlers['fs.rename']!({ from: 'c.txt', to: 'd.txt' });
		await expect(fsp.readFile(path.join(root, 'd.txt'), 'utf8')).resolves.toBe('x');
		await handlers['fs.remove']!({ path: 'd.txt' });
		await expect(fsp.access(path.join(root, 'd.txt'))).rejects.toThrow();
	});
});
