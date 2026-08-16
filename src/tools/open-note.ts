/**
 * @file src/tools/open-note.ts
 * @description open_note 工具 — 在 Obsidian 中为用户打开笔记并定位到标题/块
 * @module tools/open-note
 * @depends core/tool-registry, ports/workspace, ports/vault
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { VaultPort } from '../ports/vault';
import type { WorkspacePort } from '../ports/workspace';

/**
 * 构造 `open_note` 工具。
 *
 * 设计要点:
 * - 纯 UI 导航,不写任何文件 → readOnly: true,默认权限 allow。
 * - 锚点只拼 linktext,由 Obsidian 原生解析(标题 / ^blockId,阅读视图也能滚动);
 *   不预校验锚点存在性(避免为此读全文,锚点无效时 Obsidian 只打开文件)。
 * - path 内嵌锚点自动拆分:LLM 可能把 "foo.md#标题" 整个塞进 path,
 *   按第一个 # 拆分后再探测,避免把存在的文件误报为不存在;
 *   显式 anchor 参数优先于 path 拆出的锚点。
 * - anchor 的 # 前缀归一化:"#标题" 与 "标题" 语义一致,拼接时只保留单个 #。
 * - 文件不存在不抛错:返回降级提示让 Agent 改用 search_vault / glob 定位。
 *
 * @param workspace - 打开笔记
 * @param vault - 文件存在性验证
 * @param definition - LLM schema
 */
export function createOpenNoteTool(
	workspace: WorkspacePort,
	vault: VaultPort,
	definition: ToolDefinition,
): Tool {
	return {
		definition,
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			// 关键路径:args 运行时类型不可信(LLM 可能传非字符串),针对性报错而非静默探测
			if (typeof args.path !== 'string' || args.path.trim().length === 0) {
				return {
					opened: false,
					message: `path 参数必须是字符串(收到: ${typeof args.path})。`,
				};
			}
			let rawPath = args.path.trim();
			// 关键路径:LLM 可能把 "foo.md#标题" 整个塞进 path — 按第一个 # 拆分,
			// 否则 fileExists 拿带锚点的假路径探测,会把存在的文件误报为不存在。
			let pathAnchor: string | null = null;
			const hashIndex = rawPath.indexOf('#');
			if (hashIndex >= 0) {
				pathAnchor = rawPath.slice(hashIndex + 1);
				rawPath = rawPath.slice(0, hashIndex);
			}
			const explicitAnchor = typeof args.anchor === 'string' && args.anchor.length > 0
				? args.anchor.replace(/^#/, '')
				: null;
			const anchor = explicitAnchor ?? pathAnchor;
			// 关键路径:可省略 .md — 先试原文,再试补 .md,与 Obsidian 链接解析习惯一致
			const candidates = rawPath.endsWith('.md') ? [rawPath] : [rawPath, `${rawPath}.md`];
			let resolved: string | null = null;
			for (const candidate of candidates) {
				if (await vault.fileExists(candidate)) {
					resolved = candidate;
					break;
				}
			}

			if (!resolved) {
				return {
					opened: false,
					message: `笔记不存在: ${rawPath}。请先用 search_vault 或 glob 确认正确路径后再试。`,
				};
			}

			// 关键路径:块锚点形如 ^abc123,标题锚点是裸标题名;统一拼成 wikilink 锚点语法
			const linktext = anchor ? `${resolved}#${anchor}` : resolved;
			const opened = await workspace.openNote(linktext);
			return {
				opened,
				path: resolved,
				anchor: anchor ?? undefined,
				...(opened ? {} : { message: 'Obsidian 未能打开该链接,但文件存在,可让用户手动打开。' }),
			};
		},
	};
}
