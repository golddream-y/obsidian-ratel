<script lang="ts">
	/**
	 * @file src/ui/ChatView.svelte
	 * @description Chat 主视图 — 消息流 + StatusLine/Drawer + 斜杠命令 + 附件预览(Svelte 5)
	 * @module ui/ChatView
	 * @depends main, ui/StatusLine, ui/StatusDrawer, ui/SlashMenu, ui/AttachmentStrip
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
	import { hasChatApiKey } from '../secrets/ratel-secrets';
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

	let { plugin }: { plugin: RatelVaultPlugin } = $props();

	// ==================== 响应式状态 ====================

	let messages = $state<Message[]>([]);
	let input = $state('');
	let isRunning = $state(false);
	let sessionId = $state('session-' + Date.now());
	let drawerExpanded = $state(false);
	let fileInput = $state<HTMLInputElement | null>(null);
	let slashMenuEl = $state<{ handleKeydown: (e: KeyboardEvent) => boolean } | null>(null);
	let messagesEl = $state<HTMLDivElement | null>(null);

	// 关键路径:plugin 是稳定引用,store 是单例,直接提取到局部常量
	// 在模板/derived 中用 $ 前缀订阅(Svelte 5 store 自动订阅语法)
	const statusStore = plugin.userStatus.statusBar$;
	const contextStore = plugin.userStatus.contextUsage$;
	const attachmentStore = plugin.userStatus.pendingAttachments$;

	// SecretStorage 无文档化 onChange 事件,用 keyTick 强制重算 hasKey
	let keyTick = $state(0);
	const hasKey = $derived.by(() => {
		keyTick; // 追踪依赖
		return hasChatApiKey(plugin.app, plugin.settings);
	});

	// 发送门禁:每次 statusStore / keyTick 变化时重算
	const gate = $derived.by(() => {
		keyTick;
		return evaluateChatSendGate(plugin.settings, $statusStore, { hasChatApiKey: hasKey });
	});

	// 斜杠菜单可见性
	const slashVisible = $derived.by(() => {
		const v = input.startsWith('/') && !input.includes(' ');
		if (!v) return false;
		return filterCommands(input).length > 0;
	});

	// 当前模型名(用户切模型后需 reload,此处直接读 settings 即可)
	const modelName = $derived(plugin.settings.chatModel);

	// ==================== 工具函数 ====================

	function refreshKeyState() {
		// 关键路径:onfocus / send 前刷新,检测用户是否在 Obsidian 设置中配了 Key
		plugin.rebuildLLM();
		keyTick++;
	}

	function refreshContextUsage() {
		// 关键路径:粗估 — 发送后由 FeedbackController 精确更新,此处仅做即时反馈
		const atts = get(attachmentStore);
		const attachmentTokens = atts.reduce((s, a) => s + a.estimatedTokens, 0);
		const approxUsed = messages.reduce((s, m) => s + Math.ceil(m.content.length / 4), 0);
		plugin.userStatus.patchContextUsage({
			usedTokens: approxUsed,
			maxTokens: plugin.settings.chatModelMaxTokens,
			attachmentTokens,
		});
	}

	function handleAgentError(am: Message, code: string, message: string, toolName?: string) {
		if (code === 'CANCELLED') {
			am.cancelled = true;
			return;
		}
		// 关键路径:TOOL_DENIED(权限拒绝,如路径越界)、TOOL_ERROR(工具执行异常)、
		// INDEX_NOT_READY(索引未就绪)都优先附到最近一个 calling 状态的 toolCall 上,
		// 以红色小字显示在工具条里,不铺大错误块。找不到匹配 toolCall 时降级到 chatError。
		if (code === 'TOOL_ERROR' || code === 'TOOL_DENIED' || code === 'INDEX_NOT_READY') {
			if (am.toolCalls) {
				for (let i = am.toolCalls.length - 1; i >= 0; i--) {
					const tc = am.toolCalls[i]!;
					if (tc.status === 'calling' && (!toolName || tc.name === toolName)) {
						tc.status = 'failed';
						tc.errorMessage = message;
						return;
					}
				}
			}
		}
		am.chatError = formatChatError(code, message);
	}

	// ==================== 斜杠命令 ====================

	function executeSlashCommand(cmd: SlashCommand) {
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
				// 关键路径:打开 Obsidian 设置面板
				(plugin.app as unknown as { setting: { open: () => void } }).setting.open();
				break;
			case '/reindex':
				plugin.indexController.reindex().catch((err) => {
					devLogger.error('index', '/reindex 失败', err);
				});
				break;
		}
	}

	async function handleCompact() {
		const confirmed = await showCompactConfirm(plugin.app);
		if (!confirmed) return;
		// 简单实现:保留最后 2 条消息(LLM 总结式压缩留给后续 spec)
		messages = messages.slice(-2);
		refreshContextUsage();
	}

	// ==================== 发送消息 ====================

	async function sendMessage() {
		refreshKeyState();
		const text = input.trim();
		if (!text || isRunning) return;

		const currentGate = evaluateChatSendGate(plugin.settings, get(statusStore), {
			hasChatApiKey: hasChatApiKey(plugin.app, plugin.settings),
		});
		if (!currentGate.canSend) return;

		const currentAttachments = get(attachmentStore).map((a) => ({
			fileName: a.fileName,
			mimeType: a.mimeType,
			base64: a.base64,
		}));

		// 关键路径:用 push + 从数组中取出 Proxy 引用(不是原始对象)。
		// Svelte 5 $state 数组的元素是深度 Proxy,直接修改 Proxy 属性会触发细粒度 DOM 更新,
		// 实现真正的打字机效果(字符逐字追加)。之前用 map+浅拷贝导致每次 delta
		// 都替换整条消息引用,Svelte 批处理后变成一段一段刷新。
		messages.push({
			role: 'user' as const,
			content: text,
			attachments: currentAttachments.length > 0 ? currentAttachments : undefined,
		});
		messages.push({ role: 'assistant' as const, content: '' });
		const am = messages[messages.length - 1] as Message; // 这是 Svelte Proxy

		input = '';
		isRunning = true;
		plugin.userStatus.patch({ model: 'checking' });
		const ac = new AbortController();

		let lastToolName: string | undefined;

		/** 滚动到底部 — rAF 让浏览器先完成本次 DOM 更新再滚。 */
		const scrollToBottom = () => {
			requestAnimationFrame(() => {
				if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
			});
		};
		scrollToBottom();

		try {
			const events = plugin.ask(sessionId, text, ac.signal);
			abortController = ac;

			for await (const event of events) {
				switch (event.type) {
					case 'message.delta':
						am.content += event.payload.text;
						scrollToBottom();
						break;
					case 'tool.call':
						lastToolName = event.payload.name;
						if (!am.toolCalls) am.toolCalls = [];
						am.toolCalls.push({
							name: event.payload.name,
							args: event.payload.args,
							status: 'calling',
						});
						scrollToBottom();
						break;
					case 'tool.result':
						if (am.toolCalls) {
							for (let i = am.toolCalls.length - 1; i >= 0; i--) {
								const tc = am.toolCalls[i]!;
								if (tc.name === event.payload.name && tc.status === 'calling') {
									tc.result = event.payload.result;
									tc.status = 'done';
									break;
								}
							}
						}
						break;
					case 'search.result':
						am.searchResults = event.payload.results;
						am.searchReranked = event.payload.reranked;
						scrollToBottom();
						break;
					case 'message.end':
						break;
					case 'error':
						handleAgentError(am, event.payload.code, event.payload.message, lastToolName);
						break;
				}
			}
		} catch (err) {
			if (ac.signal.aborted) {
				am.cancelled = true;
			} else {
				const message = err instanceof Error ? err.message : String(err);
				handleAgentError(am, 'LLM_ERROR', message);
			}
		} finally {
			isRunning = false;
			abortController = null;
			plugin.userStatus.patch({ model: 'ready' });
			plugin.userStatus.clearAttachments();
			refreshContextUsage();
			scrollToBottom();
		}
	}

	let abortController: AbortController | null = null;

	function stopGeneration() {
		abortController?.abort();
	}

	// ==================== 键盘 / 文件 ====================

	function handleKeydown(e: KeyboardEvent) {
		if (slashVisible && slashMenuEl) {
			if (slashMenuEl.handleKeydown(e)) return;
		}
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			const trimmed = input.trim();
			const exactMatch = filterCommands(trimmed).find((c) => c.name === trimmed);
			if (exactMatch) {
				executeSlashCommand(exactMatch);
				return;
			}
			sendMessage();
		}
	}

	function triggerFileInput() {
		fileInput?.click();
	}

	async function handleFileSelect(e: Event) {
		const target = e.target as HTMLInputElement;
		if (!target.files || target.files.length === 0) return;
		const file = target.files[0]!;
		target.value = '';

		const currentCount = get(attachmentStore).length;
		const vr = validateAttachment(file, currentCount);
		if (!vr.ok) {
			input = `[附件错误] ${vr.reason}`;
			return;
		}

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

	function fileToBase64(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				const result = reader.result as string;
				resolve(result.split(',')[1] ?? '');
			};
			reader.onerror = reject;
			reader.readAsDataURL(file);
		});
	}

	function formatToolResult(result: unknown): string {
		if (Array.isArray(result)) return `找到 ${result.length} 项`;
		if (typeof result === 'string') return result.length > 60 ? result.slice(0, 60) + '…' : result;
		if (result && typeof result === 'object') {
			const json = JSON.stringify(result);
			return json.length > 60 ? json.slice(0, 60) + '…' : json;
		}
		return String(result);
	}


</script>

<div class="ratel-chat">
	<!-- Header — 标题 + 模型徽章 -->
	<div class="ratel-header">
		<span class="ratel-header-title">Ratel</span>
		<span class="ratel-header-badge">{modelName}</span>
	</div>

	<!-- 消息流 -->
	<div class="ratel-messages" bind:this={messagesEl}>
		{#each messages as msg}
			<div class="ratel-msg" class:ratel-msg-user={msg.role === 'user'} class:ratel-msg-assistant={msg.role === 'assistant'}>
				{#if msg.attachments && msg.attachments.length > 0}
					<div class="ratel-msg-imgs">
						{#each msg.attachments as att}
							<img class="ratel-msg-img" src="data:{att.mimeType};base64,{att.base64}" alt={att.fileName} title={att.fileName} />
						{/each}
					</div>
				{/if}
				{#if msg.toolCalls && msg.toolCalls.length > 0}
					<div class="ratel-tools">
						{#each msg.toolCalls as tc}
							<div class="ratel-tool" class:ratel-tool-done={tc.status === 'done'} class:ratel-tool-failed={tc.status === 'failed'} class:ratel-tool-calling={tc.status === 'calling'}>
								{#if tc.status === 'calling'}
									<span class="ratel-tool-dot"></span>
								{:else if tc.status === 'failed'}
									<span class="ratel-tool-icon">✗</span>
								{:else}
									<span class="ratel-tool-icon">✓</span>
								{/if}
								<span class="ratel-tool-name">{tc.name}</span>
								{#if tc.status === 'failed'}
									<span class="ratel-tool-summary ratel-tool-err">{tc.errorMessage ?? '失败'}</span>
								{:else if tc.status === 'done' && tc.result != null}
									<span class="ratel-tool-summary">— {formatToolResult(tc.result)}</span>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
				{#if msg.searchResults && msg.searchResults.length > 0}
					<div class="ratel-search">
						<div class="ratel-search-hdr">
							<span class="ratel-search-icon">🔍</span>
							搜索结果
							{#if msg.searchReranked}
								<span class="ratel-search-badge">✨ 精排</span>
							{/if}
						</div>
						{#each msg.searchResults as r}
							<div class="ratel-search-row">
								<span class="ratel-search-idx">[{r.index}]</span>
								<span class="ratel-search-path">{r.path}</span>
								<span class="ratel-search-score">{r.score.toFixed(3)}</span>
							</div>
						{/each}
					</div>
				{/if}
				{#if msg.content}
					<div class="ratel-content">{msg.content}</div>
				{/if}
				{#if msg.chatError}
					<div class="ratel-err">
						<div class="ratel-err-msg">{msg.chatError.message}</div>
						{#if msg.chatError.suggestion}
							<div class="ratel-err-sug">{msg.chatError.suggestion}</div>
						{/if}
					</div>
				{/if}
				{#if msg.cancelled}
					<div class="ratel-cancelled">已停止生成</div>
				{/if}
			</div>
		{/each}
		{#if isRunning && messages.length > 0 && messages[messages.length - 1]!.role === 'assistant' && messages[messages.length - 1]!.content === ''}
			<div class="ratel-typing">
				<span class="ratel-typing-dot"></span>
				思考中…
			</div>
		{/if}
	</div>

	<!-- StatusLine(常驻底部) -->
	<StatusLine
		status$={statusStore}
		contextUsage$={contextStore}
		expanded={drawerExpanded}
		onToggle={() => (drawerExpanded = !drawerExpanded)}
	/>

	<!-- StatusDrawer(展开时显示) -->
	<StatusDrawer
		expanded={drawerExpanded}
		status$={statusStore}
		contextUsage$={contextStore}
		pendingAttachments$={attachmentStore}
		onCompact={handleCompact}
	/>

	<!-- 输入区 -->
	<div class="ratel-input">
		{#if gate.hardBlockReason}
			<div class="ratel-gate ratel-gate-hard">{gate.hardBlockReason}</div>
		{:else if gate.softHint}
			<div class="ratel-gate">{gate.softHint}</div>
		{/if}

		<!-- 附件预览条 -->
		<AttachmentStrip
			pendingAttachments$={attachmentStore}
			onRemove={(id) => {
				plugin.userStatus.removeAttachment(id);
				refreshContextUsage();
			}}
		/>

		<!-- 斜杠命令(绝对定位,浮在输入框上方) -->
		{#if slashVisible}
			<div class="ratel-slash-wrap">
				<SlashMenu
					bind:this={slashMenuEl}
					input={input}
					onSelect={executeSlashCommand}
					onClose={() => { input = ''; }}
				/>
			</div>
		{/if}

		<div class="ratel-input-row">
			<button class="ratel-plus-btn" type="button" onclick={triggerFileInput} aria-label="添加图片" disabled={isRunning}>+</button>
			<input bind:this={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onchange={handleFileSelect} style="display:none;" />
			<textarea
				bind:value={input}
				onkeydown={handleKeydown}
				onfocus={refreshKeyState}
				placeholder="输入 / 查看命令,或直接提问…"
				disabled={isRunning || !gate.canSend}
				rows={1}
			></textarea>
		</div>
		<div class="ratel-input-footer">
			{#if isRunning}
				<button class="ratel-send ratel-stop" onclick={stopGeneration}>Stop</button>
			{:else}
				<button class="ratel-send" onclick={sendMessage} disabled={!input.trim() || !gate.canSend}>Send</button>
			{/if}
		</div>
	</div>
</div>

<style>
	/* ==================== 设计 Token 映射(mockup → Obsidian 变量) ====================
	 * bg-primary(整体背景) → 继承 Obsidian leaf 背景,不设色
	 * bg-secondary(#252526,status/slash菜单/attach-btn) → --background-secondary
	 * bg-tertiary(#2d2d2d,用户气泡/工具条/搜索卡片) → --background-tertiary
	 * bg-input(#3c3c3c,输入框) → --background-modifier-form-field
	 * border → --background-modifier-border
	 * accent(#7ee787,产品绿) → --text-success(徽章/工具done); Send 走 --interactive-accent(尊重主题)
	 * warning(#facc15) → --text-warning
	 * error(#f87171) → --text-error
	 */

	* { box-sizing: border-box; }

	.ratel-chat {
		display: flex;
		flex-direction: column;
		height: 100%;
		font-size: 13.5px;
		line-height: 1.5;
		color: var(--text-normal);
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
	}

	/* ==================== Header ==================== */
	.ratel-header {
		flex-shrink: 0;
		padding: 10px 14px;
		border-bottom: 1px solid var(--background-modifier-border);
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.ratel-header-title {
		font-size: 13px;
		font-weight: 600;
		color: var(--text-normal);
	}

	.ratel-header-badge {
		font-size: 11px;
		font-family: var(--font-monospace);
		padding: 2px 8px;
		border-radius: 12px;
		background: rgba(126, 231, 135, 0.15);
		color: #7ee787;
	}

	/* ==================== 消息流 ==================== */
	.ratel-messages {
		flex: 1;
		overflow-y: auto;
		padding: 14px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.ratel-msg {
		max-width: 88%;
	}

	.ratel-msg-user {
		align-self: flex-end;
		padding: 10px 13px;
		border-radius: 8px;
		background: var(--background-tertiary);
	}

	.ratel-msg-assistant {
		align-self: flex-start;
		padding: 0;
		background: transparent;
	}

	.ratel-content {
		white-space: pre-wrap;
		word-break: break-word;
	}

	/* 消息中的图片(mockup: .message-images) */
	.ratel-msg-imgs {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		margin-bottom: 8px;
	}

	.ratel-msg-img {
		width: 96px;
		height: 96px;
		object-fit: cover;
		border-radius: 6px;
		border: 1px solid var(--background-modifier-border);
	}

	/* 错误(mockup: .degraded-row) */
	.ratel-err {
		margin-top: 8px;
		padding: 8px 10px;
		border-radius: 6px;
		background: rgba(248, 113, 113, 0.1);
		color: var(--text-error);
		font-size: 11.5px;
		line-height: 1.4;
	}

	.ratel-err-msg { font-weight: 600; }
	.ratel-err-sug { margin-top: 4px; color: var(--text-muted); }

	.ratel-cancelled {
		margin-top: 8px;
		font-size: 11.5px;
		color: var(--text-muted);
		font-style: italic;
	}

	/* Thinking 指示器 */
	.ratel-typing {
		color: var(--text-warning);
		font-size: 12px;
		padding: 4px 0;
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.ratel-typing-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--text-warning);
		animation: ratel-pulse 1.2s infinite;
		flex-shrink: 0;
	}

	@keyframes ratel-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-typing-dot { animation: none; }
	}

	/* 门禁提示 */
	.ratel-gate {
		font-size: 11px;
		color: var(--text-warning);
		margin-bottom: 8px;
	}

	.ratel-gate-hard { color: var(--text-error); }

	/* ==================== 工具调用(mockup: .tool-call) ==================== */
	.ratel-tools {
		margin-bottom: 6px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.ratel-tool {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		border-radius: 6px;
		background: var(--background-tertiary);
		font-size: 12px;
		color: var(--text-muted);
		font-family: var(--font-monospace);
	}

	.ratel-tool-done {
		color: var(--text-success);
	}

	.ratel-tool-failed {
		color: var(--text-error);
	}

	.ratel-tool-calling {
		color: var(--text-muted);
	}

	.ratel-tool-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--text-warning);
		animation: ratel-pulse 1.2s infinite;
		flex-shrink: 0;
	}

	.ratel-tool-icon {
		font-size: 11px;
		flex-shrink: 0;
		width: 10px;
		text-align: center;
	}

	.ratel-tool-name {
		font-weight: 600;
		flex-shrink: 0;
	}

	.ratel-tool-summary {
		color: inherit;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		opacity: 0.85;
	}

	.ratel-tool-err {
		color: var(--text-error);
		white-space: normal;
		opacity: 1;
	}

	/* ==================== 搜索结果 ==================== */
	.ratel-search {
		margin-bottom: 8px;
		padding: 8px 10px;
		border-radius: 6px;
		background: var(--background-tertiary);
		font-size: 12px;
	}

	.ratel-search-hdr {
		font-weight: 600;
		margin-bottom: 4px;
		color: var(--text-muted);
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.ratel-search-icon { font-size: 0.9em; }

	.ratel-search-badge {
		margin-left: 4px;
		padding: 1px 6px;
		border-radius: 8px;
		background: rgba(250, 204, 21, 0.12);
		color: var(--text-warning);
		font-size: 10px;
		font-weight: 500;
	}

	.ratel-search-row {
		display: flex;
		gap: 6px;
		align-items: center;
		padding: 2px 0;
	}

	.ratel-search-idx {
		font-family: var(--font-monospace);
		font-weight: 600;
		color: var(--text-muted);
		min-width: 24px;
		flex-shrink: 0;
	}

	.ratel-search-path {
		flex: 1;
		font-family: var(--font-monospace);
		font-size: 11px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-normal);
	}

	.ratel-search-score {
		font-family: var(--font-monospace);
		color: var(--text-faint);
		font-size: 10px;
		flex-shrink: 0;
	}

	/* ==================== 输入区(mockup: .input-area) ==================== */
	.ratel-input {
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
		border-top: 1px solid var(--background-modifier-border);
		padding: 10px 14px 14px;
		position: relative;
	}

	.ratel-slash-wrap {
		position: absolute;
		bottom: 100%;
		left: 14px;
		right: 14px;
		margin-bottom: 4px;
		z-index: 20;
	}

	.ratel-input-row {
		display: flex;
		align-items: flex-end;
		gap: 8px;
	}

	/* + 按钮(mockup: .attach-btn) */
	.ratel-plus-btn {
		width: 32px;
		height: 32px;
		flex-shrink: 0;
		border-radius: 6px;
		border: 1px solid var(--background-modifier-border);
		background: var(--background-secondary);
		color: var(--text-muted);
		font-size: 16px;
		line-height: 1;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		transition: color 0.15s;
		box-shadow: none;
		-webkit-appearance: none;
		appearance: none;
		font-family: inherit;
	}

	.ratel-plus-btn:hover {
		color: var(--text-normal);
	}

	.ratel-plus-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.ratel-input-row textarea {
		flex: 1;
		min-height: 54px;
		max-height: 160px;
		padding: 10px 12px;
		border-radius: 8px;
		border: 1px solid var(--background-modifier-border);
		background: var(--background-modifier-form-field);
		color: var(--text-normal);
		font-family: inherit;
		font-size: 13px;
		line-height: 1.5;
		resize: none;
		outline: none;
		transition: border-color 0.15s;
		overflow-y: auto;
	}

	.ratel-input-row textarea:focus {
		border-color: var(--interactive-accent);
	}

	.ratel-input-row textarea::placeholder {
		color: var(--text-faint);
	}

	.ratel-input-footer {
		display: flex;
		justify-content: flex-end;
		margin-top: 4px;
	}

	/* Send 按钮(mockup: .send-btn) */
	.ratel-send {
		padding: 6px 16px;
		border-radius: 6px;
		border: none;
		background: var(--interactive-accent);
		color: var(--text-on-accent);
		font-size: 12px;
		font-weight: 600;
		font-family: inherit;
		cursor: pointer;
		transition: opacity 0.15s;
		box-shadow: none;
		-webkit-appearance: none;
		appearance: none;
	}

	.ratel-send:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.ratel-stop {
		background: var(--text-error) !important;
		color: #fff !important;
	}
</style>
