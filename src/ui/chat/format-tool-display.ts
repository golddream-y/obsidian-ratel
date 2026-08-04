/**
 * @file src/ui/format-tool-display.ts
 * @description 工具调用展示名格式化 — 从 name + args 提取关键参数生成 UI 展示名
 * @module ui/format-tool-display
 * @depends types, i18n
 */

import { tNow } from '../../i18n';
import type { StringKey } from '../../i18n/types';
import { parseMcpToolName } from '../mcp/parse-mcp-tool-name';

/**
 * 工具名 → i18n key 映射 — 集中管理所有已知工具的友好名模板。
 *
 * 关键路径:模板含 {path}/{pattern} 占位符的工具,仅在参数存在时才调 tNow,
 * 否则占位符会以字面量泄漏到 UI。
 */
const TOOL_NAME_KEY: Record<string, StringKey> = {
	list_files: 'tool.name.list_files',
	read_note: 'tool.name.read_note',
	write_note: 'tool.name.write_note',
	edit_note: 'tool.name.edit_note',
	delete_note: 'tool.name.delete_note',
	append_note: 'tool.name.append_note',
	grep: 'tool.name.grep',
	glob: 'tool.name.glob',
	search_vault: 'tool.name.search_vault',
	get_datetime: 'tool.name.get_datetime',
	get_active_note: 'tool.name.get_active_note',
	get_daily_note: 'tool.name.get_daily_note',
	list_recent_notes: 'tool.name.list_recent_notes',
	get_note_outline: 'tool.name.get_note_outline',
	get_links: 'tool.name.get_links',
	search_by_tag: 'tool.name.search_by_tag',
	search_by_property: 'tool.name.search_by_property',
	get_vault_structure: 'tool.name.get_vault_structure',
};

/**
 * 从工具名与参数生成 UI 展示名(如 `查看 daily.md`、`搜索 TODO`、`语义搜索`)。
 *
 * 设计要点:
 * - 集中管理 name+args → 展示名的映射,UI 与 agent-loop 都不散落格式化逻辑
 * - 展示名走 i18n(`tool.name.*`),跟随当前语言
 * - path 为 "." 或空时降级为 "/",保持非空展示
 * - pattern / query 截断到 30 字符,避免工具条被撑爆
 * - 含占位符的工具在参数缺失时降级返回 raw name,避免 `{path}` 字面量泄漏
 * - 未知工具或参数缺失时只返回 name,不抛错
 *
 * @param name - 工具名(如 `list_files`、`grep`)
 * @param args - 工具参数对象(运行时类型未知,内部按 name 提取)
 * @returns 展示名,格式 `本地化友好名 + 关键参数`;无关键参数时返回 raw name 或无占位符的友好名
 *
 * @example
 *   formatToolDisplayName('list_files', { path: 'Formatting/' }); // '列目录 Formatting/'(zh)
 *   formatToolDisplayName('grep', { pattern: 'TODO', path: 'daily/' }); // '搜索 TODO'(zh)
 *   formatToolDisplayName('read_note', { path: '.' }); // '查看 /'(zh)
 *   formatToolDisplayName('search_vault', { query: '向量检索' }); // '语义搜索'(zh)
 */
export interface FormatToolDisplayOptions {
	resolveMcpServerLabel?: (serverId: string) => string;
}

export function formatToolDisplayName(
	name: string,
	args: unknown,
	opts?: FormatToolDisplayOptions,
): string {
	const parsed = parseMcpToolName(name);
	if (parsed) {
		const server = opts?.resolveMcpServerLabel?.(parsed.serverId) ?? parsed.serverId;
		return tNow('tool.name.mcp', { server, tool: parsed.toolName });
	}

	// 关键路径:args 运行时类型不可信(LLM 可能传非对象),统一用守卫提取
	const obj = (args != null && typeof args === 'object') ? args as Record<string, unknown> : {};

	switch (name) {
		case 'list_files':
		case 'read_note':
		case 'write_note':
		case 'edit_note':
		case 'delete_note':
		case 'append_note': {
			const p = extractPath(obj.path);
			const key = TOOL_NAME_KEY[name];
			// 关键路径:参数存在时才用 i18n 模板,否则 {path} 占位符会以字面量泄漏
			// 关键路径:noUncheckedIndexedAccess 下 Record 索引可能 undefined,回退英文工具名。
			return p && key ? tNow(key, { path: p }) : name;
		}
		case 'grep':
		case 'glob': {
			const pat = extractShort(obj.pattern);
			const key = TOOL_NAME_KEY[name];
			return pat && key ? tNow(key, { pattern: pat }) : name;
		}
		case 'search_vault': {
			// search_vault 模板无占位符,直接返回本地化名
			return tNow('tool.name.search_vault');
		}
		case 'get_datetime':
			return tNow('tool.name.get_datetime');
		case 'get_active_note':
			return tNow('tool.name.get_active_note');
		case 'get_daily_note':
			return tNow('tool.name.get_daily_note');
		case 'list_recent_notes':
			return tNow('tool.name.list_recent_notes');
		case 'get_note_outline': {
			const p = extractPath(obj.path);
			const key = TOOL_NAME_KEY[name];
			return p && key ? tNow(key, { path: p }) : name;
		}
		case 'get_links': {
			const p = extractPath(obj.path);
			const key = TOOL_NAME_KEY[name];
			return p && key ? tNow(key, { path: p }) : name;
		}
		case 'search_by_tag': {
			const tag = extractShort(obj.tag);
			const key = TOOL_NAME_KEY[name];
			return tag && key ? tNow(key, { tag }) : name;
		}
		case 'search_by_property': {
			const keyName = extractShort(obj.key);
			const key = TOOL_NAME_KEY[name];
			return keyName && key ? tNow(key, { key: keyName }) : name;
		}
		case 'get_vault_structure':
			return tNow('tool.name.get_vault_structure');
		default:
			return name;
	}
}

/**
 * 提取路径参数 — "." 或空降级为 "/",其余原样返回。
 * 关键路径:mockup 展示 `list_files Formatting` 而非 `list_files .`。
 */
function extractPath(raw: unknown): string {
	if (typeof raw !== 'string' || raw.length === 0) return '';
	if (raw === '.' || raw === './') return '/';
	return raw;
}

/**
 * 提取短文本参数(pattern / query)— 截断到 30 字符,超出加省略号。
 * 关键路径:防止超长 pattern / query 撑爆工具条单行布局。
 */
function extractShort(raw: unknown): string {
	if (typeof raw !== 'string' || raw.length === 0) return '';
	return raw.length > 30 ? raw.slice(0, 30) + '…' : raw;
}
