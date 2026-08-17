/**
 * @file src/skills/skill-activator.test.ts
 * @description SkillActivator 单元测试 — composeDiscovery
 * @module skills/skill-activator.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SkillActivator } from './skill-activator';
import { SkillRegistry } from './skill-registry';
import { setLang } from '../i18n';
import type { Skill } from './types';

function makeSkill(name: string, instructions: string, opts: Partial<Skill['manifest']> = {}): Skill {
	return {
		manifest: {
			name,
			description: opts.description ?? `desc-${name}`,
			enabled: opts.enabled ?? true,
			activation: opts.activation ?? 'auto',
			tags: opts.tags ?? [],
		},
		instructions,
		source: 'vault',
		dir: `/vault/${name}`,
	};
}

describe('SkillActivator', () => {
	let registry: SkillRegistry;
	let activator: SkillActivator;
	beforeEach(() => {
		// 关键路径:Discovery 模板按当前语言解析,锁定 zh 让输出稳定。
		setLang('zh');
		registry = new SkillRegistry();
		activator = new SkillActivator(registry);
	});

	it('composeDiscovery - 无 skill - 返回空串', () => {
		registry.reload([], []);
		expect(activator.composeDiscovery({})).toBe('');
	});

	it('composeDiscovery - 含 name 与 description', () => {
		registry.reload([makeSkill('reviewer', '', { description: '审查代码' })], []);
		const text = activator.composeDiscovery({});
		expect(text).toContain('reviewer');
		expect(text).toContain('审查代码');
	});

	it('composeDiscovery - 排除 manual skill', () => {
		registry.reload([
			makeSkill('auto', '', { activation: 'auto' }),
			makeSkill('manual', '', { activation: 'manual' }),
		], []);
		const text = activator.composeDiscovery({});
		expect(text).toContain('auto');
		expect(text).not.toContain('manual');
	});
});
