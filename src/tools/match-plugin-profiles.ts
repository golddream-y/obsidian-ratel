/**
 * @file src/tools/match-plugin-profiles.ts
 * @description match_plugin_profiles 只读匹配
 * @module tools/match-plugin-profiles
 */
import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import { tNow } from '../i18n';
import { matchProfiles } from '../profiles/match';
import { expandPresetPatch } from '../profiles/expand';
import type { PluginProfile } from '../profiles/types';

/**
 * 创建 match_plugin_profiles 工具：在档案池内打分并展开 patch 预览。
 *
 * @param definition - LLM 工具 schema
 * @param deps - 档案池与可选的已有 data.json 键
 * @returns 注册用 Tool
 */
export function createMatchPluginProfilesTool(
	definition: ToolDefinition,
	deps: { getPool: () => PluginProfile[]; getExistingKeys?: (pluginId: string) => Promise<string[]> },
): Tool {
	return {
		definition,
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			const utterance = typeof args.utterance === 'string' ? args.utterance.trim() : '';
			const pluginId = typeof args.pluginId === 'string' ? args.pluginId.trim() : '';
			const tags = Array.isArray(args.tags) ? args.tags.map(String) : [];
			if (!utterance && !pluginId && tags.length === 0) {
				throw new Error(tNow('error.tool.invalidArg', { label: 'utterance|pluginId|tags', type: 'empty' }));
			}
			const hits = matchProfiles(deps.getPool(), {
				utterance: utterance || undefined,
				pluginId: pluginId || undefined,
				tags: tags.length ? tags : undefined,
			});
			return {
				hits: await Promise.all(
					hits.map(async (h) => {
						const profile = deps.getPool().find((p) => p.id === h.profileId)!;
						const preset = profile.presets.find((p) => p.id === h.presetId)!;
						const existingKeys = deps.getExistingKeys ? await deps.getExistingKeys(profile.pluginId) : [];
						const expanded = expandPresetPatch({ preset, forbid: profile.forbid, existingKeys });
						return {
							...h,
							patchPreview: expanded.patch,
							needsConfirm: expanded.needsConfirm,
							sopSkill: profile.sopSkill,
							pluginVersionRange: profile.pluginVersionRange,
						};
					}),
				),
			};
		},
	};
}
