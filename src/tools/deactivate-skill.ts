/**
 * @file src/tools/deactivate-skill.ts
 * @description `deactivate_skill` 工具 — 关闭已激活的 skill,从 system prompt 移除指令段
 * @module tools/deactivate-skill
 * @depends core/tool-registry, skills/skill-registry, ports/llm, i18n
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { SkillRegistry } from '../skills/skill-registry';
import { tNow } from '../i18n';

/**
 * 构造 `deactivate_skill` 工具实例。
 *
 * 设计要点:
 * - 只读工具(`readOnly: true`),不触发写钩子。
 * - 内部调用 `registry.deactivate(name)`,未激活时抛 notActive。
 * - 返回简短确认文本。
 *
 * 关键路径:与 activate_skill 对称,反激活后 system prompt 的重组由 agent-loop 在工具
 * 执行后调 `ctx.setSkillsContext(...)` 触发。
 *
 * @param registry - SkillRegistry 实例
 * @param definition - LLM 侧 schema,由 composeToolDefinitions 生成
 * @returns 符合 Tool 接口的工具定义
 */
export function createDeactivateSkillTool(
	registry: SkillRegistry,
	definition: ToolDefinition,
): Tool {
	return {
		definition,
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			if (typeof args.name !== 'string' || args.name.length === 0) {
				throw new Error(tNow('error.tool.invalidArg', { label: 'name', type: typeof args.name }));
			}
			const name = args.name;
			registry.deactivate(name);
			return tNow('skill.notice.deactivated', { name });
		},
	};
}
