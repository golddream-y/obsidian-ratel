/**
 * @file src/ui/slash-commands.ts
 * @description 斜杠命令注册表 + 过滤纯函数 — 供 SlashMenu 调用,不含副作用
 * @module ui/slash-commands
 */

/** 斜杠命令定义 — name 用于匹配,description 用于菜单展示,icon 是 emoji 或 lucide 名 */
export interface SlashCommand {
	/** 命令名,以 / 开头,如 '/new' */
	name: string;
	/** 简短描述,菜单中显示 */
	description: string;
	/** emoji 图标(暂不用 lucide,避免依赖 Obsidian API) */
	icon: string;
}

/** 全部斜杠命令 — 顺序即菜单显示顺序 */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
	{
		name: '/new',
		description: '开始新对话,清空当前上下文',
		icon: '✨',
	},
	{
		name: '/compact',
		description: '压缩上下文,将历史总结为摘要',
		icon: '📦',
	},
	{
		name: '/model',
		description: '切换模型',
		icon: '🤖',
	},
	{
		name: '/reindex',
		description: '重新索引 vault',
		icon: '🔄',
	},
] as const;

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
	return SLASH_COMMANDS.filter((cmd) => cmd.name.toLowerCase().startsWith(lower));
}
