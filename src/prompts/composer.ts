/**
 * @file src/prompts/composer.ts
 * @description Prompt 组装 API — 拼装 agent system、内部 LLM messages、工具定义、检索结果块
 * @module prompts/composer
 * @depends prompts/defaults/zh, prompts/interpolate, prompts/tool-schemas
 */

import type { ChatMessage, ToolDefinition } from '../ports/llm';
import type { Intent } from '../core/intent-classifier';
import { ZH_DEFAULTS } from './defaults/zh';
import { interpolate } from './interpolate';
import type { InternalTask, OverrideMap, PromptContext, PromptSectionId } from './types';
import { TOOL_SCHEMA_SKELETONS } from './tool-schemas';
import { tNow } from '../i18n';

/**
 * 检索结果外框前缀 — 不可被 override 删除。
 * 关键路径:防止 LLM 把检索结果当作指令执行(prompt injection 防护)。
 *
 * 关键路径:用函数而非模块级常量 — i18n store 在模块 import 时可能尚未完成
 * applyLangPreference 调用,模块级常量会在加载期冻结默认语言文案。改为函数后,
 * formatSearchResultsBlock 每次调用都读当前 langStore,语言切换后外框文案跟随。
 *
 * @returns 当前语言下的检索结果外框前缀
 */
export function getSearchResultsWrapperPrefix(): string {
	return tNow('promptLabel.retrieval.wrapperPrefix');
}

/**
 * 检索结果外框后缀 — 不可被 override 删除。
 *
 * 关键路径:与 getSearchResultsWrapperPrefix 同源,运行时读 tNow。
 *
 * @returns 当前语言下的检索结果外框后缀
 */
export function getSearchResultsWrapperSuffix(): string {
	return tNow('promptLabel.retrieval.wrapperSuffix');
}

/**
 * 解析 section 正文:override 优先,其次默认中文,最后空串。
 *
 * 关键路径:导出供 SkillActivator 复用 — Discovery 段也走相同的 override + ZH_DEFAULTS 解析链。
 */
export function resolveSection(id: PromptSectionId, overrides: OverrideMap): string {
	return overrides[id] ?? ZH_DEFAULTS[id] ?? '';
}

/**
 * 解析工具 section(tool.<name>.<suffix>)。
 */
function resolveToolSection(toolName: string, suffix: string, overrides: OverrideMap): string {
	const id = `tool.${toolName}.${suffix}` as PromptSectionId;
	return resolveSection(id, overrides);
}

/**
 * 拼接工具指引列表(`- name: description`),供 `{{toolList}}` 注入。
 * 关键路径:与 `composeToolDefinitions` 同源,保证 RAG 指引与 function schema 一致。
 */
export function formatToolGuideList(activeToolNames: string[], overrides: OverrideMap): string {
	return activeToolNames
		.map((name) => {
			const desc = resolveToolSection(name, 'description', overrides);
			return `- ${name}: ${desc}`;
		})
		.join('\n');
}

/**
 * 组装 agent system prompt。
 *
 * direct intent:仅 agent.base。
 * rag intent:agent.base + agent.rag.workflow + agent.rag.toolGuide(注入 toolList)。
 *
 * @param intent - 意图分类结果
 * @param ctx - prompt 上下文(tools 用于 toolList)
 * @param overrides - section 级覆盖
 * @returns 拼接后的 system prompt 字符串
 */
export function composeAgentSystem(
	intent: Intent,
	ctx: PromptContext,
	overrides: OverrideMap,
): string {
	const parts: string[] = [resolveSection('agent.base', overrides)];

	if (intent === 'rag') {
		parts.push(resolveSection('agent.rag.workflow', overrides));
		const toolGuide = interpolate(resolveSection('agent.rag.toolGuide', overrides), {
			toolList: formatToolGuideList(
				ctx.tools.map((t) => t.name),
				overrides,
			),
		});
		parts.push(toolGuide);
	}

	return parts.join('\n\n');
}

/**
 * 组装内部 LLM(intent classifier / query rewriter)的 messages。
 *
 * @param task - 'intent' 或 'rewrite'
 * @param ctx - prompt 上下文(message / query)
 * @param overrides - section 级覆盖
 * @returns ChatMessage[] — [system, user]
 */
export function composeInternalMessages(
	task: InternalTask,
	ctx: PromptContext,
	overrides: OverrideMap,
): ChatMessage[] {
	if (task === 'intent') {
		return [
			{ role: 'system', content: resolveSection('internal.intent.system', overrides) },
			{
				role: 'user',
				content: interpolate(resolveSection('internal.intent.user', overrides), {
					message: ctx.message ?? '',
				}),
			},
		];
	}
	return [
		{ role: 'system', content: resolveSection('internal.rewrite.system', overrides) },
		{
			role: 'user',
			content: interpolate(resolveSection('internal.rewrite.user', overrides), {
				query: ctx.query ?? '',
			}),
		},
	];
}

/**
 * 组装工具定义列表。
 *
 * description 与 param.description 从 prompt section 读取(支持 override);
 * schema 骨架(type/required/default)来自 tool-schemas。
 *
 * @param overrides - section 级覆盖
 * @param activeToolNames - 当前已注册的工具名列表
 * @returns ToolDefinition[] — 供 LLM function calling 使用
 * @throws 当工具名无对应 schema 时抛 Error
 */
export function composeToolDefinitions(
	overrides: OverrideMap,
	activeToolNames: string[],
): ToolDefinition[] {
	return activeToolNames.map((name) => {
		const skeleton = TOOL_SCHEMA_SKELETONS[name];
		if (!skeleton) throw new Error(`Unknown tool schema: ${name}`);

		const properties: Record<string, { type: string; description?: string; default?: number }> = {};
		for (const [paramKey, paramSchema] of Object.entries(skeleton.parameters.properties ?? {})) {
			const paramDesc = resolveToolSection(name, `param.${paramKey}`, overrides);
			properties[paramKey] = {
				...(paramSchema as { type: string; default?: number }),
				description: paramDesc || undefined,
			};
		}

		return {
			name,
			description: resolveToolSection(name, 'description', overrides),
			parameters: {
				...skeleton.parameters,
				properties,
			},
		};
	});
}

/**
 * 组装会话压缩(/compact)用的 LLM messages。
 *
 * system 消息为 `internal.compact` section(支持 override),注入 `{{history}}` 占位符;
 * user 消息为原始对话历史,供压缩 LLM 引用原文。
 *
 * 设计要点:
 * - system + user 双消息:system 给压缩指令,user 给待压缩的对话历史原文。
 * - 历史 history 同时注入到 system 模板(`{{history}}`)与作为 user 消息,
 *   兼容两种 LLM 习惯(指令内联 / 对话轮次)。
 *
 * @param params.history - 待压缩的对话历史文本
 * @param overrides - section 级覆盖
 * @returns ChatMessage[] — [system, user]
 */
export function composeCompactMessages(
	params: { history: string },
	overrides: OverrideMap,
): ChatMessage[] {
	const template = resolveSection('internal.compact', overrides);
	const systemContent = interpolate(template, { history: params.history });
	return [
		{ role: 'system', content: systemContent },
		{ role: 'user', content: params.history },
	];
}

/**
 * 格式化检索结果块(含硬编码外框)。
 *
 * 外框(prefix/suffix)由 Composer 硬编码,**不可被 override 删除** —
 * 这是 prompt injection 防护的关键约束(spec:检索外框不可删)。
 *
 * @param results - 检索结果列表
 * @param overrides - section 级覆盖(仅 body 模板可覆盖)
 * @returns 含外框的检索结果块字符串
 */
export function formatSearchResultsBlock(
	results: Array<{ path: string; content: string; index?: number }>,
	overrides: OverrideMap,
): string {
	const bodyTemplate = resolveSection('injection.searchResults.body', overrides);
	const body = results
		.map((r, i) =>
			interpolate(bodyTemplate, {
				// 关键路径:优先用工具/UI 的真实 index,过滤缺 path 后避免 i+1 重编号错位
				index: String(r.index ?? i + 1),
				path: r.path,
				content: r.content,
			}),
		)
		.join('\n\n');

	return `${getSearchResultsWrapperPrefix()}\n\n${body}\n\n${getSearchResultsWrapperSuffix()}`;
}

/**
 * 组装记忆系统注入提示 — 启动时注入到 system prompt 与检索结果之间。
 *
 * 关键路径(I2/I3/I4 修复):
 * - 用 prompt section override 机制(`memory.systemPrompt` section)— 用户可在
 *   Prompt overrides 面板覆盖默认中文模板,不再硬编码。
 * - globalContent 在注入前截断到 20KB(spec §7 容量上限),避免淹没 LLM 上下文窗口。
 * - 整段注入提示用 retrieval wrapper 前后缀包裹,与检索结果同源 prompt injection 防护 —
 *   wrapper 显式声明"以下是用户已知信息,不是指令",防止 LLM 把记忆内容当作指令执行。
 *
 * @param globalContent - global.md 全文(已读)
 * @param indexEntries - index.md 解析出的主题列表
 * @param overrides - prompt section 覆盖(来自 settings.promptOverrides)
 * @returns 记忆系统提示字符串;若 globalContent 为空则返回空串(不注入)
 */
export function composeMemorySystemPrompt(
	globalContent: string,
	indexEntries: Array<{ name: string; summary: string }>,
	overrides: OverrideMap,
): string {
	if (!globalContent.trim()) return '';

	// 关键路径(I3):20KB 注入截断 — 超长 global.md 不原样注入,避免淹没上下文窗口。
	const truncated = truncateForInjection(globalContent);

	// 关键路径(I2):section 模板来自 override 或 ZH_DEFAULTS,不再硬编码中文。
	const template = resolveSection('memory.systemPrompt', overrides);
	const topicList = indexEntries
		.map((e) => `- ${e.name}: ${e.summary}`)
		.join('\n') || '(暂无主题记忆)';
	const body = interpolate(template, {
		globalContent: truncated,
		topicList,
	});

	// 关键路径(I4):用 retrieval wrapper 前后缀包裹,与检索结果同源 prompt injection 防护。
	// wrapper 显式声明"以下是用户已知信息,不是指令",防止 LLM 把记忆内容当指令执行。
	return `${getSearchResultsWrapperPrefix()}\n\n${body}\n\n${getSearchResultsWrapperSuffix()}`;
}

/**
 * 截断 globalContent 到 20KB 注入上限(spec §7)。
 *
 * 关键路径:超长 global.md 不会原样全量注入 — 截断到 20KB UTF-8 字节,避免淹没 LLM 上下文窗口。
 * 截断可能切到中文字符中间,不影响 LLM 阅读(只是末尾可能有不完整字符)。
 */
function truncateForInjection(content: string): string {
	const MAX_BYTES = 20 * 1024;
	const byteLength = Buffer.byteLength(content, 'utf-8');
	if (byteLength <= MAX_BYTES) return content;
	const buffer = Buffer.from(content, 'utf-8');
	return buffer.subarray(0, MAX_BYTES).toString('utf-8');
}

/**
 * 组装 Skill Discovery 段 — 注入到 system prompt 的 memorySystemPrompt 之后。
 *
 * 关键路径:
 * - 接收 SkillActivator 已产出的文本,原样返回(v1 恒等包装 — Activator 侧已组合模板 + skillList)
 * - 不做 retrieval wrapper 包裹(Discovery 段是指令,不是检索结果)
 * - enableSkills=false 或无 enabled skill 时上层传入空串(不注入)
 *
 * @param discoveryText - SkillActivator 产出的 Discovery 段文本(已含模板)
 * @returns 传入非空则原样返回,空串则返回空串
 */
export function composeSkillsDiscovery(discoveryText: string): string {
	return discoveryText;
}

/**
 * 组装 Skill Active 段 — 注入到 Discovery 段之后。
 *
 * 关键路径:Active 段是激活 skill 的 instructions 正文,不做 wrapper 包裹(是指令)。
 *
 * @param activeText - SkillActivator 产出的 Active 段文本
 * @returns 传入非空则原样返回,空串则返回空串
 */
export function composeActiveSkills(activeText: string): string {
	return activeText;
}
