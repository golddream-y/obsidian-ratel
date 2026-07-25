/**
 * @file src/tools/activate-skill.ts
 * @description `activate_skill` 工具 — 激活指定 skill,把指令写入当前 Session 消息(ADR-012)
 * @module tools/activate-skill
 * @depends core/tool-registry, skills/skill-registry, ports/llm, i18n
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { SkillRegistry } from '../skills/skill-registry';
import { tNow } from '../i18n';

/**
 * 会话侧写入钩子 — 由 ask() 绑定到当前 ContextManager。
 */
export interface SkillSessionHooks {
	hasInSession: (name: string) => boolean;
	appendToSession: (name: string, instructions: string) => void;
	supersedeInSession?: (name: string) => void;
}

/**
 * 构造 `activate_skill` 工具实例。
 *
 * 设计要点:
 * - 只读工具(`readOnly: true`),不触发写钩子。
 * - ADR-012:副作用是把 instructions 写入 Session.messages,不再依赖 Active 段每轮重注。
 * - `sessionHooks` 由 main.ask 注入当前 ctx;单测可不传(仅测 registry 校验)。
 *
 * @param registry - SkillRegistry 实例
 * @param definition - LLM 侧 schema
 * @param sessionHooks - 可选;写入当前会话 transcript
 */
export function createActivateSkillTool(
	registry: SkillRegistry,
	definition: ToolDefinition,
	sessionHooks?: SkillSessionHooks,
): Tool {
	return {
		definition,
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			if (typeof args.name !== 'string' || args.name.length === 0) {
				throw new Error(tNow('error.tool.invalidArg', { label: 'name', type: typeof args.name }));
			}
			const name = args.name;
			if (sessionHooks?.hasInSession(name)) {
				return tNow('skill.notice.alreadyActive', { name });
			}
			// 关键路径:registry.activate 校验存在/启用;activeSkills 仅作可选缓存。
			const skill = registry.activate(name);
			sessionHooks?.appendToSession(skill.manifest.name, skill.instructions);
			return tNow('skill.notice.activated', { name: skill.manifest.name });
		},
	};
}
