/**
 * @file tests/core/ecosystem-lock.test.ts
 * @description 同 pluginId 串行、不同 id 可并行
 * @module core/ecosystem-lock.test
 */
import { describe, it, expect } from 'vitest';
import { withPluginLock } from '../../src/core/ecosystem-lock';

describe('withPluginLock', () => {
	it('withPluginLock - 同 id 两次 - 第二次等第一次结束', async () => {
		const order: number[] = [];
		let release!: () => void;
		const first = withPluginLock('calendar', () => new Promise<void>((r) => { release = r; order.push(1); }));
		const secondP = withPluginLock('calendar', async () => { order.push(2); });
		await Promise.resolve();
		expect(order).toEqual([1]);
		release();
		await first;
		await secondP;
		expect(order).toEqual([1, 2]);
	});
});
