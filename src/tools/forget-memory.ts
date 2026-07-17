/**
 * @file src/tools/forget-memory.ts
 * @description `forget_memory` 工具 — 按 match 字符串删除一条用户记忆(global / topic 双路径)
 * @module tools/forget-memory
 * @depends core/tool-registry, core/memory-store, ports/llm, i18n
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { MemoryStore } from '../core/memory-store';
import { tNow } from '../i18n';

/**
 * 构造 `forget_memory` 工具实例。
 *
 * 设计要点:
 * - 写工具(`readOnly: false`),Agent Loop 会触发 pre/post write hook。
 * - 双路径:type=global 在 global.md 内按行匹配删除;type=topic 在 topics/<topic>.md 内按行匹配删除。
 * - 一条记忆占两行(`- {content}` + `  source: {source}`),按 match 命中任意一行即整对删除。
 * - topic 文件清空(只剩 frontmatter + section 标题)时:
 *   a) 删除文件
 *   b) removeTopicFromIndex(name) — 从 index.md 移除主题行
 *   c) removeTopicFromIndexStore(name) — 从 vectra 索引删除文档
 *   d) 返回 topicRemoved(让 LLM 知道主题已被清理)
 * - global.md 永不删除(它是启动注入的全量记忆,即使空也保留 frontmatter 模板)。
 * - `definition` 由调用方通过 Composer 生成后注入。
 *
 * @param memoryStore - MemoryStore 实例,提供记忆文件读写 + 索引同步。
 * @param definition - LLM 侧 schema,由 `composeToolDefinitions` 生成。
 * @returns 符合 `Tool` 接口的工具定义。
 *
 * @example
 *   const tool = createForgetMemoryTool(memoryStore, def);
 *   registry.register(tool);
 */
export function createForgetMemoryTool(
	memoryStore: MemoryStore,
	definition: ToolDefinition,
): Tool {
	return {
		definition,
		readOnly: false,
		async execute(args: Record<string, unknown>) {
			// 关键路径:参数校验 — type / match 必填。
			const type = args.type;
			if (type !== 'global' && type !== 'topic') {
				throw new Error(tNow('error.tool.invalidArg', { label: 'type', type: typeof type }));
			}
			if (typeof args.match !== 'string' || args.match.length === 0) {
				throw new Error(tNow('error.tool.invalidArg', { label: 'match', type: typeof args.match }));
			}
			const matchStr = args.match;

			if (type === 'global') {
				return forgetGlobal(memoryStore, matchStr);
			}
			// 关键路径:type=topic 时 topic 参数必填。
			if (typeof args.topic !== 'string' || args.topic.length === 0) {
				throw new Error(tNow('error.memory.topicRequired'));
			}
			return forgetTopic(memoryStore, args.topic, matchStr);
		},
	};
}

/**
 * 从 global.md 删除匹配条目。
 *
 * 关键路径:
 * - global.md 不入索引,故无需同步 vectra。
 * - 无匹配时抛 noMatch,让 LLM 知道删除目标不存在(避免静默失败)。
 * - global.md 永不删除文件(它是启动注入的全量记忆,空也保留模板)。
 */
async function forgetGlobal(memoryStore: MemoryStore, matchStr: string): Promise<string> {
	const text = memoryStore.readGlobal();
	if (text.length === 0) {
		// 关键路径:global.md 不存在 → 没有任何记忆可删,直接抛 noMatch。
		throw new Error(tNow('error.memory.noMatch', { match: matchStr }));
	}
	const { result, removed } = removeEntryPairs(text, matchStr);
	if (!removed) {
		throw new Error(tNow('error.memory.noMatch', { match: matchStr }));
	}
	memoryStore.writeGlobal(result);
	return tNow('notice.memory.forgotten');
}

/**
 * 从 topics/<topic>.md 删除匹配条目。
 *
 * 关键路径:
 * - 主题文件不存在 → 抛 topicNotFound(让 LLM 知道主题名拼错或已被删)。
 * - 无匹配 → 抛 noMatch。
 * - 文件清空(只剩 frontmatter + section 标题,无 - 条目)→ 删文件 + 同步清理 index.md + vectra 索引。
 * - 否则写回 + upsertToIndex(让 search_memory 即时反映删除后的内容)。
 */
async function forgetTopic(
	memoryStore: MemoryStore,
	topic: string,
	matchStr: string,
): Promise<string> {
	const existing = memoryStore.readTopic(topic);
	if (existing === null) {
		throw new Error(tNow('error.memory.topicNotFound', { topic }));
	}

	const { result, removed } = removeEntryPairs(existing, matchStr);
	if (!removed) {
		throw new Error(tNow('error.memory.noMatch', { match: matchStr }));
	}

	// 关键路径:文件清空检测 — 若删完后没有任何 `- ` 条目(只剩 frontmatter + section 标题),
	// 视为主题已无内容,删除文件 + 清理 index.md + 清理 vectra 索引。
	if (isTopicEmpty(result)) {
		// 关键路径:删文件确保下次 remember 同名主题时 readTopic 返回 null → 触发 addTopicToIndex 重建索引行。
		// MemoryStore 作为文件 IO 唯一入口,deleteTopic 内部用 fs.unlinkSync 真正删除磁盘文件。
		memoryStore.deleteTopic(topic);
		// removeTopicFromIndex 同步写 index.md;仅 vectra 清理是 async。
		memoryStore.removeTopicFromIndex(topic);
		await memoryStore.removeTopicFromIndexStore(topic);
		return tNow('notice.memory.topicRemoved', { topic });
	}

	// 关键路径:文件仍有内容 → 写回 + 同步索引,让 search_memory 反映删除后的内容。
	memoryStore.writeTopic(topic, result);
	await memoryStore.upsertToIndex(`topics/${topic}.md`, result);
	return tNow('notice.memory.forgotten');
}

/**
 * 按行匹配删除条目对(`- {content}` + `  source: {source}`)。
 *
 * 关键路径:
 * - 一条记忆占两行 — 第一行 `- {content}`(列表项),第二行 `  source: {source}`(缩进 source)。
 * - match 命中任意一行即整对删除(避免留下孤立的 source 行)。
 * - 非 entry 行(section 标题 `## X`、frontmatter、空行)永不删。
 * - 通过 walk + lookahead 配对识别 entry 边界。
 *
 * @param text - 原始 markdown 全文。
 * @param matchStr - 匹配字符串(任意子串命中即删除)。
 * @returns `{ result, removed }` — result 是删除后的全文,removed 表示是否删了至少一条。
 */
function removeEntryPairs(
	text: string,
	matchStr: string,
): { result: string; removed: boolean } {
	const lines = text.split('\n');
	const result: string[] = [];
	let removed = false;

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (line === undefined) {
			i++;
			continue;
		}

		// 关键路径:识别 entry 起始行 — 列表项 `- {content}`(不含 section 标题 `## `)。
		if (isEntryBullet(line)) {
			// 关键路径:lookahead 取下一条 source 行(若有)。
			const nextLine = lines[i + 1];
			const hasNextSource = nextLine !== undefined && isEntrySource(nextLine);

			// 关键路径:match 命中 bullet 行或 source 行(若有)→ 整对删除。
			const bulletMatches = line.includes(matchStr);
			const sourceMatches = hasNextSource && nextLine.includes(matchStr);

			if (bulletMatches || sourceMatches) {
				removed = true;
				// 关键路径:跳过 bullet + 关联的 source 行(若有)。
				i += hasNextSource ? 2 : 1;
				continue;
			}
			// 关键路径:不匹配 → 保留 bullet 行;source 行由下一轮循环自然处理(若它是 source 且不匹配,
			// 它将被作为"孤立的 source 行"保留 — 实际不应发生,因为 source 行总跟在 bullet 后)。
			result.push(line);
			i++;
			continue;
		}

		// 非 bullet 行(包括孤立的 source 行、section 标题、frontmatter、空行)— 直接保留。
		result.push(line);
		i++;
	}

	return { result: result.join('\n'), removed };
}

/**
 * 判断一行是否为 entry bullet 行(`- {content}`,非 `## ` section 标题)。
 *
 * 关键路径:trim 后以 `- ` 开头但不是 `## `(section 标题)或 `---`(frontmatter 边界)。
 */
function isEntryBullet(line: string): boolean {
	const trimmed = line.trimStart();
	if (!trimmed.startsWith('- ')) return false;
	// 排除 `- -` 之类的嵌套列表(记忆条目都是单层)。
	// 排除 `---`(frontmatter 边界)— 它 trim 后是 `---`,不以 `- ` 开头(后跟 `-` 而非空格),自然被排除。
	return true;
}

/**
 * 判断一行是否为 entry source 行(`  source: {source}`,两空格缩进)。
 */
function isEntrySource(line: string): boolean {
	const trimmed = line.trimStart();
	// 关键路径:source 行以 `source: ` 开头(前导空格已 trim)。
	return trimmed.startsWith('source: ');
}

/**
 * 判断 topic 文件是否已"空"(只剩 frontmatter + section 标题,无 entry bullet)。
 *
 * 关键路径:
 * - 跳过 frontmatter(--- 包裹块)。
 * - 跳过 section 标题(`## X`)、空行、frontmatter 边界。
 * - 若剩余无任何 entry bullet 行,视为空。
 *
 * @param text - topic 文件全文。
 * @returns true 表示文件已无实际记忆条目。
 */
function isTopicEmpty(text: string): boolean {
	const lines = text.split('\n');
	for (const line of lines) {
		if (isEntryBullet(line)) {
			// 关键路径:遇到任意 entry bullet 即视为非空。
			return false;
		}
	}
	return true;
}
