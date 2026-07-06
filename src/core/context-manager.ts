/**
 * @file src/core/context-manager.ts
 * @description ContextManager — 会话上下文管理器,负责 Session 加载/保存与对话消息累积,并提供 token 估算。
 * @module core/context-manager
 * @depends ../ports/persistence, ../ports/llm
 */

import type { Persistence, Session, ChatMessage } from '../ports/persistence';
import type { ToolCall, ToolDefinition } from '../ports/llm';
// 关键路径:Intent 复用意图分类器定义,避免类型重复声明导致两端不同步
import type { Intent } from './intent-classifier';
// 关键路径:中英混合 token 估算,比 length/4 更准(中文 1.5 字符/token,英文 4 字符/token)
import { estimateTokens } from '../ui/tokens/token-estimator';
// 关键路径:系统提示词与检索结果外框统一由 Composer 组装,保证 prompt 注入防护(外框不可删)与 section 覆盖机制生效
import { composeAgentSystem, composeMemorySystemPrompt, formatSearchResultsBlock } from '../prompts/composer';
import type { OverrideMap } from '../prompts/types';
// 关键路径:TopicIndexEntry 用于 setMemoryContext 接收记忆索引主题列表的类型契约
import type { TopicIndexEntry } from '../types';

/**
 * ContextManager 依赖注入 — 解耦 settings/工具注册表。
 *
 * - `getOverrides`: 返回当前 prompt section 覆盖(来自 settings.promptOverrides)
 * - `getTools`: 返回当前已注册的工具定义(来自 ToolRegistry,供 RAG toolGuide 拼接)
 */
export interface ContextManagerDeps {
	getOverrides: () => OverrideMap;
	getTools: () => ToolDefinition[];
}

/**
 * 会话上下文管理器。
 *
 * 设计要点:
 * - `session` 在 `load()` 之前为 `null`,所有 mutator 方法都先调 `requireSession()` 做护栏。
 * - 任何 `add*` 方法都会更新 `session.updatedAt`,便于上层按"最近活跃"排序。
 * - `toMessages()` 总是返回 `[system, ...searchResultsMessages, ...session.messages]`,保证 LLM 始终看到最新系统提示与当前检索上下文。
 * - `load()` 切换 session 时会清空 `searchResultsMessages`,避免旧 session 的检索结果泄漏到新 session。
 * - Layer 1 截断:历史消息超过 `maxHistoryTokens` 时从最旧开始裁剪,保护系统提示词 + 搜索结果 + 最近消息。
 * - 系统提示词与检索结果外框通过 Composer 组装(direct / rag),解耦具体文案并支持 section 覆盖。
 *
 * @example
 *   const ctx = new ContextManager(persistence, deps);
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
	 * 记忆系统注入提示 — 启动时由 setMemoryContext() 设置,
	 * 注入位置在 system prompt 与 searchResults 之间。
	 * 空串表示不注入(未加载记忆或 global.md 为空)。
	 */
	private memorySystemPrompt: string = '';
	/**
	 * 历史池 token 预算上限。超出时触发 Layer 1 截断(从最旧消息裁剪)。
	 * 默认 8000 tokens(~32K 字符),适配 32K 窗口模型的历史池占比。
	 */
	private readonly maxHistoryTokens: number;

	/**
	 * @param persistence - 持久化端口,用于加载/保存 session。
	 * @param deps - 依赖注入(overrides 与 tools 来源);缺省返回空 overrides 与空工具列表。
	 * @param maxHistoryTokens - 历史池 token 上限,默认 8000。
	 */
	constructor(
		private persistence: Persistence,
		private deps: ContextManagerDeps = {
			getOverrides: () => ({}),
			getTools: () => [],
		},
		maxHistoryTokens = 8000,
	) {
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
	 * - 外框(prefix/suffix)由 Composer 硬编码,关键路径:防 prompt 注入(检索结果不可被当作指令)。
	 *
	 * @param results - 搜索结果,每项包含文档路径与已读取的内容。
	 */
	addSearchResults(results: Array<{ path: string; content: string }>): void {
		this.requireSession();
		if (results.length === 0) return;

		this.searchResultsMessages.push({
			role: 'system',
			content: formatSearchResultsBlock(results, this.deps.getOverrides()),
		});
		// 修复:检索结果消息不应更新 session.updatedAt,它不属于会话历史;但保留对旧行为兼容,暂不影响功能。
	}

	/**
	 * 追加自定义 system 消息到当前 session(用于 /compact 摘要注入等场景)。
	 *
	 * 关键路径:写入 session.messages(而非 searchResultsMessages),会被持久化保存。
	 *
	 * @param content - system 消息内容。
	 * @throws 在 `load()` 之前调用会抛 'Session not loaded'。
	 */
	addSystemMessage(content: string): void {
		const session = this.requireSession();
		session.messages.push({ role: 'system', content });
		session.updatedAt = Date.now();
	}

	/**
	 * 重置 session — 删除当前持久化,新建空 session,注入摘要 system 消息 + preserved 消息。
	 *
	 * 关键路径:供 /compact 使用。原 session 历史被完全丢弃,只保留摘要 + 最近 N 条原文。
	 *
	 * 设计要点:
	 * - 先 `delete` 持久化,失败则抛原错误,此时 `this.session` 仍是旧的(未破坏当前状态)
	 * - 删除成功后 `load` 会重建空 session(因为持久化里已无此 id)
	 * - 摘要以 `[compact 摘要]` 前缀包装为 system 消息,便于后续识别
	 * - preserved 原文按原 role 直接 push,保留 tool 消息等非 user/assistant 角色
	 *
	 * @param sessionId - 会话 ID(同名)
	 * @param summary - 摘要文本(已由 LLM 生成)
	 * @param preservedMessages - 保留的最近原文消息(通常是最后 3 条)
	 * @throws 若 persistence.sessions.delete 失败,抛原错误。
	 */
	async resetSession(
		sessionId: string,
		summary: string,
		preservedMessages: ChatMessage[],
	): Promise<void> {
		// 关键路径:先删持久化,失败则抛错,不破坏当前 session 状态(此时 this.session 仍是旧的)
		await this.persistence.sessions.delete(sessionId);
		// 重新 load 创建空 session(持久化里已无此 id)
		await this.load(sessionId);
		// 注入摘要 system 消息
		this.addSystemMessage(`[compact 摘要]\n${summary}`);
		// 关键路径:复用 requireSession 拿局部变量,避免 this.session! 非空断言
		const session = this.requireSession();
		// 注入保留的原文(按原 role 直接 push,保留 tool 消息等)
		session.messages.push(...preservedMessages);
		// 关键路径:整体 reset 操作完成时间,覆盖 preservedMessages push 的时间戳
		session.updatedAt = Date.now();
		// 关键路径:resetSession 已 delete 持久化,必须 save 重建,
		// 否则调用方 reload 后拿到空 session(数据丢失风险)
		await this.save();
	}

	/**
	 * 设置记忆上下文 — 在会话启动时调用,注入 global.md 全文 + index.md 主题列表。
	 *
	 * 关键路径:
	 * - 通过 deps.getOverrides() 拿当前 prompt section 覆盖,传给 composeMemorySystemPrompt。
	 * - composeMemorySystemPrompt 内部会做 20KB 截断(I3)+ retrieval wrapper 包装(I4)。
	 * - 生成的提示存入 this.memorySystemPrompt,toMessages() 时插入到 system 与 searchResults 之间。
	 *
	 * @param globalContent - global.md 全文
	 * @param indexEntries - index.md 解析出的主题列表
	 */
	setMemoryContext(globalContent: string, indexEntries: TopicIndexEntry[]): void {
		const overrides = this.deps.getOverrides();
		this.memorySystemPrompt = composeMemorySystemPrompt(globalContent, indexEntries, overrides);
	}

	/**
	 * 拼接最终给 LLM 的消息列表(系统提示 + 记忆注入 + 检索结果 + 历史消息)。
	 *
	 * 关键路径:
	 * - 通过 Composer 组装系统提示词(direct / rag),支持 section 覆盖与工具指引注入
	 * - 记忆注入位置在 system prompt 之后、检索结果之前,让 Agent 先"认识"用户再看检索上下文
	 * - 历史消息超出 `maxHistoryTokens` 时触发 Layer 1 截断
	 * - 系统提示词、记忆注入和搜索结果不在裁剪范围
	 *
	 * @param intent - 意图分类结果,默认 'direct'(向后兼容)
	 * @returns 消息数组,首条为 system 角色
	 */
	toMessages(intent: Intent = 'direct'): ChatMessage[] {
		const overrides = this.deps.getOverrides();
		const tools = this.deps.getTools();
		const systemPrompt = composeAgentSystem(intent, { intent, tools }, overrides);
		const history = this.session?.messages ?? [];
		const trimmed = this.trimHistory(history);

		// 关键路径:记忆注入位置在 system prompt 之后、检索结果之前,
		// 让 Agent 在看到检索结果和历史之前先"认识"用户。
		const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];
		if (this.memorySystemPrompt) {
			messages.push({ role: 'system', content: this.memorySystemPrompt });
		}
		messages.push(...this.searchResultsMessages, ...trimmed);
		return messages;
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

		const countTokens = (msgs: ChatMessage[]): number =>
			estimateTokens(msgs.map((m) => m.content).join(''));

		const tokens = countTokens(messages);
		if (tokens <= this.maxHistoryTokens) return messages;

		// 关键路径:从最旧开始裁剪,保留最后 1 条(当前上下文)。
		const trimmed = [...messages];
		while (trimmed.length > 1 && countTokens(trimmed) > this.maxHistoryTokens) {
			trimmed.shift();
		}
		return trimmed;
	}

	/**
	 * 估算当前上下文的 token 数(中英混合权重估算,真值靠 API usage 校准)。
	 *
	 * @returns token 估算值(向上取整)。
	 */
	tokenCount(): number {
		// 关键路径:用 estimateTokens 中英混合估算,比 length/4 更准。
		const text = this.toMessages().map((m) => m.content).join('');
		return estimateTokens(text);
	}

	/**
	 * 返回当前上下文使用率快照 — 供 StatusLine / StatusDrawer 显示百分比与详情。
	 *
	 * 关键路径:
	 * - usedTokens 复用 toMessages() 输出做 4 字符/token 估算(与 tokenCount 同算法)
	 * - maxTokens 由调用方从 settings.chatModelMaxTokens 传入,避免本类耦合 settings
	 * - attachmentTokens 由调用方累加 pendingAttachments$ 中每项 estimatedTokens
	 * - percentage 在 maxTokens=0 时防除零返回 0
	 *
	 * @param maxTokens - 模型上下文窗口上限(从 settings 传入)
	 * @param attachmentTokens - 待发送附件估算 token 总和(默认 0)
	 * @param intent - 意图分类(默认 'direct',影响系统提示词长度)
	 * @returns ContextUsage 快照
	 */
	getContextUsage(
		maxTokens: number,
		attachmentTokens = 0,
		intent: Intent = 'direct',
	): { usedTokens: number; maxTokens: number; attachmentTokens: number; percentage: number } {
		const text = this.toMessages(intent).map((m) => m.content).join('');
		const usedTokens = estimateTokens(text);
		const total = usedTokens + attachmentTokens;
		const percentage = maxTokens > 0 ? Math.round((total / maxTokens) * 100) : 0;
		return { usedTokens, maxTokens, attachmentTokens, percentage };
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
