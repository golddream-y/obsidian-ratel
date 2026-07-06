/**
 * @file src/skills/skill-loader.ts
 * @description SkillLoader — 三源扫描 + frontmatter 解析 + 同名合并(vault > global > builtin)
 * @module skills/skill-loader
 * @depends gray-matter, ports/skill-port, skills/types
 */

import matter from 'gray-matter';
import type { SkillPort } from '../ports/skill-port';
import type { Skill, SkillManifest, SkillActivation, SkillLoadWarning } from './types';

/**
 * Skill name 合法正则(spec §4.2):全小写字母数字 + 连字符,首字母必须字母,长度 1-64。
 */
const SKILL_NAME_REGEX = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * Skill 加载器 — 扫描三源,解析 frontmatter,合并同名 skill。
 *
 * 设计要点:
 * - 三源按 builtin → global → vault 顺序加载,后者覆盖前者同名 skill(spec §4.3)。
 * - frontmatter 解析用 gray-matter,失败时记 warning 跳过,不阻塞其他 skill。
 * - name 校验:正则不匹配 / 为空 → 跳过并记 warning。
 * - activation 非法值降级 'auto'(spec §4.2 字段约束)。
 * - enabled 缺省 true。
 *
 * 关键路径:Loader 只负责"读 + 解析 + 合并",不维护运行时状态(enabled/active 状态由 Registry 管)。
 *
 * @example
 *   const loader = new SkillLoader([builtinPort, globalPort, vaultPort]);
 *   const { skills, warnings } = await loader.loadAll();
 */
export class SkillLoader {
	constructor(private ports: SkillPort[]) {}

	/**
	 * 扫描全部已注入的端口,返回合并后的 skill 列表与 warning 列表。
	 *
	 * 关键路径:
	 * - 按 ports 数组顺序加载(调用方负责顺序:builtin → global → vault)
	 * - 同名 skill 后者覆盖前者(spec §4.3 合并规则)
	 * - 单个 skill 加载失败不阻塞其他 skill
	 *
	 * @returns skills: 合并后的 skill 数组;warnings: 加载过程中的警告
	 */
	async loadAll(): Promise<{ skills: Skill[]; warnings: SkillLoadWarning[] }> {
		// 关键路径:用 Map 按 name 去重覆盖,builtin 先入,vault 后入覆盖。
		const merged = new Map<string, Skill>();
		const warnings: SkillLoadWarning[] = [];

		for (const port of this.ports) {
			const folderNames = await this.safeListFolders(port, warnings);
			for (const folderName of folderNames) {
				const skill = await this.tryLoadOne(port, folderName, warnings);
				if (skill) {
					// 关键路径:后者覆盖前者(spec §4.3 同名覆盖)。
					merged.set(skill.manifest.name, skill);
				}
			}
		}

		return { skills: Array.from(merged.values()), warnings };
	}

	/**
	 * 安全列出端口下的 skill 文件夹,失败时记 warning 返回空数组。
	 */
	private async safeListFolders(port: SkillPort, warnings: SkillLoadWarning[]): Promise<string[]> {
		try {
			return await port.listSkillFolders();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			warnings.push({ path: port.rootDir, message: `列出 skill 文件夹失败: ${message}` });
			return [];
		}
	}

	/**
	 * 尝试加载单个 skill,失败时记 warning 返回 undefined。
	 */
	private async tryLoadOne(
		port: SkillPort,
		folderName: string,
		warnings: SkillLoadWarning[],
	): Promise<Skill | undefined> {
		const skillPath = `${port.rootDir}/${folderName}`;
		try {
			const raw = await port.readSkillManifest(folderName);
			const parsed = matter(raw);
			const manifest = this.buildManifest(parsed.data, folderName, skillPath, warnings);
			if (!manifest) return undefined;
			return {
				manifest,
				// 关键路径:gray-matter 的 content 是 frontmatter 之后的正文。
				instructions: parsed.content.trim(),
				source: port.source,
				dir: skillPath,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			warnings.push({ path: skillPath, message: `加载失败: ${message}` });
			return undefined;
		}
	}

	/**
	 * 从 frontmatter 数据构建 SkillManifest,校验并降级非法值。
	 *
	 * 关键路径:
	 * - name 必须匹配正则,否则跳过并记 warning
	 * - description 必须非空,否则跳过
	 * - activation 非法值降级 'auto'
	 * - enabled 缺省 true
	 * - version 解析失败记 warning,不影响加载(不参与兼容判断)
	 */
	private buildManifest(
		data: Record<string, unknown>,
		folderName: string,
		skillPath: string,
		warnings: SkillLoadWarning[],
	): SkillManifest | undefined {
		const name = typeof data.name === 'string' ? data.name : folderName;
		if (!SKILL_NAME_REGEX.test(name)) {
			warnings.push({
				path: skillPath,
				message: `name 非法(需匹配 ${SKILL_NAME_REGEX.source}): ${name}`,
			});
			return undefined;
		}
		const description = typeof data.description === 'string' ? data.description : '';
		if (!description) {
			warnings.push({ path: skillPath, message: 'description 为空' });
			return undefined;
		}
		const activation = this.normalizeActivation(data.activation, skillPath, warnings);
		const enabled = typeof data.enabled === 'boolean' ? data.enabled : true;
		const tags = Array.isArray(data.tags) ? data.tags.filter((t): t is string => typeof t === 'string') : [];
		const i18nDescription = this.extractI18nDescription(data.i18n, skillPath, warnings);
		return {
			name,
			description,
			version: typeof data.version === 'string' ? data.version : undefined,
			author: typeof data.author === 'string' ? data.author : undefined,
			enabled,
			activation,
			tags,
			i18nDescription,
		};
	}

	/**
	 * 规范化 activation 字段,非法值降级 'auto'(spec §4.2)。
	 */
	private normalizeActivation(
		value: unknown,
		skillPath: string,
		warnings: SkillLoadWarning[],
	): SkillActivation {
		if (value === 'auto' || value === 'manual' || value === 'always') return value;
		if (value !== undefined) {
			warnings.push({ path: skillPath, message: `activation 非法值 "${value}",降级 auto` });
		}
		return 'auto';
	}

	/**
	 * 提取 i18n.description 多语言描述对象。
	 */
	private extractI18nDescription(
		i18n: unknown,
		skillPath: string,
		warnings: SkillLoadWarning[],
	): SkillManifest['i18nDescription'] {
		if (!i18n || typeof i18n !== 'object') return undefined;
		const desc = (i18n as Record<string, unknown>).description;
		if (!desc || typeof desc !== 'object') return undefined;
		const result: Record<string, string> = {};
		for (const [locale, text] of Object.entries(desc as Record<string, unknown>)) {
			if (typeof text === 'string') {
				result[locale] = text;
			} else {
				warnings.push({ path: skillPath, message: `i18n.description.${locale} 非字符串,跳过` });
			}
		}
		return Object.keys(result).length > 0 ? result : undefined;
	}
}
