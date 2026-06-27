/**
 * @file src/ui/format-tool-display.ts
 * @description 工具调用展示名格式化 — 从 name + args 提取关键参数生成 UI 展示名
 * @module ui/format-tool-display
 * @depends types
 */

/**
 * 从工具名与参数生成 UI 展示名(如 `list_files Formatting`、`grep TODO`、`search_vault 向量检索`)。
 *
 * 设计要点:
 * - 集中管理 name+args → 展示名的映射,UI 与 agent-loop 都不散落格式化逻辑
 * - path 为 "." 或空时降级为 "/",保持非空展示
 * - pattern / query 截断到 30 字符,避免工具条被撑爆
 * - 未知工具或参数缺失时只返回 name,不抛错
 *
 * @param name - 工具名(如 `list_files`、`grep`)
 * @param args - 工具参数对象(运行时类型未知,内部按 name 提取)
 * @returns 展示名,格式 `工具名 关键参数`;无关键参数时仅返回工具名
 *
 * @example
 *   formatToolDisplayName('list_files', { path: 'Formatting/' }); // 'list_files Formatting/'
 *   formatToolDisplayName('grep', { pattern: 'TODO', path: 'daily/' }); // 'grep TODO'
 *   formatToolDisplayName('read_note', { path: '.' }); // 'read_note /'
 */
export function formatToolDisplayName(name: string, args: unknown): string {
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
			return p ? `${name} ${p}` : name;
		}
		case 'grep':
		case 'glob': {
			const pat = extractShort(obj.pattern);
			return pat ? `${name} ${pat}` : name;
		}
		case 'search_vault': {
			const q = extractShort(obj.query);
			return q ? `${name} ${q}` : name;
		}
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
