/**
 * @file tests/ui/chat/session/session-title.test.ts
 * @description 会话双轨标题 — 截断 / 解析 / prompt
 */
import { describe, it, expect } from 'vitest';
import {
	SHORT_TITLE_MAX,
	FULL_TITLE_MAX,
	clipTitle,
	deriveShortTitle,
	fallbackSessionTitle,
	isFallbackDerivedTitle,
	buildSessionTitlePrompt,
	parseSessionTitleResponse,
	normalizeTitlePair,
} from '../../../../src/ui/chat/session/session-title';

describe('session-title', () => {
	it('clipTitle - 短文本 - 原样', () => {
		expect(clipTitle('你好', SHORT_TITLE_MAX)).toBe('你好');
	});

	it('fallbackSessionTitle - 超长 - 截断加省略到正常上限', () => {
		const long = '字'.repeat(50);
		const t = fallbackSessionTitle(long);
		expect(t.length).toBe(FULL_TITLE_MAX);
		expect(t.endsWith('…')).toBe(true);
	});

	it('deriveShortTitle - 从正常标题截到短上限', () => {
		const full = '性能预算与 CDN 背景说明文档';
		const short = deriveShortTitle(full);
		expect(short.length).toBeLessThanOrEqual(SHORT_TITLE_MAX);
		expect(short.endsWith('…')).toBe(true);
	});

	it('normalizeTitlePair - 缺短标题 - 从 title 派生', () => {
		const pair = normalizeTitlePair({ title: '整理本周未完成的项目笔记' });
		expect(pair.title).toBe('整理本周未完成的项目笔记');
		expect(pair.shortTitle.length).toBeLessThanOrEqual(SHORT_TITLE_MAX);
	});

	it('isFallbackDerivedTitle - 首条截断占位 - 视为可被 LLM 覆盖', () => {
		const seed = '哪几篇小说是有男女主的';
		const fb = fallbackSessionTitle(seed);
		expect(isFallbackDerivedTitle(fb, seed, '新对话')).toBe(true);
		expect(isFallbackDerivedTitle('新对话', seed, '新对话')).toBe(true);
		expect(isFallbackDerivedTitle('工部时间线矛盾修复', seed, '新对话')).toBe(false);
	});

	it('buildSessionTitlePrompt - 含双轨与用户原文', () => {
		const p = buildSessionTitlePrompt('性能优化');
		expect(p).toContain('性能优化');
		expect(p).toContain('短:');
		expect(p).toContain('正:');
	});

	it('parseSessionTitleResponse - 双行格式 - 解析成功', () => {
		const pair = parseSessionTitleResponse('短:性能预算\n正:性能预算与 CDN 背景说明');
		expect(pair).not.toBeNull();
		expect(pair!.shortTitle).toBe('性能预算');
		expect(pair!.title).toBe('性能预算与 CDN 背景说明');
	});

	it('parseSessionTitleResponse - 单行回退 - 派生短标题', () => {
		const pair = parseSessionTitleResponse('整理本周未完成的项目笔记清单');
		expect(pair).not.toBeNull();
		expect(pair!.title.length).toBeLessThanOrEqual(FULL_TITLE_MAX);
		expect(pair!.shortTitle.length).toBeLessThanOrEqual(SHORT_TITLE_MAX);
	});
});
