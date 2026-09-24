/**
 * @file tests/profiles/skill-profile.test.ts
 * @description 内置技能自带的插件配置能被校验并展开
 * @module profiles/skill-profile.test
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadSkillProfiles } from '../../src/profiles/skill-profile';
import { expandPresetPatch } from '../../src/profiles/expand';

function skillDirWithExampleYaml(): string {
	const dir = mkdtempSync(path.join(tmpdir(), 'ratel-skill-profile-'));
	const yaml = readFileSync('plugin-profiles/calendar-week-start.yaml', 'utf-8');
	writeFileSync(path.join(dir, 'calendar-week-start.yaml'), yaml);
	return dir;
}

describe('技能目录里的插件配置', () => {
	it('loadSkillProfiles - 正式 YAML - 通过校验', () => {
		const loaded = loadSkillProfiles(skillDirWithExampleYaml());
		expect(loaded.errors).toEqual([]);
		expect(loaded.active.map((hit) => hit.profile.id)).toEqual(['calendar-week-start']);
		expect(loaded.active[0]?.profile.pluginId).toBe('calendar');
	});

	it('expandPresetPatch - week-start-monday - 只交出 weekStart', () => {
		const loaded = loadSkillProfiles(skillDirWithExampleYaml());
		const profile = loaded.active[0]?.profile;
		const preset = profile?.presets.find((item) => item.id === 'week-start-monday');
		expect(preset).toBeTruthy();
		const expanded = expandPresetPatch({
			preset: preset!,
			forbid: profile!.forbid,
			existingKeys: ['weekStart'],
		});
		expect(expanded.patch).toEqual({ weekStart: 1 });
		expect(expanded.needsConfirm).toEqual([]);
	});

	it('loadSkillProfiles - 草稿与 enabled false - 不进入可执行列表', () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'ratel-skill-profile-'));
		writeFileSync(path.join(dir, 'demo.draft.yaml'), 'kind: obsidian-plugin-profile\n');
		writeFileSync(
			path.join(dir, 'off.yaml'),
			`kind: obsidian-plugin-profile
id: off-profile
pluginId: calendar
pluginName: Calendar
pluginVersionRange: ">=1.0.0"
enabled: false
install: { source: community-store }
forbid: []
presets:
  - id: default
    when: 待填写
    patch: {}
`,
		);
		const loaded = loadSkillProfiles(dir);
		expect(loaded.active).toEqual([]);
		expect(loaded.errors).toEqual([]);
	});
});
