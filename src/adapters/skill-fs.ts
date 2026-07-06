/**
 * @file src/adapters/skill-fs.ts
 * @description SkillFsAdapter — 用 node:fs 读全局/预置 skills 的 SkillPort 实现
 * @module adapters/skill-fs
 * @depends node:fs, node:path, ports/skill-port, skills/types
 */

import fs from 'fs';
import path from 'path';
import type { SkillPort } from '../ports/skill-port';
import type { SkillSource } from '../skills/types';

/**
 * node:fs 实现的 SkillPort — 用于全局源(`~/.ratel/skills/`)与预置源(`<pluginDir>/skills/`)。
 *
 * 设计要点:
 * - 构造时注入 `source` 与 `rootDir`,运行时只读,不写。
 * - `listSkillFolders` 用 `fs.readdirSync` 读直接子目录,过滤掉文件与不含 SKILL.md 的目录。
 * - `readSkillManifest` 用 `fs.readFileSync` 读 SKILL.md 全文。
 * - path traversal 防护:`readSkillManifest` 内用 `path.resolve` 后校验结果仍在 `rootDir` 内。
 *
 * 关键路径:全局/预置源不监听文件变更(spec §4.4),仅 onload 扫描一次。
 */
export class SkillFsAdapter implements SkillPort {
	constructor(
		readonly source: SkillSource,
		readonly rootDir: string,
	) {}

	async listSkillFolders(): Promise<string[]> {
		// 关键路径:目录不存在时返回空数组,不抛错(全局源可能尚未创建)。
		if (!fs.existsSync(this.rootDir)) return [];
		const entries = fs.readdirSync(this.rootDir, { withFileTypes: true });
		const folders: string[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			// 关键路径:必须含 SKILL.md,否则跳过(不含 SKILL.md 的文件夹不是有效 skill)。
			const skillMdPath = path.join(this.rootDir, entry.name, 'SKILL.md');
			if (fs.existsSync(skillMdPath)) {
				folders.push(entry.name);
			}
		}
		return folders;
	}

	async readSkillManifest(skillName: string): Promise<string> {
		// 关键路径:path traversal 防护 — resolve 后校验仍在 rootDir 内。
		// 用 path.normalize 处理 skillName 内可能的 ../ 注入,再 resolve 到绝对路径。
		const normalized = path.normalize(skillName);
		const resolved = path.resolve(this.rootDir, normalized, 'SKILL.md');
		const rootResolved = path.resolve(this.rootDir);
		// 关键路径:resolved 必须在 rootDir 之下(前缀匹配 + path.sep 边界)。
		if (resolved !== path.join(rootResolved, normalized, 'SKILL.md') &&
			!(resolved.startsWith(rootResolved + path.sep))) {
			throw new Error(`path traversal blocked: ${skillName}`);
		}
		return fs.readFileSync(resolved, 'utf-8');
	}
}
