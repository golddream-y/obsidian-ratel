/**
 * @file src/tools/deactivate-skill.test.ts
 * @description deactivate_skill 工具单元测试
 * @module tools/deactivate-skill.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDeactivateSkillTool } from './deactivate-skill';
import { SkillRegistry } from '../skills/skill-registry';
import { setLang } from '../i18n';
import type { ToolDefinition } from '../ports/llm';
import type { Skill } from '../skills/types';

const fakeDef: ToolDefinition = {
	name: 'deactivate_skill',
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

describe('deactivate_skill 工具', () => {
	let registry: SkillRegistry;
	beforeEach(() => {
		// 关键路径:工具返回值/错误消息走 i18n,锁定 zh 让正则稳定匹配"已停用"/"未在使用"。
		setLang('zh');
		registry = new SkillRegistry();
		registry.reload([makeSkill('reviewer')], []);
	});

	it('反激活成功 - 有 session hooks 时写 supersede', async () => {
		const superseded: string[] = [];
		const tool = createDeactivateSkillTool(registry, fakeDef, {
			hasInSession: () => true,
			appendToSession: () => {},
			supersedeInSession: (name) => superseded.push(name),
		});
		registry.activate('reviewer');
		const result = await tool.execute({ name: 'reviewer' });
		expect(result).toContain('已停用');
		expect(superseded).toEqual(['reviewer']);
		expect(registry.getActive()).toHaveLength(0);
	});

	it('未在使用 - 抛 notActive', async () => {
		const tool = createDeactivateSkillTool(registry, fakeDef);
		await expect(tool.execute({ name: 'reviewer' })).rejects.toThrow(/未在使用/);
	});

	it('session hooks 未注入 - 抛 notActive', async () => {
		const tool = createDeactivateSkillTool(registry, fakeDef, {
			hasInSession: () => false,
			appendToSession: () => {},
			supersedeInSession: () => {},
		});
		await expect(tool.execute({ name: 'reviewer' })).rejects.toThrow(/未在使用/);
	});

	it('name 缺失 - 抛 invalidArg', async () => {
		const tool = createDeactivateSkillTool(registry, fakeDef);
		await expect(tool.execute({})).rejects.toThrow(/name/);
	});

	it('readOnly 标记为 true', () => {
		const tool = createDeactivateSkillTool(registry, fakeDef);
		expect(tool.readOnly).toBe(true);
	});
});
