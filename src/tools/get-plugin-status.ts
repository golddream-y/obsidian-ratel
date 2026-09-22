/**
 * @file src/tools/get-plugin-status.ts
 * @description get_plugin_status 只读
 * @module tools/get-plugin-status
 */
import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';

export function createGetPluginStatusTool(
	definition: ToolDefinition,
	deps: {
		list: () => Promise<unknown>;
		status: (pluginId: string, opts: { includeKeys: boolean; checkUpdate: boolean }) => Promise<unknown>;
	},
): Tool {
	return {
		definition,
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			if (typeof args.pluginId !== 'string' || args.pluginId.trim().length === 0) {
				return deps.list();
			}
			return deps.status(args.pluginId.trim(), {
				includeKeys: args.includeKeys === true,
				checkUpdate: args.checkUpdate === true,
			});
		},
	};
}
