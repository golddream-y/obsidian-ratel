/**
 * @file src/core/ecosystem-backup.ts
 * @description pluginDir/ecosystem-backups/<changeId>/
 * @module core/ecosystem-backup
 */
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { EcosystemIo } from '../adapters/ecosystem-vault';
import { markChangeStatus, readAllChanges } from './ecosystem-change-log';

const KEEP = 3;

/**
 * 将插件目录快照到 pluginDir/ecosystem-backups/<changeId>/,并淘汰超额旧备份。
 */
export async function snapshotPluginDir(opts: {
	pluginDir: string;
	changeId: string;
	io: EcosystemIo;
	pluginRel: string;
}): Promise<string> {
	const dstAbs = path.join(opts.pluginDir, 'ecosystem-backups', opts.changeId);
	await mkdir(dstAbs, { recursive: true });
	await opts.io.copyTree(opts.pluginRel, dstAbs);
	await expireOld(opts.pluginDir, opts.pluginRel);
	return dstAbs;
}

async function expireOld(pluginDir: string, pluginRel: string): Promise<void> {
	const pluginId = pluginRel.split('/').filter(Boolean).pop() ?? '';
	const recorded = (await readAllChanges(pluginDir)).filter((r) => r.pluginId === pluginId && r.status === 'recorded');
	const extra = recorded.length - KEEP;
	if (extra <= 0) return;
	for (const row of recorded.slice(0, extra)) {
		await rm(path.join(pluginDir, 'ecosystem-backups', row.id), { recursive: true, force: true });
		await markChangeStatus(pluginDir, row.id, 'expired');
	}
}

/**
 * 从快照目录还原到 vault 内插件相对路径。
 */
export async function restoreSnapshot(opts: {
	pluginDir: string;
	changeId: string;
	io: EcosystemIo;
	pluginRel: string;
}): Promise<void> {
	const srcAbs = path.join(opts.pluginDir, 'ecosystem-backups', opts.changeId);
	await opts.io.restoreTree(srcAbs, opts.pluginRel);
}
