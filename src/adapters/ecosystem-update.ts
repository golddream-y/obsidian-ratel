/**
 * @file src/adapters/ecosystem-update.ts
 * @description 只覆盖三件套的社区插件升级，保 data.json
 * @module adapters/ecosystem-update
 */
import { RATEL_PLUGIN_ID } from '../utils/path-safety';
import { tNow } from '../i18n';
import { withPluginLock } from '../core/ecosystem-lock';
import { appendEcosystemChange } from '../core/ecosystem-change-log';
import { restoreSnapshot, snapshotPluginDir } from '../core/ecosystem-backup';
import { compareDottedVersion } from './ecosystem-registry';
import { isCompleteInstall, OFFICIAL_SHOW_PLUGIN, type InstallDeps } from './ecosystem-install';
import { tryEnableCommunityPlugin } from './ecosystem-runtime';

export interface UpdateResult {
	ok: boolean;
	mode: 'write' | 'official-page' | 'already-current' | 'not-installed';
	pluginId: string;
	fromVersion?: string;
	toVersion?: string;
	dataJsonUnchanged: boolean;
	officialUri?: string;
	message: string;
}

export type UpdateDeps = InstallDeps & {
	confirmIncomparable?: (vers: { local: string; catalog: string }) => Promise<boolean>;
};

export async function updateCommunityPlugin(pluginId: string, deps: UpdateDeps): Promise<UpdateResult> {
	if (pluginId === RATEL_PLUGIN_ID) {
		throw new Error(tNow('error.ecosystem.self'));
	}
	return withPluginLock(pluginId, async () => {
		const pluginRel = `${deps.configDir}/plugins/${pluginId}`;
		if (!deps.writeEnabled) {
			const uri = OFFICIAL_SHOW_PLUGIN(pluginId);
			await deps.openOfficialPage(uri);
			return {
				ok: true,
				mode: 'official-page',
				pluginId,
				dataJsonUnchanged: true,
				officialUri: uri,
				message: tNow('ecosystem.install.officialPage', { id: pluginId, uri }),
			};
		}
		if (!(await isCompleteInstall(deps.io, pluginRel, pluginId))) {
			return {
				ok: false,
				mode: 'not-installed',
				pluginId,
				dataJsonUnchanged: true,
				message: tNow('error.ecosystem.notInstalled', { id: pluginId }),
			};
		}
		const catalog = await deps.registry.ensureCatalog();
		const entry = catalog.plugins.find((p) => p.id === pluginId);
		if (!entry) {
			throw new Error(tNow('error.ecosystem.notInCatalog', { id: pluginId }));
		}
		const localMan = JSON.parse(await deps.io.readText(`${pluginRel}/manifest.json`)) as { version?: string };
		const resolved = await deps.registry.resolveReleaseVersion(entry.repo, deps.apiVersion);
		if (resolved.manifestId !== pluginId) {
			throw new Error(tNow('error.ecosystem.manifestIdMismatch'));
		}
		const cmp = compareDottedVersion(resolved.version, localMan.version ?? '0');
		if (cmp === 0) {
			return {
				ok: true,
				mode: 'already-current',
				pluginId,
				fromVersion: localMan.version,
				toVersion: resolved.version,
				dataJsonUnchanged: true,
				message: tNow('ecosystem.update.current', { id: pluginId, version: resolved.version }),
			};
		}
		if (cmp !== null && cmp < 0) {
			throw new Error(tNow('error.ecosystem.noDowngrade', { local: localMan.version ?? '', catalog: resolved.version }));
		}
		if (cmp === null && (localMan.version ?? '') !== resolved.version) {
			const ok = deps.confirmIncomparable ? await deps.confirmIncomparable({ local: localMan.version ?? '', catalog: resolved.version }) : true;
			if (!ok) throw new Error(tNow('error.ecosystem.updateCancelled'));
		}
		let dataBefore = '';
		try { dataBefore = await deps.io.readText(`${pluginRel}/data.json`); } catch { dataBefore = ''; }
		const change = await appendEcosystemChange(deps.pluginDir, {
			action: 'update',
			pluginId,
			summary: `${localMan.version ?? '?'}→${resolved.version}`,
			before: { version: localMan.version },
			after: { version: resolved.version },
		});
		await snapshotPluginDir({ pluginDir: deps.pluginDir, changeId: change.id, io: deps.io, pluginRel });
		try {
			const triple = await deps.registry.downloadTriple(entry.repo, resolved.version);
			await deps.io.writeText(`${pluginRel}/manifest.json`, triple.manifestText);
			await deps.io.writeBinary(`${pluginRel}/main.js`, triple.mainJs);
			if (triple.stylesCss != null) {
				await deps.io.writeText(`${pluginRel}/styles.css`, triple.stylesCss);
			}
			let dataAfter = '';
			try { dataAfter = await deps.io.readText(`${pluginRel}/data.json`); } catch { dataAfter = ''; }
			if (dataAfter !== dataBefore) {
				throw new Error(tNow('error.ecosystem.dataJsonTouched'));
			}
			const enable = await tryEnableCommunityPlugin(
				deps.appLike as { plugins?: Parameters<typeof tryEnableCommunityPlugin>[0]['plugins'] },
				pluginId,
				pluginRel,
			);
			return {
				ok: true,
				mode: 'write',
				pluginId,
				fromVersion: localMan.version,
				toVersion: resolved.version,
				dataJsonUnchanged: true,
				message: enable.enabled
					? tNow('ecosystem.update.enabled', { id: pluginId, from: localMan.version ?? '', to: resolved.version })
					: tNow('ecosystem.update.filesOnly', { id: pluginId, from: localMan.version ?? '', to: resolved.version }),
			};
		} catch (e) {
			await restoreSnapshot({ pluginDir: deps.pluginDir, changeId: change.id, io: deps.io, pluginRel });
			throw e;
		}
	});
}
