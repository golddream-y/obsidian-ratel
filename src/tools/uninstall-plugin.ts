/**
 * @file src/tools/uninstall-plugin.ts
 * @description uninstall_plugin
 * @module tools/uninstall-plugin
 */
import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import { tNow } from '../i18n';

export function createUninstallPluginTool(
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
