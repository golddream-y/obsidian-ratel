<script lang="ts">
	/**
	 * @file src/ui/ChatView.svelte
	 * @description Chat 主视图 — 消息流 + StatusLine/Drawer + 斜杠命令 + 附件预览
	 * @module ui/ChatView
	 * @depends main, ui/StatusLine, ui/StatusDrawer, ui/SlashMenu, ui/AttachmentStrip, ui/slash-commands, ui/attachment-utils
	 */
	import type RatelVaultPlugin from '../main';
	import { get } from 'svelte/store';
	import StatusLine from './StatusLine.svelte';
	import StatusDrawer from './StatusDrawer.svelte';
	import SlashMenu from './SlashMenu.svelte';
	import AttachmentStrip from './AttachmentStrip.svelte';
	import { filterCommands, type SlashCommand } from './slash-commands';
	import { validateAttachment, estimateImageTokens } from './attachment-utils';
	import { evaluateChatSendGate } from './chat-send-gate';
	import { hasChatApiKey, resolveChatApiKey } from '../secrets/ratel-secrets';
	import { formatChatError, type DiagError } from './chat-error';
	import { showCompactConfirm } from './compact-confirm';
	import { devLogger } from '../logging/dev-logger';

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
		searchResults?: Array<{
			docId: string;
			score: number;
			path: string;
			index: number;
		}>;
		searchReranked?: boolean;
		attachments?: Array<{ fileName: string; mimeType: string; base64: string }>;
	}

	// 关键路径:Svelte 5 用 $props() 替代 export let
	let { plugin }: { plugin: RatelVaultPlugin } = $props();

	// 关键路径:Svelte 5 用 $state 替代 let 响应式变量
	let messages = $state<Message[]>([]);
	let input = $state('');
	let isRunning = $state(false);
	let sessionId = $state('session-' + Date.now());
	let abortController: AbortController | null = null;
	let drawerExpanded = $state(false);
	let fileInput: HTMLInputElement | null = null;

	// SlashMenu 组件实例引用 — 用于转发键盘事件。
	// 关键路径:用 $state 让 bind:this 赋值能被 Svelte 5 识别(消除 non_reactive_update 警告)。
	let slashMenuRef = $state<{ handleKeydown: (e: KeyboardEvent) => boolean } | null>(null);

	// 关键路径:Svelte 5 用 $derived 替代 $: 自动重算
	const statusBar = $derived(plugin.userStatus.statusBar$);
	const statusSnap = $derived($statusBar);
	const contextUsage = $derived(plugin.userStatus.contextUsage$);
	const pendingAttachments = $derived(plugin.userStatus.pendingAttachments$);

	// 关键路径:SecretStorage 无文档化事件,用 keyVersion 计数器强制 hasKey 重算。
	// keyVersion >= 0 永真,仅用于让 $derived 追踪 keyVersion 变化,实际值取 hasChatApiKey。
	let keyVersion = $state(0);
	const hasKey = $derived(keyVersion >= 0 && hasChatApiKey(plugin.app, plugin.settings));
	const gate = $derived(
		evaluateChatSendGate(plugin.settings, statusSnap, { hasChatApiKey: hasKey }),
	);

	// 斜杠命令:仅当 input 以 / 开头且 filterCommands 返回非空时显示菜单
	const slashVisible = $derived(filterCommands(input).length > 0 && input.startsWith('/') && !input.includes(' '));

	/**
	 * 重新解析钥匙串状态并按需重建 LLM 适配器。
	 * SecretStorage 无文档化 onChange 事件,改在输入聚焦 / 发送前手动刷新。
	 */
	function refreshKeyState() {
		// 关键路径:DeepSeekLLM.config 是 private,svelte-check 严格模式需 unknown 绕过类型
		const prevKey = (plugin.llm as unknown as { config?: { apiKey?: string } } | null)?.config?.apiKey ?? '';
		const currentKey = resolveChatApiKey(plugin.app, plugin.settings) ?? '';
		if (prevKey !== currentKey) {
			plugin.rebuildLLM();
		}
		keyVersion++;
	}

	/**
	 * 刷新上下文使用率 — send 前后与附件变化时调用。
	 */
	function refreshContextUsage() {
		const attachmentTokens = get(plugin.userStatus.pendingAttachments$).reduce(
			(sum, a) => sum + a.estimatedTokens,
			0,
		);
		// 关键路径:plugin.ask 内部创建 ContextManager,这里临时构造一个估算
		// 实际 usedTokens 由 agentLoop 在 send 时更新;此处用 messages 粗估
		const approxUsed = messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
		plugin.userStatus.patchContextUsage({
			usedTokens: approxUsed,
			maxTokens: plugin.settings.chatModelMaxTokens,
			attachmentTokens,
		});
	}

	function handleAgentError(assistantMsg: Message, code: string, message: string, toolName?: string): void {
		if (code === 'CANCELLED') {
			assistantMsg.cancelled = true;
			return;
		}
		if (code === 'TOOL_ERROR' || code === 'INDEX_NOT_READY') {
			if (assistantMsg.toolCalls) {
				for (let i = assistantMsg.toolCalls.length - 1; i >= 0; i--) {
					const tc = assistantMsg.toolCalls[i]!;
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

	/**
	 * 执行斜杠命令 — 由 SlashMenu onSelect 触发或回车时识别。
	 */
	function executeSlashCommand(cmd: SlashCommand): void {
		input = '';
		switch (cmd.name) {
			case '/new':
				messages = [];
				sessionId = 'session-' + Date.now();
				plugin.userStatus.patchContextUsage({ usedTokens: 0 });
				plugin.userStatus.clearAttachments();
				break;
			case '/compact':
				handleCompact();
				break;
			case '/model':
				// 关键路径:Obsidian SettingCenter 未在 d.ts 导出,用 unknown 绕过类型
				(plugin as unknown as { app: { setting: { open: () => void; openTabById: (id: string) => void } } }).app.setting.open();
				(plugin as unknown as { app: { setting: { openTabById: (id: string) => void } } }).app.setting.openTabById('ratel-vault');
				break;
			case '/reindex':
				// 关键路径:不 await,让索引在后台跑,StatusLine 会通过 statusBar$ 显示进度
				plugin.indexController.reindex().catch((err) => {
					devLogger.error('index', '/reindex 失败', err);
				});
				break;
		}
	}

	/**
	 * 压缩上下文 — 弹确认框,确认后清空 messages(本 spec 只做 UI 入口,
	 * 压缩逻辑复用 context-manager 的 truncate 能力,LLM 总结式压缩留给后续 spec)。
	 */
	async function handleCompact(): Promise<void> {
		const confirmed = await showCompactConfirm(plugin.app);
		if (!confirmed) return;
		// 关键路径:简单实现 — 保留最后 2 条消息,清空历史(spec 非目标:LLM 总结式压缩)
		messages = messages.slice(-2);
		refreshContextUsage();
	}

	async function sendMessage() {
		refreshKeyState();
		const text = input.trim();
		const freshGate = evaluateChatSendGate(plugin.settings, statusSnap, {
			hasChatApiKey: hasChatApiKey(plugin.app, plugin.settings),
		});
		if (!text || isRunning || !freshGate.canSend) return;

		// 关键路径:斜杠命令在 sendMessage 前已被 handleKeydown 拦截,这里不会再收到 / 开头的 text
		const currentAttachments = get(plugin.userStatus.pendingAttachments$).map((a) => ({
			fileName: a.fileName,
			mimeType: a.mimeType,
			base64: a.base64,
		}));

		const userMsg: Message = {
			role: 'user',
			content: text,
			attachments: currentAttachments.length > 0 ? currentAttachments : undefined,
		};
		messages = [...messages, userMsg];
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
								const tc = assistantMsg.toolCalls[i]!;
								if (
									tc.name === event.payload.name &&
									tc.status === 'calling'
								) {
									tc.result = event.payload.result;
									tc.status = 'done';
									break;
								}
							}
						}
						messages = [...messages];
						break;
					case 'search.result':
						assistantMsg.searchResults = event.payload.results;
						assistantMsg.searchReranked = event.payload.reranked;
						messages = [...messages];
						break;
					case 'message.end':
						// 关键路径:message.end.payload.tokens 当前未消费,后续可接入 contextUsage 更新
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
			// 关键路径:发送完成后清空附件并刷新上下文使用率
			plugin.userStatus.clearAttachments();
			refreshContextUsage();
		}
	}

	function stopGeneration() {
		abortController?.abort();
	}

	/**
	 * 输入框键盘事件 — 优先转发给 SlashMenu(若可见),否则 Enter 发送。
	 */
	function handleKeydown(e: KeyboardEvent) {
		// 关键路径:斜杠菜单可见时,优先处理导航键
		if (slashVisible && slashMenuRef) {
			const handled = slashMenuRef.handleKeydown(e);
			if (handled) return;
		}
		// 关键路径:回车且菜单不可见时,检查是否是斜杠命令
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			const trimmed = input.trim();
			// 关键路径:精确匹配命令名(如 /new)直接执行
			const exactMatch = filterCommands(trimmed).find((c) => c.name === trimmed);
			if (exactMatch) {
				executeSlashCommand(exactMatch);
				return;
			}
			sendMessage();
		}
	}

	/**
	 * 文件选择 — 点击 + 按钮触发隐藏 input file。
	 */
	function triggerFileInput() {
		fileInput?.click();
	}

	/**
	 * 处理文件选择 — 校验后转 base64 存入 pendingAttachments$。
	 */
	async function handleFileSelect(e: Event) {
		const target = e.target as HTMLInputElement;
		if (!target.files || target.files.length === 0) return;
		const file = target.files[0]!;
		target.value = ''; // 清空,允许重复选同一文件

		const currentCount = get(plugin.userStatus.pendingAttachments$).length;
		const validateResult = validateAttachment(file, currentCount);
		if (!validateResult.ok) {
			// 关键路径:校验失败不弹 Notice(spec 不改 FeedbackController 的错误 Notice),
			// 改为临时在输入区显示提示
			input = `[附件错误] ${validateResult.reason}`;
			return;
		}

		// 读取图片尺寸用于估算 token
		const { width, height } = await readImageDimensions(file);
		const estimatedTokens = estimateImageTokens(width, height);
		const base64 = await fileToBase64(file);

		plugin.userStatus.addAttachment({
			fileName: file.name,
			mimeType: file.type,
			base64,
			estimatedTokens,
		});
		refreshContextUsage();
	}

	/**
	 * 读取图片尺寸 — 用于估算 token。
	 */
	function readImageDimensions(file: File): Promise<{ width: number; height: number }> {
		return new Promise((resolve) => {
			const url = URL.createObjectURL(file);
			const img = new Image();
			img.onload = () => {
				resolve({ width: img.naturalWidth, height: img.naturalHeight });
				URL.revokeObjectURL(url);
			};
			img.onerror = () => {
				resolve({ width: 0, height: 0 });
				URL.revokeObjectURL(url);
			};
			img.src = url;
		});
	}

	/**
	 * File 转 base64 字符串(不含 data: 前缀)。
	 */
	function fileToBase64(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				const result = reader.result as string;
				// 关键路径:FileReader 结果是 "data:image/png;base64,xxxx",去掉前缀
				const base64 = result.split(',')[1] ?? '';
				resolve(base64);
			};
			reader.onerror = reject;
			reader.readAsDataURL(file);
		});
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
				{#if msg.searchResults && msg.searchResults.length > 0}
					<div class="ratel-search-results">
						<div class="ratel-search-header">
							🔍 搜索结果
							{#if msg.searchReranked}
								<span class="ratel-search-reranked" title="结果经过 Reranker 精排">✨ 精排</span>
							{/if}
						</div>
						{#each msg.searchResults as r}
							<div class="ratel-search-item">
								<span class="ratel-search-index">[{r.index}]</span>
								<span class="ratel-search-path">{r.path}</span>
								<span class="ratel-search-score">{r.score.toFixed(3)}</span>
							</div>
						{/each}
					</div>
				{/if}
				{#if msg.attachments && msg.attachments.length > 0}
					<div class="ratel-msg-attachments">
						{#each msg.attachments as att}
							<img
								class="ratel-msg-attachment-thumb"
								src="data:{att.mimeType};base64,{att.base64}"
								alt={att.fileName}
								title={att.fileName}
							/>
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

	<!-- 关键路径:StatusLine 常驻底部,左侧点击展开/收起 Drawer -->
	<StatusLine
		status$={plugin.userStatus.statusBar$}
		contextUsage$={plugin.userStatus.contextUsage$}
		expanded={drawerExpanded}
		onToggle={() => (drawerExpanded = !drawerExpanded)}
	/>

	<!-- 关键路径:StatusDrawer 展开式详情,expanded 控制显隐 -->
	<StatusDrawer
		expanded={drawerExpanded}
		status$={plugin.userStatus.statusBar$}
		contextUsage$={plugin.userStatus.contextUsage$}
		pendingAttachments$={plugin.userStatus.pendingAttachments$}
		onCompact={handleCompact}
	/>

	<div class="ratel-input-area">
		{#if gate.hardBlockReason}
			<div class="ratel-chat-gate-hint ratel-chat-gate-hard">{gate.hardBlockReason}</div>
		{:else if gate.softHint}
			<div class="ratel-chat-gate-hint">{gate.softHint}</div>
		{/if}

		<!-- 关键路径:附件预览条,空时不渲染 -->
		<AttachmentStrip
			pendingAttachments$={plugin.userStatus.pendingAttachments$}
			onRemove={(id) => {
				plugin.userStatus.removeAttachment(id);
				refreshContextUsage();
			}}
		/>

		<!-- 关键路径:斜杠命令菜单,仅 slashVisible 时渲染 -->
		{#if slashVisible}
			<div class="ratel-slash-container">
				<SlashMenu
					bind:this={slashMenuRef}
					input={input}
					onSelect={executeSlashCommand}
					onClose={() => { input = ''; }}
				/>
			</div>
		{/if}

		<div class="ratel-input-row">
			<!-- 关键路径:附件按钮 + 隐藏 file input -->
			<button
				class="ratel-attach-btn"
				type="button"
				onclick={triggerFileInput}
				aria-label="添加图片附件"
				disabled={isRunning}
			>+</button>
			<input
				bind:this={fileInput}
				type="file"
				accept="image/png,image/jpeg,image/webp,image/gif"
				onchange={handleFileSelect}
				style="display: none;"
			/>
			<textarea
				bind:value={input}
				onkeydown={handleKeydown}
				onfocus={refreshKeyState}
				placeholder="Ask about your vault... (输入 / 查看命令)"
				disabled={isRunning || !gate.canSend}
				rows="2"
			></textarea>
			{#if isRunning}
				<button onclick={stopGeneration} class="ratel-stop-btn">Stop</button>
			{:else}
				<button onclick={sendMessage} disabled={isRunning || !input.trim() || !gate.canSend}>Send</button>
			{/if}
		</div>
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

	.ratel-msg-attachments {
		display: flex;
		gap: 4px;
		margin-bottom: 6px;
		flex-wrap: wrap;
	}

	.ratel-msg-attachment-thumb {
		width: 96px;
		height: 96px;
		object-fit: cover;
		border-radius: 4px;
		border: 1px solid var(--background-modifier-border);
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
		color: var(--text-error);
		font-style: normal;
		white-space: normal;
		max-width: none;
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
		flex-direction: column;
		gap: 4px;
		border-top: 1px solid var(--background-modifier-border);
		padding-top: 8px;
	}

	.ratel-slash-container {
		position: relative;
	}

	.ratel-input-row {
		display: flex;
		gap: 8px;
		align-items: flex-end;
	}

	.ratel-attach-btn {
		flex-shrink: 0;
		width: 32px;
		height: 32px;
		padding: 0;
		border-radius: 6px;
		border: 1px solid var(--background-modifier-border);
		background: var(--background-modifier-form-field);
		color: var(--text-normal);
		font-size: 18px;
		line-height: 1;
		cursor: pointer;
	}

	.ratel-attach-btn:hover {
		border-color: var(--interactive-accent);
	}

	.ratel-attach-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.ratel-input-row textarea {
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

	.ratel-input-row textarea:focus {
		outline: none;
		border-color: var(--interactive-accent);
	}

	.ratel-input-row button {
		padding: 8px 16px;
		border-radius: 6px;
		border: none;
		background: var(--interactive-accent);
		color: var(--text-on-accent);
		cursor: pointer;
		font-size: 14px;
	}

	.ratel-input-row button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.ratel-stop-btn {
		background: var(--text-error) !important;
		color: var(--text-on-accent) !important;
	}

	.ratel-search-results {
		margin-bottom: 8px;
		padding: 8px 10px;
		border-radius: 6px;
		background: var(--background-modifier-form-field);
		font-size: 0.85em;
	}

	.ratel-search-header {
		font-weight: 600;
		margin-bottom: 4px;
		opacity: 0.8;
	}

	.ratel-search-item {
		display: flex;
		gap: 6px;
		align-items: center;
		padding: 2px 0;
	}

	.ratel-search-index {
		font-family: var(--font-monospace);
		font-weight: 600;
		color: var(--interactive-accent);
		min-width: 24px;
	}

	.ratel-search-path {
		flex: 1;
		font-family: var(--font-monospace);
		font-size: 0.9em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ratel-search-score {
		font-family: var(--font-monospace);
		color: var(--text-muted);
		font-size: 0.85em;
	}

	.ratel-search-reranked {
		margin-left: 6px;
		padding: 1px 6px;
		border-radius: 3px;
		background: var(--interactive-accent);
		color: var(--text-on-accent);
		font-size: 0.75em;
		font-weight: 600;
	}
</style>
