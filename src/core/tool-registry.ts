/**
 * @file src/core/tool-registry.ts
 * @description ToolRegistry — 工具注册表,统一管理 LLM 可调用的工具,提供 list/execute/isReadOnly 三类能力。
 * @module core/tool-registry
 * @depends ../ports/llm
 */

import type { ToolDefinition, ToolCall } from '../ports/llm';

/**
 * 工具定义:LLM 看到的 schema(`definition`) + 实际执行逻辑(`execute`)。
 *
 * 设计要点:
 * - `readOnly` 默认 `false`,标记为 `true` 的工具在 agent loop 中不会触发 pre/post write hook。
 * - `execute.args` 接收泛型 Record,具体 schema 由 `definition.parameters` 描述(LLM 侧校验)。
 */
export interface Tool {
	definition: ToolDefinition;
	execute(args: Record<string, unknown>): Promise<unknown>;
	/**
	 * 若为 `true`,此工具只读不写 — agent loop 不会为它触发写钩子(避免搜索/读取等无害操作触发治理)。
	 */
	readOnly?: boolean;
}

/**
 * 工具注册表(内存 Map 索引)。
 *
 * @example
 *   const tools = new ToolRegistry();
 *   tools.register({ definition: myDef, execute: myImpl, readOnly: true });
 *   const defs = tools.definitions();   // 喂给 LLM
 *   const result = await tools.execute({ id: 'tc1', name: 'myDef.name', args: {} });
 */
export class ToolRegistry {
	private tools = new Map<string, Tool>();

	/**
	 * 注册一个工具,同名工具覆盖。
	 *
	 * @param tool - 工具对象。
	 */
	register(tool: Tool): void {
		this.tools.set(tool.definition.name, tool);
	}

	/**
	 * 按名称移除工具；不存在时静默忽略。
	 *
	 * @param name - 工具名
	 */
	unregister(name: string): void {
		this.tools.delete(name);
	}

	/**
	 * 移除所有名称以 prefix 开头的工具（MCP Server 出册用）。
	 *
	 * @param prefix - 例如 `mcp__tavily__`
	 */
	unregisterByPrefix(prefix: string): void {
		for (const name of [...this.tools.keys()]) {
			if (name.startsWith(prefix)) this.tools.delete(name);
		}
	}

	/**
	 * 更新已注册工具的 definition(LLM 看到的 schema)。
	 *
	 * 关键路径:供主线程在 settings.promptOverrides 变化后,
	 * 重新生成 definition 并热替换,无需重新创建工具实例。
	 *
	 * @param toolName - 工具名(必须已注册)。
	 * @param definition - 新的 ToolDefinition(由 Composer 生成)。
	 * @throws 工具未注册时抛 `Tool not found: <name>`。
	 */
	updateDefinition(toolName: string, definition: ToolDefinition): void {
		const tool = this.tools.get(toolName);
		if (!tool) throw new Error(`Tool not found: ${toolName}`);
		tool.definition = definition;
	}

	/**
	 * 取出所有工具的 LLM schema,用于喂给 `llm.chat({ tools })`。
	 *
	 * @returns 工具 schema 数组。
	 */
	definitions(): ToolDefinition[] {
		return Array.from(this.tools.values()).map((t) => t.definition);
	}

	/**
	 * 根据 toolCall.name 找到对应工具并执行。
	 *
	 * @param toolCall - 工具调用,含 id/name/args。
	 * @returns 工具返回值(任意类型,由 tool 自定义)。
	 * @throws 工具名未注册时抛 `Tool not found: <name>`。
	 */
	async execute(toolCall: ToolCall): Promise<unknown> {
		const tool = this.tools.get(toolCall.name);
		if (!tool) throw new Error(`Tool not found: ${toolCall.name}`);
		return tool.execute(toolCall.args);
	}

	/**
	 * 判断工具是否为只读。未注册的工具返回 `false`(保守视为可写,避免跳过治理)。
	 *
	 * @param toolName - 工具名。
	 * @returns 是否只读。
	 */
	isReadOnly(toolName: string): boolean {
		return this.tools.get(toolName)?.readOnly ?? false;
	}
}
