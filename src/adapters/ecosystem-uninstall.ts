/**
 * @file src/adapters/ecosystem-uninstall.ts
 * @description 备份后禁用并删除社区插件目录
 * @module adapters/ecosystem-uninstall
 */
import { RATEL_PLUGIN_ID } from '../utils/path-safety';
import { tNow } from '../i18n';
import { withPluginLock } from '../core/ecosystem-lock';
import { appendEcosystemChange } from '../core/ecosystem-change-log';
import { snapshotPluginDir } from '../core/ecosystem-backup';
import type { EcosystemIo } from './ecosystem-vault';
import { tryDisableCommunityPlugin } from './ecosystem-runtime';

/**
 * 备份、禁用、从启用清单移除并删除插件目录。
 *
 * @param pluginId - 社区插件 id
 * @param deps - io、pluginDir、configDir、写盘开关与 app 外观
 */
export async function uninstallCommunityPlugin(
	pluginId: string,
	deps: { io: EcosystemIo; pluginDir: string; configDir: string; writeEnabled: boolean; appLike: unknown },
): Promise<{ ok: boolean; backedUp: boolean; changeId: string; message: string }> {
	if (pluginId === RATEL_PLUGIN_ID) throw new Error(tNow('error.ecosystem.self'));
	if (!deps.writeEnabled) throw new Error(tNow('error.ecosystem.writeDisabled'));
	return withPluginLock(pluginId, async () => {
		const pluginRel = `${deps.configDir}/plugins/${pluginId}`;
		if (!(await deps.io.exists(pluginRel))) {
			throw new Error(tNow('error.ecosystem.notInstalled', { id: pluginId }));
		}
		const enableListRel = `${deps.configDir}/community-plugins.json`;
		let enabledIds: string[] = [];
		try {
			enabledIds = JSON.parse(await deps.io.readText(enableListRel)) as string[];
			if (!Array.isArray(enabledIds)) enabledIds = [];
		} catch {
			enabledIds = [];
		}
		const change = await appendEcosystemChange(deps.pluginDir, {
			action: 'uninstall',
			pluginId,
			summary: pluginId,
			before: { enabledIds },
		});
		await snapshotPluginDir({ pluginDir: deps.pluginDir, changeId: change.id, io: deps.io, pluginRel });
		await tryDisableCommunityPlugin(deps.appLike as { plugins?: Parameters<typeof tryDisableCommunityPlugin>[0]['plugins'] }, pluginId);
		const next = enabledIds.filter((id) => id !== pluginId);
		await deps.io.writeText(enableListRel, JSON.stringify(next, null, 2));
		await deps.io.removeRecursive(pluginRel);
		return { ok: true, backedUp: true, changeId: change.id, message: tNow('ecosystem.uninstall.done', { id: pluginId }) };
	});
}
