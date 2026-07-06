/**
 * @file src/ports/skill-port.ts
 * @description SkillPort — Skill 文件系统访问端口(零实现,符合端口/适配器架构)
 * @module ports/skill-port
 * @depends skills/types
 */

import type { SkillSource } from '../skills/types';

/**
 * Skill 文件系统访问端口。
 *
 * 设计要点:
 * - 端口只定义契约,实现由 `adapters/skill-vault.ts`(ObsidianVault 外观)
 *   与 `adapters/skill-fs.ts`(node:fs)提供。
 * - 每个适配器实例绑定一个根目录(builtin pluginDir/skills,global ~/.ratel/skills,
 *   vault vaultRoot/.ratel/skills),构造时注入,运行时不可变。
 * - 所有路径在适配器内部做 path traversal 校验(spec §4.3 安全约束)。
 *
 * 关键路径:Loader 通过 SkillPort 抽象访问三源,不直接 import fs 或 ObsidianVault,
 * 保证 loader 可单测(mock SkillPort)。
 */
export interface SkillPort {
	/** 此端口绑定的来源标识 */
	readonly source: SkillSource;
	/** 此端口绑定的根目录绝对路径 */
	readonly rootDir: string;
	/**
	 * 列出根目录下所有 skill 文件夹名(不含路径,仅文件夹名)。
	 *
	 * 关键路径:只返回直接子文件夹(非递归),且文件夹内必须含 SKILL.md
	 * (不含 SKILL.md 的文件夹跳过,记 warning)。
	 */
	listSkillFolders(): Promise<string[]>;
	/**
	 * 读取指定 skill 的 SKILL.md 全文(frontmatter + 正文)。
	 *
	 * @param skillName - skill 文件夹名(kebab-case)
	 * @returns SKILL.md 全文;文件不存在时抛错
	 */
	readSkillManifest(skillName: string): Promise<string>;
}
