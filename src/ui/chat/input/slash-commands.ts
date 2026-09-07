/**
 * @file src/ui/slash-commands.ts
 * @description 斜杠命令注册表 + 过滤纯函数 — 供 SlashMenu 调用,不含副作用
 * @module ui/slash-commands
 * @depends i18n
 */

import { tNow } from '../../../i18n';

/** 斜杠命令定义 — name 用于匹配,description 用于菜单展示,icon 是 emoji 或 lucide 名 */
export interface SlashCommand {
	/** 命令名,以 / 开头,如 '/new' */
	name: string;
	/** 简短描述,菜单中显示 */
	description: string;
	/** emoji 图标(暂不用 lucide,避免依赖 Obsidian API) */
	icon: string;
}

/**
 * 全部斜杠命令 — 顺序即菜单显示顺序。
 *
 * 关键路径:返回函数而非模块级常量,因为 description 走 tNow,在模块 import 时
 * 会冻结当时的语言。改为函数后,每次调用都按当前 langStore 求值,
 * 配合 SlashMenu.svelte 的 $derived 响应式实现语言切换即时刷新。
 */
export function getSlashCommands(): readonly SlashCommand[] {
	return [
		{
			name: '/new',
			description: tNow('slash.new.description'),
			icon: '✨',
		},
		{
			name: '/goal',
			description: tNow('slash.goal.description'),
			icon: '🎯',
		},
		{
			name: '/compact',
			description: tNow('slash.compact.description'),
			icon: '📦',
		},
		{
			name: '/model',
			description: tNow('slash.model.description'),
			icon: '🤖',
		},
		{
			name: '/reindex',
			description: tNow('slash.reindex.description'),
			icon: '🔄',
		},
	];
}

/**
 * 根据输入框内容过滤斜杠命令 — 纯函数,无副作用。
 *
 * 关键路径:
 * - 输入必须以 / 开头,否则返回空数组(不是命令模式)
 * - 输入含空格时返回空数组(已脱离命令模式,进入实际消息)
 * - 大小写不敏感匹配(/NEW 匹配 /new)
 * - 前缀匹配:输入 /n 匹配 /new
 *
 * @param input - 输入框当前完整内容
 * @returns 匹配的命令数组(可能为空)
 */
export function filterCommands(input: string): SlashCommand[] {
	// 关键路径:不以 / 开头不是命令模式;含空格说明用户已输入参数,菜单关闭。
	if (!input.startsWith('/') || input.includes(' ')) {
		return [];
	}
	const lower = input.toLowerCase();
	return getSlashCommands().filter((cmd) => cmd.name.toLowerCase().startsWith(lower));
}

/**
 * Tab 补全:筛到只剩一条时补成 `/命令 `。
 *
 * @param input - 输入框当前内容(无空格的斜杠前缀)
 * @returns 补全后的字符串;无法唯一确定时 null
 */
export function completeUniqueSlashCommand(input: string): string | null {
	const matches = filterCommands(input);
	if (matches.length !== 1) return null;
	return `${matches[0]!.name} `;
}

/** `/goal` 解析结果 — 菜单精确匹配或带参数发送时共用 */
export interface ParsedSlashGoal {
	/** 预填进创建表单的目标陈述;空则只打开空白表单 */
	objective: string;
	/** 前缀是 30m / 2h 一类时限 — v1 不支持,剥掉后仍打开表单 */
	timeLimitIgnored: boolean;
}

/**
 * 识别聊天输入是否为 `/goal` 或 `/goal <陈述>`。
 *
 * 关键路径:含空格时 filterCommands 已关菜单,回车会走 sendMessage;
 * 必须在发往模型前拦截,否则会当成普通消息。
 *
 * @param input - 已 trim 的输入框内容
 * @returns 命中 `/goal` 时返回解析结果,否则 null(`/goalie` 不算)
 */
export function parseSlashGoalInput(input: string): ParsedSlashGoal | null {
	const trimmed = input.trim();
	const match = /^\/goal(?:\s+(.*))?$/i.exec(trimmed);
	if (!match) return null;
	let rest = (match[1] ?? '').trim();
	let timeLimitIgnored = false;
	// 与 Cursor /goal 对齐:开头的 30m / 2h 不是目标正文
	const timed = /^(\d+[mh])\s+(.*)$/i.exec(rest);
	if (timed) {
		timeLimitIgnored = true;
		rest = timed[2]!.trim();
	} else if (/^\d+[mh]$/i.test(rest)) {
		timeLimitIgnored = true;
		rest = '';
	}
	return { objective: rest, timeLimitIgnored };
}

/**
 * 本轮用户消息是否为带陈述的 `/goal` 创建回合。
 *
 * 关键路径:斜杠同回合硬拒 manage_goal create(spec 4.3),空 `/goal` 不算创建回合。
 *
 * @param text - 用户原文(通常 trim 后)
 * @returns 能解析出非空 objective 时为 true
 */
export function isSlashGoalCreateTurn(text: string): boolean {
	const parsed = parseSlashGoalInput(text.trim());
	return Boolean(parsed?.objective);
}

/** 输入高亮片段 — 完整斜杠命令用强调色,其余普通色 */
export interface SlashHighlightSpan {
	kind: 'command' | 'text';
	text: string;
}

/**
 * 把输入拆成「完整斜杠命令 + 其余」。
 *
 * 只高亮登记表里的全名(`/goal` `/new` …),`/g` 或 `/goalie` 不高亮。
 *
 * @param input - 输入框或用户气泡原文
 */
export function splitLeadingSlashCommand(input: string): SlashHighlightSpan[] {
	if (!input.startsWith('/')) {
		return [{ kind: 'text', text: input }];
	}
	const names = getSlashCommands()
		.map((c) => c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
		.sort((a, b) => b.length - a.length);
	const re = new RegExp(`^(${names.join('|')})(?=\\s|$)`, 'i');
	const match = re.exec(input);
	if (!match) {
		return [{ kind: 'text', text: input }];
	}
	const cmd = match[0];
	const rest = input.slice(cmd.length);
	if (!rest) {
		return [{ kind: 'command', text: cmd }];
	}
	return [
		{ kind: 'command', text: cmd },
		{ kind: 'text', text: rest },
	];
}
