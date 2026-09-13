/**
 * @file src/tools/write-skill-draft.test.ts
 * @description write_skill_draft 工具单元测试
 * @module tools/write-skill-draft.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import matter from 'gray-matter';
import { createWriteSkillDraftTool } from './write-skill-draft';
import { setLang } from '../i18n';
import type { ToolDefinition } from '../ports/llm';
import type { VaultPort } from '../ports/vault';

const fakeDef: ToolDefinition = {
	name: 'write_skill_draft',
	description: 'test',
	parameters: {
		type: 'object',
		properties: {
			name: { type: 'string' },
			description: { type: 'string' },
			instructions: { type: 'string' },
		},
		required: ['name', 'description', 'instructions'],
	},
};

function createRecordingVault(initial?: Record<string, string>): {
	vault: VaultPort;
	files: Map<string, string>;
	writePaths: string[];
} {
	const files = new Map<string, string>(Object.entries(initial ?? {}));
	const writePaths: string[] = [];
	const vault: VaultPort = {
		readFile: async (p) => files.get(p) ?? '',
		writeFile: async (p, content) => {
			writePaths.push(p);
			files.set(p, content);
		},
		getBacklinks: () => new Map(),
		getMetadata: () => null,
		getLinks: () => ({ outgoing: [], backlinks: [], unresolved: [] }),
		findByTag: () => [],
		findByProperty: () => [],
		getVaultStructure: () => ({}),
		listMarkdownFiles: () => [],
		stat: () => null,
		cachedRead: async (p) => files.get(p) ?? '',
		appendFile: async () => {},
		trashFile: async () => {},
		trashFolder: async () => {},
		listFiles: async () => ({ files: [], folders: [] }),
		fileExists: async (p) => files.has(p),
		processFile: async (_p, fn) => fn(''),
	};
	return { vault, files, writePaths };
}

const baseArgs = {
	name: 'my-skill',
	description: '测试技能',
	instructions: '# 用法\n\n按步骤操作。',
};

describe('write_skill_draft 工具', () => {
	beforeEach(() => {
		setLang('zh');
	});

	it('非法名 - 抛 invalidName', async () => {
		const { vault } = createRecordingVault();
		const tool = createWriteSkillDraftTool(vault, fakeDef);
		await expect(
			tool.execute({ ...baseArgs, name: 'Bad_Name' }),
		).rejects.toThrow(/名称非法/);
	});

	it('已存在且未 overwrite - 抛 exists', async () => {
		const path = '.ratel/skills/my-skill/SKILL.md';
		const { vault } = createRecordingVault({ [path]: 'old' });
		const tool = createWriteSkillDraftTool(vault, fakeDef);
		await expect(tool.execute(baseArgs)).rejects.toThrow(/已有技能/);
	});

	it('成功写入 - 强制 enabled false 与 activation auto', async () => {
		const { vault, files, writePaths } = createRecordingVault();
		const reloadSkills = vi.fn();
		const tool = createWriteSkillDraftTool(vault, fakeDef, reloadSkills);
		const result = await tool.execute(baseArgs);
		expect(result.path).toBe('.ratel/skills/my-skill/SKILL.md');
		expect(result.created).toBe(true);
		expect(result.ecosystemValidity).toBe('absent');
		expect(writePaths).toEqual(['.ratel/skills/my-skill/SKILL.md']);
		const parsed = matter(files.get(result.path)!);
		expect(parsed.data.enabled).toBe(false);
		expect(parsed.data.activation).toBe('auto');
		expect(parsed.data.name).toBe('my-skill');
		expect(parsed.data.description).toBe('测试技能');
		expect(parsed.content.trim()).toBe('# 用法\n\n按步骤操作。');
		expect(reloadSkills).toHaveBeenCalledOnce();
	});

	it('ratel-vault 依赖 - 拒绝写入', async () => {
		const { vault, files } = createRecordingVault();
		const tool = createWriteSkillDraftTool(vault, fakeDef);
		await expect(
			tool.execute({
				...baseArgs,
				ecosystem: { plugins: [{ pluginId: 'ratel-vault' }] },
			}),
		).rejects.toThrow(/ratel-vault/);
		expect(files.size).toBe(0);
	});

	it('overwrite true - 覆盖已有草稿', async () => {
		const path = '.ratel/skills/my-skill/SKILL.md';
		const { vault, files } = createRecordingVault({ [path]: 'old' });
		const tool = createWriteSkillDraftTool(vault, fakeDef);
		const result = await tool.execute({ ...baseArgs, overwrite: true });
		expect(result.created).toBe(false);
		expect(matter(files.get(path)!).data.enabled).toBe(false);
	});

	it('readOnly 为 false', () => {
		const { vault } = createRecordingVault();
		const tool = createWriteSkillDraftTool(vault, fakeDef);
		expect(tool.readOnly).toBe(false);
	});
});
