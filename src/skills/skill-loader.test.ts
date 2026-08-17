/**
 * @file src/skills/skill-loader.test.ts
 * @description SkillLoader 单元测试 — 三源扫描 + frontmatter 解析 + 同名合并
 * @module skills/skill-loader.test
 */

import { describe, it, expect } from 'vitest';
import { SkillLoader } from './skill-loader';
import type { SkillPort } from '../ports/skill-port';
import type { SkillSource } from './types';

// 关键路径:用内存 mock SkillPort,避免触碰真实 fs。
class MockSkillPort implements SkillPort {
	constructor(
		readonly source: SkillSource,
		readonly rootDir: string,
		private skills: Record<string, string>, // name → SKILL.md 全文
	) {}
	async listSkillFolders(): Promise<string[]> {
		return Object.keys(this.skills);
	}
	async readSkillManifest(skillName: string): Promise<string> {
		const content = this.skills[skillName];
		if (!content) throw new Error(`not found: ${skillName}`);
		return content;
	}
}

/**
 * 构造只含单个 skill 的单端口 stub(复用 MockSkillPort)。
 */
function makePortWithSkill(name: string, skillMd: string): SkillPort {
	return new MockSkillPort('vault', '/vault', { [name]: skillMd });
}

describe('SkillLoader', () => {
	it('loadAll - 三源合并 - vault 覆盖 global 与 builtin 同名', async () => {
		const builtin = new MockSkillPort('builtin', '/builtin', {
			'reviewer': `---
name: reviewer
description: builtin reviewer
---
builtin instructions`,
		});
		const global = new MockSkillPort('global', '/global', {
			'reviewer': `---
name: reviewer
description: global reviewer
---
global instructions`,
		});
		const vault = new MockSkillPort('vault', '/vault', {
			'reviewer': `---
name: reviewer
description: vault reviewer
---
vault instructions`,
		});
		const loader = new SkillLoader([builtin, global, vault]);
		const { skills, warnings } = await loader.loadAll();
		expect(warnings).toHaveLength(0);
		expect(skills).toHaveLength(1);
		expect(skills[0]!.manifest.description).toBe('vault reviewer');
		expect(skills[0]!.instructions).toBe('vault instructions');
		expect(skills[0]!.source).toBe('vault');
	});

	it('loadAll - name 非法 - 跳过并记 warning', async () => {
		const port = new MockSkillPort('vault', '/vault', {
			'BadName': `---
name: BadName
description: 非法大写
---
x`,
		});
		const loader = new SkillLoader([port]);
		const { skills, warnings } = await loader.loadAll();
		expect(skills).toHaveLength(0);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]!.message).toContain('name 非法');
	});

	it('loadAll - description 为空 - 跳过', async () => {
		const port = new MockSkillPort('vault', '/vault', {
			'empty-desc': `---
name: empty-desc
description: ""
---
x`,
		});
		const loader = new SkillLoader([port]);
		const { skills, warnings } = await loader.loadAll();
		expect(skills).toHaveLength(0);
		expect(warnings[0]!.message).toContain('description 为空');
	});

	it('loadAll - activation 非法值 - 降级 auto', async () => {
		const port = new MockSkillPort('vault', '/vault', {
			'my-skill': `---
name: my-skill
description: test
activation: invalid
---
x`,
		});
		const loader = new SkillLoader([port]);
		const { skills, warnings } = await loader.loadAll();
		expect(skills).toHaveLength(1);
		expect(skills[0]!.manifest.activation).toBe('auto');
		expect(warnings[0]!.message).toContain('activation 非法值');
	});

	it('normalizeActivation - always 已废弃 - 降级 auto 并记 warning', async () => {
		const port = makePortWithSkill(
			'legacy-skill',
			`---
name: legacy-skill
description: 测试 always 废弃
activation: always
---
正文`,
		);
		const loader = new SkillLoader([port]);
		const { skills, warnings } = await loader.loadAll();
		expect(skills[0]?.manifest.activation).toBe('auto');
		expect(warnings.some((w) => w.message.includes('always'))).toBe(true);
	});

	it('loadAll - enabled 缺省 - 默认 true', async () => {
		const port = new MockSkillPort('vault', '/vault', {
			'my-skill': `---
name: my-skill
description: test
---
x`,
		});
		const loader = new SkillLoader([port]);
		const { skills } = await loader.loadAll();
		expect(skills[0]!.manifest.enabled).toBe(true);
	});

	it('loadAll - i18n.description 嵌套对象 - 解析成功', async () => {
		const port = new MockSkillPort('vault', '/vault', {
			'my-skill': `---
name: my-skill
description: default desc
i18n:
  description:
    zh: 中文描述
    en: English desc
---
x`,
		});
		const loader = new SkillLoader([port]);
		const { skills } = await loader.loadAll();
		expect(skills[0]!.manifest.i18nDescription).toEqual({
			zh: '中文描述',
			en: 'English desc',
		});
	});

	it('loadAll - 文件读取失败 - 记 warning 不阻塞其他', async () => {
		const port = new MockSkillPort('vault', '/vault', {
			'good': `---
name: good
description: ok
---
x`,
			'bad': 'corrupted content without frontmatter',
		});
		// 关键路径:gray-matter 对无 frontmatter 的文件解析为空 data + content=原文,不会抛错。
		// 这里改 mock 让 readSkillManifest 抛错模拟 fs 失败。
		const failingPort: SkillPort = {
			source: 'vault',
			rootDir: '/vault',
			listSkillFolders: async () => ['bad', 'good'],
			readSkillManifest: async (name: string) => {
				if (name === 'bad') throw new Error('fs error');
				return port.readSkillManifest(name);
			},
		};
		const loader = new SkillLoader([failingPort]);
		const { skills, warnings } = await loader.loadAll();
		expect(skills).toHaveLength(1);
		expect(skills[0]!.manifest.name).toBe('good');
		expect(warnings.some((w) => w.message.includes('fs error'))).toBe(true);
	});
});
