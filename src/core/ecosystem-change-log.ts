/**
 * @file src/core/ecosystem-change-log.ts
 * @description pluginDir/ecosystem-changes.jsonl
 * @module core/ecosystem-change-log
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type EcosystemAction = 'install' | 'update' | 'uninstall' | 'configure' | 'restore';
export type ChangeStatus = 'recorded' | 'restored' | 'expired';

export interface EcosystemChange {
	id: string;
	time: string;
	action: EcosystemAction;
	pluginId: string;
	summary: string;
	before?: unknown;
	after?: unknown;
	backupPath?: string;
	status: ChangeStatus;
}

function fileOf(pluginDir: string): string {
	return path.join(pluginDir, 'ecosystem-changes.jsonl');
}

/**
 * 读入 jsonl 全部行(文件不存在则空数组)。
 */
export async function readAllChanges(pluginDir: string): Promise<EcosystemChange[]> {
	try {
		const text = await readFile(fileOf(pluginDir), 'utf-8');
		return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as EcosystemChange);
	} catch {
		return [];
	}
}

/**
 * 追加一条变更记录并返回完整行对象。
 */
export async function appendEcosystemChange(
	pluginDir: string,
	entry: { action: EcosystemAction; pluginId: string; summary: string; before?: unknown; after?: unknown; backupPath?: string; status?: ChangeStatus },
): Promise<EcosystemChange> {
	await mkdir(pluginDir, { recursive: true });
	const existing = await readAllChanges(pluginDir);
	const nextN = existing.length + 1;
	const row: EcosystemChange = {
		id: `ch_${String(nextN).padStart(6, '0')}`,
		time: new Date().toISOString(),
		status: entry.status ?? 'recorded',
		action: entry.action,
		pluginId: entry.pluginId,
		summary: entry.summary,
		before: entry.before,
		after: entry.after,
		backupPath: entry.backupPath,
	};
	await appendFile(fileOf(pluginDir), `${JSON.stringify(row)}\n`, 'utf-8');
	return row;
}

/**
 * 列出变更:默认新在前,可按 pluginId 过滤并限制条数。
 */
export async function listEcosystemChanges(
	pluginDir: string,
	opts?: { pluginId?: string; limit?: number },
): Promise<EcosystemChange[]> {
	const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 100);
	let rows = (await readAllChanges(pluginDir)).slice().reverse();
	if (opts?.pluginId) rows = rows.filter((r) => r.pluginId === opts.pluginId);
	return rows.slice(0, limit);
}

/** 过期改 status：不是业务 append。读入全部行，改匹配 id，整文件写回。 */
export async function markChangeStatus(pluginDir: string, id: string, status: ChangeStatus): Promise<void> {
	const rows = await readAllChanges(pluginDir);
	const next = rows.map((r) => (r.id === id ? { ...r, status } : r));
	await writeFile(fileOf(pluginDir), next.map((r) => JSON.stringify(r)).join('\n') + (next.length ? '\n' : ''), 'utf-8');
}
