/**
 * @file src/skills/skill-name.ts
 * @description Skill 名称合法正则 — loader 与写草稿共用,禁止两处各写一份
 * @module skills/skill-name
 */

/** Skill name 合法正则(S-SCENE-ECO / 既有 loader):全小写字母数字 + 连字符,首字母必须字母,长度 1-64。 */
export const SKILL_NAME_REGEX = /^[a-z][a-z0-9-]{0,63}$/;

export function isSkillName(value: string): boolean {
	return SKILL_NAME_REGEX.test(value);
}
