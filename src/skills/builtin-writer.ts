/**
 * @file src/skills/builtin-writer.ts
 * @description 内置 Skill 幂等写出 — 把构建期内联的 SKILL.md 落到 pluginDir/skills/
 * @module skills/builtin-writer
 * @depends gray-matter, node:fs, node:path, logging/dev-logger
 */

import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { devLogger } from '../logging/dev-logger';

/**
 * 同步内置 skill 到磁盘(幂等,按 version 判断是否重写)。
 *
 * 设计要点:
 * - 目录契约:SkillFsAdapter 只扫 skills/ 的直接子目录且必须含 SKILL.md,
 *   写出路径 <skillsDir>/<目录名>/SKILL.md 与之严格对齐。
 * - 幂等判断:落盘全文与本次要写的内容一致则零写入。
 *   同一应用版本里正文有改动也会重写,否则内置技能说明升级不出去。
 * - 单个 skill 写出失败 try/catch + warn,不阻塞其余 skill 与插件启动。
 *
 * @param skillsDir - pluginDir/skills
 * @param builtinSkills - skill 目录名 → SKILL.md 原文(来自构建期内联清单)
 * @param appVersion - manifest.json 的 version,写进 frontmatter
 * @param profiles - skill 目录名 → 同目录配置文件名 → 原文。与 SKILL.md 一起落盘
 * @returns written=本次写出的目录名;skipped=已同版本跳过的
 * @example
 *   const { written, skipped } = syncBuiltinSkills(skillsDir, BUILTIN_SKILLS, APP_VERSION, BUILTIN_SKILL_PROFILES);
 */
export function syncBuiltinSkills(
	skillsDir: string,
	builtinSkills: Record<string, string>,
	appVersion: string,
	profiles: Record<string, Record<string, string>> = {},
): { written: string[]; skipped: string[] } {
	const written: string[] = [];
	const skipped: string[] = [];

	for (const [name, raw] of Object.entries(builtinSkills)) {
		const skillDir = path.join(skillsDir, name);
		const skillMdPath = path.join(skillDir, 'SKILL.md');
		try {
			// 关键路径:全文一致才跳过。只比 version 会把同一版本里改过的说明留在磁盘上。
			const next = withVersionFrontmatter(raw, appVersion);
			if (fs.existsSync(skillMdPath) && fs.readFileSync(skillMdPath, 'utf-8') === next) {
				skipped.push(name);
			} else {
				fs.mkdirSync(skillDir, { recursive: true });
				fs.writeFileSync(skillMdPath, next);
				written.push(name);
			}
		} catch (err) {
			// 关键路径:写出失败不阻塞启动,skill 只是不能覆盖升级,vault/global 源照常加载
			devLogger.warn('skill', `内置 skill 写出失败: ${name}`, err);
			continue;
		}
		// 配置文件与 SKILL.md 同目录。版本未变时仍补齐或刷新契约，避免只升级 YAML 时被跳过。
		try {
			writeProfileFiles(skillDir, profiles[name]);
		} catch (err) {
			devLogger.warn('skill', `内置 skill 配置写出失败: ${name}`, err);
		}
	}
	return { written, skipped };
}

/**
 * 把技能自带的配置写到技能目录。文件名只允许当前目录下的基名。
 *
 * @param skillDir - 已存在或即将创建的技能目录
 * @param files - 文件名 → 原文
 */
function writeProfileFiles(skillDir: string, files: Record<string, string> | undefined): void {
	if (!files) return;
	fs.mkdirSync(skillDir, { recursive: true });
	for (const [fileName, content] of Object.entries(files)) {
		if (!isProfileBasename(fileName)) continue;
		const target = path.join(skillDir, fileName);
		if (fs.existsSync(target) && fs.readFileSync(target, 'utf-8') === content) continue;
		fs.writeFileSync(target, content);
	}
}

/**
 * 拒绝路径穿越。只接受当前目录下的配置文件名。
 *
 * @param fileName - 调用方给出的文件名
 * @returns 是否可安全落盘
 */
function isProfileBasename(fileName: string): boolean {
	return fileName.length > 0 && !fileName.includes('/') && !fileName.includes('\\') && !fileName.includes('..');
}

/**
 * 把 version 写进(或覆盖进)frontmatter,正文原样保留。
 *
 * @param raw - SKILL.md 原文(源文件 frontmatter 不含 version)
 * @param appVersion - 强制写入的应用版本号
 * @returns 重建后的完整 SKILL.md 文本
 */
function withVersionFrontmatter(raw: string, appVersion: string): string {
	const parsed = matter(raw);
	// 修复:必须用顶层 matter.stringify(file, data) 而非实例方法 parsed.stringify —
	// gray-matter 的模块级缓存命中时返回浅拷贝,不可枚举的实例 stringify 方法会丢失(变 undefined 抛 TypeError)。
	// 顶层签名 stringify(file, data) 直接进 lib/stringify,内部 Object.assign({}, file.data, data),
	// 数据键原样 + version 强制当前版本。
	return matter.stringify(parsed, { ...parsed.data, version: appVersion });
}
