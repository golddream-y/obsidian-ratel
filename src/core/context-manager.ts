/**
 * @file src/core/context-manager.ts
 * @description ContextManager — 会话上下文管理器,负责 Session 加载/保存与对话消息累积,并提供 token 估算。
 * @module core/context-manager
 * @depends ../ports/persistence, ../ports/llm
 */

import type { Persistence, Session, ChatMessage, CompactMarker } from '../ports/persistence';
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
import {
	formatSkillInstructionsContent,
	formatSkillSupersedeContent,
	sessionHasSkillInstructions,
	sessionHasSkillSupersede,
} from './skill-session-messages';
import type { Skill } from '../skills/types';
import { projectView } from './compact-project';

/**
 * ContextManager 依赖注入 — 解耦 settings/工具注册表。
 *
 * - `getOverrides`: 返回当前 prompt section 覆盖(来自 settings.promptOverrides)
 * - `getTools`: 返回当前已注册的工具定义(来自 ToolRegistry,供 RAG toolGuide 拼接)
 */
export interface ContextManagerDeps {
	getOverrides: () => OverrideMap;
	getTools: () => ToolDefinition[];
	/**
	 * 关键路径:返回当前 Skill Discovery 段文本(由 Activator 产出)。
	 * 空串表示不注入(无 enabled skill 或 enableSkills=false)。
	 */
	getSkillsDiscovery?: () => string;
	/**
	 * 关键路径:返回当前 Skill Active 段文本(由 Activator 产出)。
	 * 空串表示无激活 skill。
	 */
	getSkillsActive?: () => string;
}

/**
 * 会话上下文管理器。
 *
 * 设计要点:
 * - `session` 在 `load()` 之前为 `null`,所有 mutator 方法都先调 `requireSession()` 做护栏。
 * - 任何 `add*` 方法都会更新 `session.updatedAt`,便于上层按"最近活跃"排序。
 * - `toMessages()` 返回 Composer 系统段 + 检索结果 + `projectView` 投影后的 head/tail(tail 经 Layer 1 截断);`getTranscript()` 仅返回 `session.messages` 浅拷贝(UI 事实源)。
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
	 * Skill Discovery 段 — 启动时由 setSkillsContext() 设置,
	 * 注入位置在 memorySystemPrompt 之后、searchResults 之前。
	 */
	private skillsDiscovery = '';
	/**
	 * @deprecated ADR-012:Active 段不再作为注入源;保留字段仅为 API 兼容,toMessages 忽略之。
	 */
	private skillsActive = '';
	/**
	 * 环境时间注入行 — 每次 ask() 由 setEnvContext() 设置,
	 * 注入位置在 system prompt 之后、memory 之前;空串不注入。
	 */
	private envContextLine = '';
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
	 * @param reasoning - 可选思考过程(thinking 模式多轮回传用)。
	 */
	addAssistantMessage(content: string, reasoning?: string): void {
		const session = this.requireSession();
		const msg: ChatMessage = { role: 'assistant', content };
		// 关键路径:仅在有内容时写入,避免持久化空字段污染历史
		if (reasoning) msg.reasoning = reasoning;
		session.messages.push(msg);
		session.updatedAt = Date.now();
	}

	/**
	 * 追加 assistant 工具调用消息,把 toolCall 元数据一并保存,供后续 tool result 配对。
	 *
	 * @param toolCall - 工具调用对象(含 id/name/args)。
	 * @param text - 与 tool call 同时产生的 assistant 文本(可为空)。
	 * @param reasoning - 可选思考过程;含 tool_calls 时 DeepSeek thinking 模式要求后续必回传。
	 */
	addAssistantToolCall(toolCall: ToolCall, text: string, reasoning?: string): void {
		const session = this.requireSession();
		const msg: ChatMessage = {
			role: 'assistant',
			content: text,
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			toolArgs: toolCall.args,
		};
		if (reasoning) msg.reasoning = reasoning;
		session.messages.push(msg);
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
	addSearchResults(
		results: Array<{ path: string; content: string; index?: number }>,
	): void {
		this.requireSession();
		if (results.length === 0) return;

		this.searchResultsMessages.push({
			role: 'system',
			content: formatSearchResultsBlock(results, this.deps.getOverrides()),
		});
		// 修复:检索结果消息不应更新 session.updatedAt,它不属于会话历史;但保留对旧行为兼容,暂不影响功能。
	}

	/**
	 * 用最新一轮 search 索引块替换上下文中的检索注入(清空后写入)。
	 *
	 * 关键路径:同一回合多次 search_vault 时与 UI「后写覆盖」对齐。
	 *
	 * @param results - 搜索结果,每项包含文档路径与可选内容(content 缺省为 `''`);
	 *   可选 `index` 与 search_vault / UI chip 对齐。
	 */
	replaceSearchIndexBlock(
		results: Array<{ path: string; content?: string; index?: number }>,
	): void {
		this.searchResultsMessages = [];
		if (results.length === 0) return;
		// 关键路径:保持调用方传入顺序与真实 index;勿按过滤后下标重编号
		this.addSearchResults(
			results.map((r) => ({
				path: r.path,
				content: r.content ?? '',
				...(r.index !== undefined ? { index: r.index } : {}),
			})),
		);
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
	 * 返回当前 prompt overrides(供 agent-loop 在 activate_skill / deactivate_skill
	 * 工具执行后重组 skills 段时使用)。
	 *
	 * 关键路径:替代调用方对 private deps 字段做类型断言,提供受控的读取入口。
	 *
	 * @returns 当前 OverrideMap(来自 settings.promptOverrides)
	 */
	getOverrides(): OverrideMap {
		return this.deps.getOverrides();
	}

	/**
	 * 设置环境时间上下文 — 每次 ask() 启动时调用。
	 *
	 * 关键路径:注入到 system prompt 之后、memory / skills 之前,
	 * 让「今天几号」无需工具调用即可回答。
	 *
	 * @param line - 单行环境时间文案(空串则不注入)
	 */
	setEnvContext(line: string): void {
		this.envContextLine = line;
	}

	/**
	 * 设置 Skill 上下文 — 会话启动时注入 Discovery 目录。
	 *
	 * ADR-012:第二个参数 `active` 已废弃,传入值会被忽略(指令靠 Session.messages)。
	 *
	 * @param discovery - Discovery 段文本(空串则不注入)
	 * @param _active - 忽略;保留签名兼容旧调用
	 */
	setSkillsContext(discovery: string, _active: string = ''): void {
		this.skillsDiscovery = discovery;
		this.skillsActive = '';
		void _active;
	}

	/**
	 * 本场 messages 是否已含该 skill 指令正文。
	 */
	hasSkillInstructions(name: string): boolean {
		const session = this.requireSession();
		return sessionHasSkillInstructions(session.messages, name);
	}

	/**
	 * 将 skill 正文写入当前 Session(system + `[skill:name]` 前缀)。
	 * 已存在则幂等跳过。
	 */
	appendSkillInstructions(name: string, body: string): void {
		const session = this.requireSession();
		if (sessionHasSkillInstructions(session.messages, name)) return;
		session.messages.push({
			role: 'system',
			content: formatSkillInstructionsContent(name, body),
		});
		session.updatedAt = Date.now();
	}

	/**
	 * 追加 supersede 短消息(无法从历史上物理删除已注入正文)。
	 * 未注入过则 no-op;已 supersede 则幂等跳过。
	 */
	appendSkillSupersede(name: string): void {
		const session = this.requireSession();
		if (!sessionHasSkillInstructions(session.messages, name)) return;
		if (sessionHasSkillSupersede(session.messages, name)) return;
		session.messages.push({
			role: 'system',
			content: formatSkillSupersedeContent(name),
		});
		session.updatedAt = Date.now();
	}

	/**
	 * 为 `activation: always` 的 skill 各注入一次(本场尚未写入时)。
	 *
	 * @param skills - always 且已启用的 Skill 列表
	 */
	ensureAlwaysSkillsInjected(skills: Skill[]): void {
		for (const s of skills) {
			this.appendSkillInstructions(s.manifest.name, s.instructions);
		}
	}

	/**
	 * 拼接最终给 LLM 的消息列表(系统提示 + 记忆注入 + 检索结果 + 历史消息)。
	 *
	 * 关键路径:
	 * - 通过 Composer 组装系统提示词(direct / rag),支持 section 覆盖与工具指引注入
	 * - 记忆注入位置在 system prompt 之后、检索结果之前,让 Agent 先"认识"用户再看检索上下文
	 * - 历史消息超出 `maxHistoryTokens` 时触发 Layer 1 截断
	 * - 系统提示词、记忆注入和搜索结果不在裁剪范围
	 * - ADR-012:Skill 完整指令在 session.messages 内,此处只注入 Discovery 目录
	 *
	 * @param intent - 意图分类结果,默认 'direct'(向后兼容)
	 * @returns 消息数组,首条为 system 角色
	 */
	toMessages(intent: Intent = 'direct'): ChatMessage[] {
		const overrides = this.deps.getOverrides();
		const tools = this.deps.getTools();
		const systemPrompt = composeAgentSystem(intent, { intent, tools }, overrides);
		const history = this.session?.messages ?? [];
		const markers = this.session?.compactMarkers;
		const { head, tail } = projectView(history, markers);
		const trimmedTail = this.trimHistory(tail);

		// 关键路径:记忆注入位置在 system prompt 之后、检索结果之前,
		// 让 Agent 在看到检索结果和历史之前先"认识"用户。
		const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];
		// 关键路径:环境时间紧跟主 system,零工具成本回答「今天几号」。
		if (this.envContextLine) {
			messages.push({ role: 'system', content: this.envContextLine });
		}
		if (this.memorySystemPrompt) {
			messages.push({ role: 'system', content: this.memorySystemPrompt });
		}
		// 关键路径:ADR-012 — 仅 Discovery;Active 段废弃(skillsActive 恒为空)。
		if (this.skillsDiscovery) {
			messages.push({ role: 'system', content: this.skillsDiscovery });
		}
		void this.skillsActive;
		messages.push(...this.searchResultsMessages, ...head, ...trimmedTail);
		return messages;
	}

	/**
	 * 返回 UI 事实源 transcript — `session.messages` 浅拷贝,不含 Composer 主 system。
	 *
	 * @returns 当前 session 消息数组副本(含 skill system 等已写入 transcript 的行)
	 */
	getTranscript(): ChatMessage[] {
		return [...this.requireSession().messages];
	}

	/**
	 * 返回当前 session 的 compact 标记副本。
	 *
	 * @returns CompactMarker 数组;无标记时返回空数组
	 */
	getCompactMarkers(): CompactMarker[] {
		return [...(this.session?.compactMarkers ?? [])];
	}

	/**
	 * 追加全量压缩标记 — 只写 `compactMarkers`,不修改 `messages` 条数。
	 *
	 * @param marker - 投影标记(afterIndex / summary / restoredNotePaths / at)
	 */
	async appendCompactMarker(marker: CompactMarker): Promise<void> {
		const session = this.requireSession();
		session.compactMarkers = [...(session.compactMarkers ?? []), marker];
		session.updatedAt = Date.now();
		await this.save();
	}

	/**
	 * Layer 1 截断:从最旧历史消息开始裁剪,直到 token 估算落入预算。
	 *
	 * 关键路径:
	 * - 至少保留最后 1 条消息(当前用户输入 / 最近工具结果),避免空上下文。
	 * - 截断只影响发给 LLM 的消息列表,不修改 session.messages 原文(持久化不受影响)。
	 * - tool 消息如果对应的 assistant tool call 被裁掉,LLM 会忽略孤立 tool result(可接受,Layer 2 再处理配对)。
	 *
	 * @param messages - 投影后的 tail 消息(不含 head 摘要段)。
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
		// 修复:in-memory session 常保留空 title(load 后未改字段),而 AI 总结已写入磁盘;
		// 若直接 upsert 会用 derive(首条 user)盖掉总结标题 → Header 新、编辑弹框旧。
		const disk = await this.persistence.sessions.get(session.id);
		if (disk) {
			if (!session.title?.trim() && disk.title?.trim()) {
				session.title = disk.title;
			}
			if (!session.shortTitle?.trim() && disk.shortTitle?.trim()) {
				session.shortTitle = disk.shortTitle;
			}
		}
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
