/**
 * @file src/skills/skill-activator.ts
 * @description SkillActivator — 产出 Discovery 段与 Active 段文本,供 ContextManager 注入 system prompt
 * @module skills/skill-activator
 * @depends skills/skill-registry, prompts/composer, prompts/interpolate, i18n
 */

import type { SkillRegistry } from './skill-registry';
import type { Skill } from './types';
import type { OverrideMap } from '../prompts/types';
import { resolveSection } from '../prompts/composer';
import { interpolate } from '../prompts/interpolate';
import { tNow } from '../i18n';

/**
 * Skill 激活器 — 产出两段 system prompt 文本:
 *
 * 1. Discovery 段:列出 enabled 且非 manual 的 skill 的 name+description,
 *    注入到 system prompt 的 `agent.rag.toolGuide` 之后、检索结果之前(spec §4.4)。
 * 2. Active 段:当前激活的 skill 的 instructions 正文,作为动态指令追加(spec §4.5)。
 *
 * 设计要点:
 * - 不维护状态,纯函数式产出文本(状态由 Registry 管)
 * - Discovery 段走 `agent.skills` prompt section(支持 override),Active 段不走 section
 *   (instructions 是 skill 作者写的,不进 section 注册表)
 * - 50 个 skill 上限时按 tags 粗筛(spec §4.4 — v2 优化,本 plan 实现简单字面量截断到 50)
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
	 * - 超过 50 个时截断到前 50 个(v2 按 tags + query 粗筛)
	 * - skillList 格式:`- name: description`(每行一个)
	 *
	 * @param overrides - prompt section 覆盖(来自 settings.promptOverrides)
	 * @returns Discovery 段文本;无 skill 时返回空串
	 */
	composeDiscovery(overrides: OverrideMap): string {
		const discovered = this.registry.getDiscovered();
		if (discovered.length === 0) return '';

		// 关键路径:超过 50 个截断(v2 按 tags 粗筛)。
		const limited = discovered.slice(0, SkillActivator.MAX_DISCOVERY_SKILLS);
		const skillList = limited
			.map((s) => `- ${s.manifest.name}: ${this.resolveDescription(s)}`)
			.join('\n');

		const template = resolveSection('agent.skills', overrides);
		return interpolate(template, { skillList });
	}

	/**
	 * 产出 Active 段文本(当前激活的 skill 的 instructions 正文)。
	 *
	 * 关键路径:
	 * - 无 active skill 时返回空串(不注入)
	 * - 每个 skill 的 instructions 用标题包裹(`## 当前激活的 Skill: <name>`)
	 * - 多 skill 激活时累加,空行分隔
	 *
	 * @returns Active 段文本;无 active skill 时返回空串
	 */
	composeActive(): string {
		const active = this.registry.getActive();
		if (active.length === 0) return '';

		const parts = active.map((s) => {
			const title = tNow('skill.active.title');
			return `## ${title}: ${s.manifest.name}\n\n${s.instructions}`;
		});
		return parts.join('\n\n');
	}

	/**
	 * 解析 skill 的 description(优先 i18n.description 当前语言,fallback 顶层 description)。
	 *
	 * 关键路径:i18n.description 缺失当前 locale 时 fallback 到顶层 description(spec §4.2)。
	 *
	 * 当前 v1 实现:直接返回 manifest.description。v2 计划:i18n fallback。
	 */
	private resolveDescription(skill: Skill): string {
		return skill.manifest.description;
	}
}
