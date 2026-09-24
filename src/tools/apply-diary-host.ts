/**
 * @file src/tools/apply-diary-host.ts
 * @description apply_diary_host — 写 Templater 新建触发与核心日记模板路径
 * @module tools/apply-diary-host
 * @depends adapters/diary-host
 */

import { applyDiaryHost, resolveDiaryFolder, type DiaryHostApp, type DiaryHostResult } from '../adapters/diary-host';
import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';

/**
 * 变更类工具，默认 ask。无参数，路径写死在适配器里，模型不能改到别处。
 *
 * @param definition - 注册表里的 schema
 * @param deps - 当前库的宿主
 * @returns 工具实例
 */
export function createApplyDiaryHostTool(
	definition: ToolDefinition,
	deps: { app: DiaryHostApp },
): Tool {
	return {
		definition,
		readOnly: false,
		async execute(args: Record<string, unknown>): Promise<DiaryHostResult> {
			return applyDiaryHost(deps.app, resolveDiaryFolder(args.folder));
		},
	};
}
