/**
 * @file tests/ui/chat/session/session-transition.test.ts
 * @description 会话切换时长辅助测试
 */
import { describe, it, expect } from 'vitest';
import { loadingPadMs, SESSION_LOADING_MIN_MS } from '../../../../src/ui/chat/session/session-transition';

describe('loadingPadMs', () => {
	it('loadingPadMs - 已超下限 - 补 0', () => {
		expect(loadingPadMs(SESSION_LOADING_MIN_MS + 50)).toBe(0);
	});
	it('loadingPadMs - 很快完成 - 补足下限', () => {
		expect(loadingPadMs(40)).toBe(SESSION_LOADING_MIN_MS - 40);
	});
	it('loadingPadMs - 负数 elapsed - 按 0 起算', () => {
		expect(loadingPadMs(-10)).toBe(SESSION_LOADING_MIN_MS);
	});
});
