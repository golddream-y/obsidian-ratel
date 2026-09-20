/**
 * @file src/tools/install-plugin.ts
 * @description install_plugin — 确认后 R2 写盘或 R3 打开官方页(ADR-018)
 * @module tools/install-plugin
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import { tNow } from '../i18n';

/**
 * 变更类工具,默认 ask,且应视为破坏性(auto 档仍确认)。
 */
export function createInstallPluginTool(
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
