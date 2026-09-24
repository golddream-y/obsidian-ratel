/**
 * @file src/ui/slash-commands.ts
 * @description 斜杠命令注册表 + 过滤纯函数 — 供 SlashMenu 调用,不含副作用
 * @module ui/slash-commands
 * @depends i18n
 */

import { tNow } from '../../../i18n';
import type { SkillSource } from '../../../skills/types';

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

/** 斜杠行种类。权重数字决定排序,以后加类别只加一项,不加分段标题。 */
export const SLASH_KIND_WEIGHT = {
	command: 0,
	skill: 1,
} as const;

export type SlashKind = keyof typeof SLASH_KIND_WEIGHT;

/** 菜单一行。命令 name 带 `/`,技能 name 是 skill 标识。技能带生效来源。 */
export interface SlashMenuItem {
	kind: SlashKind;
	name: string;
	description: string;
	/** 技能生效来源。命令没有这一项。 */
	origin?: SkillSource;
}

/** 已启用 skill 的菜单投影,不含目录与禁用项。 */
export interface SlashSkillCandidate {
	name: string;
	description: string;
	origin: SkillSource;
}

/**
 * 同一份斜杠列表:命令与技能混排,用 kind 区分,不按种类拆段。
 *
 * 空 `/` 时命令保持产品固定顺序,技能按名字排在后面。
 * 有前缀时先要求名字前缀命中,再按种类权重,再按名字。
 *
 * @param input - 输入框全文
 * @param skills - 当前已启用 skill
 */
export function filterSlashMenu(
	input: string,
	skills: readonly SlashSkillCandidate[],
): SlashMenuItem[] {
	if (!input.startsWith('/') || input.includes(' ')) {
		return [];
	}
	const typed = input.toLowerCase();
	const query = typed.slice(1);
	const filtering = query.length > 0;
	const rows: Array<SlashMenuItem & { weight: number; order: number }> = [];
	getSlashCommands().forEach((cmd, index) => {
		if (!cmd.name.toLowerCase().startsWith(typed)) return;
		rows.push({
			kind: 'command',
			name: cmd.name,
			description: cmd.description,
			weight: SLASH_KIND_WEIGHT.command,
			order: index,
		});
	});
	for (const skill of skills) {
		if (!skill.name.toLowerCase().startsWith(query)) continue;
		rows.push({
			kind: 'skill',
			name: skill.name,
			description: skill.description,
			origin: skill.origin,
			weight: SLASH_KIND_WEIGHT.skill,
			order: 0,
		});
	}
	rows.sort((a, b) => {
		if (a.weight !== b.weight) return a.weight - b.weight;
		if (!filtering && a.kind === 'command' && b.kind === 'command') return a.order - b.order;
		return a.name.localeCompare(b.name);
	});
	return rows.map(({ kind, name, description, origin }) => ({ kind, name, description, origin }));
}

/**
 * 斜杠点选技能时的两段文案。
 * 气泡与 Cursor / Claude 一样显示 `/名字`；另一段只发给模型，要求按已写入的做法开工。
 *
 * @param name - skill 标识
 */
export function skillInvokeTexts(name: string): { text: string; llmText: string } {
	return {
		text: `/${name}`,
		llmText: tNow('chat.slashMenu.skillRunModel', { name }),
	};
}

/**
 * 选中后先落到输入框，等用户再按回车发送。
 * 技能和要补一句的命令走这条；没有参数的命令直接执行。
 *
 * @param item - 斜杠菜单当前行
 */
export function slashSelectionLandsInInput(item: Pick<SlashMenuItem, 'kind' | 'name'>): boolean {
	if (item.kind === 'skill') return true;
	return item.name === '/goal';
}

/**
 * 菜单没有吃掉这次回车时，当前输入是否应当直接发送。
 * 技能和 `/goal` 落到输入框后带空格，再按回车必须发送，不能再次补全进输入框。
 *
 * @param input - 输入框原文，含末尾空格
 * @param exact - 去掉空格后精确命中的菜单行；没有则为 undefined
 */
export function composerEnterSends(
	input: string,
	exact: Pick<SlashMenuItem, 'kind' | 'name'> | undefined,
): boolean {
	if (input.includes(' ')) return true;
	if (!exact) return true;
	return slashSelectionLandsInInput(exact);
}

/**
 * 发送文本是否以某个已启用技能名开头。
 *
 * @param text - 用户将要发送的原文
 * @param skillNames - 已启用技能名，不含 `/`
 * @returns 命中的技能名，以及技能名后面的补充说明；没有补充时 rest 为空
 */
export function matchLeadingSkill(
	text: string,
	skillNames: readonly string[],
): { name: string; rest: string } | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith('/')) return null;
	const names = [...skillNames].filter((name) => name.length > 0).sort((a, b) => b.length - a.length);
	for (const name of names) {
		const token = `/${name}`;
		if (trimmed.toLowerCase() === token.toLowerCase()) return { name, rest: '' };
		if (trimmed.toLowerCase().startsWith(`${token.toLowerCase()} `)) {
			return { name, rest: trimmed.slice(token.length).trim() };
		}
	}
	return null;
}

export function completeUniqueSlashItem(
	input: string,
	skills: readonly SlashSkillCandidate[],
): string | null {
	const matches = filterSlashMenu(input, skills);
	if (matches.length !== 1) return null;
	const only = matches[0]!;
	return only.kind === 'skill' ? `/${only.name} ` : `${only.name} `;
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

/** 输入高亮片段 — 命令与技能用不同颜色,其余普通色 */
export interface SlashHighlightSpan {
	kind: 'command' | 'skill' | 'text';
	text: string;
}

/**
 * 把输入拆成「完整斜杠名 + 其余」。
 *
 * 命令（`/goal` `/new` …）与已启用技能名都会高亮，颜色由 kind 区分。
 * `/g`、`/goalie` 以及未登记的名字不高亮。
 *
 * @param input - 输入框或用户气泡原文
 * @param skillNames - 当前已启用的 skill 标识，不含 `/`
 */
export function splitLeadingSlashCommand(
	input: string,
	skillNames: readonly string[] = [],
): SlashHighlightSpan[] {
	if (!input.startsWith('/')) {
		return [{ kind: 'text', text: input }];
	}
	const commandNames = getSlashCommands()
		.map((c) => c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
		.sort((a, b) => b.length - a.length);
	const commandRe = new RegExp(`^(${commandNames.join('|')})(?=\\s|$)`, 'i');
	const commandMatch = commandRe.exec(input);
	if (commandMatch) {
		return splitMatchedToken(input, commandMatch[0], 'command');
	}
	const skills = skillNames
		.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
		.filter((name) => name.length > 0)
		.sort((a, b) => b.length - a.length);
	if (skills.length === 0) {
		return [{ kind: 'text', text: input }];
	}
	const skillRe = new RegExp(`^(/(?:${skills.join('|')}))(?=\\s|$)`, 'i');
	const skillMatch = skillRe.exec(input);
	if (!skillMatch) {
		return [{ kind: 'text', text: input }];
	}
	return splitMatchedToken(input, skillMatch[0], 'skill');
}

function splitMatchedToken(
	input: string,
	token: string,
	kind: 'command' | 'skill',
): SlashHighlightSpan[] {
	const rest = input.slice(token.length);
	if (!rest) return [{ kind, text: token }];
	return [
		{ kind, text: token },
		{ kind: 'text', text: rest },
	];
}
