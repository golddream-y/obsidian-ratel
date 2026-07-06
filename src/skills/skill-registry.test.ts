/**
 * @file src/skills/skill-registry.test.ts
 * @description SkillRegistry 单元测试 — enabled/active 三态 + reload + activate/deactivate
 * @module skills/skill-registry.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SkillRegistry } from './skill-registry';
import { setLang } from '../i18n';
import type { Skill } from './types';

function makeSkill(name: string, opts: Partial<Skill['manifest']> = {}): Skill {
	return {
		manifest: {
			name,
			description: opts.description ?? `desc-${name}`,
			enabled: opts.enabled ?? true,
			activation: opts.activation ?? 'auto',
			tags: opts.tags ?? [],
		},
		instructions: `instructions-${name}`,
		source: 'vault',
		dir: `/vault/${name}`,
	};
}

describe('SkillRegistry', () => {
	let registry: SkillRegistry;
	beforeEach(() => {
		// 关键路径:langStore 全局共享,其他测试可能切到 en;锁定 zh 让 toThrow 正则稳定匹配中文文案。
		setLang('zh');
		registry = new SkillRegistry();
	});

	it('reload - always 类型自动激活', () => {
		const skills = [
			makeSkill('auto-skill', { activation: 'auto' }),
			makeSkill('always-skill', { activation: 'always' }),
			makeSkill('manual-skill', { activation: 'manual' }),
		];
		registry.reload(skills, []);
		expect(registry.getActive().map((s) => s.manifest.name)).toEqual(['always-skill']);
	});

	it('getDiscovered - 排除 manual 与 disabled', () => {
		const skills = [
			makeSkill('auto-skill'),
			makeSkill('manual-skill', { activation: 'manual' }),
			makeSkill('disabled-skill', { enabled: false }),
		];
		registry.reload(skills, []);
		const discovered = registry.getDiscovered().map((s) => s.manifest.name);
		expect(discovered).toEqual(['auto-skill']);
	});

	it('activate - 不存在 - 抛 notFound', () => {
		expect(() => registry.activate('nope')).toThrow(/未找到/);
	});

	it('activate - 已禁用 - 抛 notEnabled', () => {
		registry.reload([makeSkill('x', { enabled: false })], []);
		expect(() => registry.activate('x')).toThrow(/未启用/);
	});

	it('activate - 成功后出现在 getActive', () => {
		registry.reload([makeSkill('x')], []);
		registry.activate('x');
		expect(registry.getActive().map((s) => s.manifest.name)).toContain('x');
	});

	it('deactivate - 未激活 - 抛 notActive', () => {
		registry.reload([makeSkill('x')], []);
		expect(() => registry.deactivate('x')).toThrow(/未激活/);
	});

	it('setEnabled - false 时清掉 active', () => {
		registry.reload([makeSkill('x')], []);
		registry.activate('x');
		registry.setEnabled('x', false);
		expect(registry.getActive()).toHaveLength(0);
		expect(registry.isEnabled('x')).toBe(false);
	});

	it('reload - 保留 enabledOverrides 与清理已不存在的 active', () => {
		registry.reload([makeSkill('x')], []);
		registry.activate('x');
		registry.setEnabled('x', false);
		// reload 后 x 不存在了
		registry.reload([makeSkill('y')], []);
		expect(registry.getActive()).toHaveLength(0);
	});

	it('clearActive - 清空全部激活态', () => {
		registry.reload([makeSkill('x'), makeSkill('y')], []);
		registry.activate('x');
		registry.activate('y');
		registry.clearActive();
		expect(registry.getActive()).toHaveLength(0);
	});
});
