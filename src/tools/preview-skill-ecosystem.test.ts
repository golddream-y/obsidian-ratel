/**
 * @file src/tools/preview-skill-ecosystem.test.ts
 * @description preview_skill_ecosystem 工具单元测试
 * @module tools/preview-skill-ecosystem.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createPreviewSkillEcosystemTool } from './preview-skill-ecosystem';
import { SkillRegistry } from '../skills/skill-registry';
import { setLang } from '../i18n';
import type { ToolDefinition } from '../ports/llm';
import type { ParsedSkillEcosystem, PluginPresence } from '../skills/ecosystem-types';
import type { Skill } from '../skills/types';

const fakeDef: ToolDefinition = {
	name: 'preview_skill_ecosystem',
	description: 'test',
	parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
};

function makeSkill(name: string, ecosystem: ParsedSkillEcosystem): Skill {
	return {
		manifest: {
			name,
			description: `desc-${name}`,
			enabled: true,
			activation: 'auto' as const,
			tags: [],
			ecosystem,
		},
		instructions: `instr-${name}`,
		source: 'vault',
		dir: `/vault/${name}`,
	};
}

const validEcosystem: ParsedSkillEcosystem = {
	validity: 'valid',
	value: {
		plugins: [{ pluginId: 'dataview', required: true }],
		ratel: [{ key: 'dailyNoteFolder' }],
		vaultFiles: [{ dest: 'T/D.md', source: 'skill://scene-valid/t.md', sourceRel: 't.md' }],
	},
	issues: [],
};

const invalidEcosystem: ParsedSkillEcosystem = {
	validity: 'invalid',
	value: {
		plugins: [],
		ratel: [{ key: 'badKey' }],
		vaultFiles: [],
	},
	issues: [{ code: 'ratelKeyUnknown', detail: 'ratel.key 不在白名单: badKey' }],
};

const absentEcosystem: ParsedSkillEcosystem = { validity: 'absent', issues: [] };

function mockPresence(enabled: string[], installed: string[] = []): PluginPresence {
	const enabledSet = new Set(enabled);
	const installedSet = new Set(installed);
	return {
		listEnabled: async () => [...enabledSet],
		isInstalled: async (pluginId) => installedSet.has(pluginId),
	};
}

describe('preview_skill_ecosystem 工具', () => {
	let registry: SkillRegistry;

	beforeEach(() => {
		setLang('zh');
		registry = new SkillRegistry();
		registry.reload(
			[
				makeSkill('scene-valid', validEcosystem),
				makeSkill('scene-invalid', invalidEcosystem),
				makeSkill('scene-absent', absentEcosystem),
			],
			[],
		);
	});

	it('valid skill - 返回 applyReady 为 true 的预览', async () => {
		const tool = createPreviewSkillEcosystemTool(registry, fakeDef);
		const result = await tool.execute({ name: 'scene-valid' });
		expect(result.skillName).toBe('scene-valid');
		expect(result.validity).toBe('valid');
		expect(result.applyReady).toBe(true);
		expect(result.plugins).toEqual([
			{ pluginId: 'dataview', required: true, presence: 'unknown' },
		]);
		expect(result.ratel).toEqual([{ key: 'dailyNoteFolder' }]);
	});

	it('invalid skill - applyReady 为 false 且 issues 为用户语言', async () => {
		const tool = createPreviewSkillEcosystemTool(registry, fakeDef);
		const result = await tool.execute({ name: 'scene-invalid' });
		expect(result.applyReady).toBe(false);
		expect(result.validity).toBe('invalid');
		expect(result.issues[0].code).toBe('ratelKeyUnknown');
		expect(result.issues[0].message).toContain('badKey');
		expect(result.issues[0].message).toMatch(/白名单/);
	});

	it('absent skill - 空依赖且 applyReady 为 false', async () => {
		const tool = createPreviewSkillEcosystemTool(registry, fakeDef);
		const result = await tool.execute({ name: 'scene-absent' });
		expect(result.validity).toBe('absent');
		expect(result.plugins).toEqual([]);
		expect(result.ratel).toEqual([]);
		expect(result.vaultFiles).toEqual([]);
		expect(result.applyReady).toBe(false);
	});

	it('presence 注入 - 插件在场状态正确', async () => {
		const tool = createPreviewSkillEcosystemTool(registry, fakeDef, mockPresence(['dataview']));
		const result = await tool.execute({ name: 'scene-valid' });
		expect(result.plugins[0].presence).toBe('enabled');
	});

	it('不存在 - 抛 notFound', async () => {
		const tool = createPreviewSkillEcosystemTool(registry, fakeDef);
		await expect(tool.execute({ name: 'nope' })).rejects.toThrow(/未找到/);
	});

	it('name 缺失 - 抛 invalidArg', async () => {
		const tool = createPreviewSkillEcosystemTool(registry, fakeDef);
		await expect(tool.execute({})).rejects.toThrow(/name/);
	});

	it('readOnly 标记为 true', () => {
		const tool = createPreviewSkillEcosystemTool(registry, fakeDef);
		expect(tool.readOnly).toBe(true);
	});
});
