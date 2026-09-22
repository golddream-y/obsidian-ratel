/**
 * @file tests/tools/draft-plugin-profile.test.ts
 * @description 草稿默认不生效且不调用 configure
 * @module tools/draft-plugin-profile.test
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setConfigDir } from '../../src/utils/path-safety';
import { MemoryEcosystemIo } from '../../src/adapters/ecosystem-vault';
import { createDraftPluginProfileTool } from '../../src/tools/draft-plugin-profile';

it('draft_plugin_profile - 已装写出 enabled false 且含 apiKey forbid', async () => {
	setConfigDir('.obsidian');
	const vaultRoot = mkdtempSync(path.join(tmpdir(), 'ratel-dr-'));
	const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set(['calendar']) }));
	await io.writeText('.obsidian/plugins/calendar/manifest.json', JSON.stringify({ id: 'calendar', name: 'Calendar' }));
	await io.writeText('.obsidian/plugins/calendar/data.json', JSON.stringify({ weekStart: 0, apiKey: 's' }));
	const tool = createDraftPluginProfileTool(
		{ name: 'draft_plugin_profile', parameters: { type: 'object', properties: {} } },
		{ io, configDir: '.obsidian', vaultRoot, homedir: vaultRoot },
	);
	const r = await tool.execute({ pluginId: 'calendar' }) as { path: string; draft: boolean };
	expect(r.draft).toBe(true);
	const text = readFileSync(r.path, 'utf-8');
	expect(text).toContain('enabled: false');
	expect(text).toContain('apiKey');
	expect(text).toContain('待作者填写');
	expect(text).toContain('patch: {}');
	expect(text).not.toMatch(/^[^#]*weekStart:\s*0/m);
});

it('draft_plugin_profile - 未装失败', async () => {
	setConfigDir('.obsidian');
	const vaultRoot = mkdtempSync(path.join(tmpdir(), 'ratel-dr2-'));
	const io = new MemoryEcosystemIo(() => ({ catalogIds: new Set(['calendar']), installedIds: new Set() }));
	const tool = createDraftPluginProfileTool(
		{ name: 'draft_plugin_profile', parameters: { type: 'object', properties: {} } },
		{ io, configDir: '.obsidian', vaultRoot, homedir: vaultRoot },
	);
	await expect(tool.execute({ pluginId: 'calendar' })).rejects.toThrow();
});
