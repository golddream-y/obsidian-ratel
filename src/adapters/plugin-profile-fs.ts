/**
 * @file src/adapters/plugin-profile-fs.ts
 * @description 档案三源加载
 * @module adapters/plugin-profile-fs
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { BUILTIN_CALENDAR_YAML } from '../profiles/builtin';
import { validateProfile } from '../profiles/validate';
import type { PluginProfile } from '../profiles/types';
import type { ProfileDiagnostic, LoadReport } from '../profiles/types';

type Source = 'builtin' | 'global' | 'vault';

type StoredProfile = PluginProfile & { source: Source };

export interface LoadedProfiles extends LoadReport {
	get(id: string): StoredProfile | undefined;
	matchPool: StoredProfile[];
}

function dirOf(source: Source, opts: { pluginDir: string; vaultRoot: string; homedir: string }): string {
	if (source === 'builtin') return path.join(opts.pluginDir, 'plugin-profiles');
	if (source === 'global') return path.join(opts.homedir, '.ratel', 'plugin-profiles');
	return path.join(opts.vaultRoot, '.ratel', 'plugin-profiles');
}

/**
 * 将内置 calendar 示例档案写入插件目录（仅当目标文件不存在时）。
 *
 * @param pluginDir - Ratel 插件数据目录
 */
export function syncBuiltinProfiles(pluginDir: string): void {
	const dir = path.join(pluginDir, 'plugin-profiles');
	mkdirSync(dir, { recursive: true });
	const dest = path.join(dir, 'calendar-week-start.yaml');
	if (!existsSync(dest)) writeFileSync(dest, BUILTIN_CALENDAR_YAML, 'utf-8');
}

/**
 * 从 builtin / global / vault 三源加载档案，后者覆盖前者 id。
 *
 * @param opts - 目录与官方清单 id（null 表示不校验 store id）
 * @returns 加载报告、按 id 查询与可匹配池
 */
export async function loadAllProfiles(opts: {
	pluginDir: string;
	vaultRoot: string;
	homedir: string;
	catalogIds: Set<string> | null;
}): Promise<LoadedProfiles> {
	const diagnostics: ProfileDiagnostic[] = [];
	const byId = new Map<string, StoredProfile>();
	for (const source of ['builtin', 'global', 'vault'] as const) {
		const dir = dirOf(source, opts);
		if (!existsSync(dir)) continue;
		const files = readdirSync(dir).filter((f) => /\.(ya?ml|json)$/.test(f)).sort();
		const seenHere = new Set<string>();
		for (const file of files) {
			const full = path.join(dir, file);
			const draft = file.includes('.draft.');
			let raw: unknown;
			try {
				const text = readFileSync(full, 'utf-8');
				raw = file.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
			} catch {
				diagnostics.push({ path: full, code: 'parseError', message: file });
				continue;
			}
			const v = validateProfile(raw);
			if (!v.ok) {
				const kind = raw && typeof raw === 'object' && !Array.isArray(raw)
					? (raw as Record<string, unknown>).kind
					: undefined;
				// 修复: 无法识别为档案顶层的 YAML（如 `: : not yaml`）记 parseError，与 schema 错误区分
				const code = kind === undefined ? 'parseError' : 'schemaInvalid';
				diagnostics.push({ path: full, code, message: v.errors.join(',') });
				continue;
			}
			const profile: StoredProfile = {
				...v.profile,
				enabled: draft ? false : v.profile.enabled !== false,
				source,
			};
			if (seenHere.has(profile.id)) {
				diagnostics.push({ profileId: profile.id, path: full, code: 'idCollision', message: profile.id });
				continue;
			}
			seenHere.add(profile.id);
			byId.set(profile.id, profile);
			if (draft) {
				diagnostics.push({ profileId: profile.id, path: full, code: 'draftSkipped', message: file });
				continue;
			}
			if (opts.catalogIds && !opts.catalogIds.has(profile.pluginId)) {
				diagnostics.push({ profileId: profile.id, path: full, code: 'unknownPluginId', message: profile.pluginId });
				continue;
			}
			if (opts.catalogIds === null) {
				diagnostics.push({ profileId: profile.id, path: full, code: 'unverifiedStoreId', message: profile.pluginId });
			}
		}
	}
	const pool = [...byId.values()].filter((p) => {
		if (p.enabled === false) return false;
		if (opts.catalogIds && !opts.catalogIds.has(p.pluginId)) return false;
		const skipped = diagnostics.some(
			(x) => x.profileId === p.id && (x.code === 'draftSkipped' || x.code === 'unknownPluginId'),
		);
		return !skipped;
	});
	return {
		loaded: byId.size,
		skipped: diagnostics.length,
		diagnostics,
		get: (id) => byId.get(id),
		matchPool: pool,
	};
}
