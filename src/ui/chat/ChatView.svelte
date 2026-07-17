<script lang="ts">
	/**
	 * @file src/ui/chat/ChatView.svelte
	 * @description Chat 编排层 — 状态持有 + 事件循环 + 子组件编排(~200 行)
	 * @module ui/chat/ChatView
	 * @depends main, ./message-stream/MessageList, ../status/StatusLine, ../status/StatusDrawer,
	 *          ./input/SlashMenu, ./input/MentionMenu, ./input/MentionStrip, ./input/AttachmentStrip,
	 *          ../tokens/token-estimator
	 * 设计:Conversation-first — Header(brand+model chip) → Messages → composer(Strip→Drawer→input)
	 */
	import type RatelVaultPlugin from '../../main';
	import { get } from 'svelte/store';
	import { onMount, onDestroy } from 'svelte';
	import StatusLine from '../status/StatusLine.svelte';
	import StatusDrawer from '../status/StatusDrawer.svelte';
	import SlashMenu from './input/SlashMenu.svelte';
	import MentionMenu from './input/MentionMenu.svelte';
	import MentionStrip from './input/MentionStrip.svelte';
	import AttachmentStrip from './input/AttachmentStrip.svelte';
	import MessageList from './message-stream/MessageList.svelte';
	import type { Message } from './message-stream/types';
	import { preservedChatMessagesToUi } from './message-stream/chat-message-to-ui';
	import {
		appendText,
		appendThink,
		appendToolCall,
		attachToolResult,
		markToolFailed,
	} from './message-stream/segment-appender';
	import { filterCommands, type SlashCommand } from './input/slash-commands';
	import {
		extractMentions,
		formatMentionToken,
		isSafeVaultMentionPath,
		parseActiveMentionQuery,
	} from './input/mention-parser';
	import { suggestMentions } from './input/mention-suggest';
	import { validateAttachment, estimateImageTokens } from './input/attachment-utils';
	import { evaluateChatSendGate } from './chat-send-gate';
	import { hasChatApiKey } from '../../secrets/ratel-secrets';
	import { formatChatError } from './chat-error';
	import { showCompactConfirm } from './compact-confirm';
	import { compactSession } from './compact-session';
	import { ModelInfoModal } from './model-info-modal';
	import { openChatNote } from './open-chat-note';
	import { Notice } from 'obsidian';
	import { devLogger } from '../../logging/dev-logger';
	import { formatToolDisplayName } from './format-tool-display';
	import { estimateTokens } from '../tokens/token-estimator';
	import { getEffectiveChatModelMaxTokens } from '../../utils/context-window';
	import { t, tNow } from '../../i18n';
	import { applyRatelAppearance } from '../appearance/apply-ratel-appearance';
	import { appearanceRevision } from '../appearance/appearance-store';

	let { plugin }: { plugin: RatelVaultPlugin } = $props();

	// ==================== 外观热更新 ====================
	let chatRoot: HTMLElement | undefined;
	let appearanceUnsub: (() => void) | undefined;

	/** 把当前 settings 外观写到 Chat 根节点。 */
	function syncAppearance() {
		if (!chatRoot) return;
		applyRatelAppearance(chatRoot, {
			uiColorScheme: plugin.settings.uiColorScheme,
			uiAccent: plugin.settings.uiAccent,
		});
	}

	onMount(() => {
		syncAppearance();
		// 关键路径:subscribe 立即回调一次(与 onMount sync 重复无害);后续 bump 触发热更新。
		appearanceUnsub = appearanceRevision.subscribe(() => syncAppearance());
	});
	onDestroy(() => appearanceUnsub?.());

	// ==================== 响应式状态 ====================
	let messages = $state<Message[]>([]);
	let input = $state('');
	let isRunning = $state(false);
	let sessionId = $state('session-' + Date.now());
	let drawerExpanded = $state(false);
	let fileInput = $state<HTMLInputElement | null>(null);
	let slashMenuEl = $state<{ handleKeydown: (e: KeyboardEvent) => boolean } | null>(null);
	let mentionMenuEl = $state<{ handleKeydown: (e: KeyboardEvent) => boolean } | null>(null);
	let textareaEl = $state<HTMLTextAreaElement | null>(null);
	let mentionPaths = $state<string[]>([]);
	let mentionQuery = $state<string | null>(null);
	let mentionItems = $state<string[]>([]);
	let messagesEl = $state<HTMLDivElement | null>(null);
	// 关键路径:sticky-to-bottom — 用户主动上滑时暂停自动滚动,流式输出不打断浏览历史
	let isUserNearBottom = $state(true);
	const SCROLL_NEAR_BOTTOM_THRESHOLD = 80;
	// 关键路径:/compact 压缩进行中标志,控制 loading hint 显示
	let isCompacting = $state(false);

	// 关键路径:sticky-to-bottom — 用户主动上滑时尊重浏览历史,只在用户处于底部时自动滚动
	const scrollToBottom = () => {
		if (!isUserNearBottom) return;
		requestAnimationFrame(() => {
			if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
		});
	};

	// 关键路径:onscroll 监听内层 .ratel-messages 的滚动,更新 isUserNearBottom
	function handleScroll(el: HTMLDivElement) {
		isUserNearBottom =
			el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_NEAR_BOTTOM_THRESHOLD;
	}

	/** 芯片 / 正文 `[n]` 共用打开入口 — 函数体内读 plugin,避免模板闭包捕获初值 */
	function handleOpenPath(path: string): void {
		void openChatNote(plugin.app, path);
	}

	function openModelInfo(): void {
		new ModelInfoModal(plugin.app, plugin).open();
	}

	function removePendingAttachment(id: string): void {
		plugin.userStatus.removeAttachment(id);
	}

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
	// 关键路径:/ 与 @ 互斥 — 斜杠优先;mention 补全仅在非 slash 态
	const mentionVisible = $derived(mentionQuery !== null && !slashVisible);
	const modelName = $derived(plugin.settings.chatModel);

	// 关键路径:原 work-bar 文案合并进 StatusStrip — 优先级从上到下,同时满足只取第一个
	// 关键路径:indexing 分支不解析 indexDetail(progressing 状态是文件名,queueing 是 i18n 文字,
	// 格式不统一)。进度数字由 StatusDrawer 进度条承担,Strip 只显示笼统的"索引中..."
	const workBar = $derived.by(() => {
		const s = $statusStore;
		// 阻塞提示优先单独显示(hard gate 时 Send 仍禁用)
		if (gate.hardBlockReason) return { type: 'hard' as const, text: gate.hardBlockReason };
		// 索引中(processing/scanning/queueing/diffing 四种状态,统一显示"索引中...")
		if (s.index === 'processing' || s.index === 'scanning' || s.index === 'queueing' || s.index === 'diffing') {
			return { type: 'indexing' as const, text: $t('chat.workbar.indexing') };
		}
		// 模型下载中(真在下模型时仍提示,即使对话中)
		if (s.model === 'downloading') {
			return { type: 'downloading' as const, text: $t('chat.workbar.downloading') };
		}
		// 对话进行中:只留 MessageList 打字指示 + Stop,避免再叠「准备模型/搜索中」
		if (isRunning) {
			return null;
		}
		// 模型初始化中(空闲时才显示,避免与对话指示抢戏)
		if (s.model === 'checking' || s.model === 'initializing') {
			return { type: 'preparing' as const, text: $t('chat.workbar.preparing') };
		}
		if (isCompacting) {
			return { type: 'compacting' as const, text: $t('chat.workbar.compacting') };
		}
		return null;
	});
	// 关键路径:busyOverride 喂给 StatusLine,替代独立黄条 DOM
	const busyOverride = $derived(workBar ? workBar.text : null);

	// 关键路径:chatModelMaxTokens 由设置面板预设/自定义配置,见 ADR-007。
	$effect(() => {
		plugin.userStatus.patchContextUsage({
			maxTokens: getEffectiveChatModelMaxTokens(plugin.settings),
		});
	});

	// ==================== 工具函数 ====================
	function refreshKeyState() {
		plugin.rebuildLLM();
		keyTick++;
	}

	/** 转义正则特殊字符 — 用于从 input 删除 @path */
	function escapeRegExp(s: string): string {
		return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	/**
	 * 根据光标前文本刷新 mention 查询态。
	 */
	function syncMentionQueryFromCursor() {
		if (slashVisible || !textareaEl) {
			mentionQuery = null;
			return;
		}
		const before = input.slice(0, textareaEl.selectionStart);
		mentionQuery = parseActiveMentionQuery(before);
	}

	/**
	 * 插入 @mention(策略 A:只写路径字面量)。
	 * 供菜单选中与 main.ts file-menu 调用。
	 */
	export function insertMention(path: string) {
		if (!isSafeVaultMentionPath(path)) {
			new Notice(tNow('chat.mention.absoluteRejected'), 4000);
			return;
		}
		if (!mentionPaths.includes(path)) {
			mentionPaths = [...mentionPaths, path];
		}
		const token = formatMentionToken(path);
		if (textareaEl && mentionQuery !== null) {
			const start = textareaEl.selectionStart;
			const before = input.slice(0, start);
			const at = before.lastIndexOf('@');
			if (at >= 0) {
				const afterCursor = input.slice(start);
				input = before.slice(0, at) + token + afterCursor;
				requestAnimationFrame(() => {
					if (!textareaEl) return;
					const pos = at + token.length;
					textareaEl.focus();
					textareaEl.setSelectionRange(pos, pos);
				});
			} else {
				input = `${input}${token}`;
			}
		} else {
			const sep = !input || /[\s\n]$/.test(input) ? '' : ' ';
			input = `${input}${sep}${token}`;
		}
		mentionQuery = null;
		mentionItems = [];
	}

	function removeMention(path: string) {
		mentionPaths = mentionPaths.filter((p) => p !== path);
		const re = new RegExp(`@${escapeRegExp(path)}(\\s)?`, 'g');
		input = input.replace(re, '').replace(/ {2,}/g, ' ');
	}

	/**
	 * 从 textarea 文本重建 chip — 手动删掉 @path 时 strip 同步消失。
	 */
	function syncMentionPathsFromInput() {
		mentionPaths = extractMentions(input).filter(isSafeVaultMentionPath);
	}

	// 性能:debounce ≥80ms;只扫 path 列表,零 readFile
	$effect(() => {
		const q = mentionQuery;
		if (q === null || slashVisible) {
			mentionItems = [];
			return;
		}
		const timer = setTimeout(() => {
			const paths = plugin.app.vault.getMarkdownFiles().map((f) => f.path);
			mentionItems = suggestMentions(q, paths);
		}, 80);
		return () => clearTimeout(timer);
	});

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
				mentionPaths = [];
				plugin.userStatus.patchContextUsage({
					usedTokens: 0,
					maxTokens: getEffectiveChatModelMaxTokens(plugin.settings),
					source: 'estimate',
				});
				plugin.userStatus.clearAttachments();
				break;
			case '/compact':
				handleCompact();
				break;
			case '/model':
				new ModelInfoModal(plugin.app, plugin).open();
				break;
			case '/reindex':
				plugin.indexController.reindex().catch((err) => devLogger.error('index', '/reindex 失败', err));
				break;
		}
	}

	async function handleCompact() {
		// 关键路径:防止用户从 slash 命令 + StatusDrawer 按钮双重触发,避免并发 resetSession
		if (isCompacting) return;
		const confirmed = await showCompactConfirm(plugin.app);
		if (!confirmed) return;

		// 关键路径:显示压缩中 loading
		isCompacting = true;

		try {
			// 关键路径:每次 /compact 创建独立 ctx,与 agent-loop 解耦
			const ctx = plugin.createContext();
			const result = await compactSession(
				ctx,
				plugin.llm,
				sessionId,
				plugin.settings.promptOverrides,
			);
			// 更新 Svelte state — ChatMessage[] 转回 UI Message[]
			messages = preservedChatMessagesToUi(result.preservedMessages);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// 关键路径:压缩失败,session 未重置(LLM 抛错时 resetSession 不会被调)
			new Notice(tNow('chat.error.compactFailed', { message }), 5000);
		} finally {
			isCompacting = false;
		}
	}

	// ==================== 发送消息(含 token 三层校准) ====================
	async function sendMessage() {
		refreshKeyState();
		const text = input.trim();
		if (!text || isRunning || isCompacting) return;

		// 策略 A:发送文本以 textarea 为准(含 @path 字面量);extractMentions 仅开发日志,零 readFile
		const mentioned = extractMentions(text).filter(isSafeVaultMentionPath);
		if (mentioned.length > 0) {
			devLogger.info('agent', `@mention 发送路径: ${mentioned.join(', ')}`);
		}

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
		mentionPaths = [];
		mentionQuery = null;
		mentionItems = [];
		isRunning = true;
		// 关键路径:不在此 patch model=checking — 否则 StatusStrip「思考中」
		// 与 MessageList 打字指示双重叠;model 状态只由 FeedbackController 维护。
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
		const maxTokens = getEffectiveChatModelMaxTokens(plugin.settings);
		plugin.userStatus.patchContextUsage({
			usedTokens: baselineUsed,
			maxTokens,
			attachmentTokens,
			source: 'estimate',
		});

		// 第 2 层:流式中累计 delta token
		let streamingUsed = 0;

		// 关键路径:用户发新消息,强制滚到底(忽略之前的手动上滑)
		isUserNearBottom = true;
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
							maxTokens,
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
								maxTokens,
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
		if (mentionVisible && mentionMenuEl) {
			if (mentionMenuEl.handleKeydown(e)) return;
		}
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

	function handleInput() {
		syncMentionQueryFromCursor();
		syncMentionPathsFromInput();
	}

	function handleSelect() {
		syncMentionQueryFromCursor();
	}

	/**
	 * 整段粘贴绝对路径时拦截 — 避免 @Users/... 假相对路径进对话。
	 */
	function handlePaste(e: ClipboardEvent) {
		const raw = (e.clipboardData?.getData('text') ?? '').trim();
		if (!raw || raw.includes('\n')) return;
		const candidate = raw.replace(/^@/, '');
		const looksAbsolute =
			candidate.startsWith('/') ||
			/^[A-Za-z]:[/\\]/.test(candidate) ||
			/^(Users|home|private|var|tmp)\//i.test(candidate);
		if (looksAbsolute && !isSafeVaultMentionPath(candidate)) {
			e.preventDefault();
			new Notice(tNow('chat.mention.absoluteRejected'), 4000);
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
			input = tNow('chat.error.attachmentInvalid', { reason: vr.reason });
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

<div class="ratel-chat" bind:this={chatRoot}>
	<!-- Header — 词标 + 副标同行(原型 brand baseline) + 静默 model chip -->
	<div class="ratel-header">
		<div class="ratel-header-left">
			<div class="ratel-header-brand">
				<span class="ratel-header-mark"
					>{$t('chat.header.title')}<span class="ratel-header-dot" aria-hidden="true">.</span></span
				>
				<span class="ratel-header-tagline">{$t('chat.header.tagline')}</span>
			</div>
		</div>
		<div class="ratel-header-right">
			<button
				type="button"
				class="ratel-header-model"
				onclick={openModelInfo}
				aria-label={$t('chat.header.modelChip', { model: modelName })}
			>{modelName}</button>
		</div>
	</div>

	<!-- 消息流(委托 MessageList,容器 ref + onscroll 由子组件透传上来) -->
	<div class="ratel-messages-wrap">
		<MessageList
			{messages}
			{isRunning}
			bind:containerRef={messagesEl}
			onScroll={handleScroll}
			onOpenPath={handleOpenPath}
		/>
	</div>

	<!-- composer: Strip → Drawer → input(Conversation-first,状态不夹在消息与输入之间) -->
	<div class="ratel-composer">
		<StatusLine
			status$={statusStore}
			contextUsage$={contextStore}
			expanded={drawerExpanded}
			chatBusy={isRunning}
			busyOverride={busyOverride}
			busyHard={workBar?.type === 'hard'}
			onToggle={() => (drawerExpanded = !drawerExpanded)}
		/>
		<StatusDrawer
			expanded={drawerExpanded}
			status$={statusStore}
			contextUsage$={contextStore}
			embedKind={plugin.settings.embedProvider}
			onCompact={handleCompact}
		/>
		<div class="ratel-input">
			<!-- 附件预览条 -->
			<AttachmentStrip
				pendingAttachments$={attachmentStore}
				onRemove={removePendingAttachment}
			/>

			<!-- @mention chip 条 -->
			<MentionStrip paths={mentionPaths} onRemove={removeMention} />

			<!--
				浮层相对一体壳顶边定位(§5.6):wrap 套住 shell,
				slash/mention 的 bottom:100% 贴壳顶,而非整块 .ratel-input(含 strips)。
			-->
			<div class="ratel-input-shell-wrap">
				{#if mentionVisible}
					<div class="ratel-slash-wrap">
						<MentionMenu
							bind:this={mentionMenuEl}
							items={mentionItems}
							onSelect={insertMention}
							onClose={() => {
								mentionQuery = null;
								mentionItems = [];
							}}
						/>
					</div>
				{/if}

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

				<div
					class="ratel-input-shell"
					class:ratel-input-shell--disabled={isRunning || isCompacting || !gate.canSend}
				>
					<button class="ratel-plus-btn" type="button" onclick={triggerFileInput} aria-label={$t('chat.input.addImage')} disabled={isRunning}>+</button>
					<input bind:this={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onchange={handleFileSelect} style="display:none;" />
					<textarea
						bind:this={textareaEl}
						bind:value={input}
						onkeydown={handleKeydown}
						oninput={handleInput}
						onselect={handleSelect}
						onkeyup={handleSelect}
						onpaste={handlePaste}
						onfocus={refreshKeyState}
						placeholder={$t('chat.input.placeholder')}
						disabled={isRunning || isCompacting || !gate.canSend}
						rows={1}
					></textarea>
					{#if isRunning}
						<button class="ratel-send ratel-stop" onclick={stopGeneration} type="button">{$t('chat.input.stop')}</button>
					{:else}
						<button class="ratel-send" onclick={sendMessage} disabled={!input.trim() || !gate.canSend} type="button">{$t('chat.input.send')}</button>
					{/if}
				</div>
			</div>
		</div>
	</div>
</div>

<style>
	/*
	 * 设计 Token 映射:
	 * - 圆角 6-8px(符合设计系统上限,严禁超过 8px)
	 * - 毛玻璃 backdrop-filter blur(8-10px)
	 * - 视觉层次靠 border + background 对比度,不使用 box-shadow(项目硬约束禁止)
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
		/* Drawer 上下文 meter 渐变端点 — StatusDrawer 消费 */
		--ratel-meter-from: var(--interactive-accent);
		--ratel-meter-to: var(--text-success);
		/* 正文 [n] / cite-chip 共用(§5.10) */
		--ratel-cite: var(--interactive-accent);
	}

	/* ==================== Header — 对齐原型 v3:词标同行 + 胶囊 chip ==================== */
	.ratel-header {
		flex-shrink: 0;
		padding: 14px 16px 12px;
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
		min-width: 0;
	}

	.ratel-header-right {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
	}

	/* 关键路径:原型 brand 用 baseline 横排,不是上下堆叠 */
	.ratel-header-brand {
		display: flex;
		align-items: baseline;
		gap: 8px;
		min-width: 0;
	}

	.ratel-header-mark {
		font-size: 15px;
		font-weight: 650;
		letter-spacing: -0.02em;
		color: var(--text-normal);
		flex-shrink: 0;
	}

	.ratel-header-dot {
		color: var(--ratel-cite, var(--interactive-accent));
	}

	.ratel-header-tagline {
		font-size: 11px;
		font-weight: 450;
		color: var(--text-faint, var(--text-muted));
		letter-spacing: 0.01em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ratel-header-model {
		font-size: 10.5px;
		font-family: var(--font-monospace);
		font-weight: 500;
		padding: 4px 9px;
		border-radius: 999px;
		border: 1px solid var(--background-modifier-border);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		max-width: 160px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		transition: border-color 0.15s, color 0.15s;
	}

	.ratel-header-model:hover {
		color: var(--ratel-cite, var(--interactive-accent));
		border-color: color-mix(in srgb, var(--ratel-cite, var(--interactive-accent)) 55%, var(--background-modifier-border));
	}

	/* ==================== 消息流容器 ==================== */
	.ratel-messages-wrap {
		flex: 1;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	/* ==================== composer(Strip → Drawer → input) ==================== */
	.ratel-composer {
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		border-top: 1px solid var(--background-modifier-border);
	}

	/* ==================== 输入区(毛玻璃;顶边由 composer 承担,避免双线) ==================== */
	.ratel-input {
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px 14px 14px;
		background: color-mix(in srgb, var(--background-secondary) 65%, transparent);
		backdrop-filter: blur(10px);
		-webkit-backdrop-filter: blur(10px);
	}

	/* 关键路径:相对定位锚点仅包一体壳,浮层 bottom:100% 贴壳顶(§5.6) */
	.ratel-input-shell-wrap {
		position: relative;
	}

	.ratel-slash-wrap {
		position: absolute;
		bottom: 100%;
		left: 0;
		right: 0;
		margin-bottom: 4px;
		z-index: 20;
	}

	/*
	 * 一体输入壳 — + / textarea / Send 同框(spec §5.9)。
	 * 关键路径:边框与 focus ring 只画在壳上,子控件去边框,避免「三块拼盘」。
	 */
	.ratel-input-shell {
		display: flex;
		align-items: flex-end;
		gap: 6px;
		padding: 8px;
		border-radius: 12px;
		border: 1px solid var(--background-modifier-border);
		background: var(--background-modifier-form-field);
		transition: border-color 0.15s, outline-color 0.15s;
	}

	.ratel-input-shell:focus-within {
		border-color: var(--interactive-accent);
		/* 项目禁止 box-shadow;用 outline 做 soft ring */
		outline: 2px solid color-mix(in srgb, var(--interactive-accent) 28%, transparent);
		outline-offset: 0;
	}

	.ratel-input-shell--disabled {
		opacity: 0.85;
	}

	.ratel-plus-btn {
		width: 32px;
		height: 32px;
		flex-shrink: 0;
		border-radius: 8px;
		border: none;
		background: transparent;
		color: var(--text-muted);
		font-size: 18px;
		line-height: 1;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		transition: color 0.15s, background 0.15s;
		-webkit-appearance: none;
		appearance: none;
		font-family: inherit;
	}

	.ratel-plus-btn:hover:not(:disabled) {
		color: var(--text-normal);
		background: color-mix(in srgb, var(--interactive-accent) 10%, transparent);
	}

	.ratel-plus-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.ratel-input-shell textarea {
		flex: 1;
		min-width: 0;
		min-height: 54px;
		max-height: 160px;
		padding: 8px 4px;
		border: none;
		border-radius: 0;
		background: transparent;
		color: var(--text-normal);
		font-family: inherit;
		font-size: 13px;
		line-height: 1.5;
		resize: none;
		outline: none;
		overflow-y: auto;
		box-shadow: none;
		-webkit-appearance: none;
		appearance: none;
	}

	.ratel-input-shell textarea::placeholder {
		color: var(--text-faint);
	}

	/* Send 在壳内右侧 — 必须走强调色,否则外观 Tab 色块切换时最醒目按钮仍钉死成功绿 */
	.ratel-send {
		flex-shrink: 0;
		align-self: flex-end;
		padding: 7px 14px;
		border-radius: 8px;
		border: none;
		background: var(--interactive-accent);
		color: var(--text-on-accent, #fff);
		font-size: 12px;
		font-weight: 600;
		font-family: inherit;
		cursor: pointer;
		transition: opacity 0.15s, transform 0.1s;
		-webkit-appearance: none;
		appearance: none;
		letter-spacing: 0.3px;
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
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-plus-btn,
		.ratel-input-shell,
		.ratel-send {
			transition: none;
		}
		.ratel-send:active:not(:disabled) {
			transform: none;
		}
	}
</style>
