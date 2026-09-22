/**
 * @file tests/tools/match-plugin-profiles.test.ts
 * @description utterance 命中示例 preset
 * @module tools/match-plugin-profiles.test
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadAllProfiles } from '../../src/adapters/plugin-profile-fs';
import { createMatchPluginProfilesTool } from '../../src/tools/match-plugin-profiles';

const SAMPLE = `kind: obsidian-plugin-profile
id: calendar-week-start
pluginId: calendar
pluginName: Calendar
pluginVersionRange: ">=1.0.0"
install: { source: community-store }
forbid: []
presets:
  - id: week-start-monday
    when: 周一开始
    patch: { weekStart: 1 }
`;

it('match_plugin_profiles - 周一开始 - patchPreview.weekStart 为 1', async () => {
	const root = mkdtempSync(path.join(tmpdir(), 'ratel-mt-'));
	const pluginDir = path.join(root, 'p');
	const vaultRoot = path.join(root, 'v');
	const homedir = path.join(root, 'h');
	mkdirSync(path.join(vaultRoot, '.ratel', 'plugin-profiles'), { recursive: true });
	writeFileSync(path.join(vaultRoot, '.ratel', 'plugin-profiles', 'calendar-week-start.yaml'), SAMPLE);
	const loaded = await loadAllProfiles({ pluginDir, vaultRoot, homedir, catalogIds: new Set(['calendar']) });
	const tool = createMatchPluginProfilesTool(
		{ name: 'match_plugin_profiles', parameters: { type: 'object', properties: {} } },
		{ getPool: () => loaded.matchPool },
	);
	const r = await tool.execute({ utterance: '周一开始' }) as { hits: Array<{ patchPreview: { weekStart: number } }> };
	expect(r.hits[0]!.patchPreview.weekStart).toBe(1);
});
