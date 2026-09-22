/**
 * @file src/profiles/match.ts
 * @description 池内打分，调用方已排除 draft/unknown
 * @module profiles/match
 */
import type { PluginProfile, ProfileMatchHit, ProfileMatchQuery } from './types';

/**
 * 在已过滤的档案池内按 query 打分并返回最多 5 条命中。
 *
 * @param pool - 可匹配的档案列表（不含 draft / unknown）
 * @param query - utterance、pluginId、tags 等查询条件
 * @returns 按分数降序、同分按 profileId 字母序排列的命中列表
 */
export function matchProfiles(pool: PluginProfile[], query: ProfileMatchQuery): ProfileMatchHit[] {
	const hits: ProfileMatchHit[] = [];
	for (const profile of pool) {
		if (profile.enabled === false) continue;
		let score = 0;
		const reasons: string[] = [];
		if (query.pluginId && query.pluginId === profile.pluginId) { score += 100; reasons.push('pluginId'); }
		if (query.tags?.length && profile.tags) {
			for (const t of query.tags) {
				if (profile.tags.includes(t)) { score += 20; reasons.push(`tag:${t}`); }
			}
		}
		const u = query.utterance?.toLowerCase() ?? '';
		if (u) {
			const fields = [profile.pluginName, profile.pluginId, ...(profile.tags ?? []), ...profile.presets.map((p) => p.when)];
			for (const f of fields) {
				if (f.toLowerCase().includes(u) || u.includes(f.toLowerCase())) { score += 10; reasons.push('utterance'); break; }
			}
		}
		if (score <= 0) continue;
		const preset = profile.presets.find((p) => u && p.when.toLowerCase().includes(u)) ?? profile.presets[0]!;
		hits.push({ profileId: profile.id, pluginId: profile.pluginId, presetId: preset.id, score, reasons });
	}
	hits.sort((a, b) => b.score - a.score || a.profileId.localeCompare(b.profileId));
	return hits.slice(0, 5);
}
