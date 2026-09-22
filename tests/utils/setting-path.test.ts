/**
 * @file tests/utils/setting-path.test.ts
 * @description 点号路径叶子 patch（S-ECOSYSTEM §5.12）
 * @module utils/setting-path.test
 */
import { describe, it, expect } from 'vitest';
import { applyLeafPatch, parseSettingKey, FORBID_KEY_RE } from '../../src/utils/setting-path';

describe('parseSettingKey', () => {
	it('parseSettingKey - 合法 a.b.c - 三段', () => {
		expect(parseSettingKey('a.b.c')).toEqual(['a', 'b', 'c']);
	});
	it('parseSettingKey - 含 .. 或数组下标 - 抛错', () => {
		expect(() => parseSettingKey('a..b')).toThrow();
		expect(() => parseSettingKey('items.0')).toThrow();
		expect(() => parseSettingKey('.a')).toThrow();
	});
});

describe('applyLeafPatch', () => {
	it('applyLeafPatch - 只改点名叶子 - 兄弟不变', () => {
		const next = applyLeafPatch({ weekStart: 0, locale: 'zh' }, { weekStart: 1 });
		expect(next).toEqual({ weekStart: 1, locale: 'zh' });
	});
	it('applyLeafPatch - 嵌套叶子 - 不整枝覆盖', () => {
		const next = applyLeafPatch({ cal: { a: 1, b: 2 } }, { 'cal.a': 9 });
		expect(next).toEqual({ cal: { a: 9, b: 2 } });
	});
	it('applyLeafPatch - 超过 20 key - 抛错', () => {
		const patch: Record<string, unknown> = {};
		for (let i = 0; i < 21; i++) patch[`k${i}`] = i;
		expect(() => applyLeafPatch({}, patch)).toThrow();
	});
	it('FORBID_KEY_RE - apiKey 命中', () => {
		expect(FORBID_KEY_RE.test('apiKey')).toBe(true);
		expect(FORBID_KEY_RE.test('weekStart')).toBe(false);
	});
});
