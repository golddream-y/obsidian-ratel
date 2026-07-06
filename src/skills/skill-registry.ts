/**
 * @file src/skills/skill-registry.ts
 * @description SkillRegistry — 内存注册表,管理 enabled/disabled/active 三态
 * @module skills/skill-registry
 * @depends skills/types, i18n
 */

import type { Skill, SkillManifest, SkillLoadWarning } from './types';
import { tNow } from '../i18n';

/**
 * Skill 注册表 — 内存常驻,管理 skill 的加载结果与运行时状态。
 *
 * 设计要点:
 * - 三态管理:
 *   - `enabled`:skill manifest 的 enabled 字段(用户可改),控制是否进入 Discovery
 *   - `active`:session 内激活态,激活后 instructions 注入 system prompt
 *   - `always`:activation='always' 的 skill 在 Discovery 阶段自动 active
 * - `reload(skills, warnings)` 全量替换内部状态,供 main.ts 重新扫描后调用
 * - 激活态不跨会话持久化(spec §4.5 — session 关闭时全部清空)
 *
 * 关键路径:Registry 不直接读文件系统(load 由 Loader 做),只维护内存状态。
 * Activator 通过 Registry 拿 enabled skill 列表与 active skill 列表。
 */
export class SkillRegistry {
	/** 全部已加载 skill(name → Skill) */
	private skills = new Map<string, Skill>();
	/** 加载 warnings(供 main.ts 日志输出) */
	private warnings: SkillLoadWarning[] = [];
	/** 当前激活的 skill name 集合(session 内有效) */
	private activeSkills = new Set<string>();
	/** 用户手动 toggle 的 enabled 覆盖(name → boolean);未在 map 中则用 manifest.enabled */
	private enabledOverrides = new Map<string, boolean>();

	/**
	 * 全量替换已加载 skill(供 main.ts reload 调用)。
	 *
	 * 关键路径:
	 * - 保留当前 activeSkills(若新列表中仍存在同名 skill)
	 * - 保留 enabledOverrides(用户 toggle 的状态跨 reload 保留)
	 * - activation='always' 的 skill 自动加入 activeSkills
	 *
	 * @param skills - Loader 加载合并后的 skill 列表
	 * @param warnings - Loader 产生的 warning 列表
	 */
	reload(skills: Skill[], warnings: SkillLoadWarning[]): void {
		this.skills = new Map(skills.map((s) => [s.manifest.name, s]));
		this.warnings = warnings;
		// 关键路径:清理已不存在的 active skill。
		for (const name of Array.from(this.activeSkills)) {
			if (!this.skills.has(name)) {
				this.activeSkills.delete(name);
			}
		}
		// 关键路径:activation='always' 的 skill 自动激活(spec §4.5)。
		for (const skill of skills) {
			if (skill.manifest.activation === 'always' && this.isEnabled(skill.manifest.name)) {
				this.activeSkills.add(skill.manifest.name);
			}
		}
	}

	/**
	 * 获取全部已加载 skill(不含 active 状态过滤)。
	 */
	getAll(): Skill[] {
		return Array.from(this.skills.values());
	}

	/**
	 * 获取 warnings(加载过程中的非阻塞警告)。
	 */
	getWarnings(): SkillLoadWarning[] {
		return this.warnings;
	}

	/**
	 * 按 name 取单个 skill。
	 *
	 * @returns skill 存在则返回,否则 undefined
	 */
	get(name: string): Skill | undefined {
		return this.skills.get(name);
	}

	/**
	 * 判断 skill 是否启用(考虑 manifest.enabled 与 enabledOverrides)。
	 *
	 * 关键路径:enabledOverrides 优先于 manifest.enabled,用户在 settings/UI toggle 后立即生效。
	 */
	isEnabled(name: string): boolean {
		const skill = this.skills.get(name);
		if (!skill) return false;
		if (this.enabledOverrides.has(name)) {
			return this.enabledOverrides.get(name)!;
		}
		return skill.manifest.enabled;
	}

	/**
	 * 设置单个 skill 的 enabled 覆盖(用户 toggle)。
	 */
	setEnabled(name: string, enabled: boolean): void {
		if (!this.skills.has(name)) return;
		this.enabledOverrides.set(name, enabled);
		// 关键路径:禁用时清掉 active 状态,避免 instructions 仍在 system prompt 里。
		if (!enabled) {
			this.activeSkills.delete(name);
		}
	}

	/**
	 * 获取进入 Discovery 段的 skill 列表(enabled 且 activation != 'manual')。
	 *
	 * 关键路径:activation='manual' 的 skill 不出现在 Discovery 段(spec §4.5b),
	 * 仅 `/skill <name>` 可激活。
	 */
	getDiscovered(): Skill[] {
		return this.getAll().filter((s) => {
			if (!this.isEnabled(s.manifest.name)) return false;
			return s.manifest.activation !== 'manual';
		});
	}

	/**
	 * 获取当前激活的 skill 列表(instructions 已注入 system prompt)。
	 */
	getActive(): Skill[] {
		return Array.from(this.activeSkills)
			.map((name) => this.skills.get(name))
			.filter((s): s is Skill => s !== undefined);
	}

	/**
	 * 激活指定 skill — 读 instructions 正文并加入 activeSkills。
	 *
	 * 关键路径:
	 * - skill 不存在 → 抛 notFound
	 * - skill 未启用 → 抛 notEnabled
	 * - 已激活 → 幂等返回(不报错)
	 *
	 * @param name - skill name
	 * @returns 激活后的 Skill 对象(供 Activator 拼 system prompt)
	 * @throws skill 不存在或未启用时抛 i18n 错误
	 */
	activate(name: string): Skill {
		const skill = this.skills.get(name);
		if (!skill) {
			throw new Error(tNow('skill.notice.notFound', { name }));
		}
		if (!this.isEnabled(name)) {
			throw new Error(tNow('error.skill.notEnabled', { name }));
		}
		this.activeSkills.add(name);
		return skill;
	}

	/**
	 * 反激活指定 skill — 从 activeSkills 移除。
	 *
	 * @param name - skill name
	 * @throws skill 未激活时抛 notActive
	 */
	deactivate(name: string): void {
		if (!this.activeSkills.has(name)) {
			throw new Error(tNow('skill.notice.notActive', { name }));
		}
		this.activeSkills.delete(name);
	}

	/**
	 * 清空全部激活态(供 chat session 关闭时调用,spec §4.5)。
	 */
	clearActive(): void {
		this.activeSkills.clear();
	}
}
