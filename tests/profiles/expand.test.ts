/**
 * @file tests/profiles/expand.test.ts
 * @description preset 展开去掉 forbid 与未选 key
 * @module profiles/expand.test
 */
import { describe, it, expect } from 'vitest';
import { expandPresetPatch } from '../../src/profiles/expand';

describe('expandPresetPatch', () => {
	it('expandPresetPatch - 去掉 forbid 与未选 - 新 key needsConfirm', () => {
		const r = expandPresetPatch({
			preset: { id: 'p', when: 'x', patch: { weekStart: 1, apiKey: 'no', extra: true } },
			forbid: ['apiKey'],
			existingKeys: ['weekStart'],
			selectedKeys: ['weekStart', 'extra'],
		});
		expect(r.patch).toEqual({ weekStart: 1, extra: true });
		expect(r.needsConfirm).toEqual(['extra']);
	});
});
