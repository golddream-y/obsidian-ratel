/**
 * @file tests/ui/chat/sponsor-links.test.ts
 * @description 赞助页 URL 按语言分流
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { langStore } from '../../../src/i18n';
import {
	SPONSOR_URL_EN,
	SPONSOR_URL_ZH,
	sponsorPageUrlForLang,
} from '../../../src/ui/chat/sponsor-links';

describe('sponsorPageUrlForLang', () => {
	beforeEach(() => {
		langStore.set('zh');
	});

	it('sponsorPageUrlForLang - 中文界面 - 打开爱发电', () => {
		langStore.set('zh');
		expect(sponsorPageUrlForLang()).toBe(SPONSOR_URL_ZH);
		expect(sponsorPageUrlForLang()).toBe('https://afdian.com/a/golddream');
	});

	it('sponsorPageUrlForLang - 英文界面 - 打开 Ko-fi', () => {
		langStore.set('en');
		expect(sponsorPageUrlForLang()).toBe(SPONSOR_URL_EN);
		expect(sponsorPageUrlForLang()).toBe('https://ko-fi.com/golddream_y');
	});
});
