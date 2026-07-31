/**
 * @file src/ui/chat/sponsor-links.ts
 * @description 赞助外链 — 按界面语言跳转爱发电 / Ko-fi
 * @module ui/chat/sponsor-links
 * @depends ../../i18n, ../../utils/open-external-url
 */

import { get } from 'svelte/store';
import { langStore } from '../../i18n';
import { openExternalUrl } from '../../utils/open-external-url';

/** 国内赞助：爱发电主页 */
export const SPONSOR_URL_ZH = 'https://afdian.com/a/golddream';

/** 国外赞助：Ko-fi */
export const SPONSOR_URL_EN = 'https://ko-fi.com/golddream_y';

/**
 * 按当前界面语言返回赞助页 URL。
 *
 * @returns zh → 爱发电;en → Ko-fi
 */
export function sponsorPageUrlForLang(): string {
	return get(langStore) === 'zh' ? SPONSOR_URL_ZH : SPONSOR_URL_EN;
}

/**
 * 在系统浏览器打开对应语言的赞助页。
 */
export async function openSponsorPage(): Promise<void> {
	await openExternalUrl(sponsorPageUrlForLang());
}
