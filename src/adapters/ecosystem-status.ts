/**
 * @file src/adapters/ecosystem-status.ts
 * @description 本地已装列表与单插件 status
 * @module adapters/ecosystem-status
 */
import { RATEL_PLUGIN_ID } from '../utils/path-safety';
import { tNow } from '../i18n';
import { compareDottedVersion, type EcosystemRegistry } from './ecosystem-registry';
import type { EcosystemIo } from './ecosystem-vault';

export interface InstalledSummary {
	id: string;
	name: string;
	version: string;
	enabled: boolean;
}

/**
 * 列出当前库内已完整安装的社区插件(不含 ratel-vault),默认不出站。
 */
export async function listInstalledPlugins(deps: { io: EcosystemIo; configDir: string }): Promise<InstalledSummary[]> {
	const ids = (await deps.io.listPluginIds(deps.configDir)).filter((id) => id !== RATEL_PLUGIN_ID);
	let enabled: string[] = [];
	try {
		enabled = JSON.parse(await deps.io.readText(`${deps.configDir}/community-plugins.json`)) as string[];
		if (!Array.isArray(enabled)) enabled = [];
	} catch {
		enabled = [];
	}
	const out: InstalledSummary[] = [];
	for (const id of ids) {
		try {
			const man = JSON.parse(await deps.io.readText(`${deps.configDir}/plugins/${id}/manifest.json`)) as { id?: string; name?: string; version?: string };
			if (man.id !== id) continue;
			out.push({ id, name: man.name ?? id, version: man.version ?? '', enabled: enabled.includes(id) });
		} catch {
			/* 半成品跳过 */
		}
	}
	return out;
}

/**
 * 单插件安装/启用状态;checkUpdate 为 true 时才拉商店 HEAD manifest 比对版本。
 */
export async function getCommunityPluginStatus(
	pluginId: string,
	deps: { io: EcosystemIo; configDir: string; registry: EcosystemRegistry; checkUpdate: boolean; includeKeys: boolean },
): Promise<{
	installed: boolean;
	id?: string;
	name?: string;
	version?: string;
	enabled?: boolean;
	directoryExists?: boolean;
	keys?: string[];
	catalogVersion?: string | null;
	updateAvailable?: boolean;
	message?: string;
}> {
	const pluginRel = `${deps.configDir}/plugins/${pluginId}`;
	const directoryExists = await deps.io.exists(pluginRel);
	if (!directoryExists) return { installed: false, id: pluginId, directoryExists: false };
	let man: { id?: string; name?: string; version?: string } = {};
	try {
		man = JSON.parse(await deps.io.readText(`${pluginRel}/manifest.json`)) as typeof man;
	} catch {
		return { installed: false, id: pluginId, directoryExists: true };
	}
	if (man.id !== pluginId) return { installed: false, id: pluginId, directoryExists: true };
	const list = await listInstalledPlugins(deps);
	const row = list.find((p) => p.id === pluginId);
	const result: Awaited<ReturnType<typeof getCommunityPluginStatus>> = {
		installed: true,
		id: pluginId,
		name: man.name ?? pluginId,
		version: man.version ?? '',
		enabled: row?.enabled ?? false,
		directoryExists: true,
	};
	if (deps.includeKeys) {
		try {
			const data = JSON.parse(await deps.io.readText(`${pluginRel}/data.json`)) as Record<string, unknown>;
			result.keys = Object.keys(data);
		} catch {
			result.keys = [];
		}
	}
	if (deps.checkUpdate) {
		try {
			const catalog = await deps.registry.ensureCatalog();
			const entry = catalog.plugins.find((p) => p.id === pluginId);
			if (!entry) {
				result.catalogVersion = null;
				result.updateAvailable = false;
				result.message = tNow('error.ecosystem.notInCatalog', { id: pluginId });
			} else {
				const resolved = await deps.registry.resolveReleaseVersion(entry.repo, '99.0.0');
				result.catalogVersion = resolved.version;
				result.updateAvailable = compareDottedVersion(resolved.version, man.version ?? '0') === 1;
			}
		} catch (e) {
			result.catalogVersion = null;
			result.updateAvailable = false;
			result.message = e instanceof Error ? e.message : String(e);
		}
	}
	return result;
}
