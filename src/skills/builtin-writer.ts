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
 * - 幂等判断:磁盘 SKILL.md frontmatter version == appVersion 则零写入;
 *   不存在 / 无 version / 版本不同一律重写(升级自动刷新)。
 * - 单个 skill 写出失败 try/catch + warn,不阻塞其余 skill 与插件启动。
 *
 * @param skillsDir - pluginDir/skills
 * @param builtinSkills - skill 目录名 → SKILL.md 原文(来自构建期内联清单)
 * @param appVersion - manifest.json 的 version,写进 frontmatter
 * @returns written=本次写出的目录名;skipped=已同版本跳过的
 * @example
 *   const { written, skipped } = syncBuiltinSkills(skillsDir, BUILTIN_SKILLS, APP_VERSION);
 */
export function syncBuiltinSkills(
	skillsDir: string,
	builtinSkills: Record<string, string>,
	appVersion: string,
): { written: string[]; skipped: string[] } {
	const written: string[] = [];
	const skipped: string[] = [];

	for (const [name, raw] of Object.entries(builtinSkills)) {
		const skillDir = path.join(skillsDir, name);
		const skillMdPath = path.join(skillDir, 'SKILL.md');
		try {
			// 关键路径:幂等判断 — 磁盘版本与当前应用版本一致则零写入
			if (fs.existsSync(skillMdPath)) {
				const diskVersion = extractVersion(fs.readFileSync(skillMdPath, 'utf-8'));
				if (diskVersion === appVersion) {
					skipped.push(name);
					continue;
				}
			}
			fs.mkdirSync(skillDir, { recursive: true });
			fs.writeFileSync(skillMdPath, withVersionFrontmatter(raw, appVersion));
			written.push(name);
		} catch (err) {
			// 关键路径:写出失败不阻塞启动,skill 只是不能覆盖升级,vault/global 源照常加载
			devLogger.warn('skill', `内置 skill 写出失败: ${name}`, err);
		}
	}
	return { written, skipped };
}

/**
 * 从 SKILL.md frontmatter 提取 version。
 *
 * @param content - SKILL.md 全文
 * @returns version 字符串;无 frontmatter / 无 version / 解析失败返回 null
 */
function extractVersion(content: string): string | null {
	try {
		const data = matter(content).data as Record<string, unknown>;
		return typeof data.version === 'string' ? data.version : null;
	} catch {
		return null;
	}
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
