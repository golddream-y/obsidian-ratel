/**
 * @file tests/skills/skill-activator-ranking.test.ts
 * @description Skill Discovery 相关性排序 + activate_skill instructions 8KB 截断测试(S-SR-LAYERING Task 4)
 * @module tests/skills/skill-activator-ranking
 * @depends skills/skill-registry, skills/skill-activator, tools/activate-skill
 */

import { describe, it, expect } from 'vitest';
import { SkillRegistry } from '../../src/skills/skill-registry';
import { SkillActivator } from '../../src/skills/skill-activator';
import { langStore } from '../../src/i18n';
import type { Skill } from '../../src/skills/types';

/** 最小 Skill 桩 — manifest 必填字段按 src/skills/types.ts 实际接口构造 */
function fakeSkill(name: string, description: string, tags: string[] = []): Skill {
	return {
		manifest: { name, description, enabled: true, activation: 'auto', tags },
		instructions: 'do things',
		dir: `/fake/${name}`,
		source: 'builtin',
	};
}

describe('SkillActivator 相关性排序', () => {
	it('query 命中 tags/description - 相关 skill 排前', () => {
		const registry = new SkillRegistry();
		registry.reload(
			[
				fakeSkill('aaa-writer', '写作技能', []),
				fakeSkill('zzz-daily', '日记与晨间笔记', ['daily-note']),
			],
			[],
		);
		const activator = new SkillActivator(registry);
		const text = activator.composeDiscovery({}, '帮我写今天的 daily note');
		const writerIdx = text.indexOf('aaa-writer');
		const dailyIdx = text.indexOf('zzz-daily');
		expect(dailyIdx).toBeGreaterThanOrEqual(0);
		expect(writerIdx).toBeGreaterThanOrEqual(0);
		expect(dailyIdx).toBeLessThan(writerIdx);
	});

	it('无 query - 按名称字母序稳定排序(非注册序)', () => {
		// 关键路径:注册顺序刻意与字母序相反 — 断言有区分度,防止实现悄悄改成注册序/乱序。
		const registry = new SkillRegistry();
		registry.reload([fakeSkill('zzz-late', 'z', []), fakeSkill('aaa-early', 'a', [])], []);
		const text = new SkillActivator(registry).composeDiscovery({});
		expect(text.indexOf('aaa-early')).toBeLessThan(text.indexOf('zzz-late'));
	});

	it('i18n fallback - locale 命中取 localized,缺失回退顶层', () => {
		const registry = new SkillRegistry();
		const bilingual = fakeSkill('bilingual', 'top-level desc', []);
		// 关键路径:langStore 全局共享,其他测试可能切走 — 显式锁定 zh(先例:skill-registry.test.ts)
		langStore.set('zh');
		// i18nDescription 命中 zh 时优先取 localized
		bilingual.manifest.i18nDescription = { zh: '中文描述' };
		registry.reload([bilingual, fakeSkill('plain', 'fallback desc', [])], []);
		const text = new SkillActivator(registry).composeDiscovery({});
		expect(text).toContain('中文描述');
		expect(text).not.toContain('top-level desc');
		// 缺失 i18nDescription 的 skill 回退顶层 description
		expect(text).toContain('fallback desc');
	});
});

describe('activate_skill instructions 截断', () => {
	it('超 8KB - 截断并加尾注', async () => {
		const registry = new SkillRegistry();
		const big = fakeSkill('big', '大技能');
		big.instructions = 'x'.repeat(9 * 1024);
		registry.reload([big], []);
		const appended: Array<[string, string]> = [];
		const { createActivateSkillTool } = await import('../../src/tools/activate-skill');
		const tool = createActivateSkillTool(
			registry,
			{ name: 'activate_skill', description: '', parameters: { type: 'object', properties: {} } },
			{ hasInSession: () => false, appendToSession: (n, b) => appended.push([n, b]) },
		);
		await tool.execute({ name: 'big' });
		const [, body] = appended[0]!;
		expect(Buffer.byteLength(body, 'utf-8')).toBeLessThanOrEqual(8 * 1024 + 200); // 8KB + 尾注
		expect(body).toContain('SKILL.md');
	});

	it('未超限 - 原样注入无尾注', async () => {
		const registry = new SkillRegistry();
		const small = fakeSkill('small', '小技能');
		small.instructions = 'short';
		registry.reload([small], []);
		const appended: Array<[string, string]> = [];
		const { createActivateSkillTool } = await import('../../src/tools/activate-skill');
		const tool = createActivateSkillTool(
			registry,
			{ name: 'activate_skill', description: '', parameters: { type: 'object', properties: {} } },
			{ hasInSession: () => false, appendToSession: (n, b) => appended.push([n, b]) },
		);
		await tool.execute({ name: 'small' });
		expect(appended[0]![1]).toBe('short');
	});
});
