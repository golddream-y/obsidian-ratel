/**
 * @file tests/profiles/skill-profile.test.ts
 * @description 内置技能自带的插件配置能被校验并展开
 * @module profiles/skill-profile.test
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadSkillProfiles } from '../../src/profiles/skill-profile';
import { expandPresetPatch } from '../../src/profiles/expand';

const skillDir = path.join('src/skills/builtin/calendar-week-start');

describe('内置 Calendar 技能', () => {
	it('loadSkillProfiles - 技能目录内的正式 YAML - 通过校验且草稿不执行', () => {
		const loaded = loadSkillProfiles(skillDir);
		expect(loaded.errors).toEqual([]);
		expect(loaded.active.map((hit) => hit.profile.id)).toEqual(['calendar-week-start']);
		expect(loaded.active[0]?.profile.pluginId).toBe('calendar');
	});

	it('expandPresetPatch - week-start-monday - 只交出 weekStart', () => {
		const loaded = loadSkillProfiles(skillDir);
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

	it('技能正文 - 指向同目录契约与 configure_plugin', () => {
		const skill = readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
		const yamlText = readFileSync(path.join(skillDir, 'calendar-week-start.yaml'), 'utf-8');
		const raw = parseYaml(yamlText) as { presets: Array<{ id: string; patch: { weekStart: number } }> };
		expect(skill).toContain('configure_plugin');
		expect(skill).toContain('read_skill_reference');
		expect(skill).not.toContain('calendar-week-start.yaml');
		expect(raw.presets[0]?.patch.weekStart).toBe(1);
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
