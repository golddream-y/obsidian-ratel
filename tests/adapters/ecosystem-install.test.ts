/**
 * @file tests/adapters/ecosystem-install.test.ts
 * @description 安装编排 R2/R3 与禁区(ratel-vault / 清单外 / 不跟 latest)
 * @module adapters/ecosystem-install.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { setConfigDir } from '../../src/utils/path-safety';
import { MemoryEcosystemIo } from '../../src/adapters/ecosystem-vault';
import { installCommunityPlugin } from '../../src/adapters/ecosystem-install';
import {
	COMMUNITY_PLUGINS_CATALOG_URL,
	EcosystemRegistry,
	type HttpGet,
} from '../../src/adapters/ecosystem-registry';
import { tryEnableCommunityPlugin } from '../../src/adapters/ecosystem-runtime';
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

describe('tryEnableCommunityPlugin', () => {
	it('内部 API 缺失 - enabled false 不假装成功', async () => {
		const r = await tryEnableCommunityPlugin({}, 'calendar', '.obsidian/plugins/calendar');
		expect(r.enabled).toBe(false);
		expect(r.usedInternalApi).toBe(false);
	});

	it('enablePluginAndSave + getPlugin 存在 - enabled true', async () => {
		const r = await tryEnableCommunityPlugin(
			{
				plugins: {
					loadManifests: async () => undefined,
					enablePluginAndSave: async () => undefined,
					getPlugin: (id: string) => (id === 'calendar' ? {} : null),
				},
			},
			'calendar',
			'.obsidian/plugins/calendar',
		);
		expect(r.enabled).toBe(true);
	});
});

describe('installCommunityPlugin', () => {
	let pluginDir: string;
	let opened: string[];

	beforeEach(() => {
		setConfigDir('.obsidian');
		pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-ins-'));
		opened = [];
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

	it('R3 保守模式 - 打开官方页且零写盘', async () => {
		const fetch = http();
		const reg = new EcosystemRegistry(pluginDir, fetch);
		const io = new MemoryEcosystemIo(() => ({
			catalogIds: new Set(['calendar']),
			installedIds: new Set(),
		}));
		const result = await installCommunityPlugin('calendar', {
			registry: reg,
			io,
			configDir: '.obsidian',
			writeEnabled: false,
			apiVersion: '1.13.0',
			openOfficialPage: async (uri) => {
				opened.push(uri);
			},
			appLike: {},
		});
		expect(result.mode).toBe('official-page');
		expect(result.filesWritten).toBe(false);
		expect(opened[0]).toContain('obsidian://show-plugin?id=calendar');
		expect(io.files.size).toBe(0);
		expect((fetch as HttpGet & { seen: string[] }).seen.some((u) => u.includes('/releases/latest'))).toBe(false);
	});

	it('R2 写盘 - 写入三件套与启用清单 - 热启用失败仍 filesWritten', async () => {
		const fetch = http();
		const reg = new EcosystemRegistry(pluginDir, fetch);
		const io = new MemoryEcosystemIo(() => ({
			catalogIds: new Set(['calendar']),
			installedIds: new Set(),
		}));
		const result = await installCommunityPlugin('calendar', {
			registry: reg,
			io,
			configDir: '.obsidian',
			writeEnabled: true,
			apiVersion: '1.13.0',
			openOfficialPage: async () => undefined,
			appLike: {},
		});
		expect(result.mode).toBe('write');
		expect(result.filesWritten).toBe(true);
		expect(result.enabled).toBe(false);
		expect(io.files.get('.obsidian/plugins/calendar/main.js')).toBe('js-body');
		expect(JSON.parse(io.files.get('.obsidian/community-plugins.json')!)).toContain('calendar');
		expect((fetch as HttpGet & { seen: string[] }).seen.some((u) => u.includes('/releases/latest'))).toBe(false);
	});

	it('管理自己 - 拒绝', async () => {
		const fetch = http();
		const reg = new EcosystemRegistry(pluginDir, fetch);
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(), installedIds: new Set() }));
		await expect(
			installCommunityPlugin('ratel-vault', {
				registry: reg,
				io,
				configDir: '.obsidian',
				writeEnabled: true,
				apiVersion: '1.13.0',
				openOfficialPage: async () => undefined,
				appLike: {},
			}),
		).rejects.toThrow(/自己|itself/i);
	});

	it('清单外 id - 拒绝', async () => {
		const fetch = http();
		const reg = new EcosystemRegistry(pluginDir, fetch);
		const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set() }));
		await expect(
			installCommunityPlugin('not-a-real-plugin', {
				registry: reg,
				io,
				configDir: '.obsidian',
				writeEnabled: true,
				apiVersion: '1.13.0',
				openOfficialPage: async () => undefined,
				appLike: {},
			}),
		).rejects.toThrow();
	});
});
