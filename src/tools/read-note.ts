/**
 * @file src/tools/read-note.ts
 * @description `read_note` 工具 — 读取 vault 内任意笔记的正文 + 元数据 + 反向链接
 * @module tools/read-note
 * @depends core/tool-registry, ports/vault, ports/llm
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { VaultPort } from '../ports/vault';

/**
 * 构造 `read_note` 工具实例。
 *
 * 设计要点:
 * - 只读工具(`readOnly: true`),Agent Loop 据此可跳过确认步骤。
 * - 闭包注入 `VaultPort`,不依赖 Obsidian 运行时,方便单测。
 * - 返回值同时给出 `content` / `metadata` / `backlinks`,让模型一次性拿到上下文。
 * - `definition` 由调用方(主线程 / 测试)通过 Composer 生成后注入,工具自身不持有文案。
 *
 * @param vault - 任意 `VaultPort` 实现(主线程是 `ObsidianVault`,测试用 mock)。
 * @param definition - LLM 侧 schema,由 `composeToolDefinitions` 生成。
 * @returns 符合 `Tool` 接口的工具定义。
 *
 * @example
 *   const tool = createReadNoteTool(obsidianVault, def);
 *   registry.register(tool);
 */
export function createReadNoteTool(vault: VaultPort, definition: ToolDefinition): Tool {
	return {
		definition,
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			const path = args.path as string;
			// 关键路径:正文 + 元数据 + 反链 一次性取齐,避免模型多轮往返。
			const content = await vault.readFile(path);
			const metadata = vault.getMetadata(path);
			const backlinks = vault.getBacklinks(path);

			const result: Record<string, unknown> = { content, path };

			if (metadata) {
				result.metadata = {
					frontmatter: metadata.frontmatter,
					tags: metadata.tags?.map((t) => t.tag),
					links: metadata.links?.map((l) => l.link),
				};
			}

			if (backlinks.size > 0) {
				result.backlinks = Array.from(backlinks.keys());
			}

			return result;
		},
	};
}
