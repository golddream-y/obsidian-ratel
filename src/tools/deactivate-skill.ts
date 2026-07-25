/**
 * @file src/tools/deactivate-skill.ts
 * @description `deactivate_skill` 工具 — 追加 supersede 说明(ADR-012),无法物理删除历史正文
 * @module tools/deactivate-skill
 * @depends core/tool-registry, skills/skill-registry, ports/llm, i18n
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { SkillRegistry } from '../skills/skill-registry';
import type { SkillSessionHooks } from './activate-skill';
import { tNow } from '../i18n';

/**
 * 构造 `deactivate_skill` 工具实例。
 *
 * ADR-012:transcript 模型下只能追加 supersede;registry.deactivate 清理可选缓存。
 *
 * @param registry - SkillRegistry 实例
 * @param definition - LLM 侧 schema
 * @param sessionHooks - 可选;写入 supersede
 */
export function createDeactivateSkillTool(
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
			if (sessionHooks) {
				if (!sessionHooks.hasInSession(name)) {
					throw new Error(tNow('skill.notice.notActive', { name }));
				}
				sessionHooks.supersedeInSession?.(name);
				// 关键路径:best-effort 清缓存;未在 Set 中不抛(可能仅靠 transcript 激活)
				try {
					registry.deactivate(name);
				} catch {
					/* ignore */
				}
				return tNow('skill.notice.deactivated', { name });
			}
			registry.deactivate(name);
			return tNow('skill.notice.deactivated', { name });
		},
	};
}
