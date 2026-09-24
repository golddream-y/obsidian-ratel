/**
 * @file src/profiles/skill-profile.ts
 * @description 从 Skill 目录读取自带的插件配置并校验
 * @module profiles/skill-profile
 * @depends profiles/validate, yaml, node:fs
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateProfile } from './validate';
import type { PluginProfile } from './types';

export interface SkillProfileHit {
	file: string;
	profile: PluginProfile;
}

export interface SkillProfileLoad {
	active: SkillProfileHit[];
	errors: Array<{ file: string; errors: string[] }>;
}

/**
 * 读取一个 Skill 目录里可执行的插件配置。
 *
 * 正式文件与 `SKILL.md` 同目录。`.draft.yaml` 和 `enabled: false` 只属于创作，不进入 active。
 *
 * @param skillDir - Skill 目录绝对路径
 * @returns 通过校验且启用的配置，以及校验失败的文件
 */
export function loadSkillProfiles(skillDir: string): SkillProfileLoad {
	const active: SkillProfileHit[] = [];
	const errors: Array<{ file: string; errors: string[] }> = [];
	if (!fs.existsSync(skillDir)) return { active, errors };

	for (const file of fs.readdirSync(skillDir)) {
		if (!isProfileFile(file)) continue;
		const full = path.join(skillDir, file);
		let raw: unknown;
		try {
			const text = fs.readFileSync(full, 'utf-8');
			raw = file.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
		} catch {
			errors.push({ file, errors: ['parse'] });
			continue;
		}
		const result = validateProfile(raw);
		if (!result.ok) {
			errors.push({ file, errors: result.errors });
			continue;
		}
		if (result.profile.enabled === false) continue;
		active.push({ file, profile: result.profile });
	}
	return { active, errors };
}

/**
 * 正式配置文件名。草稿与说明文件不算。
 *
 * @param file - 目录内文件名
 * @returns 是否应尝试当作插件配置解析
 */
function isProfileFile(file: string): boolean {
	if (file.endsWith('.draft.yaml') || file.endsWith('.draft.yml') || file.endsWith('.draft.json')) {
		return false;
	}
	return file.endsWith('.yaml') || file.endsWith('.yml') || file.endsWith('.json');
}
