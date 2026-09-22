/**
 * @file tests/adapters/ecosystem-update.test.ts
 * @description 社区插件升级 — 三件套覆盖、保 data.json、不降级
 * @module adapters/ecosystem-update.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { setConfigDir } from '../../src/utils/path-safety';
import { MemoryEcosystemIo } from '../../src/adapters/ecosystem-vault';
import {
	COMMUNITY_PLUGINS_CATALOG_URL,
	EcosystemRegistry,
	type HttpGet,
} from '../../src/adapters/ecosystem-registry';
import { updateCommunityPlugin } from '../../src/adapters/ecosystem-update';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CAL = {
	id: 'calendar',
	name: 'Calendar',
	author: 'Liam Cain',
	description: 'Calendar',
	repo: 'liamcain/obsidian-calendar-plugin',
};

describe('updateCommunityPlugin', () => {
	let pluginDir: string;

	beforeEach(() => {
		setConfigDir('.obsidian');
		pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-upd-'));
	});

	function http(extra: Record<string, { status: number; text: string }> = {}): HttpGet {
		const repo = CAL.repo;
		const manifest = JSON.stringify({ id: 'calendar', version: '1.5.10', minAppVersion: '0.12.0' });
		const map: Record<string, { status: number; text: string }> = {
			[COMMUNITY_PLUGINS_CATALOG_URL]: { status: 200, text: JSON.stringify([CAL]) },
			[`https://raw.githubusercontent.com/${repo}/HEAD/manifest.json`]: { status: 200, text: manifest },
			[`https://github.com/${repo}/releases/download/1.5.10/manifest.json`]: { status: 200, text: manifest },
			[`https://github.com/${repo}/releases/download/1.5.10/main.js`]: { status: 200, text: 'js-body' },
			[`https://github.com/${repo}/releases/download/1.5.10/styles.css`]: { status: 404, text: '' },
			...extra,
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

	function makeDeps(
		pluginDir: string,
		fetch: HttpGet,
		io: MemoryEcosystemIo,
		writeEnabled: boolean,
	) {
		return {
			registry: new EcosystemRegistry(pluginDir, fetch),
			io,
			configDir: '.obsidian',
			writeEnabled,
			apiVersion: '1.13.0',
			openOfficialPage: async () => undefined,
			appLike: {},
			pluginDir,
		};
	}

	async function seedComplete(io: MemoryEcosystemIo, version = '1.0.0') {
		await io.writeText('.obsidian/plugins/calendar/manifest.json', JSON.stringify({ id: 'calendar', version }));
		await io.writeText('.obsidian/plugins/calendar/main.js', 'OLDJS');
		await io.writeText('.obsidian/plugins/calendar/styles.css', 'OLDCSS');
		await io.writeText('.obsidian/plugins/calendar/data.json', '{"weekStart":0,"token":"keep"}');
	}

	it('update - 覆盖三件套后 data.json 字节不变', async () => {
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
		await seedComplete(io, '1.0.0');
		const fetch = http();
		const result = await updateCommunityPlugin('calendar', makeDeps(pluginDir, fetch, io, true));
		expect(result.mode).toBe('write');
		expect(result.dataJsonUnchanged).toBe(true);
		expect(await io.readText('.obsidian/plugins/calendar/data.json')).toBe('{"weekStart":0,"token":"keep"}');
		expect(await io.readText('.obsidian/plugins/calendar/main.js')).toBe('js-body');
	});

	it('update - 已是 HEAD version - already-current 零写 main.js', async () => {
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
		await seedComplete(io, '1.5.10');
		const r = await updateCommunityPlugin('calendar', makeDeps(pluginDir, http(), io, true));
		expect(r.mode).toBe('already-current');
		expect(await io.readText('.obsidian/plugins/calendar/main.js')).toBe('OLDJS');
	});

	it('update - 本地 2.0.0 高于商店 1.5.10 - 不降级', async () => {
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
		await seedComplete(io, '2.0.0');
		await expect(updateCommunityPlugin('calendar', makeDeps(pluginDir, http(), io, true))).rejects.toThrow();
		expect(await io.readText('.obsidian/plugins/calendar/main.js')).toBe('OLDJS');
	});

	it('update - 未装 - not-installed', async () => {
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set() }));
		const r = await updateCommunityPlugin('calendar', makeDeps(pluginDir, http(), io, true));
		expect(r.mode).toBe('not-installed');
	});

	it('update - R3 零写盘开官方页', async () => {
		const opened: string[] = [];
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
		await seedComplete(io);
		const r = await updateCommunityPlugin('calendar', { ...makeDeps(pluginDir, http(), io, false), openOfficialPage: async (u) => { opened.push(u); } });
		expect(r.mode).toBe('official-page');
		expect(opened[0]).toContain('obsidian://show-plugin');
		expect(await io.readText('.obsidian/plugins/calendar/main.js')).toBe('OLDJS');
	});

	it('update - 新 release 无 styles.css - 旧 styles.css 仍在', async () => {
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
		await seedComplete(io, '1.0.0');
		await updateCommunityPlugin('calendar', makeDeps(pluginDir, http(), io, true));
		expect(await io.readText('.obsidian/plugins/calendar/styles.css')).toBe('OLDCSS');
	});

	it('update - writeBinary 抛错 - 整目录从备份恢复且 data.json 仍是 seed', async () => {
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
		await seedComplete(io, '1.0.0');
		const orig = io.writeBinary.bind(io);
		io.writeBinary = async () => { throw new Error('boom'); };
		await expect(updateCommunityPlugin('calendar', makeDeps(pluginDir, http(), io, true))).rejects.toThrow();
		io.writeBinary = orig;
		expect(await io.readText('.obsidian/plugins/calendar/data.json')).toBe('{"weekStart":0,"token":"keep"}');
		expect(await io.readText('.obsidian/plugins/calendar/main.js')).toBe('OLDJS');
	});

	it('update - 无法点分段比较且 confirmIncomparable 拒绝 - 零写', async () => {
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
		await seedComplete(io, '1.0.0-beta');
		const deps = { ...makeDeps(pluginDir, http(), io, true), confirmIncomparable: async () => false };
		await expect(updateCommunityPlugin('calendar', deps)).rejects.toThrow();
		expect(await io.readText('.obsidian/plugins/calendar/main.js')).toBe('OLDJS');
	});
});
