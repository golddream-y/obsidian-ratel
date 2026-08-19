/**
 * @file src/skills/skill-activator.ts
 * @description SkillActivator — 产出 Discovery 段文本,供 ContextManager 注入 system prompt
 * @module skills/skill-activator
 * @depends skills/skill-registry, prompts/composer, prompts/interpolate
 */

import type { SkillRegistry } from './skill-registry';
import type { Skill } from './types';
import type { OverrideMap } from '../prompts/types';
import { resolveSection } from '../prompts/composer';
import { interpolate } from '../prompts/interpolate';
// 关键路径(S-SR-LAYERING):i18n fallback 读取当前界面语言
import { get } from 'svelte/store';
import { langStore } from '../i18n';

/**
 * Skill 激活器 — 产出 Discovery 段 system prompt 文本:
 *
 * 1. Discovery 段:列出 enabled 且非 manual 的 skill 的 name+description,
 *    注入到 system prompt 的 `agent.rag.toolGuide` 之后、检索结果之前(spec §4.4)。
 * 2. Active 段(已废弃,S-SKILL-UX 删除;指令经 activate_skill 写入 Session.messages,见 ADR-012)。
 *
 * 设计要点:
 * - 不维护状态,纯函数式产出文本(状态由 Registry 管)
 * - Discovery 段走 `agent.skills` prompt section(支持 override)
 * - 50 个 skill 上限时按 tags/描述与当前提问的相关性排序后截断前 50(S-SR-LAYERING)
 *
 * 关键路径:Activator 由 ContextManager 在 toMessages 时调用,产出文本注入到 system 与
 * memorySystemPrompt 之间(或 memorySystemPrompt 不存在时直接在 system 之后)。
 */
export class SkillActivator {
	/** Discovery 段最多展示的 skill 数(spec §4.4 — 超过 50 时按 tags 粗筛,v2 优化) */
	private static readonly MAX_DISCOVERY_SKILLS = 50;

	constructor(private registry: SkillRegistry) {}

	/**
	 * 产出 Discovery 段文本(enabled 且非 manual 的 skill 列表)。
	 *
	 * 关键路径:
	 * - 无 enabled skill 时返回空串(不注入,避免空段)
	 * - 超过 50 个时按 tags/描述与当前提问的相关性排序后截断到前 50 个(S-SR-LAYERING)
	 * - skillList 格式:`- name: description`(每行一个)
	 *
	 * @param overrides - prompt section 覆盖(来自 settings.promptOverrides)
	 * @param query - 可选;当前用户提问文本,用于相关性排序(不传或全未命中时按名称字母序稳定排序)
	 * @returns Discovery 段文本;无 skill 时返回空串
	 */
	composeDiscovery(overrides: OverrideMap, query?: string): string {
		const discovered = this.registry.getDiscovered();
		if (discovered.length === 0) return '';

		// 关键路径(S-SR-LAYERING):按 tags/描述与当前提问的相关性排序后再截断 —
		// 装几十个 skill 时不再按列表顺序随机丢。v1 局限:空格分词,中文整句命中率低,
		// 未命中时稳定排序退回字母序(尽力而为,不影响功能)。
		const terms = (query ?? '')
			.toLowerCase()
			.split(/\s+/)
			.filter((t) => t.length >= 2);
		const scored = discovered
			.map((s) => ({ s, score: this.scoreSkill(s, terms) }))
			.sort((a, b) => b.score - a.score || a.s.manifest.name.localeCompare(b.s.manifest.name))
			.map((x) => x.s);

		const limited = scored.slice(0, SkillActivator.MAX_DISCOVERY_SKILLS);
		const skillList = limited
			.map((s) => `- ${s.manifest.name}: ${this.resolveDescription(s)}`)
			.join('\n');

		const template = resolveSection('agent.skills', overrides);
		return interpolate(template, { skillList });
	}

	/**
	 * 相关性打分:tag 命中 +2(强信号),名称/描述包含 +1。
	 *
	 * @param skill - 待评分的 skill
	 * @param terms - 从当前提问分出的检索词(已小写)
	 * @returns 累计得分;0 表示与提问无字面关联
	 */
	private scoreSkill(skill: Skill, terms: string[]): number {
		const text = `${skill.manifest.name} ${skill.manifest.description}`.toLowerCase();
		let score = 0;
		for (const term of terms) {
			if (skill.manifest.tags?.some((tag) => tag.toLowerCase().includes(term))) score += 2;
			if (text.includes(term)) score += 1;
		}
		return score;
	}

	/**
	 * 解析 skill 的 description(优先 i18nDescription 当前语言,fallback 顶层 description)。
	 *
	 * 关键路径(S-SR-LAYERING):i18nDescription 缺失当前 locale 时 fallback 到顶层 description(spec §4.2)。
	 *
	 * @param skill - 待解析的 skill
	 * @returns 当前语言的描述文案
	 */
	private resolveDescription(skill: Skill): string {
		const locale = get(langStore);
		return skill.manifest.i18nDescription?.[locale] ?? skill.manifest.description;
	}
}
