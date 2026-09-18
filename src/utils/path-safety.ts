/**
 * @file src/utils/path-safety.ts
 * @description Vault 路径沙箱 — 所有文件操作前的硬性边界校验
 * @module utils/path-safety
 */

import { tNow } from '../i18n';

// 关键路径:Obsidian 配置目录名可由用户自定义,启动期由 main.ts 调 setConfigDir
// 注入 app.vault.configDir 的实际值,此模块不硬编码任何目录名。
let configDirName = '';

/**
 * 启动期注入 Obsidian 实际 configDir(来自 app.vault.configDir)。
 * 必须在插件 onload 阶段调用一次,之后 validateVaultPath / isExcludedVaultPath 才能正确拦截。
 *
 * @param name - app.vault.configDir 返回的配置目录名(可能为非默认值)
 */
export function setConfigDir(name: string): void {
	configDirName = name;
}

/**
 * 当前注入的 configDir 名(可能为空,若尚未 setConfigDir)。
 */
export function getConfigDirName(): string {
	return configDirName;
}

/** Ratel 自身插件 id — 通道 B 永拒,禁止管理自己 */
export const RATEL_PLUGIN_ID = 'ratel-vault';

export interface EcosystemPathContext {
	/** 官方商店清单内的 id */
	catalogIds: ReadonlySet<string>;
	/** 本地 plugins/ 下已存在的 id(下架后仍可卸载) */
	installedIds: ReadonlySet<string>;
}

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
 *
 * 关键路径:单个前导 `/`(如 `/notes/foo.md`)被视为 vault 根的相对路径,
 * 归一化为 `notes/foo.md`,不抛错 — 模型常用 `/` 表示 vault 根,这是合理输入。
 * Windows 盘符绝对路径(`C:\...`)仍视为真正的系统绝对路径,拒绝。
 * @throws 路径越界(.. 穿越、Windows 盘符绝对路径)时抛错
 */
export function validateVaultPath(path: string): string {
	if (!path || typeof path !== 'string') {
		throw new Error(tNow('error.path.empty'));
	}

	if (/(^|[/\\])\.\.([/\\]|$)/.test(path)) {
		throw new Error(tNow('error.path.traversal', { path }));
	}

	// 关键路径:Windows 盘符绝对路径(C:\、D:\)是真正的系统绝对路径,拒绝。
	// 单个前导 `/` 视为 vault 根的相对路径写法,归一化时去掉,不抛错。
	if (/^[A-Za-z]:[/\\]/.test(path)) {
		throw new Error(tNow('error.path.absolute', { path }));
	}

	const normalized = normalizeVaultPath(path);

	if (normalized.includes('..')) {
		throw new Error(tNow('error.path.traversal', { path }));
	}

	// 关键路径:用启动期注入的 configDirName 拦截配置目录访问,兼容用户自定义 configDir。
	if (normalized === configDirName || normalized.startsWith(`${configDirName}/`)) {
		throw new Error(tNow('error.path.configDir', { path }));
	}

	if (normalized === '.trash' || normalized.startsWith('.trash/')) {
		throw new Error(tNow('error.path.trash', { path }));
	}

	return normalized;
}

function assertSafeVaultRelativePath(path: string): string {
	if (!path || typeof path !== 'string') {
		throw new Error(tNow('error.path.empty'));
	}

	if (/(^|[/\\])\.\.([/\\]|$)/.test(path)) {
		throw new Error(tNow('error.path.traversal', { path }));
	}

	if (/^[A-Za-z]:[/\\]/.test(path)) {
		throw new Error(tNow('error.path.absolute', { path }));
	}

	const normalized = normalizeVaultPath(path);

	if (normalized.includes('..')) {
		throw new Error(tNow('error.path.traversal', { path }));
	}

	return normalized;
}

/**
 * 通道 B:仅放行生态写盘白名单(ADR-018)。
 *
 * 允许:
 * - `{configDir}/community-plugins.json`
 * - `{configDir}/plugins/{id}/**` 且 id ≠ ratel-vault,且 id 在清单或本地已装集合中
 *
 * 禁止缝进 ObsidianVault;笔记工具必须继续走 validateVaultPath。
 *
 * @param path - vault 相对路径
 * @param ctx - 已校验的商店 id 与本地已装 id
 * @returns 归一化路径
 * @throws 越界、未知 id、管理自身、非白名单配置文件
 */
export function validateEcosystemPath(path: string, ctx: EcosystemPathContext): string {
	const normalized = assertSafeVaultRelativePath(path);
	const cfg = configDirName;
	if (!cfg) {
		throw new Error(tNow('error.path.ecosystem', { path }));
	}

	if (normalized === `${cfg}/community-plugins.json`) {
		return normalized;
	}

	const prefix = `${cfg}/plugins/`;
	if (!normalized.startsWith(prefix)) {
		throw new Error(tNow('error.path.ecosystem', { path }));
	}

	const rest = normalized.slice(prefix.length);
	const slash = rest.indexOf('/');
	const id = slash === -1 ? rest : rest.slice(0, slash);
	if (!id) {
		throw new Error(tNow('error.path.ecosystem', { path }));
	}
	if (id === RATEL_PLUGIN_ID) {
		throw new Error(tNow('error.path.ratelSelf', { path }));
	}
	if (!ctx.catalogIds.has(id) && !ctx.installedIds.has(id)) {
		throw new Error(tNow('error.path.unknownPlugin', { path, id }));
	}
	return normalized;
}

/**
 * 是否纳入向量索引 — 全量扫描只扫 Markdown;增量也必须同一口径。
 *
 * 关键路径:库内 png/pdf 等二进制若当笔记去 chunk+embed,会长时间卡在排队/处理中。
 *
 * @param vaultRelativePath - vault 相对路径
 */
export function isIndexableMarkdownPath(vaultRelativePath: string): boolean {
	const normalized = vaultRelativePath.replace(/\\/g, '/');
	const base = normalized.slice(normalized.lastIndexOf('/') + 1);
	return base.toLowerCase().endsWith('.md');
}

/** grep/glob 用:排除插件配置与回收站目录下的文件 */
export function isExcludedVaultPath(filePath: string): boolean {
	// 关键路径:用启动期注入的 configDirName 拦截配置目录,兼容用户自定义 configDir。
	return (
		filePath === configDirName ||
		filePath.startsWith(`${configDirName}/`) ||
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
