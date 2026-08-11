/**
 * @file tests/ui/chat/nav/chat-nav-rail.test.ts
 * @description 对话进度轨纯函数
 * @module tests/ui/chat/nav/chat-nav-rail
 */
import { describe, it, expect } from 'vitest';
import {
	CHAT_NAV_TICK_CAP,
	extractUserAnchors,
	thinAnchors,
	needsRail,
	thumbRatio,
	summarizeNavText,
} from '../../../../src/ui/chat/nav/chat-nav-rail';

function msg(id: string, role: 'user' | 'assistant', text: string) {
	return { id, role, segments: [{ type: 'text' as const, text }] };
}

describe('summarizeNavText', () => {
	it('summarizeNavText - 超长 - 截断到 maxChars', () => {
		expect(summarizeNavText('一二三四五六七八九十一二三四五六七八九十', 24).length).toBeLessThanOrEqual(24);
	});
});

describe('extractUserAnchors', () => {
	it('extractUserAnchors - 空列表 - 空数组', () => {
		expect(extractUserAnchors([])).toEqual([]);
	});

	it('extractUserAnchors - 仅 assistant - 空数组', () => {
		expect(extractUserAnchors([msg('a1', 'assistant', 'hi')])).toEqual([]);
	});

	it('extractUserAnchors - 交错 user - 只收 user 且带 summary', () => {
		const a = extractUserAnchors([
			msg('u1', 'user', '第一问'),
			msg('a1', 'assistant', '答'),
			msg('u2', 'user', '第二问很长很长很长很长很长很长很长'),
		]);
		expect(a.map((x) => x.id)).toEqual(['u1', 'u2']);
		expect(a[0]!.summary).toContain('第一问');
		expect(a[0]!.index).toBe(0);
		expect(a[1]!.index).toBe(2);
	});
});

describe('thinAnchors', () => {
	it('thinAnchors - 不超过 cap - 原样', () => {
		const anchors = Array.from({ length: 5 }, (_, i) => ({
			id: `u${i}`,
			summary: `q${i}`,
			index: i,
		}));
		expect(thinAnchors(anchors, null, 12)).toHaveLength(5);
	});

	it('thinAnchors - 超过 cap - 含首尾与 visible', () => {
		const anchors = Array.from({ length: 20 }, (_, i) => ({
			id: `u${i}`,
			summary: `q${i}`,
			index: i * 2,
		}));
		const thinned = thinAnchors(anchors, 'u10', CHAT_NAV_TICK_CAP);
		expect(thinned.length).toBeLessThanOrEqual(CHAT_NAV_TICK_CAP);
		expect(thinned[0]!.id).toBe('u0');
		expect(thinned[thinned.length - 1]!.id).toBe('u19');
		expect(thinned.some((x) => x.id === 'u10')).toBe(true);
	});

	it('thinAnchors - keep 超额小 cap - 仍保留首尾', () => {
		const anchors = Array.from({ length: 20 }, (_, i) => ({
			id: `u${i}`,
			summary: `q${i}`,
			index: i,
		}));
		// cap=3 时首尾 + visible±1 会使 keep>cap；旧实现 slice 会丢掉末项
		const thinned = thinAnchors(anchors, 'u10', 3);
		expect(thinned.length).toBeLessThanOrEqual(3);
		expect(thinned[0]!.id).toBe('u0');
		expect(thinned[thinned.length - 1]!.id).toBe('u19');
	});
});

describe('needsRail / thumbRatio', () => {
	it('needsRail - 内容不高过视口 - false', () => {
		expect(needsRail(100, 100)).toBe(false);
		expect(needsRail(100, 120)).toBe(false);
	});

	it('needsRail - 可滚动 - true', () => {
		expect(needsRail(500, 200)).toBe(true);
	});

	it('thumbRatio - 顶/底/中 - 钳制', () => {
		expect(thumbRatio(0, 500, 200)).toBe(0);
		expect(thumbRatio(300, 500, 200)).toBe(1);
		expect(thumbRatio(150, 500, 200)).toBeCloseTo(0.5);
		expect(thumbRatio(-10, 500, 200)).toBe(0);
	});

	it('thumbRatio - scrollHeight<=clientHeight - 0', () => {
		expect(thumbRatio(0, 100, 100)).toBe(0);
	});
});
