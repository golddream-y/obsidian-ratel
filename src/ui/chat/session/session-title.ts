/**
 * @file src/ui/chat/session/session-title.ts
 * @description 会话双轨标题 — 短标题(Header) + 正常标题(列表) + LLM 生成
 * @module ui/chat/session/session-title
 * @depends ports/llm
 */

import type { LLMClient } from '../../../ports/llm';

/** Header chip / 列表主行字数上限 */
export const SHORT_TITLE_MAX = 12;
/** 列表副行 / 持久化 title 字数上限 */
export const FULL_TITLE_MAX = 40;

export interface SessionTitlePair {
	shortTitle: string;
	title: string;
}

/**
 * 按字数截断标题;空白返回空串。
 *
 * @param text - 原始标题
 * @param max - 最大字数(含省略号占位)
 * @returns 截断后的标题
 */
export function clipTitle(text: string, max: number): string {
	const t = String(text || '')
		.trim()
		.replace(/\s+/g, ' ');
	if (!t) return '';
	return t.length <= max ? t : t.slice(0, max - 1) + '…';
}

/**
 * 用首条用户消息截断作正常标题回退。
 */
export function fallbackSessionTitle(
	firstUserText: string,
	maxLen = FULL_TITLE_MAX,
): string {
	return clipTitle(firstUserText, maxLen);
}

/**
 * 判断持久化 title 是否只是「首条 user 截断」占位(非 LLM/手改真标题)。
 *
 * Persistence upsert 会在空 title 时用首条 user 填洞;maybeGenerateTitle 若把这种
 * 占位当成已有标题就会跳过 LLM,Header 只变成截断开场白,编辑框也仍是开场白。
 *
 * @param title - 当前 title
 * @param firstUserText - 首条用户消息原文
 * @param emptyFallback - 「新对话」等空标题文案
 */
export function isFallbackDerivedTitle(
	title: string,
	firstUserText: string,
	emptyFallback = '',
): boolean {
	const t = title.trim();
	if (!t || t === emptyFallback) return true;
	const fb = fallbackSessionTitle(firstUserText);
	if (!fb) return false;
	return t === fb || t === deriveShortTitle(fb);
}

/**
 * 从正常标题派生短标题(无 LLM 时的本地截断)。
 */
export function deriveShortTitle(full: string, maxLen = SHORT_TITLE_MAX): string {
	return clipTitle(full, maxLen);
}

/**
 * 归一化双轨标题:强制限长;短标题缺失时从正常标题派生。
 */
export function normalizeTitlePair(
	pair: Partial<SessionTitlePair>,
	emptyFallback = '',
): SessionTitlePair {
	const title =
		clipTitle(pair.title ?? '', FULL_TITLE_MAX) ||
		clipTitle(pair.shortTitle ?? '', FULL_TITLE_MAX) ||
		emptyFallback;
	const shortTitle =
		clipTitle(pair.shortTitle ?? '', SHORT_TITLE_MAX) ||
		deriveShortTitle(title) ||
		emptyFallback;
	return { shortTitle, title };
}

/**
 * 拼装让模型同时起短标题与正常标题的 user 提示。
 */
export function buildSessionTitlePrompt(firstUserText: string): string {
	return (
		`请为下面这段用户开场白起两个标题。` +
		`短标题不超过 ${SHORT_TITLE_MAX} 个汉字,正常标题不超过 ${FULL_TITLE_MAX} 个汉字。` +
		`只按下面两行格式输出,不要引号、不要解释、不要其它行:\n` +
		`短:……\n` +
		`正:……\n\n` +
		firstUserText.trim().slice(0, 500)
	);
}

/**
 * 解析模型双轨标题输出;失败返回 null。
 */
export function parseSessionTitleResponse(raw: string): SessionTitlePair | null {
	const text = raw.trim();
	if (!text) return null;
	const shortMatch = text.match(/短\s*[:：]\s*(.+)/);
	const fullMatch = text.match(/正\s*[:：]\s*(.+)/);
	if (shortMatch?.[1] && fullMatch?.[1]) {
		return normalizeTitlePair({
			shortTitle: shortMatch[1].split('\n')[0]!.trim(),
			title: fullMatch[1].split('\n')[0]!.trim(),
		});
	}
	// 回退:单行当正常标题,再派生短标题
	const oneLine = text
		.replace(/^["「『]|["」』]$/g, '')
		.split('\n')[0]
		?.trim();
	if (!oneLine) return null;
	const title = clipTitle(oneLine, FULL_TITLE_MAX);
	if (!title) return null;
	return { shortTitle: deriveShortTitle(title), title };
}

/**
 * 异步生成双轨会话标题;失败时抛错由调用方回退。
 * signal 预留:当前 LLMClient.chat 未接 AbortSignal,调用方仍可在外层忽略结果。
 *
 * 安全路径:DeepSeek V4 默认 thinking=enabled,推理 token 计入 max_tokens;
 * 标题只需短输出,必须 thinking:disabled,否则常见「HTTP 200 但 content 为空」。
 */
export async function generateSessionTitles(
	llm: LLMClient,
	firstUserText: string,
	_signal?: AbortSignal,
): Promise<SessionTitlePair> {
	void _signal;
	const prompt = buildSessionTitlePrompt(firstUserText);
	let text = '';
	for await (const delta of llm.chat({
		messages: [{ role: 'user', content: prompt }],
		options: { maxTokens: 96, thinking: 'disabled' },
	})) {
		if (delta.text) text += delta.text;
	}
	const parsed = parseSessionTitleResponse(text);
	if (!parsed?.title) {
		throw new Error(
			text.trim()
				? `无法解析标题输出: ${text.trim().slice(0, 120)}`
				: 'empty title (模型未返回 content)',
		);
	}
	return parsed;
}

/**
 * @deprecated 请用 generateSessionTitles;保留兼容旧调用。
 */
export async function generateSessionTitle(
	llm: LLMClient,
	firstUserText: string,
	signal?: AbortSignal,
): Promise<string> {
	const pair = await generateSessionTitles(llm, firstUserText, signal);
	return pair.title;
}
