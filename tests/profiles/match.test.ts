/**
 * @file tests/profiles/match.test.ts
 * @description 匹配权重与 draft 不进池
 * @module profiles/match.test
 */
import { describe, it, expect } from 'vitest';
import { matchProfiles } from '../../src/profiles/match';
import type { PluginProfile } from '../../src/profiles/types';

function p(over: Partial<PluginProfile> & Pick<PluginProfile, 'id'>): PluginProfile {
	return {
		kind: 'obsidian-plugin-profile',
		pluginId: 'calendar',
		pluginName: 'Calendar',
		pluginVersionRange: '*',
		install: { source: 'community-store' },
		forbid: [],
		presets: [{ id: 'week-start-monday', when: '周一开始', patch: { weekStart: 1 } }],
		enabled: true,
		...over,
	};
}

describe('matchProfiles', () => {
	it('matchProfiles - enabled false 或 draft 标记 - 不进结果', () => {
		const hits = matchProfiles([p({ id: 'a', enabled: false })], { utterance: '周一开始' });
		expect(hits).toEqual([]);
	});
	it('matchProfiles - utterance 周一开始 - presetId week-start-monday', () => {
		const hits = matchProfiles([p({ id: 'calendar-week-start' })], { utterance: '周一开始' });
		expect(hits[0]!.presetId).toBe('week-start-monday');
		expect(hits[0]!.score).toBeGreaterThanOrEqual(10);
	});
	it('matchProfiles - pluginId 精确 - +100', () => {
		const hits = matchProfiles([p({ id: 'x' })], { pluginId: 'calendar' });
		expect(hits[0]!.score).toBe(100);
	});
	it('matchProfiles - 无命中 - 空数组', () => {
		expect(matchProfiles([p({ id: 'x' })], { utterance: '看板' })).toEqual([]);
	});
	it('matchProfiles - 同分 - 按 profileId 字母序 最多 5', () => {
		const pool = ['e', 'c', 'a', 'd', 'b', 'f'].map((id) => p({ id, pluginId: 'cal' }));
		const hits = matchProfiles(pool, { pluginId: 'cal' });
		expect(hits).toHaveLength(5);
		expect(hits.map((h) => h.profileId)).toEqual(['a', 'b', 'c', 'd', 'e']);
	});
});
