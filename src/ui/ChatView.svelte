<script lang="ts">
	import type RatelVaultPlugin from '../main';

	// Ratel 聊天侧栏 — 用户输入 + 流式渲染 + 错误展示
	// 关键路径:每个 message.delta 触发 messages 数组重建(Svelte 5 反应性依赖引用比较)。
	interface Message {
		role: 'user' | 'assistant';
		content: string;
	}

	let plugin: RatelVaultPlugin;
	let messages: Message[] = [];
	let input = '';
	let isRunning = false;
	// 关键路径:sessionId 用于把同一会话的多轮消息绑回 Session 存储。
	let sessionId = 'session-' + Date.now();

	async function sendMessage() {
		const text = input.trim();
		if (!text || isRunning) return;

		messages = [...messages, { role: 'user', content: text }];
		input = '';
		isRunning = true;

		// 关键路径:先占位一个空 assistant 消息,流式 delta 直接 mutate 它。
		const assistantMsg: Message = { role: 'assistant', content: '' };
		messages = [...messages, assistantMsg];

		try {
			const events = plugin.ask(sessionId, text);

			for await (const event of events) {
				switch (event.type) {
					case 'message.delta':
						assistantMsg.content += event.payload.text;
						// 修复:重新赋值触发 Svelte 反应性,否则内容变更不可见。
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
			// 关键路径:无论成功 / 失败 / 取消,都必须复位 isRunning 释放输入框。
			isRunning = false;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		// 关键路径:Enter 发送,Shift+Enter 换行 — 跟主流 IM 一致。
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
