/**
 * @file tests/ui/motion/prefs.test.ts
 * @description 聊天动效总闸门
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { isChatMotionEnabled, prefersMotionReduced } from '../../../src/ui/motion/prefs';

describe('prefs', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('isChatMotionEnabled - 默认缺字段 - true（需未 reduce）', () => {
		vi.stubGlobal('matchMedia', (q: string) => ({
			matches: false,
			media: q,
			addEventListener: () => {},
			removeEventListener: () => {},
		}));
		expect(isChatMotionEnabled({})).toBe(true);
		expect(isChatMotionEnabled({ chatMotionEnabled: true })).toBe(true);
	});

	it('isChatMotionEnabled - 设置为 false - false', () => {
		vi.stubGlobal('matchMedia', (q: string) => ({
			matches: false,
			media: q,
			addEventListener: () => {},
			removeEventListener: () => {},
		}));
		expect(isChatMotionEnabled({ chatMotionEnabled: false })).toBe(false);
	});

	it('isChatMotionEnabled - prefers-reduced-motion - false', () => {
		vi.stubGlobal('matchMedia', (q: string) => ({
			matches: q.includes('prefers-reduced-motion'),
			media: q,
			addEventListener: () => {},
			removeEventListener: () => {},
		}));
		expect(prefersMotionReduced()).toBe(true);
		expect(isChatMotionEnabled({ chatMotionEnabled: true })).toBe(false);
	});
});
