/**
 * @file src/tools/get-daily-note.ts
 * @description get_daily_note 工具 — 按约定路径探测日记是否存在(不自动创建)
 * @module tools/get-daily-note
 * @depends core/tool-registry, ports/vault, utils/local-datetime
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { VaultPort } from '../ports/vault';
import { optionalString } from './validate-args';
import {
	formatDailyNoteStem,
	formatLocalDateTime,
	parseLocalDateOnly,
} from '../utils/local-datetime';

/** 日记路径约定(来自 settings) */
export interface DailyNoteConfig {
	/** 日记文件夹,空串表示 vault 根 */
	folder: string;
	/** 文件名格式,默认 YYYY-MM-DD */
	format: string;
}

/**
 * 构造 `get_daily_note` 工具 — 只探测路径,不创建文件。
 *
 * @param vault - VaultPort
 * @param getConfig - 运行时读 settings(避免闭包过期)
 * @param definition - LLM schema
 */
export function createGetDailyNoteTool(
	vault: VaultPort,
	getConfig: () => DailyNoteConfig,
	definition: ToolDefinition,
): Tool {
	return {
		definition,
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			const config = getConfig();
			const dateArg = optionalString(args, 'date');
			let target: Date;
			let dateLabel: string;

			if (dateArg) {
				const parsed = parseLocalDateOnly(dateArg);
				if (!parsed) {
					return {
						path: null,
						exists: false,
						date: dateArg,
						message: `日期格式无效,请使用 YYYY-MM-DD(收到: ${dateArg})`,
					};
				}
				target = parsed;
				dateLabel = dateArg;
			} else {
				target = new Date();
				dateLabel = formatLocalDateTime(target).local.slice(0, 10);
			}

			const stem = formatDailyNoteStem(target, config.format || 'YYYY-MM-DD');
			const folder = (config.folder ?? '').replace(/^\/+|\/+$/g, '');
			const path = folder ? `${folder}/${stem}.md` : `${stem}.md`;
			const exists = await vault.fileExists(path);

			return {
				path,
				exists,
				date: dateLabel,
				message: exists
					? undefined
					: `日记文件不存在。可用 write_note 创建,或确认设置中的日记目录/格式(当前: folder="${folder || '(根)'}", format="${config.format || 'YYYY-MM-DD'}")。`,
			};
		},
	};
}
