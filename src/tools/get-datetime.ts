/**
 * @file src/tools/get-datetime.ts
 * @description get_datetime 工具 — 返回当前(或偏移后)本地时间结构化字段
 * @module tools/get-datetime
 * @depends core/tool-registry, ports/llm, utils/local-datetime
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import { optionalNumber, optionalString } from './validate-args';
import { formatLocalDateTime } from '../utils/local-datetime';

/**
 * 构造 `get_datetime` 工具 — 无 vault 依赖,只读。
 *
 * @param definition - Composer 生成的 LLM schema
 * @returns Tool 实例
 */
export function createGetDatetimeTool(definition: ToolDefinition): Tool {
	return {
		definition,
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			const format = optionalString(args, 'format') ?? 'full';
			const offsetDays = Math.floor(optionalNumber(args, 'offsetDays', 0));
			const date = new Date();
			if (offsetDays !== 0) {
				date.setDate(date.getDate() + offsetDays);
			}
			const info = formatLocalDateTime(date);

			if (format === 'iso') {
				return { iso: info.iso, timezone: info.timezone, epochMs: info.epochMs };
			}
			if (format === 'local') {
				return {
					local: info.local,
					timezone: info.timezone,
					weekday: info.weekday,
					epochMs: info.epochMs,
				};
			}
			// 默认 full
			return info;
		},
	};
}
