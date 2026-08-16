/**
 * @file src/types/builtin-skills.d.ts
 * @description esbuild 虚拟模块 @ratel/builtin-skills-code 的类型声明(内容由 esbuild.config.mjs 的 inlineBuiltinSkillsPlugin 构建期生成:src/skills/builtin 下各 skill 目录的 SKILL.md 清单 + manifest.json version)
 * @module types/builtin-skills
 */

declare module '@ratel/builtin-skills-code' {
	/** 内置 skill 清单 — skill 目录名 → SKILL.md 原文 */
	export const BUILTIN_SKILLS: Record<string, string>;
	/** 应用版本(manifest.json 的 version,启动落盘时注入 frontmatter) */
	export const APP_VERSION: string;
}
