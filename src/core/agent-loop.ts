import type { UserChatRequest, AgentEvent } from '../types';
import type { LLMClient, ToolCall } from '../ports/llm';
import type { ContextManager } from './context-manager';
import type { ToolRegistry } from './tool-registry';
import type { HookRegistry } from './hooks';

const MAX_STEPS = 10;

export async function* agentLoop(
	req: UserChatRequest,
	ctx: ContextManager,
	llm: LLMClient,
	tools: ToolRegistry,
	hooks: HookRegistry,
): AsyncIterable<AgentEvent> {
	await ctx.load(req.sessionId);
	ctx.addUserMessage(req.message);

	for (let step = 0; step < MAX_STEPS; step++) {
		yield { type: 'message.start', payload: { role: 'assistant' as const } };

		const stream = llm.chat({
			messages: ctx.toMessages(),
			tools: tools.definitions(),
		});

		let accumulatedText = '';
		let toolCall: ToolCall | null = null;

		for await (const delta of stream) {
			if (delta.text) {
				accumulatedText += delta.text;
				yield { type: 'message.delta', payload: { text: delta.text } };
			}
			if (delta.toolCall) {
				toolCall = delta.toolCall;
			}
		}

		if (!toolCall) {
			ctx.addAssistantMessage(accumulatedText);
			break;
		}

		yield { type: 'tool.call', payload: { name: toolCall.name, args: toolCall.args } };

		await hooks.run('pre-write', toolCall);

		const result = await tools.execute(toolCall);
		yield { type: 'tool.result', payload: { name: toolCall.name, result } };

		await hooks.run('post-write', toolCall);

		ctx.addAssistantToolCall(toolCall, accumulatedText);
		ctx.addToolResult(toolCall.id, JSON.stringify(result));
	}

	yield { type: 'message.end', payload: { tokens: ctx.tokenCount() } };
	await ctx.save();
}
