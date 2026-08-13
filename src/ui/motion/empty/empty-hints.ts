/**
 * @file src/ui/motion/empty/empty-hints.ts
 * @description 空态副句轮换文案键
 * @module ui/motion/empty/empty-hints
 */
export type EmptyHintKey = 'chat.empty.hint.1' | 'chat.empty.hint.2' | 'chat.empty.hint.3';
export type EmptyHintLookup = EmptyHintKey | 'chat.empty.hint';

export const EMPTY_HINT_KEYS: EmptyHintKey[] = [
	'chat.empty.hint.1',
	'chat.empty.hint.2',
	'chat.empty.hint.3',
];

/**
 * 将三条空态副句 hint 键解析为展示文案；缺译时回退 `chat.empty.hint`。
 *
 * @param t - i18n 查找函数（键为 hint 三键或回退键）
 * @returns 长度恒为 3 的副句数组
 */
export function resolveEmptyHints(t: (k: EmptyHintLookup) => string): string[] {
	const fallback = t('chat.empty.hint') || '';
	return EMPTY_HINT_KEYS.map((k) => {
		const v = t(k);
		return v && v !== k ? v : fallback;
	});
}
