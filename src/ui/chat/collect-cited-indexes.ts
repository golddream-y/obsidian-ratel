/**
 * @file src/ui/chat/collect-cited-indexes.ts
 * @description 从助手正文抽取与 searchResults 交集的引用编号；chip 显隐判定
 * @module ui/chat/collect-cited-indexes
 */

const CITE_RE = /\[\[(\d+)\]\]|\[(\d+)\]/g;

/**
 * 从纯文本抽取落在 validIndexes 内的引用编号。
 *
 * @param text - 助手正文(可含 [n] / [[n]])
 * @param validIndexes - 当前 searchResults 合法 index 集合
 * @returns 命中的编号集合(空集合表示无有效内联标)
 */
export function collectCitedIndexes(
	text: string,
	validIndexes: ReadonlySet<number>,
): Set<number> {
	const out = new Set<number>();
	if (!text || validIndexes.size === 0) return out;
	CITE_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = CITE_RE.exec(text)) !== null) {
		const n = Number(m[1] ?? m[2]);
		if (validIndexes.has(n)) out.add(n);
	}
	return out;
}

/**
 * 从消息 segments 中仅扫描 text 段,汇总有效引用编号。
 *
 * @param segments - 消息片段(只处理 type==='text')
 * @param validIndexes - 当前 searchResults 合法 index 集合
 * @returns 全部 text 段命中编号的并集
 */
export function collectCitedIndexesFromSegments(
	segments: Array<{ type: string; text?: string }>,
	validIndexes: ReadonlySet<number>,
): Set<number> {
	const out = new Set<number>();
	for (const seg of segments) {
		if (seg.type !== 'text' || !seg.text) continue;
		for (const n of collectCitedIndexes(seg.text, validIndexes)) out.add(n);
	}
	return out;
}

/**
 * 是否渲染底部 cite chip 行(含折叠条)。
 * 有 searchResults 且正文无任何有效 [n] 时才显示。
 *
 * @param hasSearchResults - 消息是否挂有 searchResults
 * @param citedCount - 有效内联 [n] 个数
 * @returns true 时渲染 SearchResults;false 时隐藏(交给正文 A 通道)
 */
export function shouldShowCiteChips(hasSearchResults: boolean, citedCount: number): boolean {
	return hasSearchResults && citedCount === 0;
}
