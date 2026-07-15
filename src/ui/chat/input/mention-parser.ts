/**
 * @file src/ui/chat/input/mention-parser.ts
 * @description @mention 路径解析 — 提取/校验 vault 相对路径,不含 IO
 * @module ui/chat/input/mention-parser
 */

/** 匹配 `@path`(path 不含空白与第二个 @) */
const MENTION_RE = /@([^\s@]+)/g;

/**
 * 从用户输入提取 @mention 路径列表(去重,保序)。
 *
 * @param text - 输入或待发送全文
 * @returns vault 相对路径数组(未再校验安全性)
 */
export function extractMentions(text: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	MENTION_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = MENTION_RE.exec(text)) !== null) {
		const raw = m[1] ?? '';
		if (!raw || seen.has(raw)) continue;
		seen.add(raw);
		out.push(raw);
	}
	return out;
}

/**
 * 格式化为插入 textarea 的 token(尾随空格便于继续打字)。
 *
 * @param path - vault 相对路径
 */
export function formatMentionToken(path: string): string {
	return `@${path} `;
}

/**
 * 是否可作为安全的 vault 相对 mention 路径。
 *
 * 拒绝:空、`..`、Windows 盘符、POSIX 绝对(`/Users/...`)、剥前导 / 后仍像系统绝对路径。
 *
 * @param path - 候选路径(可含或不含前导 @)
 */
export function isSafeVaultMentionPath(path: string): boolean {
	const p = path.replace(/^@/, '').trim();
	if (!p) return false;
	if (/(^|[/\\])\.\.([/\\]|$)/.test(p)) return false;
	if (/^[A-Za-z]:[/\\]/.test(p)) return false;
	// 真正的 POSIX 绝对路径(粘贴自 Finder)
	if (p.startsWith('/')) return false;
	// validateVaultPath 剥掉前导 / 后的「假相对」:Users/...、home/...
	if (/^(Users|home|private|var|tmp)\//i.test(p)) return false;
	return true;
}

/**
 * 从 textarea 光标前文本解析正在输入的 @ 查询(无空格)。
 *
 * @param textBeforeCursor - 光标前子串
 * @returns 查询串(不含 @);未在 mention 态返回 null
 */
export function parseActiveMentionQuery(textBeforeCursor: string): string | null {
	const at = textBeforeCursor.lastIndexOf('@');
	if (at < 0) return null;
	const after = textBeforeCursor.slice(at + 1);
	if (after.includes(' ') || after.includes('\n')) return null;
	// 关键路径:@ 前若是单词字符,视为邮箱等,不触发
	if (at > 0) {
		const prev = textBeforeCursor[at - 1]!;
		if (/[A-Za-z0-9_]/.test(prev)) return null;
	}
	return after;
}
