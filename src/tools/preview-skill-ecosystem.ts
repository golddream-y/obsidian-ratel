/**
 * @file src/tools/preview-skill-ecosystem.ts
 * @description `preview_skill_ecosystem` 工具 — 只读预览 Skill ecosystem 依赖计划(S-SCENE-ECO 分期 A)
 * @module tools/preview-skill-ecosystem
 * @depends core/tool-registry, skills/skill-registry, skills/preview-skill-ecosystem, i18n
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { EcosystemErrorCode, PluginPresence } from '../skills/ecosystem-types';
import { buildEcosystemPreview } from '../skills/preview-skill-ecosystem';
import type { SkillRegistry } from '../skills/skill-registry';
import { tNow } from '../i18n';
import type { StringKey } from '../i18n/types';

/**
 * 把 ecosystem 错误码映射为用户可见文案。
 */
function ecosystemIssueMessage(code: EcosystemErrorCode, params?: Record<string, string>): string {
	const key = `ecosystem.invalid.${code}` as StringKey;
	return params ? tNow(key, params) : tNow(key);
}

/**
 * 构造 `preview_skill_ecosystem` 工具实例。
 *
 * 设计要点:
 * - 只读工具(`readOnly: true`),不写盘、不安装插件。
 * - `name` 必填;skill 不存在时抛 `skill.notice.notFound`。
 * - 返回 JSON 可序列化的 `EcosystemPreview`;`issues.message` 走 i18n。
 *
 * @param registry - SkillRegistry 实例
 * @param definition - LLM 侧 schema
 * @param presence - 可选插件在场探测;main 注入 Obsidian adapter
 */
export function createPreviewSkillEcosystemTool(
	registry: SkillRegistry,
	definition: ToolDefinition,
	presence?: PluginPresence,
): Tool {
	return {
		definition,
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			if (typeof args.name !== 'string' || args.name.length === 0) {
				throw new Error(tNow('error.tool.invalidArg', { label: 'name', type: typeof args.name }));
			}
			const name = args.name;
			const skill = registry.get(name);
			if (!skill) {
				throw new Error(tNow('skill.notice.notFound', { name }));
			}
			return await buildEcosystemPreview(skill, {
				presence,
				t: ecosystemIssueMessage,
			});
		},
	};
}
