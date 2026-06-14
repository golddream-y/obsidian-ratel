// Hooks registry — knowledge governance hooks

import type { ToolCall } from '../ports/llm';

export class HookRegistry {
	private handlers = new Map<string, Array<(toolCall: ToolCall) => Promise<void>>>();

	register(phase: string, handler: (toolCall: ToolCall) => Promise<void>): void {
		const list = this.handlers.get(phase) ?? [];
		list.push(handler);
		this.handlers.set(phase, list);
	}

	async run(phase: string, toolCall: ToolCall): Promise<void> {
		const list = this.handlers.get(phase) ?? [];
		for (const handler of list) {
			try {
				await handler(toolCall);
			} catch (err) {
				console.error(`Hook error in ${phase}:`, err);
			}
		}
	}
}
