/**
 * @file tests/ui/status/index-rate-label.test.ts
 * @description 索引速率文案 — 区分当前整体耗时与纯推理耗时
 * @module tests/ui/status/index-rate-label
 */

import { describe, expect, it } from 'vitest';
import { zh } from '../../../src/i18n/zh';
import { en } from '../../../src/i18n/en';

describe('索引速率展示口径', () => {
	it('中文标注当前整体速度，不与纯推理日志混淆', () => {
		expect(zh['status.drawer.indexSecondsPerBlock']).toBe('当前约 {seconds} 秒/块');
	});

	it('英文同样标注当前整体速度', () => {
		expect(en['status.drawer.indexSecondsPerBlock']).toBe('currently ~{seconds}s per block overall');
	});
});
