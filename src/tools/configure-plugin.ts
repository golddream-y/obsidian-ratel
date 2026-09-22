/**
 * @file src/tools/configure-plugin.ts
 * @description configure_plugin — inspect 只读，apply 点名写
 * @module tools/configure-plugin
 */
import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import { tNow } from '../i18n';

export function createConfigurePluginTool(
	definition: ToolDefinition,
	deps: {
		inspect: (pluginId: string) => Promise<unknown>;
		apply: (pluginId: string, patch: Record<string, unknown>, confirmedNewKeys: string[]) => Promise<unknown>;
	},
): Tool {
	return {
		definition,
		readOnly: false,
		async execute(args: Record<string, unknown>) {
			if (typeof args.pluginId !== 'string' || args.pluginId.trim().length === 0) {
				throw new Error(tNow('error.tool.invalidArg', { label: 'pluginId', type: typeof args.pluginId }));
			}
			const id = args.pluginId.trim();
			const op = args.op === 'apply' ? 'apply' : 'inspect';
			if (op !== 'apply') return deps.inspect(id);
			if (!args.patch || typeof args.patch !== 'object' || Array.isArray(args.patch)) {
				throw new Error(tNow('error.tool.invalidArg', { label: 'patch', type: typeof args.patch }));
			}
			const confirmed = Array.isArray(args.confirmedNewKeys) ? args.confirmedNewKeys.map(String) : [];
			return deps.apply(id, args.patch as Record<string, unknown>, confirmed);
		},
	};
}
