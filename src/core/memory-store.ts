/**
 * @file src/core/memory-store.ts
 * @description 用户记忆存储层 — 管理 .ratel/memory/ 下的 markdown 记忆文件与 .memory-index/ vectra 索引
 * @module core/memory-store
 * @depends adapters/vector-vectra, ports/vector, i18n, types
 *
 * 设计要点:
 * - 两层记忆:global.md(启动全量注入)+ topics/*.md(工具按需检索)
 * - 记忆索引独立于 vault 索引,主线程直接 upsert(不走 Worker)
 * - global.md 永不入记忆索引(避免与启动注入重复)
 * - index.md 仅记录主题列表,不入记忆索引
 * - 主线程直接读写文件系统(MemoryStore 不跑在 Worker 中)
 */

import fs from 'fs';
import path from 'path';
import type { VectraStore } from '../adapters/vector-vectra';
import type { EmbeddingPort } from '../ports/embedding';
import type { TopicIndexEntry } from '../types';
import type { VectorSearchResult } from '../ports/vector';
import { tNow } from '../i18n';
import { bumpMemory } from './memory-revision';

// 关键路径:spec §7 容量上限 — 记忆目录总大小上限,超出拒绝写入。
// 注:globalContent 注入到 system prompt 前的字节预算由 composer.ts 分层处理(truncateUtf8Bytes)。
const MEMORY_STORAGE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * 记忆索引搜索结果 — 在 VectorSearchResult 基础上补齐 index + text。
 *
 * 关键路径:searchIndex 把 vectra 的 hybridSearch 结果 + getDocumentText 回查合并,
 * 给 LLM 返回可直接阅读的"片段 + 编号"格式,避免 LLM 再调 read_note 二次往返。
 */
export interface MemorySearchResult {
	/** 引用编号,从 1 开始(与 search_vault 工具的 index 语义一致,供 LLM 用 [1][2] 引用)。 */
	index: number;
	/** 文档 ID(即记忆文件路径,如 `topics/GraphQL.md`)。 */
	docId: string;
	/** 相关性分数(由 vectra hybridSearch 给出)。 */
	score: number;
	/** 文档原文(由 getDocumentText 回查)。 */
	text: string;
}

/**
 * 用户记忆存储层 — 管理 .ratel/memory/ 下两层记忆文件与对应 vectra 索引。
 *
 * 设计要点:
 * - `baseDir` 即 `.ratel/memory/`,由调用方(main.ts)在 onload 时拼好传入。
 * - `memoryIndex` 是独立的 vectra 索引(路径如 `.ratel/memory/.memory-index/`),
 *   与 vault 索引完全隔离,避免记忆写入触发 vault 重建。
 * - 所有方法同步执行文件 IO(读 / 写 markdown),除 upsertToIndex/searchIndex/removeTopicFromIndexStore
 *   是 async(走 vectra 异步路径)。
 * - 文件操作用 `node:fs`,不依赖 Obsidian API(MemoryStore 跑在主线程,有完整 Node 环境)。
 *
 * @example
 *   const store = new MemoryStore('/vault/.ratel/memory', vectraStore);
 *   store.ensureDir();
 *   store.writeGlobal('## 用户身份\n- Erwin');
 *   store.addTopicToIndex('GraphQL', '查询语言');
 *   await store.upsertToIndex('topics/GraphQL.md', fullText);
 */
export class MemoryStore {
	private baseDir: string;
	private memoryIndex: VectraStore | null;
	// 关键路径:C2 修复 — MemoryStore 持有 embeddingPort,upsertToIndex 用预计算向量 + upsertItem,
	// 绕过 vectra 内部 embeddings 依赖(与 IndexProcessor 同模式)。
	private embeddingPort: EmbeddingPort | null;

	/**
	 * @param baseDir - 记忆根目录(即 `.ratel/memory/`),由调用方拼接。
	 * @param memoryIndex - 可选的 vectra 索引实例;若为空则 upsertToIndex/searchIndex/removeTopicFromIndexStore 抛 storeNotInit。
	 * @param embeddingPort - 可选的 EmbeddingPort;upsertToIndex 用它把文本编为向量,
	 *   再调 vectraStore.upsertItem 写入(绕过 vectra 内部 embeddings 模型依赖)。
	 */
	constructor(baseDir: string, memoryIndex?: VectraStore, embeddingPort?: EmbeddingPort) {
		this.baseDir = baseDir;
		this.memoryIndex = memoryIndex ?? null;
		this.embeddingPort = embeddingPort ?? null;
	}

	/**
	 * 创建目录结构并写入空模板文件(若不存在)。
	 *
	 * 关键路径:
	 * - 幂等:已存在的文件不覆盖,避免擦除用户数据。
	 * - 首次启动时由 main.ts onload 调用,后续重启再次调用无副作用。
	 */
	ensureDir(): void {
		// 关键路径:baseDir 与 topics 子目录用 recursive 一次创建。
		const topicsDir = path.join(this.baseDir, 'topics');
		if (!fs.existsSync(this.baseDir)) {
			fs.mkdirSync(this.baseDir, { recursive: true });
		}
		if (!fs.existsSync(topicsDir)) {
			fs.mkdirSync(topicsDir, { recursive: true });
		}

		// 关键路径:global.md / index.md 不存在时写空模板,已存在则保留(避免清空用户数据)。
		const globalPath = path.join(this.baseDir, 'global.md');
		if (!fs.existsSync(globalPath)) {
			fs.writeFileSync(globalPath, this.buildGlobalTemplate(), 'utf-8');
		}

		const indexPath = path.join(this.baseDir, 'index.md');
		if (!fs.existsSync(indexPath)) {
			fs.writeFileSync(indexPath, this.buildIndexTemplate(), 'utf-8');
		}
	}

	/**
	 * 读 global.md 全文。
	 *
	 * @returns 文件原文;文件不存在时返回空串(供 ContextManager 判空跳过注入)。
	 */
	readGlobal(): string {
		const globalPath = path.join(this.baseDir, 'global.md');
		if (!fs.existsSync(globalPath)) return '';
		return fs.readFileSync(globalPath, 'utf-8');
	}

	/**
	 * 写 global.md 全文。
	 *
	 * 关键路径:global.md 永不入记忆索引 — 启动时由 ContextManager 全量注入,
	 * 重复入索引会导致 search_memory 命中与启动注入重复,浪费 LLM 上下文。
	 *
	 * @param content - 完整文件内容(frontmatter + 区块 + 条目)。
	 */
	writeGlobal(content: string): void {
		const globalPath = path.join(this.baseDir, 'global.md');
		fs.writeFileSync(globalPath, content, 'utf-8');
		// 关键路径:通知 MemoryPanel 等订阅方重读(agent remember / 面板编辑共用)。
		bumpMemory();
	}

	/**
	 * 解析 index.md 中的主题列表行,返回主题索引条目。
	 *
	 * 关键路径:行格式 `- [[topics/{name}]] — {summary}`,
	 * - 用 `—`(U+2014 em-dash)作分隔符,与中文排版一致。
	 * - summary 可能含逗号、空格、连字符等,正则用非贪婪 `(.+)$` 捕获到行尾。
	 *
	 * @returns 主题索引条目数组;空 index.md 返回空数组。
	 */
	readIndex(): TopicIndexEntry[] {
		const indexPath = path.join(this.baseDir, 'index.md');
		if (!fs.existsSync(indexPath)) return [];

		const text = fs.readFileSync(indexPath, 'utf-8');
		const entries: TopicIndexEntry[] = [];
		// 关键路径:行匹配 — `[[topics/X]]` 中 X 即主题名,` — ` 后到行尾是 summary。
		const lineRegex = /^-\s+\[\[topics\/(.+?)\]\]\s+—\s+(.+)$/;

		for (const line of text.split('\n')) {
			const m = line.match(lineRegex);
			if (m && m[1] !== undefined && m[2] !== undefined) {
				// 关键路径:正则 match 数组下标返回 string | undefined(strict mode),需显式断言。
				entries.push({ name: m[1], summary: m[2] });
			}
		}
		return entries;
	}

	/**
	 * 追加一个主题到 index.md 末尾。
	 *
	 * 关键路径:
	 * - 不去重 — 调用方 remember 工具已确保只在主题文件不存在时调用一次。
	 * - 行尾自动补换行,避免与下一行粘连。
	 *
	 * @param name - 主题名(不含 .md 后缀)。
	 * @param summary - 主题摘要(自由文本)。
	 */
	addTopicToIndex(name: string, summary: string): void {
		const indexPath = path.join(this.baseDir, 'index.md');
		// 关键路径:读取已有内容(不存在则用空模板兜底),追加一行后写回。
		const existing = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf-8') : this.buildIndexTemplate();
		// 修复:确保已有内容以换行结尾,避免追加行与原最后一行粘连。
		const normalized = existing.endsWith('\n') ? existing : existing + '\n';
		const appended = normalized + `- [[topics/${name}]] — ${summary}\n`;
		fs.writeFileSync(indexPath, appended, 'utf-8');
		bumpMemory();
	}

	/**
	 * 从 index.md 移除匹配主题的行。
	 *
	 * 关键路径:
	 * - 按 `[[topics/{name}]]` 子串匹配,不解析 summary,避免 summary 中含特殊字符导致正则失效。
	 * - 主题不存在时无副作用,不抛错(允许 forget_memory 在主题已被删的情况下幂等调用)。
	 *
	 * @param name - 主题名(不含 .md 后缀)。
	 */
	removeTopicFromIndex(name: string): void {
		const indexPath = path.join(this.baseDir, 'index.md');
		if (!fs.existsSync(indexPath)) return;

		const text = fs.readFileSync(indexPath, 'utf-8');
		// 关键路径:按行过滤,移除所有匹配 `[[topics/{name}]]` 的行。
		const target = `[[topics/${name}]]`;
		const filtered = text
			.split('\n')
			.filter((line) => !line.includes(target))
			.join('\n');
		fs.writeFileSync(indexPath, filtered, 'utf-8');
		bumpMemory();
	}

	/**
	 * 读 topics/<name>.md 全文。
	 *
	 * @param name - 主题名(不含 .md 后缀)。
	 * @returns 文件原文;不存在时返回 null(供 remember 工具判断是否需要新建主题)。
	 * @throws name 含路径分隔符或穿越片段时抛 invalidTopic(防 LLM 注入攻击)。
	 */
	readTopic(name: string): string | null {
		// 关键路径:C1 修复 — LLM 输出的 topic 名可能含 ../,校验后再拼路径,避免越出 topics/ 目录。
		this.validateTopicName(name);
		const topicPath = path.join(this.baseDir, 'topics', `${name}.md`);
		if (!fs.existsSync(topicPath)) return null;
		return fs.readFileSync(topicPath, 'utf-8');
	}

	/**
	 * 写 topics/<name>.md 全文。
	 *
	 * 关键路径:不在此处同步记忆索引 — 调用方(remember / forget 工具)负责决定
	 * 是否调用 upsertToIndex,保持职责单一。
	 *
	 * @param name - 主题名(不含 .md 后缀)。
	 * @param content - 完整文件内容。
	 * @throws name 含路径分隔符或穿越片段时抛 invalidTopic。
	 */
	writeTopic(name: string, content: string): void {
		this.validateTopicName(name);
		const topicPath = path.join(this.baseDir, 'topics', `${name}.md`);
		fs.writeFileSync(topicPath, content, 'utf-8');
		bumpMemory();
	}

	/**
	 * 删除 topics/<name>.md 文件。
	 *
	 * 关键路径:forget_memory 工具在主题清空时调用,确保下次 remember 该主题时
	 * readTopic 返回 null → 触发 addTopicToIndex 重建主题索引行。
	 * 文件不存在时静默忽略(幂等),避免 forget 在主题已被删的情况下抛错。
	 *
	 * @param name - 主题名(不含 .md 后缀)。
	 * @throws name 含路径分隔符或穿越片段时抛 invalidTopic。
	 */
	deleteTopic(name: string): void {
		this.validateTopicName(name);
		const topicPath = path.join(this.baseDir, 'topics', `${name}.md`);
		if (fs.existsSync(topicPath)) {
			fs.unlinkSync(topicPath);
			bumpMemory();
		}
	}

	/**
	 * 把文档写入记忆 vectra 索引。
	 *
	 * 关键路径(C2 修复):
	 * - 旧实现用 `vectraStore.upsert(docId, text)` — 它内部调 vectra 的 `embeddings.createEmbeddings()`,
	 *   要求 VectraStore 构造时注入 EmbeddingsModel。但 main.ts 出于"等模型就绪后再 init"的考虑,
	 *   创建 memory VectraStore 时未注入 embeddings → upsert 必失败(TypeError)。
	 * - 新实现:用 `embeddingPort.embed([text])[0]` 拿到预计算向量,再调 `vectraStore.upsertItem(docId, vector, metadata)`。
	 *   upsertItem 直接写 LocalIndex,绕过 vectra 内部 embeddings 调用 — 与 IndexProcessor 同模式。
	 * - metadata.path 写入 docId,供后续 deleteByPath / 诊断页过滤。
	 *
	 * @param docId - 文档 ID(即记忆文件相对路径,如 `topics/GraphQL.md`)。
	 * @param text - 文档全文。
	 * @throws memoryIndex 为 null 时抛 `storeNotInit`;embeddingPort 为 null 时抛 `embeddingNotInit`;
	 *   embedding 返回空向量时抛 `embeddingFailed`。
	 */
	async upsertToIndex(docId: string, text: string): Promise<void> {
		if (!this.memoryIndex) {
			throw new Error(tNow('error.memory.storeNotInit'));
		}
		if (!this.embeddingPort) {
			throw new Error(tNow('error.memory.embeddingNotInit'));
		}
		// 关键路径:批量 embed 接口收 string[],这里只编一条文档,取结果数组第 0 项。
		const vectors = await this.embeddingPort.embed([text]);
		const vector = vectors[0];
		if (!vector) {
			throw new Error(tNow('error.memory.embeddingFailed'));
		}
		// 关键路径:upsertItem 绕过 vectra 内部 embeddings,直接写预计算向量。
		// metadata.path 与 docId 对齐,供 deleteByPath 按 path 过滤删除。
		await this.memoryIndex.upsertItem(docId, vector, { path: docId });
	}

	/**
	 * 在记忆 vectra 索引上做混合搜索(向量 + BM25),并回查原文。
	 *
	 * 关键路径:
	 * - 调用 `hybridSearch` 拿 TopK 文档级结果(docId + score + metadata)。
	 * - 对每条结果调 `getDocumentText` 回查原文,组装成 LLM 可直接引用的格式。
	 * - 加 index 编号(从 1 开始),与 search_vault 工具的 index 语义一致。
	 *
	 * @param query - 用户查询文本(用于 BM25)。
	 * @param queryVector - 查询向量(用于语义搜索,长度须等于 embedding dimensions)。
	 * @param topK - 返回结果上限。
	 * @returns 记忆搜索结果数组,含 index + docId + score + text。
	 * @throws memoryIndex 为 null 时抛 `tNow('error.memory.storeNotInit')`。
	 */
	async searchIndex(query: string, queryVector: number[], topK: number): Promise<MemorySearchResult[]> {
		if (!this.memoryIndex) {
			throw new Error(tNow('error.memory.storeNotInit'));
		}
		const results: VectorSearchResult[] = await this.memoryIndex.hybridSearch(query, queryVector, topK);

		// 关键路径:逐条回查原文 — getDocumentText 返回 null 时降级为空串,避免 LLM 看到 null。
		const enriched: MemorySearchResult[] = [];
		for (let i = 0; i < results.length; i++) {
			const r = results[i];
			if (!r) continue;
			const text = (await this.memoryIndex.getDocumentText(r.docId)) ?? '';
			enriched.push({
				index: i + 1,
				docId: r.docId,
				score: r.score,
				text,
			});
		}
		return enriched;
	}

	/**
	 * 从记忆 vectra 索引删除指定主题对应的文档。
	 *
	 * 关键路径:forget_memory 工具在主题文件清空时调用,确保索引与文件系统一致。
	 * docId 拼接为 `topics/{name}.md`,与 upsertToIndex 写入时的 docId 对齐。
	 *
	 * @param name - 主题名(不含 .md 后缀)。
	 * @throws memoryIndex 为 null 时抛 `tNow('error.memory.storeNotInit')`。
	 */
	async removeTopicFromIndexStore(name: string): Promise<void> {
		if (!this.memoryIndex) {
			throw new Error(tNow('error.memory.storeNotInit'));
		}
		await this.memoryIndex.delete([`topics/${name}.md`]);
	}

	/**
	 * 递归统计 baseDir 下所有文件大小(字节数)。
	 *
	 * 关键路径:
	 * - 用 `readdirSync` + `statSync` 递归遍历,跳过目录本身只算文件。
	 * - 空目录返回 0。
	 * - 用于诊断面板展示记忆系统磁盘占用。
	 *
	 * @returns baseDir 下所有文件大小之和(字节);目录不存在时返回 0。
	 */
	getTotalSize(): number {
		if (!fs.existsSync(this.baseDir)) return 0;
		return this.sumDirSize(this.baseDir);
	}

	/**
	 * 检查写入指定字节数后是否超过 10MB 存储上限。
	 *
	 * 关键路径:spec §7 容量上限 — remember 工具在写入前调用,超限拒绝写入并提示用户清理。
	 *
	 * @param additionBytes - 即将写入的字节数。
	 * @returns true 表示写入后仍在上限内;false 表示超限。
	 */
	isWithinStorageLimit(additionBytes: number): boolean {
		const current = this.getTotalSize();
		return current + additionBytes <= MEMORY_STORAGE_MAX_BYTES;
	}

	// ==================== 私有辅助 ====================

	/**
	 * 校验 topic 名是否合法 — 拒绝路径分隔符、.. 穿越片段、Windows 保留名与控制字符。
	 *
	 * 关键路径(C1 修复):topic 来自 LLM 输出,可能含 `../` 等穿越片段。
	 * 不校验会导致 readTopic/writeTopic/deleteTopic 越出 `.ratel/memory/topics/` 目录,
	 * 写入或删除任意文件(prompt injection 攻击向量)。
	 *
	 * 校验规则:
	 * - 拒绝空字符串与非字符串(undefined / null)
	 * - 拒绝路径分隔符 `/` `\`(防止跨目录)
	 * - 拒绝 `.` 与 `..`(防止穿越到父目录)
	 * - 拒绝 Windows 保留名(CON/NUL/AUX/COM1-9/LPT1-9,防止 Windows 文件系统异常)
	 * - 拒绝控制字符(\x00-\x1f,防止特殊字符注入)
	 *
	 * @param name - 主题名(不含 .md 后缀)。
	 * @throws name 含非法字符时抛 `invalidTopic`。
	 */
	private validateTopicName(name: string): void {
		if (!name || typeof name !== 'string') {
			throw new Error(tNow('error.memory.invalidTopic', { name: String(name) }));
		}
		// 关键路径:路径分隔符(正反斜杠)— 一旦命中即拒绝,不允许子目录主题。
		// 字符类里 `/` 无需转义(商店 no-useless-escape)。
		if (/[/\\]/.test(name)) {
			throw new Error(tNow('error.memory.invalidTopic', { name }));
		}
		// 关键路径:. 与 .. 直接穿越,显式拒绝。
		if (name === '.' || name === '..') {
			throw new Error(tNow('error.memory.invalidTopic', { name }));
		}
		// 关键路径:Windows 保留名 — 在 Windows 上会触发系统级错误,提前拒绝。
		if (/^(CON|NUL|AUX|COM[1-9]|LPT[1-9])$/i.test(name)) {
			throw new Error(tNow('error.memory.invalidTopic', { name }));
		}
		// 关键路径:控制字符(0x00-0x1f)包括换行、制表符等 — 不用正则字面量嵌入控制字符(商店 no-control-regex)。
		for (let i = 0; i < name.length; i++) {
			if (name.charCodeAt(i) <= 0x1f) {
				throw new Error(tNow('error.memory.invalidTopic', { name }));
			}
		}
	}

	/**
	 * 递归累加目录下所有文件大小。
	 *
	 * @param dir - 起始目录。
	 * @returns 该目录下所有文件大小之和(字节)。
	 */
	private sumDirSize(dir: string): number {
		let total = 0;
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				total += this.sumDirSize(fullPath);
			} else if (entry.isFile()) {
				total += fs.statSync(fullPath).size;
			}
		}
		return total;
	}

	/**
	 * 生成 global.md 空模板 — 含 frontmatter + 四个固定区块。
	 *
	 * 关键路径:updated 字段用 ISO 8601 时间戳,便于后续诊断"最后更新时间"。
	 */
	private buildGlobalTemplate(): string {
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
	 * 生成 index.md 空模板 — 含 frontmatter + 主题列表区块占位。
	 */
	private buildIndexTemplate(): string {
		const now = new Date().toISOString();
		return `---
memory_type: index
updated: ${now}
---

## 主题列表
`;
	}
}

/** splitGlobalSections 的返回结构 — pinned 与 normal 两桶正文 */
export interface GlobalSections {
	/** 带 [pinned] 标记的段落全文(标题 + 正文,按出现顺序拼接) */
	pinned: string;
	/** 其余内容(frontmatter + 非 pinned 段落),沿用全文注入的既有行为 */
	normal: string;
}

/** 识别段落标题行尾 [pinned] 标记;如 `## 偏好 [pinned]` */
const PINNED_HEADING_REGEX = /^(#{1,6}\s+.+?)\s+\[pinned\]\s*$/;

/**
 * 拆分 global.md 为 pinned / normal 两桶(S-SR-LAYERING 分层注入)。
 *
 * 关键路径:
 * - 事实源就在正文里 — 用户手编 `[pinned]` 后缀即生效,无独立 contract 数据结构(ADR-016 ①)。
 * - 标记被误删时该段降级进 normal 桶,无功能损坏(向后兼容)。
 * - frontmatter 归 normal 桶 — 现状即全文注入,不改变既有行为。
 *
 * @param content - global.md 全文
 * @returns 两桶正文;pinned 为空串表示无任何标记段落
 */
export function splitGlobalSections(content: string): GlobalSections {
	const lines = content.split('\n');
	const pinnedParts: string[] = [];
	const normalParts: string[] = [];
	let inPinned = false;
	let inCodeFence = false;
	for (const line of lines) {
		// 修复:代码块围栏内的 `#` 行(shell 注释等)不是标题,不重算 inPinned,防止 pinned 正文误入 normal 桶。
		if (line.startsWith('```')) {
			inCodeFence = !inCodeFence;
		}
		if (!inCodeFence && line.startsWith('#')) {
			inPinned = PINNED_HEADING_REGEX.test(line);
		}
		// 关键路径:frontmatter(--- 围栏)与无标题前导行都归 normal。
		(inPinned ? pinnedParts : normalParts).push(line);
	}
	return { pinned: pinnedParts.join('\n').trim(), normal: normalParts.join('\n').trim() };
}
