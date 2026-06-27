<script lang="ts">
	/**
	 * @file src/ui/chat/ChatView.svelte
	 * @description Chat 编排层 — 状态持有 + 事件循环 + 子组件编排(~200 行)
	 * @module ui/chat/ChatView
	 * @depends main, ./message-stream/MessageList, ../status/StatusLine, ../status/StatusDrawer,
	 *          ./input/SlashMenu, ./input/AttachmentStrip, ../tokens/token-estimator
	 * 设计:Header 毛玻璃徽章 + 输入区毛玻璃 + 底部 Send 按钮精致圆角
	 */
	import type RatelVaultPlugin from '../../main';
	import { get } from 'svelte/store';
	import StatusLine from '../status/StatusLine.svelte';
	import StatusDrawer from '../status/StatusDrawer.svelte';
	import SlashMenu from './input/SlashMenu.svelte';
	import AttachmentStrip from './input/AttachmentStrip.svelte';
	import MessageList from './message-stream/MessageList.svelte';
	import type { Message } from './message-stream/types';
	import {
		appendText,
		appendThink,
		appendToolCall,
		attachToolResult,
		markToolFailed,
	} from './message-stream/segment-appender';
	import { filterCommands, type SlashCommand } from './input/slash-commands';
	import { validateAttachment, estimateImageTokens } from './input/attachment-utils';
	import { evaluateChatSendGate } from './chat-send-gate';
	import { hasChatApiKey } from '../../secrets/ratel-secrets';
	import { formatChatError } from './chat-error';
	import { showCompactConfirm } from './compact-confirm';
	import { devLogger } from '../../logging/dev-logger';
	import { formatToolDisplayName } from './format-tool-display';
	import { estimateTokens } from '../tokens/token-estimator';

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

	const statusStore = plugin.userStatus.statusBar$;
	const contextStore = plugin.userStatus.contextUsage$;
	const attachmentStore = plugin.userStatus.pendingAttachments$;

	let keyTick = $state(0);
	const hasKey = $derived.by(() => {
		keyTick;
		return hasChatApiKey(plugin.app, plugin.settings);
	});
	const gate = $derived.by(() => {
		keyTick;
		return evaluateChatSendGate(plugin.settings, $statusStore, { hasChatApiKey: hasKey });
	});
	const slashVisible = $derived.by(() => {
		const v = input.startsWith('/') && !input.includes(' ');
		if (!v) return false;
		return filterCommands(input).length > 0;
	});
	const modelName = $derived(plugin.settings.chatModel);

	// ==================== 工具函数 ====================
	function refreshKeyState() {
		plugin.rebuildLLM();
		keyTick++;
	}

	function handleAgentError(am: Message, code: string, message: string, toolName?: string) {
		if (code === 'CANCELLED') {
			am.cancelled = true;
			return;
		}
		// 关键路径:工具相关错误优先附到最近一个 calling 状态的同名工具段
		if (code === 'TOOL_ERROR' || code === 'TOOL_DENIED' || code === 'INDEX_NOT_READY') {
			if (toolName) {
				markToolFailed(am, toolName, message);
				return;
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
				plugin.userStatus.patchContextUsage({ usedTokens: 0, source: 'estimate' });
				plugin.userStatus.clearAttachments();
				break;
			case '/compact':
				handleCompact();
				break;
			case '/model':
				(plugin.app as unknown as { setting: { open: () => void } }).setting.open();
				break;
			case '/reindex':
				plugin.indexController.reindex().catch((err) => devLogger.error('index', '/reindex 失败', err));
				break;
		}
	}

	async function handleCompact() {
		const confirmed = await showCompactConfirm(plugin.app);
		if (!confirmed) return;
		messages = messages.slice(-2);
	}

	// ==================== 发送消息(含 token 三层校准) ====================
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

		// 关键路径:用 push + 从数组中取出 Proxy 引用,触发细粒度 DOM 更新
		messages.push({
			role: 'user' as const,
			segments: [{ type: 'text', text }],
			attachments: currentAttachments.length > 0 ? currentAttachments : undefined,
		});
		messages.push({ role: 'assistant' as const, segments: [] });
		const am = messages[messages.length - 1] as Message;

		input = '';
		isRunning = true;
		plugin.userStatus.patch({ model: 'checking' });
		const ac = new AbortController();
		let lastToolName: string | undefined;

		// 第 1 层:send 前精确估算(基于历史消息 segments)
		const baselineUsed = messages.reduce(
			(sum, m) =>
				sum +
				m.segments.reduce((s, seg) => {
					if (seg.type === 'text' || seg.type === 'think') return s + estimateTokens(seg.text);
					return s;
				}, 0),
			0,
		);
		const attachmentTokens = get(attachmentStore).reduce((s, a) => s + a.estimatedTokens, 0);
		plugin.userStatus.patchContextUsage({
			usedTokens: baselineUsed,
			maxTokens: plugin.settings.chatModelMaxTokens,
			attachmentTokens,
			source: 'estimate',
		});

		// 第 2 层:流式中累计 delta token
		let streamingUsed = 0;

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
						if (event.payload.reasoning) {
							appendThink(am, event.payload.reasoning);
							streamingUsed += estimateTokens(event.payload.reasoning);
						} else if (event.payload.text) {
							appendText(am, event.payload.text);
							streamingUsed += estimateTokens(event.payload.text);
						}
						// 第 2 层:流式中累计校准
						plugin.userStatus.patchContextUsage({
							usedTokens: baselineUsed + streamingUsed,
							source: 'streaming',
						});
						scrollToBottom();
						break;
					case 'tool.call':
						lastToolName = event.payload.name;
						appendToolCall(am, {
							name: event.payload.name,
							displayName: formatToolDisplayName(event.payload.name, event.payload.args),
							args: event.payload.args,
							status: 'calling',
							startAt: Date.now(),
						});
						scrollToBottom();
						break;
					case 'tool.result':
						attachToolResult(am, event.payload.name, event.payload.result);
						scrollToBottom();
						break;
					case 'search.result':
						am.searchResults = event.payload.results;
						am.searchReranked = event.payload.reranked;
						scrollToBottom();
						break;
					case 'message.end':
						// 第 3 层:API 真值校准(若 LLM 返回 usage)
						if (event.payload.promptTokens && event.payload.completionTokens) {
							am.tokenUsage = {
								promptTokens: event.payload.promptTokens,
								completionTokens: event.payload.completionTokens,
							};
							plugin.userStatus.patchContextUsage({
								usedTokens: event.payload.promptTokens + event.payload.completionTokens,
								source: 'api',
							});
						}
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
</script>

<div class="ratel-chat">
	<!-- Header — 标题 + 模型徽章(毛玻璃) -->
	<div class="ratel-header">
		<div class="ratel-header-left">
			<span class="ratel-header-logo">R</span>
			<span class="ratel-header-title">Ratel</span>
		</div>
		<span class="ratel-header-badge">{modelName}</span>
	</div>

	<!-- 消息流(委托 MessageList) -->
	<div class="ratel-messages-wrap" bind:this={messagesEl}>
		<MessageList {messages} {isRunning} />
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

	<!-- 输入区(毛玻璃) -->
	<div class="ratel-input">
		{#if gate.hardBlockReason}
			<div class="ratel-gate ratel-gate-hard">⚠ {gate.hardBlockReason}</div>
		{:else if gate.softHint}
			<div class="ratel-gate">ⓘ {gate.softHint}</div>
		{/if}

		<!-- 附件预览条 -->
		<AttachmentStrip
			pendingAttachments$={attachmentStore}
			onRemove={(id) => plugin.userStatus.removeAttachment(id)}
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
				<button class="ratel-send ratel-stop" onclick={stopGeneration} type="button">Stop</button>
			{:else}
				<button class="ratel-send" onclick={sendMessage} disabled={!input.trim() || !gate.canSend} type="button">Send</button>
			{/if}
		</div>
	</div>
</div>

<style>
	/*
	 * 设计 Token 映射:
	 * - 圆角 6-8px(符合设计系统上限)
	 * - 毛玻璃 backdrop-filter blur(8-10px)
	 * - 微阴影增强层次感(用户明确要求阴影)
	 * - 半透明背景 color-mix 适配亮/暗主题
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

	/* ==================== Header(毛玻璃 + 微阴影) ==================== */
	.ratel-header {
		flex-shrink: 0;
		padding: 10px 14px;
		border-bottom: 1px solid var(--background-modifier-border);
		display: flex;
		align-items: center;
		justify-content: space-between;
		background: color-mix(in srgb, var(--background-secondary) 65%, transparent);
		backdrop-filter: blur(10px);
		-webkit-backdrop-filter: blur(10px);
	}

	.ratel-header-left {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.ratel-header-logo {
		width: 22px;
		height: 22px;
		border-radius: 6px;
		background: color-mix(in srgb, var(--text-success) 20%, transparent);
		color: var(--text-success);
		font-size: 12px;
		font-weight: 700;
		display: flex;
		align-items: center;
		justify-content: center;
		font-family: var(--font-monospace);
		border: 1px solid color-mix(in srgb, var(--text-success) 30%, transparent);
	}

	.ratel-header-title {
		font-size: 13px;
		font-weight: 600;
		color: var(--text-normal);
		letter-spacing: 0.3px;
	}

	.ratel-header-badge {
		font-size: 11px;
		font-family: var(--font-monospace);
		padding: 2px 9px;
		border-radius: 12px;
		background: color-mix(in srgb, var(--text-success) 15%, transparent);
		color: var(--text-success);
		border: 1px solid color-mix(in srgb, var(--text-success) 20%, transparent);
		font-weight: 500;
		max-width: 180px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* ==================== 消息流容器 ==================== */
	.ratel-messages-wrap {
		flex: 1;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	/* ==================== 门禁提示 ==================== */
	.ratel-gate {
		font-size: 11px;
		color: var(--text-warning);
		margin-bottom: 8px;
		padding: 6px 10px;
		border-radius: 6px;
		background: color-mix(in srgb, var(--text-warning) 8%, transparent);
		border: 1px solid color-mix(in srgb, var(--text-warning) 15%, transparent);
	}

	.ratel-gate-hard {
		color: var(--text-error);
		background: color-mix(in srgb, var(--text-error) 8%, transparent);
		border-color: color-mix(in srgb, var(--text-error) 15%, transparent);
	}

	/* ==================== 输入区(毛玻璃) ==================== */
	.ratel-input {
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
		border-top: 1px solid var(--background-modifier-border);
		padding: 10px 14px 14px;
		position: relative;
		background: color-mix(in srgb, var(--background-secondary) 65%, transparent);
		backdrop-filter: blur(10px);
		-webkit-backdrop-filter: blur(10px);
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

	/* + 按钮(毛玻璃 + 微阴影) */
	.ratel-plus-btn {
		width: 32px;
		height: 32px;
		flex-shrink: 0;
		border-radius: 8px;
		border: 1px solid var(--background-modifier-border);
		background: color-mix(in srgb, var(--background-secondary) 70%, transparent);
		backdrop-filter: blur(6px);
		-webkit-backdrop-filter: blur(6px);
		color: var(--text-muted);
		font-size: 16px;
		line-height: 1;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		transition: color 0.15s, border-color 0.15s, background 0.15s;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
		-webkit-appearance: none;
		appearance: none;
		font-family: inherit;
	}

	.ratel-plus-btn:hover {
		color: var(--text-normal);
		border-color: var(--interactive-accent);
		background: color-mix(in srgb, var(--interactive-accent) 8%, var(--background-secondary));
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
		transition: border-color 0.15s, box-shadow 0.15s;
		overflow-y: auto;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04) inset;
	}

	.ratel-input-row textarea:focus {
		border-color: var(--interactive-accent);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--interactive-accent) 15%, transparent),
					0 1px 2px rgba(0, 0, 0, 0.04) inset;
	}

	.ratel-input-row textarea::placeholder {
		color: var(--text-faint);
	}

	.ratel-input-footer {
		display: flex;
		justify-content: flex-end;
		margin-top: 4px;
	}

	/* Send 按钮(产品绿背景 + 微阴影 + 悬停增强) */
	.ratel-send {
		padding: 7px 18px;
		border-radius: 8px;
		border: none;
		background: var(--text-success);
		color: var(--background-primary);
		font-size: 12px;
		font-weight: 600;
		font-family: inherit;
		cursor: pointer;
		transition: opacity 0.15s, box-shadow 0.15s, transform 0.1s;
		box-shadow: 0 1px 3px color-mix(in srgb, var(--text-success) 30%, transparent),
					0 1px 2px rgba(0, 0, 0, 0.08);
		-webkit-appearance: none;
		appearance: none;
		letter-spacing: 0.3px;
	}

	.ratel-send:hover:not(:disabled) {
		box-shadow: 0 2px 6px color-mix(in srgb, var(--text-success) 40%, transparent),
					0 1px 3px rgba(0, 0, 0, 0.1);
	}

	.ratel-send:active:not(:disabled) {
		transform: translateY(1px);
	}

	.ratel-send:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.ratel-stop {
		background: var(--text-error) !important;
		color: #fff !important;
		box-shadow: 0 1px 3px color-mix(in srgb, var(--text-error) 30%, transparent),
					0 1px 2px rgba(0, 0, 0, 0.08) !important;
	}

	.ratel-stop:hover:not(:disabled) {
		box-shadow: 0 2px 6px color-mix(in srgb, var(--text-error) 40%, transparent),
					0 1px 3px rgba(0, 0, 0, 0.1) !important;
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-plus-btn,
		.ratel-input-row textarea,
		.ratel-send {
			transition: none;
		}
		.ratel-send:active:not(:disabled) {
			transform: none;
		}
	}
</style>
