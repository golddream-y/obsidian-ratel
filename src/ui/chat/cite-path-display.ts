/**
 * @file src/ui/chat/cite-path-display.ts
 * @description 引用 chip 路径可读截断 — 优先文件名 / 末两段
 * @module ui/chat/cite-path-display
 */

/**
 * 将 vault 相对路径截成 chip 可读短串。
 *
 * @param path - vault 相对路径
 * @param maxLen - 最大字符数,默认 28
 */
export function formatCitePath(path: string, maxLen = 28): string {
	const normalized = path.replace(/\\/g, '/').trim();
	if (!normalized) return normalized;
	if (normalized.length <= maxLen) return normalized;

	const parts = normalized.split('/').filter(Boolean);
	const file = parts[parts.length - 1] ?? normalized;
	if (file.length >= maxLen) {
		return '…' + file.slice(-(maxLen - 1));
	}
	if (parts.length >= 2) {
		const two = `${parts[parts.length - 2]}/${file}`;
		if (two.length <= maxLen) return two;
		const withEllipsis = '…/' + file;
		// 修复:…/file 可能比 maxLen 长 1–2,超长时回退到仅文件名截断
		if (withEllipsis.length <= maxLen) return withEllipsis;
		return '…' + file.slice(-(maxLen - 1));
	}
	return '…' + file.slice(-(maxLen - 1));
}
