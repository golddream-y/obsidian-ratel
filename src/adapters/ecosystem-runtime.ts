/**
 * @file src/adapters/ecosystem-runtime.ts
 * @description 未文档 app.plugins 热启用 — 全部 typeof 守卫,失败诚实降级(ADR-018)
 * @module adapters/ecosystem-runtime
 */

export interface EnableAttempt {
	enabled: boolean;
	usedInternalApi: boolean;
}

type PluginsHost = {
	loadManifest?: (dir: string) => void | Promise<void>;
	loadManifests?: () => void | Promise<void>;
	enablePluginAndSave?: (id: string) => void | Promise<void>;
	getPlugin?: (id: string) => unknown;
	plugins?: Record<string, unknown>;
	enabledPlugins?: Set<string> | string[];
};

/**
 * 尽力启用已写入目录的社区插件。缺方法或抛错 → enabled=false,不假装成功。
 *
 * @param appLike - 宿主 app(只取 plugins)
 * @param pluginId - 目标 id
 * @param pluginFolder - `{configDir}/plugins/{id}` vault 相对路径,供 loadManifest
 */
export async function tryEnableCommunityPlugin(
	appLike: { plugins?: PluginsHost },
	pluginId: string,
	pluginFolder: string,
): Promise<EnableAttempt> {
	const plugins = appLike.plugins;
	if (!plugins) return { enabled: false, usedInternalApi: false };
	try {
		if (typeof plugins.loadManifest === 'function') {
			await plugins.loadManifest(pluginFolder);
		} else if (typeof plugins.loadManifests === 'function') {
			await plugins.loadManifests();
		}
		if (typeof plugins.enablePluginAndSave === 'function') {
			await plugins.enablePluginAndSave(pluginId);
		} else {
			return { enabled: false, usedInternalApi: false };
		}
		const instance = typeof plugins.getPlugin === 'function' ? plugins.getPlugin(pluginId) : plugins.plugins?.[pluginId];
		return { enabled: Boolean(instance), usedInternalApi: true };
	} catch {
		return { enabled: false, usedInternalApi: true };
	}
}
