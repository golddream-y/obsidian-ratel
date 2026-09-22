/**
 * @file tests/adapters/plugin-profile-fs.test.ts
 * @description 三源覆盖与诊断
 * @module adapters/plugin-profile-fs.test
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadAllProfiles, syncBuiltinProfiles } from '../../src/adapters/plugin-profile-fs';
import { BUILTIN_CALENDAR_YAML } from '../../src/profiles/builtin';
import { readFileSync } from 'node:fs';

const SAMPLE = `kind: obsidian-plugin-profile
id: calendar-week-start
pluginId: calendar
pluginName: Calendar
pluginVersionRange: ">=1.0.0"
install: { source: community-store }
forbid: [apiKey]
presets:
  - id: week-start-monday
    when: 周一开始
    patch: { weekStart: 1 }
`;

function dirs() {
	const root = mkdtempSync(path.join(tmpdir(), 'ratel-pf-'));
	const pluginDir = path.join(root, 'plugin');
	const vaultRoot = path.join(root, 'vault');
	const homedir = path.join(root, 'home');
	mkdirSync(path.join(pluginDir, 'plugin-profiles'), { recursive: true });
	mkdirSync(path.join(homedir, '.ratel', 'plugin-profiles'), { recursive: true });
	mkdirSync(path.join(vaultRoot, '.ratel', 'plugin-profiles'), { recursive: true });
	return { pluginDir, vaultRoot, homedir };
}

describe('loadAllProfiles', () => {
	it('同 id - vault 覆盖 global 覆盖 builtin', async () => {
		const d = dirs();
		writeFileSync(path.join(d.pluginDir, 'plugin-profiles', 'calendar-week-start.yaml'), SAMPLE);
		writeFileSync(path.join(d.homedir, '.ratel', 'plugin-profiles', 'calendar-week-start.yaml'), SAMPLE.replace('pluginName: Calendar', 'pluginName: G'));
		writeFileSync(path.join(d.vaultRoot, '.ratel', 'plugin-profiles', 'calendar-week-start.yaml'), SAMPLE.replace('pluginName: Calendar', 'pluginName: V'));
		const r = await loadAllProfiles({ ...d, catalogIds: new Set(['calendar']) });
		expect(r.loaded).toBe(1);
		expect(r.get('calendar-week-start')?.pluginName).toBe('V');
	});
	it('同源两文件同 id - 按文件名排序丢后者并 idCollision', async () => {
		const d = dirs();
		writeFileSync(path.join(d.vaultRoot, '.ratel', 'plugin-profiles', 'a-calendar-week-start.yaml'), SAMPLE);
		writeFileSync(path.join(d.vaultRoot, '.ratel', 'plugin-profiles', 'z-calendar-week-start.yaml'), SAMPLE);
		const r = await loadAllProfiles({ ...d, catalogIds: new Set(['calendar']) });
		expect(r.diagnostics.some((x) => x.code === 'idCollision')).toBe(true);
		expect(r.loaded).toBe(1);
	});
	it('坏 YAML - parseError 不拖垮其它', async () => {
		const d = dirs();
		writeFileSync(path.join(d.vaultRoot, '.ratel', 'plugin-profiles', 'calendar-week-start.yaml'), SAMPLE);
		writeFileSync(path.join(d.vaultRoot, '.ratel', 'plugin-profiles', 'bad.yaml'), ': : not yaml');
		const r = await loadAllProfiles({ ...d, catalogIds: new Set(['calendar']) });
		expect(r.loaded).toBe(1);
		expect(r.diagnostics.some((x) => x.code === 'parseError')).toBe(true);
	});
	it('draft 文件 - 不进 match 池', async () => {
		const d = dirs();
		writeFileSync(path.join(d.vaultRoot, '.ratel', 'plugin-profiles', 'calendar-week-start.draft.yaml'), SAMPLE);
		const r = await loadAllProfiles({ ...d, catalogIds: new Set(['calendar']) });
		expect(r.matchPool).toHaveLength(0);
		expect(r.diagnostics.some((x) => x.code === 'draftSkipped')).toBe(true);
	});
	it('unknownPluginId - 清单无此 id 不进 match', async () => {
		const d = dirs();
		writeFileSync(path.join(d.vaultRoot, '.ratel', 'plugin-profiles', 'calendar-week-start.yaml'), SAMPLE.replace('pluginId: calendar', 'pluginId: nope'));
		const r = await loadAllProfiles({ ...d, catalogIds: new Set(['calendar']) });
		expect(r.matchPool).toHaveLength(0);
		expect(r.diagnostics.some((x) => x.code === 'unknownPluginId')).toBe(true);
	});
	it('unverifiedStoreId - 清单 null 仍可 match', async () => {
		const d = dirs();
		writeFileSync(path.join(d.vaultRoot, '.ratel', 'plugin-profiles', 'calendar-week-start.yaml'), SAMPLE);
		const r = await loadAllProfiles({ ...d, catalogIds: null });
		expect(r.matchPool).toHaveLength(1);
		expect(r.diagnostics.some((x) => x.code === 'unverifiedStoreId')).toBe(true);
	});
});

describe('syncBuiltinProfiles', () => {
	it('缺省写入 calendar YAML 且与常量一致', () => {
		const d = dirs();
		syncBuiltinProfiles(d.pluginDir);
		const onDisk = readFileSync(path.join(d.pluginDir, 'plugin-profiles', 'calendar-week-start.yaml'), 'utf-8');
		expect(onDisk).toBe(BUILTIN_CALENDAR_YAML);
		expect(readFileSync('plugin-profiles/calendar-week-start.yaml', 'utf-8').replace(/\r\n/g, '\n').trim()).toBe(BUILTIN_CALENDAR_YAML.trim());
	});
});
