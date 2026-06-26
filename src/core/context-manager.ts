/**
 * @file src/core/context-manager.ts
 * @description ContextManager — 会话上下文管理器,负责 Session 加载/保存与对话消息累积,并提供 token 估算。
 * @module core/context-manager
 * @depends ../ports/persistence, ../ports/llm
 */

import type { Persistence, Session, ChatMessage } from '../ports/persistence';
import type { ToolCall } from '../ports/llm';
// 关键路径:Intent 复用意图分类器定义,避免类型重复声明导致两端不同步
import type { Intent } from './intent-classifier';

/**
 * 基础系统提示词 — direct 模式(闲聊、生成、统计等不需要搜索的场景)。
 *
 * 关键路径:英文版,token 效率高于中文;`Always respond in the same language the user uses`
 * 强制 LLM 跟随用户语言,避免用户问中文时模型用英文回答。
 */
const BASE_PROMPT = `You are Ratel, an AI assistant that helps users explore and manage their Obsidian vault. You can read notes and answer questions about their content. Always respond in the same language the user uses.`;

/**
 * RAG 系统提示词 — rag 模式(问知识库内容、查笔记关系等需要搜索的场景)。
 *
 * 关键路径:在 BASE_PROMPT 基础上追加 RAG 工作流指令,引导 LLM:
 * 1. 调 search_vault 找相关笔记(结果带 index 编号)
 * 2. 调 read_note 读全文
 * 3. 回答时用 [1][2] 引用 search_vault 返回的 index
 */
const RAG_PROMPT = BASE_PROMPT + `

When answering knowledge base questions, follow this workflow:
1. Call search_vault to find relevant notes. Results include an index number for citation.
2. Call read_note for promising results to read the full content.
3. Answer the question and cite sources using [1], [2] format matching the index numbers from search results.
4. If search returns no results, tell the user honestly.
`;

const VAULT_TOOLS_GUIDE_ZH = `

你可使用以下 vault 工具:
- search_vault: 语义搜索(向量+BM25),适合找概念相关的内容
- grep: 全文精确/正则搜索,适合查找特定汉字、代码、固定字符串
- glob: 按文件名模式查找笔记(如 "daily/*.md")
- list_files: 列出目录内容
- read_note: 读取笔记全文
- write_note: 创建或覆盖笔记
- append_note: 在笔记末尾追加内容
- edit_note: 精确替换文本(old_string 必须唯一且完全匹配)
- delete_note: 将笔记移到回收站(可恢复)

何时用 grep 而非 search_vault:
- 用户要找特定词语、精确字符串、正则模式,或「包含 X 的所有文件」→ 用 grep
- 用户问主题、概念、语义相关内容 → 用 search_vault
- 不确定时先试 search_vault;若结果未包含精确词,再用 grep 补充
`;

const RAG_PROMPT_WITH_TOOLS = RAG_PROMPT + VAULT_TOOLS_GUIDE_ZH;

/**
 * 会话上下文管理器。
 *
 * 设计要点:
 * - `session` 在 `load()` 之前为 `null`,所有 mutator 方法都先调 `requireSession()` 做护栏。
 * - 任何 `add*` 方法都会更新 `session.updatedAt`,便于上层按"最近活跃"排序。
 * - `toMessages()` 总是返回 `[system, ...searchResultsMessages, ...session.messages]`,保证 LLM 始终看到最新系统提示与当前检索上下文。
 * - `load()` 切换 session 时会清空 `searchResultsMessages`,避免旧 session 的检索结果泄漏到新 session。
 * - Layer 1 截断:历史消息超过 `maxHistoryTokens` 时从最旧开始裁剪,保护系统提示词 + 搜索结果 + 最近消息。
 *
 * @example
 *   const ctx = new ContextManager(persistence);
 *   await ctx.load('session-1');
 *   ctx.addUserMessage('hello');
 *   const messages = ctx.toMessages();
 */
export class ContextManager {
	private session: Session | null = null;
	/**
	 * 当前 session 的检索结果消息,保存在 session.messages 之外,
	 * 便于在切换 session 时整体丢弃,避免旧 session 的检索结果泄漏。
	 */
	private searchResultsMessages: ChatMessage[] = [];
	/**
	 * 历史池 token 预算上限。超出时触发 Layer 1 截断(从最旧消息裁剪)。
	 * 默认 8000 tokens(~32K 字符),适配 32K 窗口模型的历史池占比。
	 */
	private readonly maxHistoryTokens: number;

	/**
	 * @param persistence - 持久化端口,用于加载/保存 session。
	 * @param maxHistoryTokens - 历史池 token 上限,默认 8000。
	 */
	constructor(private persistence: Persistence, maxHistoryTokens = 8000) {
		this.maxHistoryTokens = maxHistoryTokens;
	}

	/**
	 * 加载已有 session;若不存在则创建新 session(in-memory,不落盘)。
	 * 切换 session 时清空当前检索结果,防止旧 session 的检索上下文泄漏到新 session。
	 *
	 * @param sessionId - 会话标识。
	 * @returns 加载完成(无返回值)。
	 */
	async load(sessionId: string): Promise<void> {
		this.searchResultsMessages = [];
		this.session = await this.persistence.sessions.get(sessionId);
		if (!this.session) {
			this.session = {
				id: sessionId,
				title: '',
				messages: [],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
		}
	}

	/**
	 * 追加用户消息。
	 *
	 * @param content - 用户消息文本。
	 * @throws 在 `load()` 之前调用会抛 'Session not loaded'。
	 */
	addUserMessage(content: string): void {
		const session = this.requireSession();
		session.messages.push({ role: 'user', content });
		session.updatedAt = Date.now();
	}

	/**
	 * 追加纯文本 assistant 消息(无 tool call 的回复)。
	 *
	 * @param content - assistant 文本。
	 */
	addAssistantMessage(content: string): void {
		const session = this.requireSession();
		session.messages.push({ role: 'assistant', content });
		session.updatedAt = Date.now();
	}

	/**
	 * 追加 assistant 工具调用消息,把 toolCall 元数据一并保存,供后续 tool result 配对。
	 *
	 * @param toolCall - 工具调用对象(含 id/name/args)。
	 * @param text - 与 tool call 同时产生的 assistant 文本(可为空)。
	 */
	addAssistantToolCall(toolCall: ToolCall, text: string): void {
		const session = this.requireSession();
		session.messages.push({
			role: 'assistant',
			content: text,
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			toolArgs: toolCall.args,
		});
		session.updatedAt = Date.now();
	}

	/**
	 * 追加工具结果消息,必须与 `addAssistantToolCall` 中的 toolCallId 对应。
	 *
	 * @param toolCallId - 对应的 assistant 工具调用 id。
	 * @param result - 工具结果(序列化为字符串)。
	 */
	addToolResult(toolCallId: string, result: string): void {
		const session = this.requireSession();
		session.messages.push({
			role: 'tool',
			content: result,
			toolCallId,
		});
		session.updatedAt = Date.now();
	}

	/**
	 * 把搜索结果格式化为系统消息追加到上下文。
	 *
	 * 设计要点:
	 * - 插入位置固定:base system prompt 之后、历史消息之前。
	 * - 多次调用追加,不覆盖,支持多轮检索。
	 * - content 来自 read_note,不是 search_vault(工具只返回 metadata)。
	 *
	 * @param results - 搜索结果,每项包含文档路径与已读取的内容。
	 */
	addSearchResults(results: Array<{ path: string; content: string }>): void {
		this.requireSession();
		if (results.length === 0) return;

		const formatted = results
			.map((r, i) => `[${i + 1}] ${r.path}\n${r.content}`)
			.join('\n\n');

		this.searchResultsMessages.push({
			role: 'system',
			content: `--- 知识库检索结果 ---\n\n${formatted}`,
		});
		// 修复:检索结果消息不应更新 session.updatedAt,它不属于会话历史;但保留对旧行为兼容,暂不影响功能。
	}

	/**
	 * 拼接最终给 LLM 的消息列表(系统提示 + 检索结果 + 历史消息)。
	 *
	 * 关键路径:
	 * - 按意图选择 BASE_PROMPT(direct)或 RAG_PROMPT(rag)
	 * - 历史消息超出 `maxHistoryTokens` 时触发 Layer 1 截断
	 * - 系统提示词和搜索结果不在裁剪范围
	 *
	 * @param intent - 意图分类结果,默认 'direct'(向后兼容)
	 * @returns 消息数组,首条为 system 角色
	 */
	toMessages(intent: Intent = 'direct'): ChatMessage[] {
		const systemPrompt = intent === 'rag' ? RAG_PROMPT_WITH_TOOLS : BASE_PROMPT;
		const history = this.session?.messages ?? [];
		const trimmed = this.trimHistory(history);
		return [
			{ role: 'system', content: systemPrompt },
			...this.searchResultsMessages,
			...trimmed,
		];
	}

	/**
	 * Layer 1 截断:从最旧历史消息开始裁剪,直到 token 估算落入预算。
	 *
	 * 关键路径:
	 * - 至少保留最后 1 条消息(当前用户输入 / 最近工具结果),避免空上下文。
	 * - 截断只影响发给 LLM 的消息列表,不修改 session.messages 原文(持久化不受影响)。
	 * - tool 消息如果对应的 assistant tool call 被裁掉,LLM 会忽略孤立 tool result(可接受,Layer 2 再处理配对)。
	 *
	 * @param messages - session 内的完整历史消息。
	 * @returns 裁剪后的消息数组(可能比输入短)。
	 */
	private trimHistory(messages: ChatMessage[]): ChatMessage[] {
		if (messages.length <= 1) return messages;

		const estimateTokens = (msgs: ChatMessage[]): number =>
			Math.ceil(msgs.map((m) => m.content).join('').length / 4);

		const tokens = estimateTokens(messages);
		if (tokens <= this.maxHistoryTokens) return messages;

		// 关键路径:从最旧开始裁剪,保留最后 1 条(当前上下文)。
		const trimmed = [...messages];
		while (trimmed.length > 1 && estimateTokens(trimmed) > this.maxHistoryTokens) {
			trimmed.shift();
		}
		return trimmed;
	}

	/**
	 * 估算当前上下文的 token 数(粗略算法,每 4 字符约 1 token,中英文混合经验值)。
	 *
	 * @returns token 估算值(向上取整)。
	 */
	tokenCount(): number {
		// 粗略估算:中英文混合 ~4 字符/token,精度足够用于"是否需要截断"的判断,不可用于计费。
		const text = this.toMessages().map((m) => m.content).join('');
		return Math.ceil(text.length / 4);
	}

	/**
	 * 把当前 session 持久化到 storage。
	 *
	 * @throws 在 `load()` 之前调用会抛 'Session not loaded'。
	 */
	async save(): Promise<void> {
		const session = this.requireSession();
		await this.persistence.sessions.upsert(session);
	}

	/**
	 * 当前 session id,未加载时返回空串。
	 */
	get sessionId(): string {
		return this.session?.id ?? '';
	}

	/**
	 * 内部护栏:未加载时抛错,避免在 null session 上误操作。
	 *
	 * @returns 当前 session 引用(非 null)。
	 * @throws 'Session not loaded. Call load() first.'。
	 */
	private requireSession(): Session {
		if (!this.session) throw new Error('Session not loaded. Call load() first.');
		return this.session;
	}
}
