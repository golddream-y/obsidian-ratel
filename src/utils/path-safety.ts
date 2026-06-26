/**
 * @file src/utils/path-safety.ts
 * @description Vault 路径沙箱 — 所有文件操作前的硬性边界校验
 * @module utils/path-safety
 */

/**
 * Vault 相对路径归一化(对齐 Obsidian normalizePath 语义,避免测试环境依赖 obsidian 包)。
 */
function normalizeVaultPath(path: string): string {
	const parts = path.replace(/\\/g, '/').split('/');
	const result: string[] = [];
	for (const part of parts) {
		if (part === '' || part === '.') continue;
		if (part === '..') {
			result.pop();
			continue;
		}
		result.push(part);
	}
	return result.join('/');
}

/**
 * 校验路径是否在 vault 安全范围内,返回归一化后的路径。
 * @throws 路径越界时抛错
 */
export function validateVaultPath(path: string): string {
	if (!path || typeof path !== 'string') {
		throw new Error('路径不能为空');
	}

	if (/(^|[/\\])\.\.([/\\]|$)/.test(path)) {
		throw new Error(`路径越界:禁止使用 ".." 穿越 "${path}"`);
	}

	if (path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(path)) {
		throw new Error(`路径越界:不允许绝对路径 "${path}"`);
	}

	const normalized = normalizeVaultPath(path);

	if (normalized.includes('..')) {
		throw new Error(`路径越界:禁止使用 ".." 穿越 "${path}"`);
	}

	if (normalized === '.obsidian' || normalized.startsWith('.obsidian/')) {
		throw new Error(`路径越界:不允许访问 .obsidian 配置目录 "${path}"`);
	}

	if (normalized === '.trash' || normalized.startsWith('.trash/')) {
		throw new Error(`路径越界:不允许访问 .trash 回收站 "${path}"`);
	}

	return normalized;
}

/** grep/glob 用:排除插件配置与回收站目录下的文件 */
export function isExcludedVaultPath(filePath: string): boolean {
	return (
		filePath === '.obsidian' ||
		filePath.startsWith('.obsidian/') ||
		filePath === '.trash' ||
		filePath.startsWith('.trash/')
	);
}

/** 判断 filePath 是否在 dir 目录树下(dir 为空表示整个 vault) */
export function isUnderDirectory(filePath: string, dir: string): boolean {
	if (!dir) return true;
	const base = dir.replace(/\/$/, '');
	return filePath === base || filePath.startsWith(`${base}/`);
}
