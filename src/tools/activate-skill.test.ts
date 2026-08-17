/**
 * @file src/tools/activate-skill.test.ts
 * @description activate_skill 工具单元测试(含 ADR-012 session hooks)
 * @module tools/activate-skill.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createActivateSkillTool } from './activate-skill';
import { SkillRegistry } from '../skills/skill-registry';
import { setLang } from '../i18n';
import type { ToolDefinition } from '../ports/llm';
import type { Skill } from '../skills/types';

const fakeDef: ToolDefinition = {
	name: 'activate_skill',
	description: 'test',
	parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
};

function makeSkill(name: string): Skill {
	return {
		manifest: { name, description: `desc-${name}`, enabled: true, activation: 'auto' as const, tags: [] },
		instructions: `instr-${name}`,
		source: 'vault',
		dir: `/vault/${name}`,
	};
}

describe('activate_skill 工具', () => {
	let registry: SkillRegistry;
	beforeEach(() => {
		setLang('zh');
		registry = new SkillRegistry();
		registry.reload([makeSkill('reviewer')], []);
	});

	it('激活成功 - 返回 activated 并写入 session hooks', async () => {
		const injected: string[] = [];
		const tool = createActivateSkillTool(registry, fakeDef, {
			hasInSession: () => false,
			appendToSession: (name, body) => {
				injected.push(`${name}:${body}`);
			},
		});
		const result = await tool.execute({ name: 'reviewer' });
		expect(result).toContain('已使用技能');
		expect(injected).toEqual(['reviewer:instr-reviewer']);
		expect(registry.getActive().map((s) => s.manifest.name)).toContain('reviewer');
	});

	it('会话已注入 - 返回 alreadyActive 且不再 append', async () => {
		let appendCount = 0;
		const tool = createActivateSkillTool(registry, fakeDef, {
			hasInSession: (name) => name === 'reviewer',
			appendToSession: () => {
				appendCount += 1;
			},
		});
		const result = await tool.execute({ name: 'reviewer' });
		// S-SKILL-UX:已注入会话时话术为「已在当前会话生效」,不再出现「激活」。
		expect(result).toMatch(/已在当前会话生效/);
		expect(appendCount).toBe(0);
	});

	it('不存在 - 抛 notFound', async () => {
		const tool = createActivateSkillTool(registry, fakeDef);
		await expect(tool.execute({ name: 'nope' })).rejects.toThrow(/未找到/);
	});

	it('name 缺失 - 抛 invalidArg', async () => {
		const tool = createActivateSkillTool(registry, fakeDef);
		await expect(tool.execute({})).rejects.toThrow(/name/);
	});

	it('readOnly 标记为 true', () => {
		const tool = createActivateSkillTool(registry, fakeDef);
		expect(tool.readOnly).toBe(true);
	});
});
