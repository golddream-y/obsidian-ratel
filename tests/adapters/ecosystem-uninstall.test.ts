/**
 * @file tests/adapters/ecosystem-uninstall.test.ts
 * @description 卸载备份后删目录
 * @module adapters/ecosystem-uninstall.test
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setConfigDir } from '../../src/utils/path-safety';
import { MemoryEcosystemIo } from '../../src/adapters/ecosystem-vault';
import { uninstallCommunityPlugin } from '../../src/adapters/ecosystem-uninstall';

let pluginDir: string;
beforeEach(() => {
	setConfigDir('.obsidian');
	pluginDir = mkdtempSync(path.join(tmpdir(), 'ratel-un-'));
});

describe('uninstallCommunityPlugin', () => {
	it('卸载 - 目录消失且启用清单无 id', async () => {
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
		await io.writeText('.obsidian/plugins/calendar/manifest.json', '{"id":"calendar"}');
		await io.writeText('.obsidian/plugins/calendar/main.js', 'JS');
		await io.writeText('.obsidian/community-plugins.json', JSON.stringify(['calendar', 'other']));
		const r = await uninstallCommunityPlugin('calendar', { io, pluginDir, configDir: '.obsidian', writeEnabled: true, appLike: {} });
		expect(r.ok).toBe(true);
		expect(r.backedUp).toBe(true);
		expect(await io.exists('.obsidian/plugins/calendar/main.js')).toBe(false);
		expect(JSON.parse(await io.readText('.obsidian/community-plugins.json'))).toEqual(['other']);
	});
	it('卸载 - 下架 id 本地仍有目录 - 可卸', async () => {
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(), installedIds: new Set(['oldplug']) }));
		await io.writeText('.obsidian/plugins/oldplug/manifest.json', '{"id":"oldplug"}');
		await io.writeText('.obsidian/plugins/oldplug/main.js', 'JS');
		const r = await uninstallCommunityPlugin('oldplug', { io, pluginDir, configDir: '.obsidian', writeEnabled: true, appLike: {} });
		expect(r.ok).toBe(true);
		expect(await io.exists('.obsidian/plugins/oldplug/main.js')).toBe(false);
	});
	it('卸载 - ratel-vault - 拒绝', async () => {
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(), installedIds: new Set(['ratel-vault']) }));
		await expect(uninstallCommunityPlugin('ratel-vault', { io, pluginDir, configDir: '.obsidian', writeEnabled: true, appLike: {} })).rejects.toThrow();
	});
	it('卸载 - writeEnabled false - 零写盘', async () => {
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
		await io.writeText('.obsidian/plugins/calendar/manifest.json', '{"id":"calendar"}');
		await io.writeText('.obsidian/plugins/calendar/main.js', 'JS');
		await expect(uninstallCommunityPlugin('calendar', { io, pluginDir, configDir: '.obsidian', writeEnabled: false, appLike: {} })).rejects.toThrow();
		expect(await io.readText('.obsidian/plugins/calendar/main.js')).toBe('JS');
	});
	it('卸载 - 目录不存在 - 失败不造假成功', async () => {
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set() }));
		await expect(uninstallCommunityPlugin('calendar', { io, pluginDir, configDir: '.obsidian', writeEnabled: true, appLike: {} })).rejects.toThrow();
	});
});
