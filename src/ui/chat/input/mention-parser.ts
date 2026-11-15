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
 * 整段粘贴是否像本机绝对路径(Finder / 资源管理器),而不是斜杠命令。
 *
 * 关键路径:`/goal 审查…` 以 `/` 开头但不是路径;不能用 startsWith('/') 一刀切。
 *
 * @param text - 剪贴板原文(可含前导 @)
 */
export function isPastedAbsoluteFsPath(text: string): boolean {
	const candidate = text.replace(/^@/, '').trim();
	if (!candidate) return false;
	if (/^[A-Za-z]:[/\\]/.test(candidate)) return true;
	if (/^(Users|home|private|var|tmp)\//i.test(candidate)) return true;
	if (/^\/(Users|home|private|var|tmp|Volumes|opt|etc)\//i.test(candidate)) return true;
	return false;
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

/**
 * 从粘贴文本里还原「被 URL 编码的库内笔记路径」。
 *
 * 场景:从浏览器、其他应用或 Obsidian 的「复制链接」拿到的路径常被整体百分号编码
 * (中文路径会变成 `%E6%9E%B6…`),直接粘进输入框会得到一串乱码。
 *
 * 设计要点:
 * - 只接受**相对路径**且必须以 `.md` 结尾;绝对路径仍按库外路径处理,不在这里转 mention。
 * - 拒绝含 `..` 的路径,避免借 `%2e%2e` 跳出库目录。
 * - 非编码、非链接形态的普通文本原样返回 null,不改变正常粘贴行为。
 *
 * @param text - 剪贴板文本
 * @returns 解码后的库内相对路径;不匹配返回 null
 */
export function parsePastedVaultLink(text: string): string | null {
	const raw = text.trim();
	if (!raw || raw.includes('\n')) return null;

	let candidate: string | null = null;
	if (/^obsidian:\/\//i.test(raw)) {
		try {
			candidate = new URL(raw).searchParams.get('file');
		} catch {
			return null;
		}
	} else if (/^app:\/\//i.test(raw)) {
		try {
			candidate = decodeURIComponent(new URL(raw).pathname.replace(/^\/+/, ''));
		} catch {
			return null;
		}
	} else if (/%[0-9a-f]{2}/i.test(raw)) {
		try {
			candidate = decodeURIComponent(raw);
		} catch {
			return null;
		}
	}

	if (candidate === null) return null;
	const path = candidate.replace(/^\.\//, '').trim();
	if (!path || !path.toLowerCase().endsWith('.md')) return null;
	if (/^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/')) return null;
	if (path.split(/[\\/]+/).some((segment) => segment === '..')) return null;
	return path.replace(/[\\/]+/g, '/');
}
