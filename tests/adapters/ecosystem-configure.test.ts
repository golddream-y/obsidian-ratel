/**
 * @file tests/adapters/ecosystem-configure.test.ts
 * @description inspect / apply 点名 diff
 * @module adapters/ecosystem-configure.test
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setConfigDir } from '../../src/utils/path-safety';
import { MemoryEcosystemIo } from '../../src/adapters/ecosystem-vault';
import { inspectPluginData, applyPluginData } from '../../src/adapters/ecosystem-configure';
import { createConfigurePluginTool } from '../../src/tools/configure-plugin';

let pluginDir: string;
beforeEach(() => {
	setConfigDir('.obsidian');
	pluginDir = mkdtempSync(path.join(tmpdir(), 'ratel-cfg-'));
});

function ioCal() {
	return new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
}

describe('configure', () => {
	it('inspect - 无 data.json 当空对象', async () => {
		const io = ioCal();
		await io.writeText('.obsidian/plugins/calendar/manifest.json', '{"id":"calendar"}');
		const r = await inspectPluginData('calendar', { io, configDir: '.obsidian' });
		expect(r.keys).toEqual([]);
	});
	it('inspect - apiKey 值打码', async () => {
		const io = ioCal();
		await io.writeText('.obsidian/plugins/calendar/manifest.json', '{"id":"calendar"}');
		await io.writeText('.obsidian/plugins/calendar/data.json', JSON.stringify({ apiKey: 'secret', weekStart: 0 }));
		const r = await inspectPluginData('calendar', { io, configDir: '.obsidian' });
		expect(r.values.apiKey).not.toBe('secret');
		expect(r.values.weekStart).toBe(0);
	});
	it('apply - 只改点名叶子兄弟不变', async () => {
		const io = ioCal();
		await io.writeText('.obsidian/plugins/calendar/manifest.json', '{"id":"calendar"}');
		await io.writeText('.obsidian/plugins/calendar/data.json', JSON.stringify({ weekStart: 0, locale: 'zh' }));
		await applyPluginData('calendar', { weekStart: 1 }, { io, pluginDir, configDir: '.obsidian', writeEnabled: true, confirmedNewKeys: ['weekStart'] });
		expect(JSON.parse(await io.readText('.obsidian/plugins/calendar/data.json'))).toEqual({ weekStart: 1, locale: 'zh' });
	});
	it('apply - 命中启发式 - 整次失败零写盘', async () => {
		const io = ioCal();
		await io.writeText('.obsidian/plugins/calendar/manifest.json', '{"id":"calendar"}');
		await io.writeText('.obsidian/plugins/calendar/data.json', JSON.stringify({ apiKey: 'a', weekStart: 0 }));
		await expect(applyPluginData('calendar', { apiKey: 'x' }, { io, pluginDir, configDir: '.obsidian', writeEnabled: true, confirmedNewKeys: ['apiKey'] })).rejects.toThrow();
		expect(JSON.parse(await io.readText('.obsidian/plugins/calendar/data.json')).apiKey).toBe('a');
	});
	it('apply - 新 key 未确认 - 失败', async () => {
		const io = ioCal();
		await io.writeText('.obsidian/plugins/calendar/manifest.json', '{"id":"calendar"}');
		await io.writeText('.obsidian/plugins/calendar/data.json', '{}');
		await expect(applyPluginData('calendar', { weekStart: 1 }, { io, pluginDir, configDir: '.obsidian', writeEnabled: true, confirmedNewKeys: [] })).rejects.toThrow();
	});
	it('apply - rename 失败 - 原 JSON 完好', async () => {
		const io = ioCal();
		await io.writeText('.obsidian/plugins/calendar/manifest.json', '{"id":"calendar"}');
		await io.writeText('.obsidian/plugins/calendar/data.json', JSON.stringify({ weekStart: 0 }));
		const orig = io.rename.bind(io);
		io.rename = async () => { throw new Error('rename-fail'); };
		await expect(applyPluginData('calendar', { weekStart: 1 }, { io, pluginDir, configDir: '.obsidian', writeEnabled: true, confirmedNewKeys: ['weekStart'] })).rejects.toThrow();
		io.rename = orig;
		expect(JSON.parse(await io.readText('.obsidian/plugins/calendar/data.json'))).toEqual({ weekStart: 0 });
	});
	it('configure 工具 - 缺省 op 走 inspect', async () => {
		const io = ioCal();
		await io.writeText('.obsidian/plugins/calendar/manifest.json', '{"id":"calendar"}');
		const tool = createConfigurePluginTool(
			{ name: 'configure_plugin', parameters: { type: 'object', properties: {} } },
			{ inspect: (id) => inspectPluginData(id, { io, configDir: '.obsidian' }), apply: async () => { throw new Error('should not apply'); } },
		);
		const r = await tool.execute({ pluginId: 'calendar' }) as { keys: string[] };
		expect(r.keys).toEqual([]);
	});
	it('configure 工具 - apply 无 patch 抛 invalidArg', async () => {
		const tool = createConfigurePluginTool(
			{ name: 'configure_plugin', parameters: { type: 'object', properties: {} } },
			{ inspect: async () => ({ keys: [], values: {} }), apply: async () => ({}) },
		);
		await expect(tool.execute({ pluginId: 'calendar', op: 'apply' })).rejects.toThrow();
	});
});
