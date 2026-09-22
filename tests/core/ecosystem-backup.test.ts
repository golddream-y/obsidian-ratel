/**
 * @file tests/core/ecosystem-backup.test.ts
 * @description 快照恢复与每插件保留 3 份
 * @module core/ecosystem-backup.test
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setConfigDir } from '../../src/utils/path-safety';
import { MemoryEcosystemIo } from '../../src/adapters/ecosystem-vault';
import { snapshotPluginDir, restoreSnapshot } from '../../src/core/ecosystem-backup';
import { appendEcosystemChange, listEcosystemChanges } from '../../src/core/ecosystem-change-log';

let pluginDir: string;
beforeEach(() => {
	setConfigDir('.obsidian');
	pluginDir = mkdtempSync(path.join(tmpdir(), 'ratel-ebak-'));
});
afterEach(() => { rmSync(pluginDir, { recursive: true, force: true }); });

describe('ecosystem-backup', () => {
	it('snapshotPluginDir / restoreSnapshot - data.json 回到快照', async () => {
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
		await io.writeText('.obsidian/plugins/calendar/manifest.json', '{"id":"calendar"}');
		await io.writeText('.obsidian/plugins/calendar/data.json', '{"weekStart":0}');
		const change = await appendEcosystemChange(pluginDir, { action: 'configure', pluginId: 'calendar', summary: 'snap' });
		await snapshotPluginDir({ pluginDir, changeId: change.id, io, pluginRel: '.obsidian/plugins/calendar' });
		await io.writeText('.obsidian/plugins/calendar/data.json', '{"weekStart":1}');
		await restoreSnapshot({ pluginDir, changeId: change.id, io, pluginRel: '.obsidian/plugins/calendar' });
		expect(await io.readText('.obsidian/plugins/calendar/data.json')).toBe('{"weekStart":0}');
		expect(readFileSync(path.join(pluginDir, 'ecosystem-backups', change.id, 'data.json'), 'utf-8')).toBe('{"weekStart":0}');
	});
	it('同一 pluginId 第 4 份 - 最旧 status expired', async () => {
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
		await io.writeText('.obsidian/plugins/calendar/manifest.json', '{"id":"calendar"}');
		const ids: string[] = [];
		for (let i = 0; i < 4; i++) {
			const c = await appendEcosystemChange(pluginDir, { action: 'configure', pluginId: 'calendar', summary: String(i) });
			ids.push(c.id);
			await snapshotPluginDir({ pluginDir, changeId: c.id, io, pluginRel: '.obsidian/plugins/calendar' });
		}
		const rows = await listEcosystemChanges(pluginDir, { pluginId: 'calendar', limit: 100 });
		expect(rows.find((r) => r.id === ids[0])!.status).toBe('expired');
		expect(rows.filter((r) => r.status === 'recorded')).toHaveLength(3);
	});
});
