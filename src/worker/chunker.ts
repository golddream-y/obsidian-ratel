/**
 * @file src/worker/chunker.ts
 * @description Markdown 文本分块 — 按标题 → 段落 → 句子的三级回退策略
 * @module worker/chunker
 */

/**
 * 单个文本块。
 *
 * - `text`:块内容(已 trim)。
 * - `index`:块序号,从 0 开始。
 * - `startOffset` / `endOffset`:原文中的字符偏移区间(用于 UI 高亮定位)。
 */
export interface Chunk {
	text: string;
	index: number;
	startOffset: number;
	endOffset: number;
}

/**
 * 把 Markdown 文档切成 ~`chunkSize` 字符的块,相邻块保留 `overlap` 字符重叠。
 *
 * 关键路径:
 * 1. 先按 ATX 标题(`#` ~ `######`)切成 sections,保证语义边界优先。
 * 2. 累积小 sections 直到接近 `chunkSize`,超过则刷新并携带 overlap。
 * 3. 超过 `chunkSize * 1.5` 的超长 section 进一步按段落 / 句子回退切分。
 *
 * @param content - 原始 Markdown 文本。
 * @param chunkSize - 目标块大小(字符数,默认 500)。
 * @param overlap - 块间重叠字符数(默认 100)。
 * @returns 块数组,空文档返回 `[]`。
 */
export function chunkMarkdown(
	content: string,
	chunkSize = 500,
	overlap = 100,
): Chunk[] {
	if (!content.trim()) return [];

	// 关键路径:先按标题切,保留语义边界,避免一个 H2 标题孤立到新块中。
	const sections = splitByHeadings(content);

	// 合并小 sections,超出 chunkSize 时刷新;过大的 section 再二次切分。
	const chunks: Chunk[] = [];
	let currentText = '';
	let currentStart = 0;

	for (const section of sections) {
		if (currentText.length + section.text.length > chunkSize && currentText.length > 0) {
			// 当前 section 会超出 chunkSize,先 flush 已有累积。
			chunks.push({
				text: currentText.trim(),
				index: chunks.length,
				startOffset: currentStart,
				endOffset: currentStart + currentText.length,
			});

			// 新块从上一块末尾的 overlap 开始,保证跨块语义连续。
			const overlapText = getOverlapSuffix(currentText, overlap);
			currentText = overlapText + section.text;
			currentStart = section.startOffset - overlapText.length;
		} else {
			currentText += (currentText ? '\n\n' : '') + section.text;
			if (currentText === section.text) {
				currentStart = section.startOffset;
			}
		}

		// 修复:超长 section 兜底,防止单块爆炸到 chunkSize * N 倍。
		if (currentText.length > chunkSize * 1.5) {
			const subChunks = splitLongText(currentText, chunkSize, overlap);
			for (const sub of subChunks) {
				chunks.push({
					text: sub.trim(),
					index: chunks.length,
					startOffset: currentStart,
					endOffset: currentStart + sub.length,
				});
			}
			currentText = '';
		}
	}

	// 关键路径:把循环结束后剩余的尾巴 flush 出去。
	if (currentText.trim()) {
		chunks.push({
			text: currentText.trim(),
			index: chunks.length,
			startOffset: currentStart,
			endOffset: currentStart + currentText.length,
		});
	}

	return chunks;
}

/**
 * 内部 section 结构 — 包含文本和起始字符偏移。
 */
interface Section {
	text: string;
	startOffset: number;
}

/**
 * 按 ATX 标题(`#` ~ `######`)切分 Markdown,每段从一个标题开始直到下一个标题。
 *
 * 关键路径:行首正则 `^#{1,6}\s` 严格匹配 ATX 风格,Setext(`===` / `---`)暂不识别。
 */
function splitByHeadings(content: string): Section[] {
	const lines = content.split('\n');
	const sections: Section[] = [];
	let currentLines: string[] = [];
	let currentStart = 0;
	let charOffset = 0;

	for (const line of lines) {
		if (/^#{1,6}\s/.test(line) && currentLines.length > 0) {
			sections.push({
				text: currentLines.join('\n'),
				startOffset: currentStart,
			});
			currentStart = charOffset;
			currentLines = [line];
		} else {
			if (currentLines.length === 0) {
				currentStart = charOffset;
			}
			currentLines.push(line);
		}
		// +1 计入换行符,与 split('\n) 行为对齐。
		charOffset += line.length + 1;
	}

	if (currentLines.length > 0) {
		sections.push({
			text: currentLines.join('\n'),
			startOffset: currentStart,
		});
	}

	return sections;
}

/**
 * 二次切分:按段落(`\n\n`) → 中文句号(。) → 英文句号(`. `) → 强制硬切 的四级回退。
 *
 * 关键路径:任一回退必须满足"切点 ≥ chunkSize * 0.3",
 * 否则切到太靠前,造成大量小碎块。
 */
function splitLongText(text: string, chunkSize: number, overlap: number): string[] {
	const chunks: string[] = [];
	let remaining = text;

	while (remaining.length > 0) {
		if (remaining.length <= chunkSize) {
			chunks.push(remaining);
			break;
		}

		// 关键路径:优先按段落边界切,保证一个段落不会跨块。
		let splitPoint = remaining.lastIndexOf('\n\n', chunkSize);
		if (splitPoint < chunkSize * 0.3) {
			// 段落边界太靠前,退化到中文句号。
			splitPoint = remaining.lastIndexOf('。', chunkSize);
			if (splitPoint < chunkSize * 0.3) {
				// 再退化到英文句号 + 空格(避免切到 "Dr." 这类缩写)。
				splitPoint = remaining.lastIndexOf('. ', chunkSize);
			}
			if (splitPoint < chunkSize * 0.3) {
				// 修复:上述边界都不合适,硬切在 chunkSize 位置,保证不会卡死。
				splitPoint = chunkSize;
			}
		}

		chunks.push(remaining.slice(0, splitPoint + 1));
		// 下一块从 `splitPoint + 1 - overlap` 开始,保留 overlap 上下文。
		remaining = remaining.slice(Math.max(splitPoint + 1 - overlap, 1));
	}

	return chunks;
}

/**
 * 取一段文本末尾的 `overlapSize` 字符作为下一块前缀。
 *
 * 关键路径:尽量在第一个换行后开始,避免 overlap 是半句话的尴尬拼接。
 *
 * @param text - 上一块完整文本。
 * @param overlapSize - 期望 overlap 字符数。
 * @returns 截取的 overlap 子串;`overlapSize <= 0` 或文本太短时返回空串。
 */
function getOverlapSuffix(text: string, overlapSize: number): string {
	if (overlapSize <= 0 || text.length <= overlapSize) return '';
	const suffix = text.slice(-overlapSize);
	// 关键路径:从换行后的第一个字符开始,避免 overlap 是半句话。
	const newlineIdx = suffix.indexOf('\n');
	if (newlineIdx >= 0 && newlineIdx < suffix.length - 1) {
		return suffix.slice(newlineIdx + 1);
	}
	return suffix;
}
