/**
 * @file src/ui/chat/input/mention-suggest.ts
 * @description @mention 补全建议 — 纯函数,无 IO
 * @module ui/chat/input/mention-suggest
 */

/** 默认最多返回条数(性能硬约束) */
export const MENTION_SUGGEST_LIMIT = 20;

/**
 * 按 query 过滤 vault 路径列表。
 *
 * - 空 query:返回前 limit 条
 * - 非空:path 或 basename 小写 includes;basename 命中优先
 *
 * @param query - `@` 后的查询(不含 @)
 * @param paths - vault 相对路径全集
 * @param limit - 上限,默认 20
 */
export function suggestMentions(
	query: string,
	paths: readonly string[],
	limit: number = MENTION_SUGGEST_LIMIT,
): string[] {
	const q = query.trim().toLowerCase();
	const cap = Math.max(1, Math.min(limit, MENTION_SUGGEST_LIMIT));
	if (!q) {
		return paths.slice(0, cap);
	}

	type Hit = { path: string; score: number };
	const hits: Hit[] = [];
	for (const path of paths) {
		const lower = path.toLowerCase();
		const slash = lower.lastIndexOf('/');
		const base = slash >= 0 ? lower.slice(slash + 1) : lower;
		let score = 0;
		if (base.includes(q)) score = 2;
		else if (lower.includes(q)) score = 1;
		else continue;
		hits.push({ path, score });
	}
	hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
	return hits.slice(0, cap).map((h) => h.path);
}

/**
 * 取路径 basename(展示用)。
 *
 * @param path - vault 相对路径
 */
export function mentionBasename(path: string): string {
	const i = path.lastIndexOf('/');
	return i >= 0 ? path.slice(i + 1) : path;
}
