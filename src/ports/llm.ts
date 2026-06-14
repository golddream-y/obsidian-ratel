// LLM Port — zero-implementation interface contract
// From ARCHITECTURE.md section 4.3

export interface LLMClient {
	chat(req: ChatRequest): AsyncIterable<ChatDelta>;
	countTokens(text: string): number;
}

export interface ChatRequest {
	messages: ChatMessage[];
	tools?: ToolDefinition[];
	maxSteps?: number;
}

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	toolCallId?: string;
	toolName?: string;
	toolArgs?: Record<string, unknown>;
}

export interface ChatDelta {
	text: string;
	toolCall?: ToolCall;
}

export interface ToolCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
}

export interface ToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}
