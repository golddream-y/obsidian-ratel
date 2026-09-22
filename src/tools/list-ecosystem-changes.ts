/**
 * @file src/tools/list-ecosystem-changes.ts
 * @description list_ecosystem_changes 只读
 * @module tools/list-ecosystem-changes
 */
import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';

export function createListEcosystemChangesTool(
	definition: ToolDefinition,
	deps: { run: (opts: { pluginId?: string; limit?: number }) => Promise<unknown> },
): Tool {
	return {
		definition,
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			const pluginId = typeof args.pluginId === 'string' && args.pluginId.trim() ? args.pluginId.trim() : undefined;
			let limit = typeof args.limit === 'number' ? args.limit : 20;
			if (!Number.isFinite(limit)) limit = 20;
			limit = Math.min(Math.max(Math.floor(limit), 1), 100);
			return deps.run({ pluginId, limit });
		},
	};
}
