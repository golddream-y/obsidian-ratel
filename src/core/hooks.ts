/**
 * @file src/core/hooks.ts
 * @description HookRegistry — 知识治理钩子注册中心,按阶段(phase)组织写工具的 pre/post 钩子。
 * @module core/hooks
 * @depends ../ports/llm
 */

import type { ToolCall } from '../ports/llm';

/**
 * 钩子注册表。
 *
 * 设计要点:
 * - 钩子按"阶段字符串"分组,目前只用 `pre-write` / `post-write`,预留 `pre-read` / `post-read` 扩展点。
 * - 单个钩子抛错会被 `try/catch` 吞掉,只打 console.error,避免一个坏钩子阻塞整个工具调用。
 *
 * @example
 *   const hooks = new HookRegistry();
 *   hooks.register('pre-write', async (tc) => { console.log('about to write', tc.name); });
 */
export class HookRegistry {
	private handlers = new Map<string, Array<(toolCall: ToolCall) => Promise<void>>>();

	/**
	 * 注册一个钩子到指定阶段。同一阶段允许多个钩子,按注册顺序串行执行。
	 *
	 * @param phase - 阶段名,如 'pre-write' / 'post-write'。
	 * @param handler - 钩子函数,接收 ToolCall,返回 Promise。
	 */
	register(phase: string, handler: (toolCall: ToolCall) => Promise<void>): void {
		const list = this.handlers.get(phase) ?? [];
		list.push(handler);
		this.handlers.set(phase, list);
	}

	/**
	 * 串行执行指定阶段的所有钩子,任一抛错被吞掉并记录(不阻断后续钩子)。
	 *
	 * @param phase - 阶段名。
	 * @param toolCall - 触发的工具调用,作为参数传给每个钩子。
	 */
	async run(phase: string, toolCall: ToolCall): Promise<void> {
		const list = this.handlers.get(phase) ?? [];
		for (const handler of list) {
			try {
				await handler(toolCall);
			} catch (err) {
				// 关键路径:单个钩子失败不应阻塞其他钩子或主流程,只记录错误便于排查。
				console.error(`Hook error in ${phase}:`, err);
			}
		}
	}
}
