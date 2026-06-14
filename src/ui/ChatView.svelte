<script lang="ts">
	import type RatelVaultPlugin from '../main';

	interface Message {
		role: 'user' | 'assistant';
		content: string;
	}

	let plugin: RatelVaultPlugin;
	let messages: Message[] = [];
	let input = '';
	let isRunning = false;
	let sessionId = 'session-' + Date.now();

	async function sendMessage() {
		const text = input.trim();
		if (!text || isRunning) return;

		messages = [...messages, { role: 'user', content: text }];
		input = '';
		isRunning = true;

		const assistantMsg: Message = { role: 'assistant', content: '' };
		messages = [...messages, assistantMsg];

		try {
			const events = plugin.ask(sessionId, text);

			for await (const event of events) {
				switch (event.type) {
					case 'message.delta':
						assistantMsg.content += event.payload.text;
						messages = [...messages];
						break;
					case 'message.end':
						break;
					case 'error':
						assistantMsg.content += '\n\n⚠ Error: ' + event.payload.message;
						messages = [...messages];
						break;
				}
			}
		} catch (err) {
			assistantMsg.content += '\n\n⚠ Error: ' + (err instanceof Error ? err.message : String(err));
			messages = [...messages];
		} finally {
			isRunning = false;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			sendMessage();
		}
	}
</script>

<div class="ratel-chat">
	<div class="ratel-messages">
		{#each messages as msg}
			<div class="ratel-message ratel-{msg.role}">
				<div class="ratel-role">{msg.role === 'user' ? 'You' : 'Ratel'}</div>
				<div class="ratel-content">{msg.content}</div>
			</div>
		{/each}
		{#if isRunning && messages[messages.length - 1]?.content === ''}
			<div class="ratel-typing">Thinking...</div>
		{/if}
	</div>

	<div class="ratel-input-area">
		<textarea
			bind:value={input}
			on:keydown={handleKeydown}
			placeholder="Ask about your vault..."
			disabled={isRunning}
			rows="2"
		></textarea>
		<button on:click={sendMessage} disabled={isRunning || !input.trim()}>
			Send
		</button>
	</div>
</div>

<style>
	.ratel-chat {
		display: flex;
		flex-direction: column;
		height: 100%;
		padding: 8px;
	}

	.ratel-messages {
		flex: 1;
		overflow-y: auto;
		padding-bottom: 8px;
	}

	.ratel-message {
		margin-bottom: 12px;
		padding: 8px 12px;
		border-radius: 8px;
	}

	.ratel-user {
		background: var(--interactive-accent);
		color: var(--text-on-accent);
		margin-left: 20%;
	}

	.ratel-assistant {
		background: var(--background-secondary);
		color: var(--text-normal);
		margin-right: 10%;
	}

	.ratel-role {
		font-size: 0.75em;
		font-weight: 600;
		margin-bottom: 4px;
		opacity: 0.7;
	}

	.ratel-content {
		white-space: pre-wrap;
		word-break: break-word;
	}

	.ratel-typing {
		color: var(--text-muted);
		font-style: italic;
		padding: 4px 12px;
	}

	.ratel-input-area {
		display: flex;
		gap: 8px;
		align-items: flex-end;
		border-top: 1px solid var(--background-modifier-border);
		padding-top: 8px;
	}

	.ratel-input-area textarea {
		flex: 1;
		resize: none;
		padding: 8px;
		border-radius: 6px;
		border: 1px solid var(--background-modifier-border);
		background: var(--background-primary);
		color: var(--text-normal);
		font-family: inherit;
		font-size: 14px;
	}

	.ratel-input-area textarea:focus {
		outline: none;
		border-color: var(--interactive-accent);
	}

	.ratel-input-area button {
		padding: 8px 16px;
		border-radius: 6px;
		border: none;
		background: var(--interactive-accent);
		color: var(--text-on-accent);
		cursor: pointer;
		font-size: 14px;
	}

	.ratel-input-area button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
