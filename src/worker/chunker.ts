/**
 * @file src/worker/chunker.ts
 * @description Markdown 文本分块 — 按 token 预算切分,块携带结构前缀与嵌入输入
 * @module worker/chunker
 */

/**
 * 单个文本块。
 *
 * - `text`:正文(已 trim,不含结构前缀)——用于精确检索与返回。
 * - `embedText`:嵌入输入 = `prefix` + `text`。
 * - `index`:块序号,从 0 开始。
 * - `startOffset` / `endOffset`:原文中正文的字符偏移区间(用于 UI 高亮定位),不含前缀。
 * - `prefix`:结构前缀(文档标题 › 标题路径),无前缀时为空串。
 * - `headingPath`:块所属的标题路径,供上层扩展页号与表头。
 */
export interface Chunk {
	text: string;
	embedText: string;
	index: number;
	startOffset: number;
	endOffset: number;
	prefix: string;
	headingPath: string[];
}

/**
 * 分块参数。
 */
export interface ChunkOptions {
	/** 单块总预算(含结构前缀)。 */
	maxTokens: number;
	/** 相邻块重叠的 token 数。 */
	overlapTokens: number;
	/** token 计数函数(本地词表精确计数,或字符上界估算)。 */
	count: (text: string) => number;
	/** 文档标题,与标题路径一起拼结构前缀。 */
	docTitle?: string;
}

/**
 * 把 Markdown 文档按 token 预算切成块,相邻块保留 token 级重叠。
 *
 * 关键路径:
 * 1. 先按 ATX 标题(`#` ~ `######`)切成 sections,保证语义边界优先。
 * 2. 累积小 sections 直到接近预算,超过则刷新并携带 overlap。
 * 3. 超出预算的 section 进一步按段落 / 句子 / 硬切回退切分。
 * 4. 每块按所在标题层级拼结构前缀,前缀只进 `embedText`,不污染正文与偏移。
 *
 * @param content - 原始 Markdown 文本。
 * @param opts - 分块参数(预算、重叠、token 计数与文档标题)。
 * @returns 块数组,空文档返回 `[]`。
 */
export function chunkMarkdown(content: string, opts: ChunkOptions): Chunk[] {
	const { maxTokens, overlapTokens, count, docTitle } = opts;
	if (!content.trim()) return [];

	// 关键路径:前缀逐块不同(取决于所在标题层级),因此正文预算要逐块算。
	const prefixOf = (headingPath: string[]): string => {
		const parts = [docTitle, ...headingPath].filter((x): x is string => !!x && x.length > 0);
		return parts.length > 0 ? `${parts.join(' › ')} › ` : '';
	};
	const budgetOf = (headingPath: string[]): number => {
		const budget = maxTokens - count(prefixOf(headingPath));
		// 关键路径:前缀本身就超预算属于配置异常,退化为 1 个 token ——
		// 宁可块变小,也不要让块超出模型输入上限被静默截断。
		return budget > 0 ? budget : 1;
	};

	// 关键路径:先按标题切,保留语义边界,避免一个 H2 标题孤立到新块中。
	const sections = splitByHeadings(content);

	const chunks: Chunk[] = [];
	let currentText = '';
	let currentStart = 0;
	let currentPath: string[] = [];
	let hasCurrent = false;

	/**
	 * 把一段正文切成不超过预算的块并追加到结果,返回最后一块的正文。
	 *
	 * @param text - 待输出正文。
	 * @param startOffset - 该正文在原文中的起始字符偏移。
	 * @param headingPath - 该正文所属的标题路径(决定前缀与预算)。
	 * @returns 最后一块的正文(用于取 overlap),无输出时为空串。
	 */
	const emit = (text: string, startOffset: number, headingPath: string[]): string => {
		const budget = budgetOf(headingPath);
		const prefix = prefixOf(headingPath);
		let last = '';
		for (const part of splitLongText(text, budget, overlapTokens, count)) {
			const trimmed = part.text.trim();
			if (!trimmed) continue;
			// 关键路径:偏移只针对正文,结构前缀不占原文位置。
			const lead = part.text.length - part.text.trimStart().length;
			const absStart = startOffset + part.offset + lead;
			chunks.push({
				text: trimmed,
				embedText: prefix + trimmed,
				prefix,
				headingPath: [...headingPath],
				index: chunks.length,
				startOffset: absStart,
				endOffset: absStart + trimmed.length,
			});
			last = trimmed;
		}
		return last;
	};

	for (const section of sections) {
		const budget = budgetOf(section.headingPath);
		const candidate = currentText ? `${currentText}\n\n${section.text}` : section.text;
		if (hasCurrent && count(candidate) > budget) {
			// 当前 section 会超出预算,先 flush 已有累积。
			const last = emit(currentText, currentStart, currentPath);

			// 新块从上一块末尾的 overlap 开始,保证跨块语义连续。
			const overlapText = takeOverlapSuffix(last, overlapTokens, count);
			currentText = overlapText ? `${overlapText}\n\n${section.text}` : section.text;
			currentStart = Math.max(0, section.startOffset - overlapText.length);
		} else {
			currentText = candidate;
			if (!hasCurrent) {
				currentStart = section.startOffset;
				hasCurrent = true;
			}
		}
		// 关键路径:块前缀取最深层级(最后进入的 section)的标题路径 ——
		// 前缀含完整祖先链,既保留上级语境,又保留最具体的定位信息。
		currentPath = section.headingPath;
	}

	// 关键路径:把循环结束后剩余的尾巴 flush 出去。
	if (hasCurrent && currentText.trim()) {
		emit(currentText, currentStart, currentPath);
	}

	return chunks;
}

/**
 * 内部 section 结构 — 包含文本、起始字符偏移与所属标题路径。
 */
interface Section {
	text: string;
	startOffset: number;
	headingPath: string[];
}

/**
 * 内部切片段 — 记录正文片段与其在输入文本中的字符偏移。
 */
interface TextPart {
	text: string;
	/** 相对输入文本的起始字符偏移。 */
	offset: number;
}

/**
 * 按 ATX 标题(`#` ~ `######`)切分 Markdown,每段从一个标题开始直到下一个标题。
 *
 * 关键路径:行首正则 `^#{1,6}\s` 严格匹配 ATX 风格,Setext(`===` / `---`)暂不识别。
 * 关键路径:标题栈按层级截断再压入,section 记录自己所处的标题路径。
 */
function splitByHeadings(content: string): Section[] {
	const lines = content.split('\n');
	const sections: Section[] = [];
	let currentLines: string[] = [];
	let currentStart = 0;
	let charOffset = 0;
	// 关键路径:标题栈 —— 进入新标题时按层级截断栈再压入标题文本。
	let headingStack: string[] = [];

	for (const line of lines) {
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading && currentLines.length > 0) {
			sections.push({
				text: currentLines.join('\n'),
				startOffset: currentStart,
				headingPath: [...headingStack],
			});
			currentStart = charOffset;
			currentLines = [line];
		} else {
			if (currentLines.length === 0) {
				currentStart = charOffset;
			}
			currentLines.push(line);
		}
		if (heading) {
			const level = heading[1]?.length ?? 1;
			headingStack = [...headingStack.slice(0, level - 1), heading[2]?.trim() ?? ''];
		}
		// +1 计入换行符,与 split('\n') 行为对齐。
		charOffset += line.length + 1;
	}

	if (currentLines.length > 0) {
		sections.push({
			text: currentLines.join('\n'),
			startOffset: currentStart,
			headingPath: [...headingStack],
		});
	}

	return sections;
}

/**
 * 二次切分:按段落(`\n\n`) → 中文句号(。) → 英文句号(`. `) → 强制硬切 的四级回退。
 *
 * 关键路径:任一回退必须满足"切点 ≥ 预算 * 0.3",
 * 否则切到太靠前,造成大量小碎块。
 *
 * @param text - 待切分正文。
 * @param budgetTokens - 单块正文预算(token)。
 * @param overlapTokens - 相邻块重叠的 token 数。
 * @param count - token 计数函数。
 * @returns 切分后的片段列表,每片的 token 数都不超过预算。
 */
function splitLongText(
	text: string,
	budgetTokens: number,
	overlapTokens: number,
	count: (t: string) => number,
): TextPart[] {
	const parts: TextPart[] = [];
	// 关键路径:切点下限 —— 前一块至少占预算的 30%,否则会产生大量碎块。
	const minTokens = Math.max(1, Math.floor(budgetTokens * 0.3));
	let pos = 0;

	while (pos < text.length) {
		const remaining = text.slice(pos);
		if (count(remaining) <= budgetTokens) {
			parts.push({ text: remaining, offset: pos });
			break;
		}

		// 关键路径:硬切点是仍能装进预算的最长前缀。
		const fitIndex = maxFitIndex(remaining, budgetTokens, count);
		const end = pickSplitEnd(remaining, fitIndex, minTokens, budgetTokens, count);
		if (end <= 0) {
			// 预算装不下任何字符,只能整体输出以避免死循环。
			parts.push({ text: remaining, offset: pos });
			break;
		}
		parts.push({ text: remaining.slice(0, end), offset: pos });

		// 关键路径:overlap 不得超过块长的一半,否则下一块几乎整块重复且收敛缓慢。
		const chunkText = remaining.slice(0, end);
		const overlap = takeOverlapSuffix(chunkText, overlapTokens, count);
		const overlapLen = Math.min(overlap.length, Math.floor(end / 2));
		const next = pos + end - overlapLen;
		// 至少前进一个字符,避免死循环。
		pos = next > pos ? next : pos + 1;
	}

	return parts;
}

/**
 * 在预算内挑一个切点:优先段落边界 → 中文句号 → 英文句号 + 空格 → 硬切。
 *
 * @param text - 待切分正文。
 * @param fitIndex - 硬切点(仍能装进预算的最长前缀结束下标)。
 * @param minTokens - 切点下限(过靠前的切点会产生碎块)。
 * @param budgetTokens - 单块正文预算(token)。
 * @param count - token 计数函数。
 * @returns 切点结束下标(切分后的片段为 `text.slice(0, end)`)。
 */
function pickSplitEnd(
	text: string,
	fitIndex: number,
	minTokens: number,
	budgetTokens: number,
	count: (t: string) => number,
): number {
	// 关键路径:分隔符归入前一块,避免下一块以标点或换行开头。
	const candidates: number[] = [];
	const paragraph = text.lastIndexOf('\n\n', fitIndex);
	if (paragraph >= 0) candidates.push(paragraph + 2);
	const chinese = text.lastIndexOf('。', fitIndex);
	if (chinese >= 0) candidates.push(chinese + 1);
	const english = text.lastIndexOf('. ', fitIndex);
	if (english >= 0) candidates.push(english + 2);

	for (const end of candidates) {
		const tokens = count(text.slice(0, end));
		if (tokens >= minTokens && tokens <= budgetTokens) {
			return end;
		}
	}
	return fitIndex;
}

/**
 * 找到仍能装进预算的最长前缀的结束下标。
 *
 * 关键路径:计数对前缀单调不减,用二分定位,避免逐字符计数的平方级开销。
 *
 * @param text - 待切分正文。
 * @param budgetTokens - 预算(token)。
 * @param count - token 计数函数。
 * @returns 最长可装进预算的前缀长度(字符数)。
 */
function maxFitIndex(text: string, budgetTokens: number, count: (t: string) => number): number {
	let lo = 0;
	let hi = text.length;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (count(text.slice(0, mid)) <= budgetTokens) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}
	return lo;
}

/**
 * 取一段文本末尾不超过 `budgetTokens` 的最长后缀,尽量从换行后开始。
 *
 * 关键路径:overlap 落在块尾,保证跨块语义连续;
 * 计数对后缀单调不增,用二分定位后缀起点。
 *
 * @param text - 上一块完整文本。
 * @param budgetTokens - 期望 overlap 的 token 数。
 * @param count - token 计数函数。
 * @returns 截取的 overlap 子串;`budgetTokens <= 0` 或文本为空时返回空串。
 */
function takeOverlapSuffix(
	text: string,
	budgetTokens: number,
	count: (t: string) => number,
): string {
	if (budgetTokens <= 0 || text.length === 0) return '';

	let lo = 0;
	let hi = text.length;
	while (lo < hi) {
		const mid = Math.floor((lo + hi) / 2);
		if (count(text.slice(mid)) <= budgetTokens) {
			hi = mid;
		} else {
			lo = mid + 1;
		}
	}
	const suffix = text.slice(lo);
	// 关键路径:从换行后的第一个字符开始,避免 overlap 是半句话。
	const newlineIdx = suffix.indexOf('\n');
	if (newlineIdx >= 0 && newlineIdx < suffix.length - 1) {
		return suffix.slice(newlineIdx + 1);
	}
	return suffix;
}
