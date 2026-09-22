/**
 * @file src/tools/list-plugin-profiles.ts
 * @description list_plugin_profiles 只读
 * @module tools/list-plugin-profiles
 */
import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';

/**
 * 创建 list_plugin_profiles 只读工具，结果由 deps.run 提供。
 *
 * @param definition - LLM 工具 schema
 * @param deps - run 回调（通常返回 loadAllProfiles 摘要）
 * @returns 注册用 Tool
 */
export function createListPluginProfilesTool(
	definition: ToolDefinition,
	deps: { run: () => unknown },
): Tool {
	return {
		definition,
		readOnly: true,
		async execute() {
			return deps.run();
		},
	};
}
