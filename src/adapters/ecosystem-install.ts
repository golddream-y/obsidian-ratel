/**
 * @file src/adapters/ecosystem-install.ts
 * @description 安装编排 — R2 写盘+尽力启用 / R3 打开官方页(ADR-018)
 * @module adapters/ecosystem-install
 */

import { RATEL_PLUGIN_ID } from '../utils/path-safety';
import { tNow } from '../i18n';
import type { EcosystemRegistry } from './ecosystem-registry';
import type { EcosystemIo } from './ecosystem-vault';
import { tryEnableCommunityPlugin } from './ecosystem-runtime';

export const OFFICIAL_SHOW_PLUGIN = (id: string): string => `obsidian://show-plugin?id=${encodeURIComponent(id)}`;

export interface InstallResult {
	ok: boolean;
	mode: 'write' | 'official-page';
	pluginId: string;
	filesWritten?: boolean;
	enabled?: boolean;
	officialUri?: string;
	message: string;
	version?: string;
}

export interface InstallDeps {
	registry: EcosystemRegistry;
	io: EcosystemIo;
	configDir: string;
	writeEnabled: boolean;
	apiVersion: string;
	openOfficialPage: (uri: string) => Promise<void>;
	/** 宿主 app;只读取未文档 plugins */
	appLike: unknown;
}

/**
 * 安装官方清单内插件。writeEnabled=false 时零写盘,只打开官方页。
 */
export async function installCommunityPlugin(pluginId: string, deps: InstallDeps): Promise<InstallResult> {
	if (pluginId === RATEL_PLUGIN_ID) {
		throw new Error(tNow('error.ecosystem.self'));
	}
	const catalog = await deps.registry.ensureCatalog();
	const entry = catalog.plugins.find((p) => p.id === pluginId);
	if (!entry) {
		throw new Error(tNow('error.ecosystem.notInCatalog', { id: pluginId }));
	}

	if (!deps.writeEnabled) {
		const uri = OFFICIAL_SHOW_PLUGIN(pluginId);
		await deps.openOfficialPage(uri);
		return {
			ok: true,
			mode: 'official-page',
			pluginId,
			officialUri: uri,
			filesWritten: false,
			enabled: false,
			message: tNow('ecosystem.install.officialPage', { id: pluginId, uri }),
		};
	}

	const pluginDirRel = `${deps.configDir}/plugins/${pluginId}`;
	const enableListRel = `${deps.configDir}/community-plugins.json`;
	try {
		const resolved = await deps.registry.resolveReleaseVersion(entry.repo, deps.apiVersion);
		if (resolved.manifestId !== pluginId) {
			throw new Error(tNow('error.ecosystem.manifestIdMismatch'));
		}
		const triple = await deps.registry.downloadTriple(entry.repo, resolved.version);
		const man = JSON.parse(triple.manifestText) as { id?: string };
		if (man.id !== pluginId) {
			throw new Error(tNow('error.ecosystem.manifestIdMismatch'));
		}
		await deps.io.mkdir(pluginDirRel);
		await deps.io.writeText(`${pluginDirRel}/manifest.json`, triple.manifestText);
		await deps.io.writeBinary(`${pluginDirRel}/main.js`, triple.mainJs);
		if (triple.stylesCss != null) {
			await deps.io.writeText(`${pluginDirRel}/styles.css`, triple.stylesCss);
		}

		let enabledIds: string[] = [];
		try {
			enabledIds = JSON.parse(await deps.io.readText(enableListRel)) as string[];
			if (!Array.isArray(enabledIds)) enabledIds = [];
		} catch {
			enabledIds = [];
		}
		if (!enabledIds.includes(pluginId)) enabledIds.push(pluginId);
		await deps.io.writeText(enableListRel, JSON.stringify(enabledIds, null, 2));

		const enable = await tryEnableCommunityPlugin(
			deps.appLike as { plugins?: Parameters<typeof tryEnableCommunityPlugin>[0]['plugins'] },
			pluginId,
			pluginDirRel,
		);
		return {
			ok: true,
			mode: 'write',
			pluginId,
			filesWritten: true,
			enabled: enable.enabled,
			version: resolved.version,
			message: enable.enabled
				? tNow('ecosystem.install.enabled', { id: pluginId, version: resolved.version })
				: tNow('ecosystem.install.filesOnly', { id: pluginId, version: resolved.version }),
		};
	} catch (err) {
		try {
			await deps.io.removeRecursive(pluginDirRel);
		} catch {
			/* 半成品清理失败时仍抛原错误,调用方可看残留 */
		}
		throw err;
	}
}
