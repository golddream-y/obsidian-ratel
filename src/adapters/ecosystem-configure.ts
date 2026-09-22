/**
 * @file src/adapters/ecosystem-configure.ts
 * @description 点名读写他人 data.json
 * @module adapters/ecosystem-configure
 */
import { tNow } from '../i18n';
import { applyLeafPatch, FORBID_KEY_RE, parseSettingKey } from '../utils/setting-path';
import { withPluginLock } from '../core/ecosystem-lock';
import { appendEcosystemChange } from '../core/ecosystem-change-log';
import { snapshotPluginDir } from '../core/ecosystem-backup';
import type { EcosystemIo } from './ecosystem-vault';

function rel(configDir: string, id: string): string {
	return `${configDir}/plugins/${id}`;
}

async function installed(io: EcosystemIo, pluginRel: string, pluginId: string): Promise<boolean> {
	try {
		const man = JSON.parse(await io.readText(`${pluginRel}/manifest.json`)) as { id?: string };
		return man.id === pluginId;
	} catch {
		return false;
	}
}

function flattenKeys(obj: Record<string, unknown>, prefix = '', depth = 0): string[] {
	if (depth >= 6) return prefix ? [prefix] : [];
	const keys: string[] = [];
	for (const [k, v] of Object.entries(obj)) {
		const path = prefix ? `${prefix}.${k}` : k;
		if (v && typeof v === 'object' && !Array.isArray(v)) keys.push(...flattenKeys(v as Record<string, unknown>, path, depth + 1));
		else keys.push(path);
	}
	return keys;
}

export async function inspectPluginData(pluginId: string, deps: { io: EcosystemIo; configDir: string }) {
	if (!(await installed(deps.io, rel(deps.configDir, pluginId), pluginId))) {
		throw new Error(tNow('error.ecosystem.notInstalled', { id: pluginId }));
	}
	let data: Record<string, unknown> = {};
	try { data = JSON.parse(await deps.io.readText(`${rel(deps.configDir, pluginId)}/data.json`)) as Record<string, unknown>; } catch { data = {}; }
	const keys = flattenKeys(data);
	const values: Record<string, unknown> = {};
	for (const k of keys) {
		const segs = parseSettingKey(k);
		let cur: unknown = data;
		for (const s of segs) cur = (cur as Record<string, unknown>)?.[s];
		values[k] = FORBID_KEY_RE.test(k.split('.').pop() ?? k) ? '***' : cur;
	}
	return { keys, values };
}

export async function applyPluginData(
	pluginId: string,
	patch: Record<string, unknown>,
	deps: { io: EcosystemIo; pluginDir: string; configDir: string; writeEnabled: boolean; confirmedNewKeys: string[]; forbidKeys?: string[] },
) {
	if (!deps.writeEnabled) throw new Error(tNow('error.ecosystem.writeDisabled'));
	return withPluginLock(pluginId, async () => {
		const pluginRel = rel(deps.configDir, pluginId);
		if (!(await installed(deps.io, pluginRel, pluginId))) throw new Error(tNow('error.ecosystem.notInstalled', { id: pluginId }));
		for (const k of Object.keys(patch)) {
			if (FORBID_KEY_RE.test(k) || deps.forbidKeys?.includes(k)) throw new Error(tNow('error.ecosystem.badKey', { key: k }));
		}
		let data: Record<string, unknown> = {};
		try { data = JSON.parse(await deps.io.readText(`${pluginRel}/data.json`)) as Record<string, unknown>; } catch { data = {}; }
		const existing = new Set(flattenKeys(data));
		for (const k of Object.keys(patch)) {
			if (!existing.has(k) && !deps.confirmedNewKeys.includes(k)) {
				throw new Error(tNow('error.ecosystem.newKey', { key: k }));
			}
		}
		const next = applyLeafPatch(data, patch);
		const change = await appendEcosystemChange(deps.pluginDir, { action: 'configure', pluginId, summary: Object.keys(patch).join(','), before: data, after: next });
		await snapshotPluginDir({ pluginDir: deps.pluginDir, changeId: change.id, io: deps.io, pluginRel });
		const tmp = `${pluginRel}/data.json.tmp`;
		await deps.io.writeText(tmp, JSON.stringify(next, null, 2));
		JSON.parse(await deps.io.readText(tmp));
		await deps.io.rename(tmp, `${pluginRel}/data.json`);
		return { changed: Object.keys(patch).map((key) => ({ key, before: (data as Record<string, unknown>)[key], after: patch[key] })), changeId: change.id };
	});
}
