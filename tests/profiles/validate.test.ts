/**
 * @file tests/profiles/validate.test.ts
 * @description 档案 schema + 语义校验
 * @module profiles/validate.test
 */
import { describe, it, expect } from 'vitest';
import { validateProfile } from '../../src/profiles/validate';

const base = {
	kind: 'obsidian-plugin-profile',
	id: 'calendar-week-start',
	pluginId: 'calendar',
	pluginName: 'Calendar',
	pluginVersionRange: '>=1.0.0',
	install: { source: 'community-store' },
	forbid: ['apiKey'],
	presets: [{ id: 'week-start-monday', when: '周一开始', patch: { weekStart: 1 } }],
};

describe('validateProfile', () => {
	it('validateProfile - 合法档案 - ok', () => {
		const r = validateProfile(base);
		expect(r.ok).toBe(true);
	});
	it('validateProfile - forbid 与 patch 相交 - 拒绝', () => {
		const r = validateProfile({ ...base, presets: [{ id: 'x', when: 'a', patch: { apiKey: 'no' } }] });
		expect(r.ok).toBe(false);
	});
	it('validateProfile - pluginId ratel-vault - 拒绝', () => {
		expect(validateProfile({ ...base, pluginId: 'ratel-vault' }).ok).toBe(false);
	});
	it('validateProfile - 非法 range caret - 拒绝', () => {
		expect(validateProfile({ ...base, pluginVersionRange: '^1.0.0' }).ok).toBe(false);
	});
	it('validateProfile - 重复 preset id - 拒绝', () => {
		const r = validateProfile({
			...base,
			presets: [
				{ id: 'a', when: 'x', patch: { n: 1 } },
				{ id: 'a', when: 'y', patch: { n: 2 } },
			],
		});
		expect(r.ok).toBe(false);
	});
});
