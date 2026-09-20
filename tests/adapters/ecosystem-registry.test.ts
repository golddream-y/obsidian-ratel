/**
 * @file tests/adapters/ecosystem-registry.test.ts
 * @description 社区清单缓存 / 搜索打分 / 版本定位(禁止 releases/latest)
 * @module adapters/ecosystem-registry.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	COMMUNITY_PLUGINS_CATALOG_URL,
	EcosystemRegistry,
	rankCommunityPlugins,
	type CommunityPluginEntry,
	type HttpGet,
} from '../../src/adapters/ecosystem-registry';

const SAMPLE: CommunityPluginEntry[] = [
	{
		id: 'calendar',
		name: 'Calendar',
		author: 'Liam Cain',
		description: 'Calendar view for your daily notes',
		repo: 'liamcain/obsidian-calendar-plugin',
	},
	{
		id: 'dataview',
		name: 'Dataview',
		author: 'Michael Brenan',
		description: 'Complex data views for the data-obsessed',
		repo: 'blacksmithgu/obsidian-dataview',
	},
];

describe('rankCommunityPlugins', () => {
	it('搜索 - 按名称命中 - 返回 top 结果含作者与下载量', () => {
		const hits = rankCommunityPlugins('看板 calendar', SAMPLE, { calendar: { downloads: 9000 } }, new Set(['calendar']), 5);
		expect(hits[0]?.id).toBe('calendar');
		expect(hits[0]?.author).toBe('Liam Cain');
		expect(hits[0]?.downloads).toBe(9000);
		expect(hits[0]?.installed).toBe(true);
	});

	it('搜索 - 无 stats - downloads 为 null 不假装 0', () => {
		const hits = rankCommunityPlugins('dataview', SAMPLE, {}, new Set(), 5);
		const dv = hits.find((h) => h.id === 'dataview');
		expect(dv?.downloads).toBeNull();
	});
});

describe('EcosystemRegistry', () => {
	let dir: string;
	let urls: string[];

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-eco-'));
		urls = [];
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	function http(map: Record<string, { status: number; text: string }>): HttpGet {
		return async (url) => {
			urls.push(url);
			const hit = map[url];
			if (!hit) return { status: 404, text: '' };
			return hit;
		};
	}

	it('ensureCatalog - 无缓存时拉官方 HEAD 清单 - 写入 pluginDir 不进 data.json', async () => {
		const reg = new EcosystemRegistry(dir, http({
			[COMMUNITY_PLUGINS_CATALOG_URL]: { status: 200, text: JSON.stringify(SAMPLE) },
		}));
		const cat = await reg.ensureCatalog();
		expect(cat.plugins).toHaveLength(2);
		expect(cat.stale).toBe(false);
		expect(fs.existsSync(path.join(dir, 'ecosystem-catalog.json'))).toBe(true);
		expect(urls.every((u) => !u.includes('data.json'))).toBe(true);
	});

	it('ensureCatalog - TTL 内 - 不再出站', async () => {
		const fetch = http({
			[COMMUNITY_PLUGINS_CATALOG_URL]: { status: 200, text: JSON.stringify(SAMPLE) },
		});
		const reg = new EcosystemRegistry(dir, fetch);
		await reg.ensureCatalog();
		urls.length = 0;
		await reg.ensureCatalog();
		expect(urls).toEqual([]);
	});

	it('ensureCatalog - 拉取失败但有过期缓存 - 仍可搜并标 stale', async () => {
		const fetch = http({
			[COMMUNITY_PLUGINS_CATALOG_URL]: { status: 200, text: JSON.stringify(SAMPLE) },
		});
		const reg = new EcosystemRegistry(dir, fetch, { ttlMs: 1 });
		await reg.ensureCatalog();
		await new Promise((r) => setTimeout(r, 5));
		const fail = new EcosystemRegistry(dir, http({}), { ttlMs: 1 });
		const cat = await fail.ensureCatalog();
		expect(cat.stale).toBe(true);
		expect(cat.plugins[0]?.id).toBe('calendar');
	});

	it('ensureCatalog - 无缓存且失败 - 抛错', async () => {
		const reg = new EcosystemRegistry(dir, http({}));
		await expect(reg.ensureCatalog()).rejects.toThrow();
	});

	it('resolveReleaseVersion - 使用仓库 HEAD manifest.version - 不请求 releases/latest', async () => {
		const repo = 'liamcain/obsidian-calendar-plugin';
		const fetch = http({
			[`https://raw.githubusercontent.com/${repo}/HEAD/manifest.json`]: {
				status: 200,
				text: JSON.stringify({ id: 'calendar', version: '1.5.10', minAppVersion: '0.13.0' }),
			},
		});
		const reg = new EcosystemRegistry(dir, fetch);
		const v = await reg.resolveReleaseVersion(repo, '1.13.0');
		expect(v.version).toBe('1.5.10');
		expect(urls.some((u) => u.includes('/releases/latest'))).toBe(false);
	});

	it('resolveReleaseVersion - minAppVersion 高于当前 - 拒绝', async () => {
		const repo = 'x/y';
		const fetch = http({
			[`https://raw.githubusercontent.com/${repo}/HEAD/manifest.json`]: {
				status: 200,
				text: JSON.stringify({ id: 'x', version: '9.0.0', minAppVersion: '99.0.0' }),
			},
		});
		const reg = new EcosystemRegistry(dir, fetch);
		await expect(reg.resolveReleaseVersion(repo, '1.13.0')).rejects.toThrow(/minAppVersion|Obsidian/);
	});
});
