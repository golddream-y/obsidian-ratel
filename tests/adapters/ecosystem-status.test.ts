/**
 * @file tests/adapters/ecosystem-status.test.ts
 * @description 已装列表默认不出站；checkUpdate 才拉 HEAD
 * @module adapters/ecosystem-status.test
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setConfigDir } from '../../src/utils/path-safety';
import { MemoryEcosystemIo } from '../../src/adapters/ecosystem-vault';
import { getCommunityPluginStatus, listInstalledPlugins } from '../../src/adapters/ecosystem-status';
import { COMMUNITY_PLUGINS_CATALOG_URL, EcosystemRegistry, type HttpGet } from '../../src/adapters/ecosystem-registry';

const CAL = { id: 'calendar', name: 'Calendar', author: 'Liam Cain', description: 'Calendar', repo: 'liamcain/obsidian-calendar-plugin' };

function http(): HttpGet {
	const manifest = JSON.stringify({ id: 'calendar', version: '1.5.10', minAppVersion: '0.12.0' });
	const map: Record<string, { status: number; text: string }> = {
		[COMMUNITY_PLUGINS_CATALOG_URL]: { status: 200, text: JSON.stringify([CAL]) },
		[`https://raw.githubusercontent.com/${CAL.repo}/HEAD/manifest.json`]: { status: 200, text: manifest },
	};
	const seen: string[] = [];
	const fn: HttpGet = async (url) => {
		seen.push(url);
		(fn as HttpGet & { seen: string[] }).seen = seen;
		return map[url] ?? { status: 404, text: '' };
	};
	(fn as HttpGet & { seen: string[] }).seen = seen;
	return fn;
}

describe('status', () => {
	let pluginDir: string;
	beforeEach(() => {
		setConfigDir('.obsidian');
		pluginDir = mkdtempSync(path.join(tmpdir(), 'ratel-st-'));
	});
	it('listInstalled - 省略 id 不出站且不含 ratel-vault', async () => {
		const fetch = http();
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar', 'ratel-vault']) }));
		await io.writeText('.obsidian/plugins/calendar/manifest.json', JSON.stringify({ id: 'calendar', name: 'Calendar', version: '1.0.0' }));
		// 通道 B writeText 会拒 ratel-vault;直接写入内存盘键模拟 vault 上已存在
		io.files.set('.obsidian/plugins/ratel-vault/manifest.json', JSON.stringify({ id: 'ratel-vault', version: '0.8.0' }));
		await io.writeText('.obsidian/community-plugins.json', JSON.stringify(['calendar']));
		const list = await listInstalledPlugins({ io, configDir: '.obsidian' });
		expect(list.map((p) => p.id)).toEqual(['calendar']);
		expect((fetch as HttpGet & { seen: string[] }).seen).toEqual([]);
	});
	it('status - checkUpdate 返回 updateAvailable 且 URL 不含 latest', async () => {
		const fetch = http();
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
		await io.writeText('.obsidian/plugins/calendar/manifest.json', JSON.stringify({ id: 'calendar', name: 'Calendar', version: '1.0.0' }));
		await io.writeText('.obsidian/community-plugins.json', JSON.stringify(['calendar']));
		const reg = new EcosystemRegistry(pluginDir, fetch);
		const r = await getCommunityPluginStatus('calendar', { io, configDir: '.obsidian', registry: reg, checkUpdate: true, includeKeys: false });
		expect(r.installed).toBe(true);
		expect(r.catalogVersion).toBe('1.5.10');
		expect(r.updateAvailable).toBe(true);
		expect((fetch as HttpGet & { seen: string[] }).seen.some((u) => u.includes('/releases/latest'))).toBe(false);
	});
	it('status - 未装 installed false', async () => {
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set() }));
		const r = await getCommunityPluginStatus('calendar', { io, configDir: '.obsidian', registry: new EcosystemRegistry(pluginDir, http()), checkUpdate: false, includeKeys: false });
		expect(r.installed).toBe(false);
	});
});
