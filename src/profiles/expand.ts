/**
 * @file src/profiles/expand.ts
 * @description 展开 preset 为 configure_plugin 的 patch
 * @module profiles/expand
 */
import type { ProfilePreset } from './types';

/**
 * 将 preset.patch 展开为可写入的配置 patch，并标记需用户确认的新 key。
 *
 * @param opts - preset、forbid 列表、已有 key、可选的 selectedKeys 白名单
 * @returns patch 与 needsConfirm（不在 existingKeys 中的 key）
 */
export function expandPresetPatch(opts: {
	preset: ProfilePreset;
	forbid: string[];
	existingKeys: string[];
	selectedKeys?: string[];
}): { patch: Record<string, unknown>; needsConfirm: string[] } {
	const forbid = new Set(opts.forbid);
	const selected = opts.selectedKeys ? new Set(opts.selectedKeys) : null;
	const patch: Record<string, unknown> = {};
	const needsConfirm: string[] = [];
	for (const [k, v] of Object.entries(opts.preset.patch)) {
		if (forbid.has(k)) continue;
		if (selected && !selected.has(k)) continue;
		patch[k] = v;
		if (!opts.existingKeys.includes(k)) needsConfirm.push(k);
	}
	return { patch, needsConfirm };
}
