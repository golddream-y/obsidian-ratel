/**
 * @file src/ui/motion/empty/blur-split.ts
 * @description 欢迎主句 Blur 动画分词 — 英文按词、中文按字
 * @module ui/motion/empty/blur-split
 */

/** CJK 统一表意文字范围（简繁与扩展 A 区） */
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;

export type BlurSplitMode = 'words' | 'letters';

/**
 * 将欢迎主句拆成 Blur 逐段动画单元。
 *
 * - `letters`：逐字符
 * - `words`：英文按空格分词；无空格且含 CJK 则按字；否则整句一段
 *
 * @param text - 原文
 * @param mode - 分词模式
 * @returns 动画单元数组（不含空格 token）
 */
export function splitBlurUnits(text: string, mode: BlurSplitMode): string[] {
	if (mode === 'letters') {
		return [...text];
	}

	const trimmed = text.trim();
	if (!trimmed) return [];

	if (/\s/.test(trimmed)) {
		return trimmed.split(/\s+/);
	}

	if (CJK_RE.test(trimmed)) {
		return [...trimmed];
	}

	return [trimmed];
}

/**
 * 英文按词拆开后要用词间距拼回；中文按字则不能插空格。
 *
 * @param text - 原文
 * @returns 为 true 时单元之间应留词间距
 */
export function shouldGapBlurWords(text: string): boolean {
	return /\s/.test(text.trim());
}
