/**
 * @file src/adapters/ecosystem-install.ts
 * @description 安装编排 — R2 写盘+尽力启用 / R3 打开官方页(ADR-018)
 * @module adapters/ecosystem-install
 */

import { RATEL_PLUGIN_ID } from '../utils/path-safety';
import { tNow } from '../i18n';
import { withPluginLock } from '../core/ecosystem-lock';
import { appendEcosystemChange } from '../core/ecosystem-change-log';
import { snapshotPluginDir } from '../core/ecosystem-backup';
import type { EcosystemRegistry } from './ecosystem-registry';
import type { EcosystemIo } from './ecosystem-vault';
import { tryEnableCommunityPlugin } from './ecosystem-runtime';

export const OFFICIAL_SHOW_PLUGIN = (id: string): string => `obsidian://show-plugin?id=${encodeURIComponent(id)}`;

export interface InstallResult {
	ok: boolean;
	mode: 'write' | 'official-page' | 'already-installed';
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
	pluginDir: string;
}

export async function isCompleteInstall(io: EcosystemIo, pluginDirRel: string, pluginId: string): Promise<boolean> {
	try {
		const man = JSON.parse(await io.readText(`${pluginDirRel}/manifest.json`)) as { id?: string };
		return man.id === pluginId;
	} catch {
		return false;
	}
}

/**
 * 安装官方清单内插件。writeEnabled=false 时零写盘,只打开官方页。
 */
export async function installCommunityPlugin(pluginId: string, deps: InstallDeps): Promise<InstallResult> {
	if (pluginId === RATEL_PLUGIN_ID) {
		throw new Error(tNow('error.ecosystem.self'));
	}
	return withPluginLock(pluginId, async () => {
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

		const existed = await deps.io.exists(pluginDirRel);
		const complete = await isCompleteInstall(deps.io, pluginDirRel, pluginId);
		const created = !existed;
		if (existed && !complete) {
			await deps.io.removeRecursive(pluginDirRel);
		}

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
			if (await isCompleteInstall(deps.io, pluginDirRel, pluginId)) {
				return {
					ok: true,
					mode: 'already-installed',
					pluginId,
					filesWritten: false,
					message: tNow('ecosystem.install.already', { id: pluginId }),
				};
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
			const change = await appendEcosystemChange(deps.pluginDir, {
				action: 'install',
				pluginId,
				summary: `${pluginId}@${resolved.version}`,
			});
			await snapshotPluginDir({ pluginDir: deps.pluginDir, changeId: change.id, io: deps.io, pluginRel: pluginDirRel });
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
			if (created || (existed && !complete)) {
				try { await deps.io.removeRecursive(pluginDirRel); } catch { /* 半成品清理失败仍抛原错 */ }
			}
			throw err;
		}
	});
}
