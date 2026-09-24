/**
 * @file tests/tools/host-access.test.ts
 * @description 库外访问 — 总闸关闭失败、库内路径拒绝、清单随开关隐藏
 * @module tests/tools/host-access
 */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../src/core/tool-registry';
import { DEFAULT_SETTINGS } from '../../src/settings';
import {
	createListHostDirTool,
	createReadHostFileTool,
	resolveOutsideVault,
} from '../../src/tools/host-access';

const dirs: string[] = [];

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeDir(name: string): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), name));
	dirs.push(dir);
	return dir;
}

const def = (name: string) => ({
	name,
	description: name,
	parameters: { type: 'object' as const, properties: {} },
});

describe('host access', () => {
	it('默认设置 - 总闸 - 关闭', () => {
		expect(DEFAULT_SETTINGS.hostAccessEnabled).toBe(false);
		expect(DEFAULT_SETTINGS.toolPermissions.list_host_dir).toBe('ask');
		expect(DEFAULT_SETTINGS.toolPermissions.read_host_file).toBe('ask');
		expect(DEFAULT_SETTINGS.toolPermissions.import_host_file).toBe('ask');
		expect(DEFAULT_SETTINGS.toolPermissions.run_host_command).toBe('ask');
	});

	it('resolveOutsideVault - 路径在库内 - 拒绝', async () => {
		const vault = await makeDir('ratel-vault-');
		await expect(resolveOutsideVault(path.join(vault, 'note.md'), vault)).rejects.toThrow(/当前库/);
	});

	it('resolveOutsideVault - 路径在库外 - 返回绝对路径', async () => {
		const vault = await makeDir('ratel-vault-');
		const outside = await makeDir('ratel-out-');
		const file = path.join(outside, 'a.txt');
		await writeFile(file, 'hi');
		await expect(resolveOutsideVault(file, vault)).resolves.toBe(await realpath(file));
	});

	it('list_host_dir - 总闸关闭 - 不进模型清单且执行失败', async () => {
		const tool = createListHostDirTool(def('list_host_dir'), {
			enabled: () => false,
			vaultRoot: () => '/Users/alice/Notes',
		});
		const registry = new ToolRegistry();
		registry.register(tool);
		expect(registry.definitions()).toEqual([]);
		await expect(tool.execute({ path: '/tmp' })).rejects.toThrow(/未打开/);
	});

	it('read_host_file - 总闸打开且文件在库外 - 返回正文', async () => {
		const vault = await makeDir('ratel-vault-');
		const outside = await makeDir('ratel-out-');
		const file = path.join(outside, 'a.txt');
		await writeFile(file, 'hello');
		const tool = createReadHostFileTool(def('read_host_file'), {
			enabled: () => true,
			vaultRoot: () => vault,
		});
		const registry = new ToolRegistry();
		registry.register(tool);
		expect(registry.definitions().map((item) => item.name)).toEqual(['read_host_file']);
		await expect(tool.execute({ path: file })).resolves.toMatchObject({ text: 'hello' });
	});
});
