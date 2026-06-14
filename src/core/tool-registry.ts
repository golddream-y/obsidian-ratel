import type { ToolDefinition, ToolCall } from '../ports/llm';

export interface Tool {
	definition: ToolDefinition;
	execute(args: Record<string, unknown>): Promise<unknown>;
	/** If true, this tool only reads data and should not trigger write hooks */
	readOnly?: boolean;
}

export class ToolRegistry {
	private tools = new Map<string, Tool>();

	register(tool: Tool): void {
		this.tools.set(tool.definition.name, tool);
	}

	definitions(): ToolDefinition[] {
		return Array.from(this.tools.values()).map((t) => t.definition);
	}

	async execute(toolCall: ToolCall): Promise<unknown> {
		const tool = this.tools.get(toolCall.name);
		if (!tool) throw new Error(`Tool not found: ${toolCall.name}`);
		return tool.execute(toolCall.args);
	}

	isReadOnly(toolName: string): boolean {
		return this.tools.get(toolName)?.readOnly ?? false;
	}
}
