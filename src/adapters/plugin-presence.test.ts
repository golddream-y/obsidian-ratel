/**
 * @file src/adapters/plugin-presence.test.ts
 * @description createPluginPresence 单元测试
 * @module adapters/plugin-presence.test
 */

import { describe, it, expect } from 'vitest';
import { createPluginPresence } from './plugin-presence';
import type { PluginPresenceAdapter } from './plugin-presence';

function mockAdapter(files: Record<string, string>): PluginPresenceAdapter {
	return {
		read: async (path: string) => {
			const content = files[path];
			if (content === undefined) throw new Error(`ENOENT: ${path}`);
			return content;
		},
		exists: async (path: string) => path in files,
	};
}

describe('createPluginPresence', () => {
	it('listEnabled - community-plugins.json 为数组 - 返回启用 id 列表', async () => {
		const adapter = mockAdapter({
			'.obsidian/community-plugins.json': '["dataview","calendar"]',
		});
		const presence = createPluginPresence(adapter, '.obsidian');
		await expect(presence.listEnabled()).resolves.toEqual(['dataview', 'calendar']);
	});

	it('listEnabled - 文件不存在 - 返回空数组', async () => {
		const adapter = mockAdapter({});
		const presence = createPluginPresence(adapter, '.obsidian');
		await expect(presence.listEnabled()).resolves.toEqual([]);
	});

	it('isInstalled - manifest 存在 - 返回 true', async () => {
		const adapter = mockAdapter({
			'.obsidian/plugins/dataview/manifest.json': '{}',
		});
		const presence = createPluginPresence(adapter, '.obsidian');
		await expect(presence.isInstalled('dataview')).resolves.toBe(true);
	});

	it('isInstalled - manifest 不存在 - 返回 false', async () => {
		const adapter = mockAdapter({});
		const presence = createPluginPresence(adapter, '.obsidian');
		await expect(presence.isInstalled('dataview')).resolves.toBe(false);
	});

	it('isInstalled - pluginId 含斜杠 - 返回 false', async () => {
		const adapter = mockAdapter({
			'.obsidian/plugins/evil/id/manifest.json': '{}',
		});
		const presence = createPluginPresence(adapter, '.obsidian');
		await expect(presence.isInstalled('evil/id')).resolves.toBe(false);
	});

	it('isInstalled - pluginId 含 .. - 返回 false', async () => {
		const adapter = mockAdapter({
			'.obsidian/plugins/../secret/manifest.json': '{}',
		});
		const presence = createPluginPresence(adapter, '.obsidian');
		await expect(presence.isInstalled('../secret')).resolves.toBe(false);
	});
});
