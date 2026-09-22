/**
 * @file src/tools/update-plugin.ts
 * @description update_plugin — 确认后只覆盖三件套
 * @module tools/update-plugin
 */
import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import { tNow } from '../i18n';

export function createUpdatePluginTool(
	definition: ToolDefinition,
	deps: { run: (pluginId: string) => Promise<unknown> },
): Tool {
	return {
		definition,
		readOnly: false,
		async execute(args: Record<string, unknown>) {
			if (typeof args.pluginId !== 'string' || args.pluginId.trim().length === 0) {
				throw new Error(tNow('error.tool.invalidArg', { label: 'pluginId', type: typeof args.pluginId }));
			}
			return deps.run(args.pluginId.trim());
		},
	};
}
