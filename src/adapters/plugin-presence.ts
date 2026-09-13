/**
 * @file src/adapters/plugin-presence.ts
 * @description 只读探测 Obsidian 社区插件是否已安装/启用(S-SCENE-ECO 分期 A)
 * @module adapters/plugin-presence
 * @depends skills/ecosystem-types
 */

import type { PluginPresence } from '../skills/ecosystem-types';

/** Obsidian FileSystemAdapter 子集 — 不走 VaultPort,直接读 configDir */
export interface PluginPresenceAdapter {
	read(path: string): Promise<string>;
	exists(path: string): Promise<boolean>;
}

/**
 * 拼接 configDir 下的相对路径(vault 路径风格,正斜杠)。
 */
function configPath(configDir: string, ...segments: string[]): string {
	return [configDir, ...segments].join('/').replace(/\/+/g, '/');
}

/**
 * pluginId 含路径穿越片段时不探测 manifest,直接视为未安装。
 */
function isUnsafePluginId(pluginId: string): boolean {
	return pluginId.includes('/') || pluginId.includes('..');
}

/**
 * 创建只读插件在场端口 — 读 community-plugins.json 与 plugins/<id>/manifest.json。
 *
 * 设计要点:
 * - 使用 app.vault.adapter 子集,绕过 VaultPort(validateVaultPath 会拦截 configDir)
 * - community-plugins.json 缺失或解析失败时返回空启用列表,不抛错
 * - pluginId 含 `/` 或 `..` 时 isInstalled 恒 false
 *
 * @param adapter - Obsidian 文件系统适配器(read/exists)
 * @param configDir - app.vault.configDir(如 `.obsidian`)
 * @returns PluginPresence 端口实现
 */
export function createPluginPresence(
	adapter: PluginPresenceAdapter,
	configDir: string,
): PluginPresence {
	const communityPluginsPath = configPath(configDir, 'community-plugins.json');

	return {
		async listEnabled(): Promise<string[]> {
			try {
				const raw = await adapter.read(communityPluginsPath);
				const parsed: unknown = JSON.parse(raw);
				if (!Array.isArray(parsed)) return [];
				return parsed.filter((id): id is string => typeof id === 'string');
			} catch {
				return [];
			}
		},

		async isInstalled(pluginId: string): Promise<boolean> {
			if (isUnsafePluginId(pluginId)) return false;
			const manifestPath = configPath(configDir, 'plugins', pluginId, 'manifest.json');
			return adapter.exists(manifestPath);
		},
	};
}
