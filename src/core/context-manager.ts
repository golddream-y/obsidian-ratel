import type { Persistence, Session, ChatMessage } from '../ports/persistence';
import type { ToolCall } from '../ports/llm';

const SYSTEM_PROMPT = `You are Ratel, an AI assistant that helps users explore and manage their Obsidian vault. You can read notes and answer questions about their content. Always respond in the same language the user uses.`;

export class ContextManager {
	private session: Session | null = null;

	constructor(private persistence: Persistence) {}

	async load(sessionId: string): Promise<void> {
		this.session = await this.persistence.sessions.get(sessionId);
		if (!this.session) {
			this.session = {
				id: sessionId,
				title: '',
				messages: [],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
		}
	}

	addUserMessage(content: string): void {
		const session = this.requireSession();
		session.messages.push({ role: 'user', content });
		session.updatedAt = Date.now();
	}

	addAssistantMessage(content: string): void {
		const session = this.requireSession();
		session.messages.push({ role: 'assistant', content });
		session.updatedAt = Date.now();
	}

	addAssistantToolCall(toolCall: ToolCall, text: string): void {
		const session = this.requireSession();
		session.messages.push({
			role: 'assistant',
			content: text,
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			toolArgs: toolCall.args,
		});
		session.updatedAt = Date.now();
	}

	addToolResult(toolCallId: string, result: string): void {
		const session = this.requireSession();
		session.messages.push({
			role: 'tool',
			content: result,
			toolCallId,
		});
		session.updatedAt = Date.now();
	}

	toMessages(): ChatMessage[] {
		return [
			{ role: 'system', content: SYSTEM_PROMPT },
			...(this.session?.messages ?? []),
		];
	}

	tokenCount(): number {
		// Rough estimation: ~4 chars per token for mixed CJK/Latin
		const text = this.toMessages().map((m) => m.content).join('');
		return Math.ceil(text.length / 4);
	}

	async save(): Promise<void> {
		const session = this.requireSession();
		await this.persistence.sessions.upsert(session);
	}

	get sessionId(): string {
		return this.session?.id ?? '';
	}

	private requireSession(): Session {
		if (!this.session) throw new Error('Session not loaded. Call load() first.');
		return this.session;
	}
}
