/**
 * @file src/tools/activate-skill.ts
 * @description `activate_skill` 工具 — 激活指定 skill,读完整 SKILL.md 注入 system prompt
 * @module tools/activate-skill
 * @depends core/tool-registry, skills/skill-registry, ports/llm, i18n
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { SkillRegistry } from '../skills/skill-registry';
import { tNow } from '../i18n';

/**
 * 构造 `activate_skill` 工具实例。
 *
 * 设计要点:
 * - 只读工具(`readOnly: true`),不触发写钩子 — 激活只改 system prompt,不写文件。
 * - 内部调用 `registry.activate(name)`,失败时抛 i18n 错误(notFound / notEnabled)。
 * - 工具返回值是简短确认文本,供 LLM 知道激活成功。
 * - `definition` 由调用方通过 Composer 生成后注入(参考 search-vault 模式)。
 *
 * 关键路径:激活后 system prompt 的重组不在工具内做 — 由 agent-loop 在工具执行后
 * 调 `ctx.setSkillsContext(...)` 触发(见 agent-loop skills 段重组逻辑)。
 *
 * @param registry - SkillRegistry 实例
 * @param definition - LLM 侧 schema,由 composeToolDefinitions 生成
 * @returns 符合 Tool 接口的工具定义
 */
export function createActivateSkillTool(
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
			// 关键路径:registry.activate 幂等 — 已激活时直接返回(不抛 alreadyActive)。
			// 这里用 getActive 判断返回更友好的消息,避免重复激活时无意义地再走一遍 activate 流程。
			const active = registry.getActive();
			if (active.some((s) => s.manifest.name === name)) {
				return tNow('skill.notice.alreadyActive', { name });
			}
			const skill = registry.activate(name);
			return tNow('skill.notice.activated', { name: skill.manifest.name });
		},
	};
}
