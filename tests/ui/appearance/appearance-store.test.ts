/**
 * @file tests/ui/appearance/appearance-store.test.ts
 * @description appearanceRevision / bumpAppearance 单元测试
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { appearanceRevision, bumpAppearance } from '../../../src/ui/appearance/appearance-store';

describe('appearanceRevision store', () => {
	beforeEach(() => {
		appearanceRevision.set(0);
	});

	it('bumpAppearance - 调用后 - revision 递增', () => {
		expect(get(appearanceRevision)).toBe(0);
		bumpAppearance();
		expect(get(appearanceRevision)).toBe(1);
		bumpAppearance();
		expect(get(appearanceRevision)).toBe(2);
	});

	it('appearanceRevision - 订阅 - bump 时收到新值', () => {
		const seen: number[] = [];
		const unsub = appearanceRevision.subscribe((n) => seen.push(n));
		bumpAppearance();
		bumpAppearance();
		unsub();
		// 订阅立即收到当前值 0,之后两次 bump → [0, 1, 2]
		expect(seen).toEqual([0, 1, 2]);
	});
});
