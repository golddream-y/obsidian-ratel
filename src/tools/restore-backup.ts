/**
 * @file src/tools/restore-backup.ts
 * @description restore_backup
 * @module tools/restore-backup
 */
import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import { tNow } from '../i18n';

export function createRestoreBackupTool(
	definition: ToolDefinition,
	deps: { run: (changeId: string) => Promise<unknown> },
): Tool {
	return {
		definition,
		readOnly: false,
		async execute(args: Record<string, unknown>) {
			if (typeof args.changeId !== 'string' || args.changeId.trim().length === 0) {
				throw new Error(tNow('error.tool.invalidArg', { label: 'changeId', type: typeof args.changeId }));
			}
			return deps.run(args.changeId.trim());
		},
	};
}
