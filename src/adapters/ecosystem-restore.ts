/**
 * @file src/adapters/ecosystem-restore.ts
 * @description 按 changeId 把备份拷回插件目录
 * @module adapters/ecosystem-restore
 */
import { tNow } from '../i18n';
import { appendEcosystemChange, readAllChanges } from '../core/ecosystem-change-log';
import { restoreSnapshot } from '../core/ecosystem-backup';
import { withPluginLock } from '../core/ecosystem-lock';
import type { EcosystemIo } from './ecosystem-vault';

/**
 * 从 ecosystem-backups 还原快照,并按变更记录的 before 写回 community-plugins.json。
 */
export async function restoreEcosystemBackup(
	changeId: string,
	deps: { io: EcosystemIo; pluginDir: string; configDir: string; writeEnabled: boolean },
): Promise<{ ok: boolean; restoredAction: string; message: string }> {
	if (!deps.writeEnabled) throw new Error(tNow('error.ecosystem.writeDisabled'));
	const rows = await readAllChanges(deps.pluginDir);
	const row = rows.find((r) => r.id === changeId);
	if (!row) throw new Error(tNow('error.ecosystem.unknownChange', { id: changeId }));
	if (row.status === 'expired') throw new Error(tNow('error.ecosystem.expiredChange', { id: changeId }));
	return withPluginLock(row.pluginId, async () => {
		const pluginRel = `${deps.configDir}/plugins/${row.pluginId}`;
		await restoreSnapshot({ pluginDir: deps.pluginDir, changeId, io: deps.io, pluginRel });
		const before = row.before as { enabledIds?: string[] } | undefined;
		if (Array.isArray(before?.enabledIds)) {
			await deps.io.writeText(`${deps.configDir}/community-plugins.json`, JSON.stringify(before.enabledIds, null, 2));
		}
		await appendEcosystemChange(deps.pluginDir, { action: 'restore', pluginId: row.pluginId, summary: changeId });
		return { ok: true, restoredAction: row.action, message: tNow('ecosystem.restore.done', { id: row.pluginId, action: row.action }) };
	});
}
