/**
 * @file src/tools/note-text-stats.ts
 * @description 落盘全文的长度与拉丁词统计
 * @module tools/note-text-stats
 */

/** 写入、追加、替换成功后附在结果里的正文统计 */
export interface NoteTextStats {
	length: {
		/** UTF-16 编码单元个数，等于 JavaScript 字符串长度 */
		chars: number;
		/** Unicode 码点个数。han + latinLetters + other 等于此值 */
		codePoints: number;
		/** Script=Han 的码点个数 */
		han: number;
		/** Script=Latin 且为字母的码点个数 */
		latinLetters: number;
		/** 其余码点：标点、空白、数字，以及汉字和拉丁字母以外的字符 */
		other: number;
	};
	words: {
		/** 连续拉丁字母的段数。汉语拼音记在这里 */
		latin: number;
	};
}

const HAN = /\p{Script=Han}/u;
const LATIN_LETTER = /\p{Script=Latin}/u;
const LETTER = /\p{L}/u;

/**
 * 统计一篇已落盘的全文。
 *
 * 汉字按 Unicode Script=Han 计码点，不按拼音。拉丁词是连续拉丁字母的段数，撇号会断开。
 * 三个长度划分之和等于 codePoints。chars 是 UTF-16 长度，增补平面字符会让它大于 codePoints。
 *
 * @param content - 落盘后的全文
 * @returns 长度与拉丁词统计
 */
export function measureNoteText(content: string): NoteTextStats {
	let codePoints = 0;
	let han = 0;
	let latinLetters = 0;
	let latinWords = 0;
	let inLatinWord = false;

	for (const ch of content) {
		codePoints += 1;
		if (HAN.test(ch)) {
			han += 1;
			inLatinWord = false;
			continue;
		}
		if (LATIN_LETTER.test(ch) && LETTER.test(ch)) {
			latinLetters += 1;
			if (!inLatinWord) {
				latinWords += 1;
				inLatinWord = true;
			}
			continue;
		}
		inLatinWord = false;
	}

	return {
		length: {
			chars: content.length,
			codePoints,
			han,
			latinLetters,
			other: codePoints - han - latinLetters,
		},
		words: { latin: latinWords },
	};
}
