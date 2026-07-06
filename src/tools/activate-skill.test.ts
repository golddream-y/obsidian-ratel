/**
 * @file src/tools/activate-skill.test.ts
 * @description activate_skill 工具单元测试
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
		// 关键路径:工具返回值/错误消息走 i18n,锁定 zh 让正则稳定匹配"已激活"/"未找到"。
		setLang('zh');
		registry = new SkillRegistry();
		registry.reload([makeSkill('reviewer')], []);
	});

	it('激活成功 - 返回 activated 消息', async () => {
		const tool = createActivateSkillTool(registry, fakeDef);
		const result = await tool.execute({ name: 'reviewer' });
		expect(result).toContain('已激活');
		expect(registry.getActive().map((s) => s.manifest.name)).toContain('reviewer');
	});

	it('已激活 - 返回 alreadyActive', async () => {
		registry.activate('reviewer');
		const tool = createActivateSkillTool(registry, fakeDef);
		const result = await tool.execute({ name: 'reviewer' });
		expect(result).toContain('已激活');
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
