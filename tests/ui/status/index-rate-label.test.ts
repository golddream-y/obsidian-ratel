/**
 * @file tests/ui/status/index-rate-label.test.ts
 * @description 索引速率文案 — 口径统一为「块/秒」，不再暴露「节/秒」或「秒/块」
 * @module tests/ui/status/index-rate-label
 */

import { describe, expect, it } from 'vitest';
import { zh } from '../../../src/i18n/zh';
import { en } from '../../../src/i18n/en';

describe('索引速率展示口径', () => {
	it('中文只按块/秒展示，且不含秒/块或节/秒', () => {
		expect(zh['status.drawer.indexBlocksPerSecond']).toBe('当前约 {rate} 块/秒');
		const keys = Object.keys(zh).filter((key) => key.startsWith('status.drawer.'));
		const texts = keys.map((key) => zh[key as keyof typeof zh]);
		expect(texts.some((text) => text.includes('秒/块'))).toBe(false);
		expect(texts.some((text) => text.includes('节/秒'))).toBe(false);
	});

	it('英文同样只按 blocks/s 展示', () => {
		expect(en['status.drawer.indexBlocksPerSecond']).toBe('currently ~{rate} blocks/s');
		expect(Object.values(en).some((text) => text.includes('s per block'))).toBe(false);
	});

	it('块进度区分预估与实际', () => {
		expect(zh['status.drawer.blocksProgress']).toBe('已写 {done} / 共 {total} 块');
		expect(zh['status.drawer.blocksProgressEstimated']).toBe('已写 {done} / 共 {total} 块（预估）');
	});
});
