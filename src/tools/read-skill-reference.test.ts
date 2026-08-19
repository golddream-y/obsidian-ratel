/**
 * @file src/tools/read-skill-reference.test.ts
 * @description read_skill_reference 工具测试 — traversal 防护 / 大小上限 / 二进制拒绝 / 启用校验
 * @module tools/read-skill-reference.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setLang } from '../i18n';
import { SkillRegistry } from '../skills/skill-registry';
import { createReadSkillReferenceTool } from './read-skill-reference';
import type { ToolDefinition } from '../ports/llm';

const DEF: ToolDefinition = {
	name: 'read_skill_reference',
	// 关键路径:ToolDefinition.description 必填,补占位值满足类型(plan 原代码缺失)
	description: 'read skill reference test',
	parameters: { type: 'object', properties: {}, required: [] },
};

function makeRegistry(dir: string): SkillRegistry {
	const registry = new SkillRegistry();
	registry.reload(
		[{
			manifest: { name: 'demo', description: 'd', enabled: true, activation: 'auto', tags: [] },
			instructions: 'body',
			source: 'vault',
			dir,
		}],
		[],
	);
	return registry;
}

describe('read_skill_reference 工具', () => {
	let dir: string;
	let registry: SkillRegistry;

	beforeEach(() => {
		// 关键路径:langStore 全局共享,锁定 zh 让 toThrow 正则稳定匹配中文文案。
		setLang('zh');
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-skillref-'));
		fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'references', 'guide.md'), '# Guide\n内容');
		registry = makeRegistry(dir);
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('正常读取 - references 内文件内容返回', async () => {
		const tool = createReadSkillReferenceTool(registry, DEF);
		const out = await tool.execute({ skillName: 'demo', path: 'guide.md' });
		expect(out).toContain('# Guide');
	});

	it('traversal - .. 逃逸出 references 被拒', async () => {
		const secret = path.join(dir, 'SKILL.md');
		fs.writeFileSync(secret, 'secret');
		const tool = createReadSkillReferenceTool(registry, DEF);
		await expect(tool.execute({ skillName: 'demo', path: '../SKILL.md' })).rejects.toThrow(/路径非法/);
	});

	it('traversal - 绝对路径被拒', async () => {
		const tool = createReadSkillReferenceTool(registry, DEF);
		await expect(tool.execute({ skillName: 'demo', path: '/etc/passwd' })).rejects.toThrow(/路径非法/);
	});

	it('文件不存在 - 抛 notFound', async () => {
		const tool = createReadSkillReferenceTool(registry, DEF);
		await expect(tool.execute({ skillName: 'demo', path: 'nope.md' })).rejects.toThrow(/未找到/);
	});

	it('skill 不存在 - 抛 notFound', async () => {
		const tool = createReadSkillReferenceTool(registry, DEF);
		await expect(tool.execute({ skillName: 'ghost', path: 'guide.md' })).rejects.toThrow(/未找到/);
	});

	it('超 100KB - 抛 tooLarge', async () => {
		fs.writeFileSync(path.join(dir, 'references', 'big.md'), 'x'.repeat(101 * 1024));
		const tool = createReadSkillReferenceTool(registry, DEF);
		await expect(tool.execute({ skillName: 'demo', path: 'big.md' })).rejects.toThrow(/100KB/);
	});

	it('二进制文件 - 抛 binary 拒绝', async () => {
		fs.writeFileSync(path.join(dir, 'references', 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
		const tool = createReadSkillReferenceTool(registry, DEF);
		await expect(tool.execute({ skillName: 'demo', path: 'blob.bin' })).rejects.toThrow(/文本/);
	});
});
