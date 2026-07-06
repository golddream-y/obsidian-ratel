/**
 * @file src/tools/remember.ts
 * @description `remember` 工具 — 写入一条用户记忆(global 全局 / topic 主题双路径)
 * @module tools/remember
 * @depends core/tool-registry, core/memory-store, ports/llm, i18n, types
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { MemoryStore } from '../core/memory-store';
import { tNow } from '../i18n';

// 关键路径:remember 工具的 autoSummary 取 content 前 50 字符,作为 index.md 主题摘要。
const AUTO_SUMMARY_MAX_CHARS = 50;

/**
 * 构造 `remember` 工具实例。
 *
 * 设计要点:
 * - 写工具(`readOnly: false`),Agent Loop 会触发 pre/post write hook。
 * - 双路径:type=global 写 global.md(不入索引,启动时全量注入);type=topic 写 topics/<topic>.md(同步入索引)。
 * - 主题文件不存在时自动创建,并把主题追加到 index.md(供启动注入主题列表)。
 * - 条目格式:`- {content}\n  source: {source}`,source 标记来源便于 LLM 区分用户/模型。
 * - section 不存在时自动追加(避免 LLM 因 section 名拼错而失败)。
 * - `definition` 由调用方通过 Composer 生成后注入。
 *
 * @param memoryStore - MemoryStore 实例,提供记忆文件读写 + 索引同步。
 * @param definition - LLM 侧 schema,由 `composeToolDefinitions` 生成。
 * @returns 符合 `Tool` 接口的工具定义。
 *
 * @example
 *   const tool = createRememberTool(memoryStore, def);
 *   registry.register(tool);
 */
export function createRememberTool(
	memoryStore: MemoryStore,
	definition: ToolDefinition,
): Tool {
	return {
		definition,
		readOnly: false,
		async execute(args: Record<string, unknown>) {
			// 关键路径:参数校验 — type / content / source 必填。
			const type = args.type;
			if (type !== 'global' && type !== 'topic') {
				throw new Error(tNow('error.tool.invalidArg', { label: 'type', type: typeof type }));
			}
			if (typeof args.content !== 'string' || args.content.length === 0) {
				throw new Error(tNow('error.tool.invalidArg', { label: 'content', type: typeof args.content }));
			}
			if (args.source !== 'user' && args.source !== 'model') {
				throw new Error(tNow('error.tool.invalidArg', { label: 'source', type: typeof args.source }));
			}
			const content = args.content;
			const source = args.source;
			const section = typeof args.section === 'string' && args.section.length > 0 ? args.section : null;

			if (type === 'global') {
				return rememberGlobal(memoryStore, content, source, section);
			}
			// 关键路径:type=topic 时 topic 参数必填。
			if (typeof args.topic !== 'string' || args.topic.length === 0) {
				throw new Error(tNow('error.memory.topicRequired'));
			}
			return rememberTopic(memoryStore, args.topic, content, source, section);
		},
	};
}

/**
 * 写一条 global 记忆到 global.md 指定 section。
 *
 * 关键路径:
 * - global.md 不入记忆索引 — 启动时由 ContextManager 全量注入,重复入索引会浪费 LLM 上下文。
 * - section 不存在时追加新 section 区块到文件末尾(在 frontmatter 之后)。
 * - 条目格式:`- {content}\n  source: {source}`,source 缩进对齐,便于后续 forget_memory 按行匹配删除。
 * - 写入前调 isWithinStorageLimit 检查 10MB 上限,超限拒绝写入(I3 spec §7)。
 */
async function rememberGlobal(
	memoryStore: MemoryStore,
	content: string,
	source: 'user' | 'model',
	section: string | null,
): Promise<string> {
	const existing = memoryStore.readGlobal();
	// 关键路径:文件不存在时 ensureDir 写空模板,readGlobal 返回空串,
	// 这里用模板兜底,确保后续写入有 frontmatter。
	const text = existing.length > 0 ? existing : buildGlobalTemplate();
	const sectionName = section ?? '关键决策';
	const updated = appendEntryToSection(text, sectionName, content, source);
	// 关键路径(I3):写入前检查 10MB 存储上限,超限拒绝写入。
	// 用 updated - existing 估算增量字节数(已是 UTF-8 字符串,Buffer.byteLength 估准)。
	const additionBytes = Buffer.byteLength(updated, 'utf-8') - Buffer.byteLength(existing, 'utf-8');
	if (!memoryStore.isWithinStorageLimit(Math.max(additionBytes, 0))) {
		throw new Error(tNow('error.memory.storageFull'));
	}
	memoryStore.writeGlobal(updated);
	return tNow('notice.memory.saved');
}

/**
 * 写一条 topic 记忆到 topics/<topic>.md 指定 section。
 *
 * 关键路径:
 * - 主题文件不存在时新建 + addTopicToIndex(autoSummary = content 前 50 字符)。
 * - 写入后调用 upsertToIndex 同步记忆索引,使 search_memory 即时命中。
 * - docId 拼接为 `topics/{topic}.md`,与 searchIndex 回查 / removeTopicFromIndexStore 删除保持一致。
 */
async function rememberTopic(
	memoryStore: MemoryStore,
	topic: string,
	content: string,
	source: 'user' | 'model',
	section: string | null,
): Promise<string> {
	const existing = memoryStore.readTopic(topic);
	let wasCreated = false;
	// 关键路径:主题文件不存在 → 用模板新建 + 追加到 index.md。
	let text: string;
	if (existing === null) {
		text = buildTopicTemplate(topic);
		memoryStore.addTopicToIndex(topic, makeAutoSummary(content));
		wasCreated = true;
	} else {
		text = existing;
	}

	const sectionName = section ?? '关键决策';
	const updated = appendEntryToSection(text, sectionName, content, source);
	// 关键路径(I3):写入前检查 10MB 存储上限,超限拒绝写入。
	const additionBytes = Buffer.byteLength(updated, 'utf-8') - Buffer.byteLength(existing ?? '', 'utf-8');
	if (!memoryStore.isWithinStorageLimit(Math.max(additionBytes, 0))) {
		throw new Error(tNow('error.memory.storageFull'));
	}
	memoryStore.writeTopic(topic, updated);

	// 关键路径:同步记忆索引 — upsertToIndex 用文件全文,内部触发 vectra embedding。
	// docId 与 readTopic 路径对齐,确保 searchIndex 回查与 removeTopicFromIndexStore 删除使用同一 ID。
	await memoryStore.upsertToIndex(`topics/${topic}.md`, updated);

	// 关键路径:主题首次创建时返回 topicCreated,否则返回 saved(让用户/LLM 知道新建了主题)。
	if (wasCreated) {
		return tNow('notice.memory.topicCreated', { topic });
	}
	return tNow('notice.memory.saved');
}

/**
 * 在 markdown 文本的指定 section 末尾追加一条记忆条目。
 *
 * 关键路径:
 * - section 由 `## {sectionName}` 标识,定位后追加 `- {content}\n  source: {source}`。
 * - section 不存在时,在文件末尾追加新 section 区块(空行 + 标题 + 条目)。
 * - frontmatter(--- 包裹)不会被破坏 — 只在 frontmatter 之后操作 section。
 *
 * @param text - 原始 markdown 全文。
 * @param sectionName - 区块标题(不含 ## 前缀)。
 * @param content - 条目内容(一行)。
 * @param source - 来源标记(user / model)。
 * @returns 更新后的 markdown 全文。
 */
function appendEntryToSection(
	text: string,
	sectionName: string,
	content: string,
	source: 'user' | 'model',
): string {
	const sectionHeader = `## ${sectionName}`;
	const lines = text.split('\n');

	// 关键路径:找到 section 起始行(## {sectionName})。
	const sectionStartIdx = lines.findIndex((line) => line.trim() === sectionHeader);
	if (sectionStartIdx === -1) {
		// 关键路径:section 不存在 → 在文件末尾追加新 section(空行 + 标题 + 条目)。
		// 确保前面有空行分隔(若文件非空且最后一行非空)。
		const needsLeadingNewline = lines.length > 0 && lines[lines.length - 1] !== '';
		const prefix = needsLeadingNewline ? '\n' : '';
		const newSection = `${prefix}${sectionHeader}\n\n- ${content}\n  source: ${source}\n`;
		return lines.join('\n') + newSection;
	}

	// 关键路径:section 存在 → 找到 section 末尾(下一个 ## 标题或文件末尾)。
	let insertIdx = lines.length;
	for (let i = sectionStartIdx + 1; i < lines.length; i++) {
		if (lines[i]?.startsWith('## ')) {
			insertIdx = i;
			break;
		}
	}

	// 关键路径:在 section 末尾插入条目,确保前面有空行与已有内容分隔。
	// 同时确保插入后 section 末尾与下一个 section 之间有空行。
	const entryLines = ['', `- ${content}`, `  source: ${source}`];
	lines.splice(insertIdx, 0, ...entryLines);
	return lines.join('\n');
}

/**
 * 取 content 前 50 字符作为主题自动摘要。
 *
 * 关键路径:超长 content 会被截断,末尾不加省略号(让 LLM 自行判断是否需要 search_memory 查全文)。
 */
function makeAutoSummary(content: string): string {
	return content.length > AUTO_SUMMARY_MAX_CHARS ? content.slice(0, AUTO_SUMMARY_MAX_CHARS) : content;
}

/**
 * 生成 global.md 空模板(用于 readGlobal 返回空时的兜底)。
 *
 * 关键路径:与 MemoryStore.buildGlobalTemplate 保持一致 — frontmatter + 四个固定区块。
 * 不直接调 MemoryStore 私有方法,这里复制模板字符串(避免改 MemoryStore 公开 API)。
 */
function buildGlobalTemplate(): string {
	const now = new Date().toISOString();
	return `---
memory_type: global
updated: ${now}
---

## 用户身份

## 偏好

## 当前项目

## 关键决策
`;
}

/**
 * 生成 topics/<topic>.md 空模板。
 *
 * 关键路径:frontmatter 含 memory_type: topic + topic 字段;区块留空,由后续 remember 填充。
 */
function buildTopicTemplate(topic: string): string {
	const now = new Date().toISOString();
	return `---
memory_type: topic
topic: ${topic}
updated: ${now}
---

## 关键决策

## 偏好

## 历史记录
`;
}
