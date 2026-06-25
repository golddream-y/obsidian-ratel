<script lang="ts">
	import type RatelVaultPlugin from '../main';
	import StatusBar from './StatusBar.svelte';
	import { evaluateChatSendGate } from './chat-send-gate';
	import { hasChatApiKey, resolveChatApiKey } from '../secrets/ratel-secrets';
	import { formatChatError, type DiagError } from './chat-error';

	interface ToolCallEntry {
		name: string;
		args: unknown;
		status: 'calling' | 'done' | 'failed';
		result?: unknown;
		errorMessage?: string;
	}

	interface Message {
		role: 'user' | 'assistant';
		content: string;
		toolCalls?: ToolCallEntry[];
		chatError?: DiagError;
		cancelled?: boolean;
	}

	export let plugin: RatelVaultPlugin;
	let messages: Message[] = [];
	let input = '';
	let isRunning = false;
	let sessionId = 'session-' + Date.now();
	let abortController: AbortController | null = null;

	$: statusSnap = $plugin.userStatus.statusBar$;
	// 关键路径:SecretStorage 无文档化事件,plugin.settings 原地 mutate 也不触发响应式;
	// 用 keyVersion 计数器强制 hasKey 重算,在输入聚焦 / 发送时手动刷新。
	let keyVersion = 0;
	$: hasKey = (keyVersion, hasChatApiKey(plugin.app, plugin.settings));
	$: gate = evaluateChatSendGate(plugin.settings, statusSnap, { hasChatApiKey: hasKey });

	/**
	 * 重新解析钥匙串状态并按需重建 LLM 适配器。
	 * SecretStorage 无文档化 onChange 事件,改在输入聚焦 / 发送前手动刷新,
	 * 让用户在 Obsidian 钥匙串添加密钥后无需重载插件即可生效。
	 */
	function refreshKeyState() {
		// 关键路径:钥匙串值可能已变更,按需 rebuild LLM 让新 key 即时注入 config。
		const prevKey = plugin.llm?.config?.apiKey ?? '';
		const currentKey = resolveChatApiKey(plugin.app, plugin.settings) ?? '';
		if (prevKey !== currentKey) {
			plugin.rebuildLLM();
		}
		keyVersion++;
	}

	function handleAgentError(assistantMsg: Message, code: string, message: string, toolName?: string): void {
		if (code === 'CANCELLED') {
			assistantMsg.cancelled = true;
			return;
		}
		if (code === 'TOOL_ERROR' || code === 'INDEX_NOT_READY') {
			if (assistantMsg.toolCalls) {
				for (let i = assistantMsg.toolCalls.length - 1; i >= 0; i--) {
					const tc = assistantMsg.toolCalls[i];
					if (tc.status === 'calling' && (!toolName || tc.name === toolName)) {
						tc.status = 'failed';
						tc.errorMessage = message;
						break;
					}
				}
			}
			return;
		}
		assistantMsg.chatError = formatChatError(code, message);
	}

	async function sendMessage() {
		refreshKeyState();
		const text = input.trim();
		// 关键路径:用最新钥匙串状态重算 gate,避免响应式 stale 导致误拦或误放行。
		const freshGate = evaluateChatSendGate(plugin.settings, statusSnap, {
			hasChatApiKey: hasChatApiKey(plugin.app, plugin.settings),
		});
		if (!text || isRunning || !freshGate.canSend) return;

		messages = [...messages, { role: 'user', content: text }];
		input = '';
		isRunning = true;
		abortController = new AbortController();

		const assistantMsg: Message = { role: 'assistant', content: '' };
		messages = [...messages, assistantMsg];
		let lastToolName: string | undefined;

		try {
			const events = plugin.ask(sessionId, text, abortController.signal);

			for await (const event of events) {
				switch (event.type) {
					case 'message.delta':
						assistantMsg.content += event.payload.text;
						messages = [...messages];
						break;
					case 'tool.call':
						lastToolName = event.payload.name;
						if (!assistantMsg.toolCalls) assistantMsg.toolCalls = [];
						assistantMsg.toolCalls.push({
							name: event.payload.name,
							args: event.payload.args,
							status: 'calling',
						});
						messages = [...messages];
						break;
					case 'tool.result':
						if (assistantMsg.toolCalls) {
							for (let i = assistantMsg.toolCalls.length - 1; i >= 0; i--) {
								if (
									assistantMsg.toolCalls[i].name === event.payload.name &&
									assistantMsg.toolCalls[i].status === 'calling'
								) {
									assistantMsg.toolCalls[i].result = event.payload.result;
									assistantMsg.toolCalls[i].status = 'done';
									break;
								}
							}
						}
						messages = [...messages];
						break;
					case 'message.end':
						break;
					case 'error':
						handleAgentError(assistantMsg, event.payload.code, event.payload.message, lastToolName);
						messages = [...messages];
						break;
				}
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			handleAgentError(assistantMsg, 'LLM_ERROR', message);
			messages = [...messages];
		} finally {
			isRunning = false;
			abortController = null;
		}
	}

	function stopGeneration() {
		abortController?.abort();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			sendMessage();
		}
	}

	function formatToolResult(result: unknown): string {
		if (Array.isArray(result)) {
			return `找到 ${result.length} 项`;
		}
		if (typeof result === 'string') {
			return result.length > 60 ? result.slice(0, 60) + '...' : result;
		}
		if (result && typeof result === 'object') {
			const json = JSON.stringify(result);
			return json.length > 60 ? json.slice(0, 60) + '...' : json;
		}
		return String(result);
	}

	function toolIcon(status: ToolCallEntry['status']): string {
		if (status === 'calling') return '⟳';
		if (status === 'failed') return '✗';
		return '✓';
	}
</script>

<div class="ratel-chat">
	<StatusBar status$={plugin.userStatus.statusBar$} />
	<div class="ratel-messages">
		{#each messages as msg}
			<div class="ratel-message ratel-{msg.role}">
				<div class="ratel-role">{msg.role === 'user' ? 'You' : 'Ratel'}</div>
				{#if msg.toolCalls && msg.toolCalls.length > 0}
					<div class="ratel-tool-calls">
						{#each msg.toolCalls as tc}
							<div class="ratel-tool-call ratel-tool-{tc.status}">
								<span class="ratel-tool-icon">{toolIcon(tc.status)}</span>
								<span class="ratel-tool-name">{tc.name}</span>
								{#if tc.status === 'calling'}
									<span class="ratel-tool-status">...</span>
								{:else if tc.status === 'failed'}
									<span class="ratel-tool-summary ratel-tool-failed">{tc.errorMessage ?? '失败'}</span>
								{:else if tc.result != null}
									<span class="ratel-tool-summary">{formatToolResult(tc.result)}</span>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
				{#if msg.content}
					<div class="ratel-content">{msg.content}</div>
				{/if}
				{#if msg.chatError}
					<div class="ratel-chat-error ratel-chat-error-{msg.chatError.type}">
						<div class="ratel-chat-error-msg">{msg.chatError.message}</div>
						{#if msg.chatError.suggestion}
							<div class="ratel-chat-error-suggestion">{msg.chatError.suggestion}</div>
						{/if}
					</div>
				{/if}
				{#if msg.cancelled}
					<div class="ratel-chat-cancelled">已停止生成</div>
				{/if}
			</div>
		{/each}
		{#if isRunning && messages[messages.length - 1]?.content === ''}
			<div class="ratel-typing">Thinking...</div>
		{/if}
	</div>

	<div class="ratel-input-area">
		{#if gate.hardBlockReason}
			<div class="ratel-chat-gate-hint ratel-chat-gate-hard">{gate.hardBlockReason}</div>
		{:else if gate.softHint}
			<div class="ratel-chat-gate-hint">{gate.softHint}</div>
		{/if}
		<textarea
			bind:value={input}
			on:keydown={handleKeydown}
			on:focus={refreshKeyState}
			placeholder="Ask about your vault..."
			disabled={isRunning || !gate.canSend}
			rows="2"
		></textarea>
		{#if isRunning}
			<button on:click={stopGeneration} class="ratel-stop-btn">Stop</button>
		{:else}
			<button on:click={sendMessage} disabled={isRunning || !input.trim() || !gate.canSend}>Send</button>
		{/if}
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

	.ratel-chat-error {
		margin-top: 8px;
		padding: 8px 10px;
		border-radius: 6px;
		border-left: 3px solid var(--text-error);
		background: var(--background-modifier-error);
		font-size: 0.9em;
	}

	.ratel-chat-error-msg {
		font-weight: 600;
	}

	.ratel-chat-error-suggestion {
		margin-top: 4px;
		font-size: 0.85em;
		color: var(--text-muted);
	}

	.ratel-chat-cancelled {
		margin-top: 8px;
		font-size: 0.85em;
		color: var(--text-muted);
		font-style: italic;
	}

	.ratel-chat-gate-hint {
		width: 100%;
		font-size: 0.8em;
		color: var(--text-warning);
		margin-bottom: 4px;
	}

	.ratel-chat-gate-hard {
		color: var(--text-error);
	}

	.ratel-tool-calls {
		margin-bottom: 8px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.ratel-tool-call {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.85em;
		padding: 4px 8px;
		border-radius: 4px;
		background: var(--background-modifier-form-field);
	}

	.ratel-tool-calling {
		color: var(--text-muted);
	}

	.ratel-tool-done {
		color: var(--text-normal);
		opacity: 0.8;
	}

	.ratel-tool-failed {
		color: var(--text-error) !important;
		font-style: normal !important;
		white-space: normal !important;
		max-width: none !important;
	}

	.ratel-tool-icon {
		font-size: 0.9em;
	}

	.ratel-tool-name {
		font-weight: 600;
		font-family: var(--font-monospace);
	}

	.ratel-tool-status {
		color: var(--text-muted);
	}

	.ratel-tool-summary {
		color: var(--text-muted);
		font-style: italic;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 200px;
	}

	.ratel-typing {
		color: var(--text-muted);
		font-style: italic;
		padding: 4px 12px;
	}

	.ratel-input-area {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: flex-end;
		border-top: 1px solid var(--background-modifier-border);
		padding-top: 8px;
	}

	.ratel-input-area textarea {
		flex: 1;
		min-width: 0;
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

	.ratel-stop-btn {
		background: var(--text-error, #e53935) !important;
		color: var(--text-on-accent, #fff) !important;
	}
</style>
