<script lang="ts">
	import type RatelVaultPlugin from '../main';

	// Ratel 聊天侧栏 — 用户输入 + 流式渲染 + 工具调用过程 + 错误展示
	// 关键路径:每个 message.delta 触发 messages 数组重建(Svelte 5 反应性依赖引用比较)。
	interface ToolCallEntry {
		name: string;
		args: unknown;
		status: 'calling' | 'done';
		result?: unknown;
	}

	interface Message {
		role: 'user' | 'assistant';
		content: string;
		// 关键路径:assistant 消息可附带工具调用过程,按到达顺序追加。
		toolCalls?: ToolCallEntry[];
	}

	// 修复:加 `export` 让 Svelte 5 识别为 prop 声明。
	// 原因:Svelte 4 时代 `let x;` 隐式 prop,Svelte 5 改为必须 `export let` 或 `$props()`。
	// 没 `export` 时 esbuild-svelte 0.9 编译出 `let t,` 但不绑定 props,
	// 导致父组件传的 plugin 永远 undefined,Svelte 5 effect 链某处 .call() 失败。
	export let plugin: RatelVaultPlugin;
	let messages: Message[] = [];
	let input = '';
	let isRunning = false;
	// 关键路径:sessionId 用于把同一会话的多轮消息绑回 Session 存储。
	let sessionId = 'session-' + Date.now();
	// 关键路径:AbortController 用于取消正在进行的 agentLoop。
	let abortController: AbortController | null = null;

	async function sendMessage() {
		const text = input.trim();
		if (!text || isRunning) return;

		messages = [...messages, { role: 'user', content: text }];
		input = '';
		isRunning = true;
		// 关键路径:每次发送创建新的 AbortController,供 Stop 按钮触发。
		abortController = new AbortController();

		// 关键路径:先占位一个空 assistant 消息,流式 delta 直接 mutate 它。
		const assistantMsg: Message = { role: 'assistant', content: '' };
		messages = [...messages, assistantMsg];

		try {
			const events = plugin.ask(sessionId, text, abortController.signal);

			for await (const event of events) {
				switch (event.type) {
					case 'message.delta':
						assistantMsg.content += event.payload.text;
						// 修复:重新赋值触发 Svelte 反应性,否则内容变更不可见。
						messages = [...messages];
						break;
					case 'tool.call':
						// 关键路径:工具调用过程对用户可见,减少等待焦虑。
						if (!assistantMsg.toolCalls) assistantMsg.toolCalls = [];
						assistantMsg.toolCalls.push({
							name: event.payload.name,
							args: event.payload.args,
							status: 'calling',
						});
						messages = [...messages];
						break;
					case 'tool.result':
						// 关键路径:匹配最后一个同名 calling 条目,更新为 done。
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
			abortController = null;
		}
	}

	/**
	 * 取消正在进行的 agentLoop — 触发 AbortController,agentLoop 在下一个检查点退出。
	 */
	function stopGeneration() {
		abortController?.abort();
	}

	function handleKeydown(e: KeyboardEvent) {
		// 关键路径:Enter 发送,Shift+Enter 换行 — 跟主流 IM 一致。
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			sendMessage();
		}
	}

	/**
	 * 把工具结果格式化为简短摘要,避免在 UI 中显示过长内容。
	 * 数组 → "找到 N 项";字符串 → 截断 60 字符;对象 → JSON 截断。
	 */
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
</script>

<div class="ratel-chat">
	<div class="ratel-messages">
		{#each messages as msg}
			<div class="ratel-message ratel-{msg.role}">
				<div class="ratel-role">{msg.role === 'user' ? 'You' : 'Ratel'}</div>
				{#if msg.toolCalls && msg.toolCalls.length > 0}
					<div class="ratel-tool-calls">
						{#each msg.toolCalls as tc}
							<div class="ratel-tool-call ratel-tool-{tc.status}">
								<span class="ratel-tool-icon">{tc.status === 'calling' ? '⟳' : '✓'}</span>
								<span class="ratel-tool-name">{tc.name}</span>
								{#if tc.status === 'calling'}
									<span class="ratel-tool-status">...</span>
								{:else if tc.result != null}
									<span class="ratel-tool-summary">{formatToolResult(tc.result)}</span>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
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
		{#if isRunning}
			<button on:click={stopGeneration} class="ratel-stop-btn">
				Stop
			</button>
		{:else}
			<button on:click={sendMessage} disabled={isRunning || !input.trim()}>
				Send
			</button>
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

	.ratel-stop-btn {
		background: var(--text-error, #e53935) !important;
		color: var(--text-on-accent, #fff) !important;
	}
</style>
