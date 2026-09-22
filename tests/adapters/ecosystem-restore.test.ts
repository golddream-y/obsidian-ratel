/**
 * @file tests/adapters/ecosystem-restore.test.ts
 * @description 按 changeId 恢复备份
 * @module adapters/ecosystem-restore.test
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setConfigDir } from '../../src/utils/path-safety';
import { MemoryEcosystemIo } from '../../src/adapters/ecosystem-vault';
import { appendEcosystemChange, markChangeStatus } from '../../src/core/ecosystem-change-log';
import { snapshotPluginDir } from '../../src/core/ecosystem-backup';
import { restoreEcosystemBackup } from '../../src/adapters/ecosystem-restore';

describe('restoreEcosystemBackup', () => {
	let pluginDir: string;
	beforeEach(() => {
		setConfigDir('.obsidian');
		pluginDir = mkdtempSync(path.join(tmpdir(), 'ratel-rs-'));
	});
	it('restore - 卸载后还原目录与启用清单', async () => {
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
		await io.writeText('.obsidian/plugins/calendar/manifest.json', '{"id":"calendar"}');
		await io.writeText('.obsidian/plugins/calendar/main.js', 'JS');
		await io.writeText('.obsidian/community-plugins.json', JSON.stringify(['calendar', 'other']));
		const change = await appendEcosystemChange(pluginDir, {
			action: 'uninstall',
			pluginId: 'calendar',
			summary: 'calendar',
			before: { enabledIds: ['calendar', 'other'] },
		});
		await snapshotPluginDir({ pluginDir, changeId: change.id, io, pluginRel: '.obsidian/plugins/calendar' });
		await io.removeRecursive('.obsidian/plugins/calendar');
		await io.writeText('.obsidian/community-plugins.json', JSON.stringify(['other']));
		await restoreEcosystemBackup(change.id, { io, pluginDir, configDir: '.obsidian', writeEnabled: true });
		expect(await io.readText('.obsidian/plugins/calendar/main.js')).toBe('JS');
		expect(JSON.parse(await io.readText('.obsidian/community-plugins.json'))).toEqual(['calendar', 'other']);
	});
	it('restore - 恢复后 data.json 回到 before 并追加 restore', async () => {
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
		await io.writeText('.obsidian/plugins/calendar/manifest.json', '{"id":"calendar"}');
		await io.writeText('.obsidian/plugins/calendar/data.json', '{"weekStart":0}');
		const change = await appendEcosystemChange(pluginDir, { action: 'configure', pluginId: 'calendar', summary: 'weekStart' });
		await snapshotPluginDir({ pluginDir, changeId: change.id, io, pluginRel: '.obsidian/plugins/calendar' });
		await io.writeText('.obsidian/plugins/calendar/data.json', '{"weekStart":1}');
		const r = await restoreEcosystemBackup(change.id, { io, pluginDir, configDir: '.obsidian', writeEnabled: true });
		expect(r.ok).toBe(true);
		expect(r.restoredAction).toBe('configure');
		expect(await io.readText('.obsidian/plugins/calendar/data.json')).toBe('{"weekStart":0}');
	});
	it('restore - expired 失败', async () => {
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
		await io.writeText('.obsidian/plugins/calendar/manifest.json', '{"id":"calendar"}');
		const change = await appendEcosystemChange(pluginDir, { action: 'configure', pluginId: 'calendar', summary: 'x' });
		await snapshotPluginDir({ pluginDir, changeId: change.id, io, pluginRel: '.obsidian/plugins/calendar' });
		await markChangeStatus(pluginDir, change.id, 'expired');
		await expect(restoreEcosystemBackup(change.id, { io, pluginDir, configDir: '.obsidian', writeEnabled: true })).rejects.toThrow();
	});
	it('restore - 未知 id 失败', async () => {
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(), installedIds: new Set() }));
		await expect(restoreEcosystemBackup('ch_999999', { io, pluginDir, configDir: '.obsidian', writeEnabled: true })).rejects.toThrow();
	});
});
