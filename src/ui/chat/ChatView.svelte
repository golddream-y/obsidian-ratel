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
	import { onMount, onDestroy, tick } from 'svelte';
	import StatusLine from '../status/StatusLine.svelte';
	import StatusDrawer from '../status/StatusDrawer.svelte';
	import SlashMenu from './input/SlashMenu.svelte';
	import MentionMenu from './input/MentionMenu.svelte';
	import MentionStrip from './input/MentionStrip.svelte';
	import AttachmentStrip from './input/AttachmentStrip.svelte';
	import MessageList from './message-stream/MessageList.svelte';
	import type { Message } from './message-stream/types';
	import { newMessageId } from './message-stream/new-message-id';
	import { hydrateSessionMessages } from './message-stream/hydrate-session-messages';
	import { latestCiteSearchResults } from './latest-cite-search';
	import ChatNavRail from './nav/ChatNavRail.svelte';
	import {
		CHAT_NAV_TICK_CAP,
		extractUserAnchors,
		needsRail,
		thinAnchors,
		thumbRatio,
	} from './nav/chat-nav-rail';
	import SessionMenu from './session/SessionMenu.svelte';
	import { sessionHasContent } from './session/session-content';
	import {
		SESSION_ENTER_MS,
		SESSION_EXIT_MS,
		loadingPadMs,
		prefersReducedMotion,
	} from './session/session-transition';
	import {
		deriveShortTitle,
		fallbackSessionTitle,
		generateSessionTitles,
		isFallbackDerivedTitle,
		normalizeTitlePair,
	} from './session/session-title';
	import { showSessionRenameModal } from './session/session-rename-modal';
	import { showSessionSwitchConfirm } from './session/session-switch-confirm';
	import type { SessionIndexEntry } from '../../ports/persistence';
	import { t, tNow, type StringKey } from '../../i18n';
	import type { ToolPermissionLevel } from '../../core/tool-permissions';
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
	import { compactSession } from './compact-session';
	import { loadSessionContextUsage } from './session-context-usage';
	import { decidePostTurnCompact, decidePreSendCompact } from './compact-auto';
	import { CompactCircuitBreaker } from '../../core/compact-project';
	import { ModelInfoModal } from './model-info-modal';
	import { FeedbackModal } from './feedback-modal';
	import { openSponsorPage } from './sponsor-links';
	import { openChatNote } from './open-chat-note';
	import { Notice } from 'obsidian';
	import { devLogger } from '../../logging/dev-logger';
	import { formatToolDisplayName } from './format-tool-display';
	import { estimateMessagesTokens, estimateTokens } from '../tokens/token-estimator';
	import { getEffectiveChatModelMaxTokens } from '../../utils/context-window';
	import { applyRatelAppearance } from '../appearance/apply-ratel-appearance';
	import { appearanceRevision } from '../appearance/appearance-store';
	import { settings$ as settingsStore } from '../settings-store';
	import TitleDissolve from '../motion/title/TitleDissolve.svelte';
	import EchoText from '../motion/title/EchoText.svelte';
	import ClickSpark from '../motion/brand/ClickSpark.svelte';
	import GlareHover from '../motion/chrome/GlareHover.svelte';
	import OrbBackdrop from '../motion/empty/OrbBackdrop.svelte';
	import { isChatMotionEnabled } from '../motion/prefs';
	import { isNearBottom, snapScrollToBottom } from './sticky-scroll';
	import { FrameCoalescer } from './frame-coalescer';

	let { plugin }: { plugin: RatelVaultPlugin } = $props();

	/** 自动压缩断路器 — 模块级单例,进程内连续失败计数 */
	const compactCircuit = new CompactCircuitBreaker();

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
		void bootstrapSession();
		const onDocClick = (e: MouseEvent) => {
			if (!sessionMenuOpen) return;
			const t = e.target as Node | null;
			if (!t) return;
			// 关键路径:用 DOM 查询,避免 onMount 闭包未捕获到后声明的 \$state 绑定
			const float = chatRoot?.querySelector('.ratel-session-menu-float');
			if (historyBtnEl?.contains(t) || (float instanceof Node && float.contains(t))) return;
			sessionMenuOpen = false;
		};
		document.addEventListener('click', onDocClick);
		return () => document.removeEventListener('click', onDocClick);
	});
	onDestroy(() => {
		appearanceUnsub?.();
		if (navFlashTimer) clearTimeout(navFlashTimer);
		layoutFrame.cancel();
		void flushCurrentSession();
	});

	// ==================== 响应式状态 ====================
	let messages = $state<Message[]>([]);
	let input = $state('');

	// 关键路径:空态背景要改 Obsidian leaf 底色，用 class 代替 :has（商店 CSS lint 会警告 :has）
	$effect(() => {
		const leaf = chatRoot?.closest('.workspace-leaf-content');
		if (!leaf) return;
		leaf.classList.toggle('is-ratel-empty', messages.length === 0);
		return () => leaf.classList.remove('is-ratel-empty');
	});
	let isRunning = $state(false);
	let sessionId = $state('');
	let sessionShortTitle = $state('');
	let sessionFullTitle = $state('');
	/** 标题落定动效令牌 — maybeGenerateTitle / 手改成功后递增 */
	let titleMotionToken = $state(0);
	/** 发完第一句：顶栏 Logo Echo 入场 */
	let echoEnterToken = $state(0);
	let sessionEntries = $state<SessionIndexEntry[]>([]);
	let sessionMenuOpen = $state(false);
	let sessionMenuFloatEl = $state<HTMLDivElement | null>(null);
	let historyBtnEl = $state<HTMLButtonElement | null>(null);
	let switching = $state(false);
	let sessionLoading = $state(false);
	let sessionLoadingLabel = $state('');
	let sessionLoadingId = $state<string | null>(null);
	let messagesAnimClass = $state('');
	let sessionDirty = $state(false);
	let titleAbort: AbortController | null = null;
	let abortController: AbortController | null = null;
	let drawerExpanded = $state(false);
	let fileInput = $state<HTMLInputElement | null>(null);
	let slashMenuEl = $state<{ handleKeydown: (e: KeyboardEvent) => boolean } | null>(null);
	let mentionMenuEl = $state<{ handleKeydown: (e: KeyboardEvent) => boolean } | null>(null);
	let textareaEl = $state<HTMLTextAreaElement | null>(null);
	let sendSparkTick = $state(0);
	let mentionPaths = $state<string[]>([]);
	let mentionQuery = $state<string | null>(null);
	let mentionItems = $state<string[]>([]);
	let messagesEl = $state<HTMLDivElement | null>(null);
	// 关键路径:sticky-to-bottom — 用户主动上滑时暂停自动滚动,流式输出不打断浏览历史
	let isUserNearBottom = $state(true);
	const SCROLL_NEAR_BOTTOM_THRESHOLD = 80;
	// 关键路径:合帧器 — 贴底写入与进度轨度量共用同一帧,流式期间每帧最多一次布局
	let wantsBottomScroll = false;
	const layoutFrame = new FrameCoalescer(() => {
		// 关键路径:先捕获并复位标志,el 未挂载提前 return 时也不残留到下一帧
		const shouldScroll = wantsBottomScroll;
		wantsBottomScroll = false;
		const el = messagesEl;
		if (!el) return;
		if (shouldScroll && isUserNearBottom) snapScrollToBottom(el);
		updateNavMetrics(el);
	});
	// 关键路径:/compact 压缩进行中标志,控制 loading hint 显示
	let isCompacting = $state(false);

	// ==================== 对话进度轨 ====================
	let navHighlightId = $state<string | null>(null);
	/** 虚拟跳转请求 — 目标消息可能未挂载,委托 MessageList 按布局偏移定位 */
	let navJumpRequest = $state<import('./message-stream/render-unit-projector').VirtualJumpRequest | null>(null);
	let navJumpToken = 0;
	let navRatio = $state(0);
	let railVisible = $state(false);
	/** 会话内最近一次 search_vault 结果 — 跟进回合 [n] 仍可点 */
	let lastCiteSearchResults = $state<Message['searchResults'] | null>(null);
	let navFlashTimer: ReturnType<typeof setTimeout> | null = null;

	const navEnabled = $derived($settingsStore.chatNavRailEnabled !== false);
	const rawAnchors = $derived(
		extractUserAnchors(
			messages.filter((m) => !!m.id) as Array<{
				id: string;
				role: string;
				segments: Message['segments'];
			}>,
		),
	);
	// 首版 visibleId 用跳转高亮 id；无高亮时 thin 仍保首尾
	const navAnchorsThinned = $derived(
		thinAnchors(rawAnchors, navHighlightId, CHAT_NAV_TICK_CAP),
	);

	// 关键路径:sticky-to-bottom — 用户主动上滑时尊重浏览历史,只在用户处于底部时自动滚动
	const scrollToBottom = () => {
		if (!isUserNearBottom) return;
		wantsBottomScroll = true;
		layoutFrame.request();
	};

	/** 根据滚动容器度量更新轨显隐与拇指比例。 */
	function updateNavMetrics(el: HTMLDivElement) {
		railVisible = navEnabled && needsRail(el.scrollHeight, el.clientHeight);
		navRatio = thumbRatio(el.scrollTop, el.scrollHeight, el.clientHeight);
	}

	// 关键路径:onscroll 监听内层 .ratel-messages 的滚动,更新 isUserNearBottom + 进度轨
	function handleScroll(el: HTMLDivElement) {
		isUserNearBottom = isNearBottom(
			el.scrollTop,
			el.scrollHeight,
			el.clientHeight,
			SCROLL_NEAR_BOTTOM_THRESHOLD,
		);
		updateNavMetrics(el);
	}

	/** 回底：恢复 sticky 并滚到最新。 */
	function forceScrollToBottom() {
		isUserNearBottom = true;
		wantsBottomScroll = true;
		layoutFrame.request();
	}

	/** 拖拇指：按比例设置 scrollTop。 */
	function seekByRatio(r: number) {
		if (!messagesEl) return;
		const max = messagesEl.scrollHeight - messagesEl.clientHeight;
		if (max <= 0) return;
		messagesEl.scrollTop = Math.min(1, Math.max(0, r)) * max;
	}

	/** 点刻度：请求虚拟跳转到对应消息并短暂高亮。 */
	function jumpToMessage(id: string) {
		// 离开贴底，避免流式 scrollToBottom 把用户拽回底部
		isUserNearBottom = false;
		// 关键路径:目标消息可能被虚拟化卸载 — 由 MessageList 按布局偏移挂载后对齐
		navJumpRequest = { messageId: id, token: ++navJumpToken };
		navHighlightId = id;
		if (navFlashTimer) clearTimeout(navFlashTimer);
		navFlashTimer = setTimeout(() => {
			navHighlightId = null;
			navFlashTimer = null;
		}, 1000);
	}

	/** 拖侧吸附：写 settings 并持久化。 */
	async function setNavSide(next: 'left' | 'right') {
		plugin.settings.chatNavRailSide = next;
		await plugin.saveSettings();
	}

	// 消息变高 / 开关变更后重算轨度量(与贴底写入共用同一合帧器)
	$effect(() => {
		void messages;
		void navEnabled;
		const el = messagesEl;
		if (!el) return;
		layoutFrame.request();
	});

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

	// ==================== Session 生命周期 ====================

	function emptyTitle(): string {
		return tNow('chat.session.emptyTitle');
	}

	/** 同步 Header chip 的短/正常标题。 */
	function syncChipTitles(s: { title?: string; shortTitle?: string } | null): void {
		const empty = emptyTitle();
		if (!s) {
			sessionShortTitle = empty;
			sessionFullTitle = empty;
			return;
		}
		const pair = normalizeTitlePair(
			{ title: s.title, shortTitle: s.shortTitle },
			empty,
		);
		sessionShortTitle = pair.shortTitle;
		sessionFullTitle = pair.title;
	}

	function resetComposerForNewSession(): void {
		mentionPaths = [];
		mentionQuery = null;
		mentionItems = [];
		input = '';
		plugin.userStatus.patchContextUsage({
			usedTokens: 0,
			maxTokens: getEffectiveChatModelMaxTokens(plugin.settings),
			source: 'estimate',
		});
		plugin.userStatus.clearAttachments();
	}

	function clearToolSessionGrants(): void {
		plugin.toolSessionGrants.clear();
	}

	async function refreshSessionIndex(): Promise<void> {
		sessionEntries = await plugin.persistence.listSessionIndex();
	}

	/**
	 * 关侧栏 / 切换前 flush:有内容则确保 lastSessionId;空场文件删除。
	 * 正文一般已由 agent-loop upsert;此处兜底脏标题等。
	 */
	async function flushCurrentSession(): Promise<void> {
		if (!sessionId) return;
		await plugin.persistence.setLastSessionId(sessionId);
		const s = await plugin.persistence.sessions.get(sessionId);
		if (!s) {
			sessionDirty = false;
			return;
		}
		if (!sessionHasContent(s.messages)) {
			await plugin.persistence.sessions.delete(sessionId);
			sessionDirty = false;
			return;
		}
		if (sessionDirty) {
			await plugin.persistence.sessions.upsert(s);
		}
		sessionDirty = false;
	}

	async function loadSessionIntoUi(id: string): Promise<void> {
		const s = await plugin.persistence.sessions.get(id);
		if (!s) {
			await startBlankSession();
			return;
		}
		sessionId = s.id;
		syncChipTitles(s);
		messages = hydrateSessionMessages(s.messages, {
			resolveMcpServerLabel,
			markers: s.compactMarkers,
		});
		lastCiteSearchResults = latestCiteSearchResults(messages);
		// 修复:用 ContextManager 投影估算占用,避免已压历史被 UI 全量重复计入
		const maxTokens = getEffectiveChatModelMaxTokens(plugin.settings);
		const usage = await loadSessionContextUsage(
			() => plugin.createContext(),
			s.id,
			maxTokens,
			estimateMessagesTokens(messages),
		);
		plugin.userStatus.patchContextUsage(usage);
		await plugin.persistence.setLastSessionId(s.id);
		sessionDirty = false;
		isUserNearBottom = true;
		await tick();
		scrollToBottom();
	}

	/** 新开空白场:只占本地 sessionId,正文不落盘直到首条消息(ContextManager.load 同语义)。 */
	async function startBlankSession(): Promise<void> {
		const id = `session-${Date.now()}`;
		sessionId = id;
		syncChipTitles(null);
		messages = [];
		lastCiteSearchResults = null;
		await plugin.persistence.setLastSessionId(id);
		sessionDirty = false;
		clearToolSessionGrants();
		resetComposerForNewSession();
	}

	async function bootstrapSession(): Promise<void> {
		await refreshSessionIndex();
		const lastId = await plugin.persistence.getLastSessionId();
		if (lastId) {
			const s = await plugin.persistence.sessions.get(lastId);
			if (s && sessionHasContent(s.messages)) {
				await loadSessionIntoUi(s.id);
				return;
			}
			if (s && !sessionHasContent(s.messages)) {
				await plugin.persistence.sessions.delete(s.id);
			}
		}
		await startBlankSession();
		await refreshSessionIndex();
	}

	function sleep(ms: number): Promise<void> {
		return new Promise((r) => setTimeout(r, ms));
	}

	async function runSessionTransition(
		load: () => Promise<void>,
		loadingKey: 'chat.session.loading' | 'chat.session.loadingNew' = 'chat.session.loading',
		loadingIdForMenu: string | null = null,
	): Promise<void> {
		if (switching) return;
		switching = true;
		sessionMenuOpen = false;
		titleAbort?.abort();
		titleAbort = null;
		const reduced = prefersReducedMotion();
		const exitMs = reduced ? 0 : SESSION_EXIT_MS;
		const enterMs = reduced ? 0 : SESSION_ENTER_MS;
		try {
			messagesAnimClass = reduced ? '' : 'is-exiting';
			if (exitMs > 0) await sleep(exitMs);
			sessionLoading = true;
			sessionLoadingLabel = tNow(loadingKey);
			// 关键路径:菜单行 spinner 指向目标场;新对话则为 null
			sessionLoadingId = loadingIdForMenu;
			const t0 = Date.now();
			await load();
			const pad = loadingPadMs(Date.now() - t0);
			if (pad > 0) await sleep(pad);
			messagesAnimClass = reduced ? '' : 'is-entering';
			if (enterMs > 0) await sleep(enterMs);
			messagesAnimClass = '';
		} catch (err) {
			devLogger.error('agent', '会话切换失败', err);
			new Notice(tNow('chat.session.loadFailed'), 4000);
			messagesAnimClass = '';
		} finally {
			sessionLoading = false;
			sessionLoadingId = null;
			switching = false;
			await refreshSessionIndex();
		}
	}

	/** 若正在生成或压缩则 abort 并等到收尾,避免新场被旧循环锁住。 */
	async function abortActiveGeneration(): Promise<void> {
		if (!isRunning && !abortController && !isCompacting) return;
		abortController?.abort();
		const deadline = Date.now() + 8000;
		while ((isRunning || isCompacting) && Date.now() < deadline) {
			await sleep(40);
		}
	}

	/** 生成中切换/新建前确认，避免默默掐断。 */
	async function confirmLeaveIfRunning(): Promise<boolean> {
		if (!isRunning && !abortController && !isCompacting) return true;
		return showSessionSwitchConfirm(plugin.app);
	}

	async function createNewSession(): Promise<void> {
		if (switching) return;
		// 已是空白场:关菜单即可,避免「点了没反应」
		const cur = sessionId ? await plugin.persistence.sessions.get(sessionId) : null;
		const uiEmpty = messages.length === 0;
		const diskEmpty = !cur || !sessionHasContent(cur.messages);
		if (uiEmpty && diskEmpty) {
			sessionMenuOpen = false;
			return;
		}
		if (!(await confirmLeaveIfRunning())) return;
		await abortActiveGeneration();
		await runSessionTransition(async () => {
			const curId = sessionId;
			const existing = curId ? await plugin.persistence.sessions.get(curId) : null;
			if (existing) {
				if (sessionHasContent(existing.messages)) {
					await plugin.persistence.sessions.upsert(existing);
					await plugin.persistence.setLastSessionId(existing.id);
				} else {
					await plugin.persistence.sessions.delete(existing.id);
				}
			}
			clearToolSessionGrants();
			await startBlankSession();
		}, 'chat.session.loadingNew', null);
	}

	async function switchToSession(id: string): Promise<void> {
		if (id === sessionId) {
			sessionMenuOpen = false;
			return;
		}
		if (switching) return;
		if (!(await confirmLeaveIfRunning())) return;
		await abortActiveGeneration();
		await runSessionTransition(
			async () => {
				await flushCurrentSession();
				clearToolSessionGrants();
				resetComposerForNewSession();
				const s = await plugin.persistence.sessions.get(id);
				if (!s) {
					new Notice(tNow('chat.session.loadFailed'), 4000);
					return;
				}
				sessionId = s.id;
				syncChipTitles(s);
				messages = hydrateSessionMessages(s.messages, {
			resolveMcpServerLabel,
			markers: s.compactMarkers,
		});
				lastCiteSearchResults = latestCiteSearchResults(messages);
				const maxTokens = getEffectiveChatModelMaxTokens(plugin.settings);
				const usage = await loadSessionContextUsage(
					() => plugin.createContext(),
					s.id,
					maxTokens,
					estimateMessagesTokens(messages),
				);
				plugin.userStatus.patchContextUsage(usage);
				await plugin.persistence.setLastSessionId(s.id);
				sessionDirty = false;
				isUserNearBottom = true;
				await tick();
				scrollToBottom();
			},
			'chat.session.loading',
			id,
		);
	}

	/** 编辑当前会话标题；弹窗内可选手改或 AI 总结。 */
	async function editCurrentSessionTitle(): Promise<void> {
		sessionMenuOpen = false;
		// 关键路径:在任何 await 之前拍下 Header 正在显示的标题,弹框初值与芯片严格同源
		const seedFromUi =
			sessionFullTitle.trim() || sessionShortTitle.trim();
		const id = sessionId;
		const s = await plugin.persistence.sessions.get(id);
		if (!s) {
			new Notice(tNow('chat.session.loadFailed'), 4000);
			return;
		}
		const empty = emptyTitle();
		const result = await showSessionRenameModal(
			plugin.app,
			seedFromUi || s.title?.trim() || s.shortTitle?.trim() || empty,
		);
		if (!result) return;
		if (result.kind === 'retitle') {
			await retitleSessionFromMenu(id);
			return;
		}
		s.title = result.pair.title;
		s.shortTitle = result.pair.shortTitle;
		s.updatedAt = Date.now();
		await plugin.persistence.sessions.upsert(s);
		if (id === sessionId) {
			syncChipTitles(s);
			titleMotionToken += 1;
		}
		await refreshSessionIndex();
	}

	/**
	 * 强制用 LLM 重新总结标题（忽略已有 title）。
	 */
	async function retitleSessionFromMenu(id: string): Promise<void> {
		const s = await plugin.persistence.sessions.get(id);
		if (!s || !sessionHasContent(s.messages)) {
			new Notice(tNow('chat.session.retitleEmpty'), 4000);
			return;
		}
		const empty = emptyTitle();
		const firstUser = s.messages.find((m) => m.role === 'user');
		const seed = typeof firstUser?.content === 'string' ? firstUser.content : '';
		if (!seed.trim()) {
			new Notice(tNow('chat.session.retitleEmpty'), 4000);
			return;
		}
		titleAbort?.abort();
		titleAbort = new AbortController();
		const signal = titleAbort.signal;
		try {
			const pair = await generateSessionTitles(plugin.llm, seed, signal);
			if (signal.aborted) return;
			const cur = await plugin.persistence.sessions.get(id);
			if (!cur || !sessionHasContent(cur.messages)) return;
			const normalized = normalizeTitlePair(pair, empty);
			cur.title = normalized.title;
			cur.shortTitle = normalized.shortTitle;
			cur.updatedAt = Date.now();
			await plugin.persistence.sessions.upsert(cur);
			if (id === sessionId) {
				syncChipTitles(cur);
				titleMotionToken += 1;
			}
			await refreshSessionIndex();
			new Notice(tNow('chat.session.retitleOk'), 2500);
		} catch (err) {
			if (signal.aborted) return;
			// 修复:原先吞错导致无法诊断;V4 thinking 吃光 max_tokens 时常见 empty content
			devLogger.error('main', '会话标题总结失败', err);
			const title = fallbackSessionTitle(seed) || empty;
			const cur = await plugin.persistence.sessions.get(id);
			if (!cur) return;
			const normalized = normalizeTitlePair(
				{ title, shortTitle: deriveShortTitle(title) || empty },
				empty,
			);
			cur.title = normalized.title;
			cur.shortTitle = normalized.shortTitle;
			cur.updatedAt = Date.now();
			await plugin.persistence.sessions.upsert(cur);
			if (id === sessionId) syncChipTitles(cur);
			await refreshSessionIndex();
			new Notice(tNow('chat.session.retitleFail'), 4000);
		}
	}

	async function deleteSessionFromMenu(id: string): Promise<void> {
		if (switching || isRunning) return;
		await plugin.persistence.sessions.delete(id);
		if (id === sessionId) {
			await createNewSession();
		} else {
			await refreshSessionIndex();
		}
	}

	/**
	 * 首轮结束后异步双轨标题(短 + 正常)。
	 * 关键路径:只改 title/shortTitle;upsert 前再 get 一次,避免用过期 messages 覆盖正文。
	 */
	async function maybeGenerateTitle(): Promise<void> {
		const forId = sessionId;
		let s = await plugin.persistence.sessions.get(forId);
		// 关键路径:极端时 save 与 end 仍有细小窗口,短重试
		for (let i = 0; !s?.messages.length && i < 5; i++) {
			await sleep(30);
			s = await plugin.persistence.sessions.get(forId);
		}
		if (!s || !sessionHasContent(s.messages)) return;
		const empty = emptyTitle();
		const firstUser = s.messages.find((m) => m.role === 'user');
		const seed = typeof firstUser?.content === 'string' ? firstUser.content : '';
		// 修复:upsert 用首条 user 填的占位 title 不算真标题 — 仍走 LLM,否则 Header/弹框永远停在开场白截断
		if (
			s.title &&
			s.title !== empty &&
			s.title.trim() !== '' &&
			!isFallbackDerivedTitle(s.title, seed, empty)
		) {
			// 旧场缺 shortTitle 时本地派生补齐
			if (!s.shortTitle?.trim()) {
				const short = deriveShortTitle(s.title) || empty;
				s.shortTitle = short;
				s.updatedAt = Date.now();
				await plugin.persistence.sessions.upsert(s);
				if (forId === sessionId) syncChipTitles(s);
				await refreshSessionIndex();
			}
			return;
		}
		titleAbort?.abort();
		titleAbort = new AbortController();
		const signal = titleAbort.signal;
		const applyTitles = async (title: string, shortTitle: string) => {
			if (signal.aborted || forId !== sessionId) return;
			const cur = await plugin.persistence.sessions.get(forId);
			if (!cur || !sessionHasContent(cur.messages)) return;
			const pair = normalizeTitlePair({ title, shortTitle }, empty);
			cur.title = pair.title;
			cur.shortTitle = pair.shortTitle;
			cur.updatedAt = Date.now();
			await plugin.persistence.sessions.upsert(cur);
			if (forId === sessionId) {
				syncChipTitles(cur);
				titleMotionToken += 1;
			}
			await refreshSessionIndex();
		};
		try {
			const pair = await generateSessionTitles(plugin.llm, seed, signal);
			await applyTitles(pair.title, pair.shortTitle);
		} catch (err) {
			devLogger.error('main', '首轮会话标题生成失败', err);
			const title = fallbackSessionTitle(seed) || empty;
			await applyTitles(title, deriveShortTitle(title) || empty);
		}
	}

	const statusStore = plugin.userStatus.statusBar$;
	const contextStore = plugin.userStatus.contextUsage$;
	const attachmentStore = plugin.userStatus.pendingAttachments$;

	let keyTick = $state(0);
	const hasKey = $derived.by(() => {
		void keyTick;
		void $settingsStore;
		return hasChatApiKey(plugin.app, plugin.settings);
	});
	const gate = $derived.by(() => {
		void keyTick;
		const s = $settingsStore;
		return evaluateChatSendGate(s, $statusStore, { hasChatApiKey: hasKey });
	});
	const slashVisible = $derived.by(() => {
		const v = input.startsWith('/') && !input.includes(' ');
		if (!v) return false;
		return filterCommands(input).length > 0;
	});
	// 关键路径:/ 与 @ 互斥 — 斜杠优先;mention 补全仅在非 slash 态
	const mentionVisible = $derived(mentionQuery !== null && !slashVisible);
	const chatMotionOn = $derived(isChatMotionEnabled($settingsStore));
	const modelName = $derived($settingsStore.chatModel);
	const embedKind = $derived($settingsStore.embedProvider);
	const permLevel = $derived(($settingsStore.toolPermissionLevel ?? 'safe') as ToolPermissionLevel);

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
	// 忙态文案对应 ThinkingOrb 动词(硬 gate 无 orb)
	const busyOrbKind = $derived.by(() => {
		if (!workBar || workBar.type === 'hard') return null;
		if (workBar.type === 'indexing') return 'index' as const;
		if (workBar.type === 'compacting') return 'compact' as const;
		if (workBar.type === 'preparing' || workBar.type === 'downloading') return 'connecting' as const;
		return 'thinking' as const;
	});

	// 关键路径:chatModelMaxTokens 由设置面板预设/自定义配置,见 ADR-007。
	$effect(() => {
		plugin.userStatus.patchContextUsage({
			maxTokens: getEffectiveChatModelMaxTokens($settingsStore),
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
				void createNewSession();
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

	/** 状态抽屉「记忆管理」入口 → 打开 MemoryModal */
	function openMemory(): void {
		plugin.openMemoryModal();
	}

	/** 状态抽屉「MCP」入口 → 打开 McpManageModal */
	function openMcp(): void {
		plugin.openMcpManageModal();
	}

	/** MCP 工具展示名 — 用配置 label 替代裸 server id */
	function resolveMcpServerLabel(id: string): string {
		return plugin.settings.mcpServers.find((s) => s.id === id)?.label ?? id;
	}

	function openFeedback(): void {
		new FeedbackModal(plugin.app, plugin).open();
	}

	function openSponsor(): void {
		void openSponsorPage();
	}

	/** 从 persistence 重水合 compact 分隔(与 runCompactInChat 成功路径一致)。 */
	async function rehydrateCompactMarkersInUi(targetSessionId: string): Promise<void> {
		if (targetSessionId !== sessionId) return;
		const ctx = plugin.createContext();
		await ctx.load(targetSessionId);
		messages = hydrateSessionMessages(ctx.getTranscript(), {
			markers: ctx.getCompactMarkers(),
			resolveMcpServerLabel,
		});
		lastCiteSearchResults = latestCiteSearchResults(messages);
	}

	async function runCompactInChat(opts: { auto: boolean }) {
		// 关键路径:防止 slash + StatusDrawer 与自动压并发
		if (isCompacting || isRunning) return;

		isCompacting = true;
		const compactingSessionId = sessionId;
		const runningId = newMessageId();
		messages = [
			...messages,
			{ id: runningId, role: 'compact', compactPhase: 'running', segments: [] },
		];

		try {
			const ctx = plugin.createContext();
			const result = await compactSession(
				ctx,
				plugin.llm,
				compactingSessionId,
				plugin.settings.promptOverrides,
			);
			if (result.skipped) {
				if (sessionId === compactingSessionId) {
					messages = messages.filter((m) => m.id !== runningId);
					if (!opts.auto) {
						new Notice(tNow('chat.compact.tooShort'), 2500);
					}
				}
				return;
			}
			// 关键路径:切场后只写 persistence,不把旧场 hydrate 进新场 UI
			if (sessionId !== compactingSessionId) return;
			await ctx.load(compactingSessionId);
			messages = hydrateSessionMessages(ctx.getTranscript(), {
				markers: ctx.getCompactMarkers(),
				resolveMcpServerLabel,
			});
			lastCiteSearchResults = latestCiteSearchResults(messages);
			if (!opts.auto) {
				new Notice(tNow('chat.compacted'), 2500);
			}
			compactCircuit.succeed(compactingSessionId);
			plugin.userStatus.patchContextUsage({
				usedTokens: ctx.tokenCount(),
				maxTokens: getEffectiveChatModelMaxTokens(plugin.settings),
				source: 'estimate',
			});
		} catch (err) {
			compactCircuit.fail(compactingSessionId);
			if (sessionId === compactingSessionId) {
				messages = messages.map((m) =>
					m.id === runningId ? { ...m, compactPhase: 'failed' as const } : m,
				);
				const message = err instanceof Error ? err.message : String(err);
				if (!opts.auto) {
					new Notice(tNow('chat.error.compactFailed', { message }), 5000);
				}
				setTimeout(() => {
					if (sessionId === compactingSessionId) {
						messages = messages.filter((m) => m.id !== runningId);
					}
				}, 2500);
			}
		} finally {
			isCompacting = false;
		}
	}

	async function handleCompact() {
		await runCompactInChat({ auto: false });
	}

	// ==================== 发送消息(含 token 三层校准) ====================
	async function sendMessage() {
		refreshKeyState();
		const text = input.trim();
		if (!text || isRunning || isCompacting || switching || !sessionId) return;

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

		const maxTokens = getEffectiveChatModelMaxTokens(plugin.settings);
		const attachmentTokens = get(attachmentStore).reduce((s, a) => s + a.estimatedTokens, 0);

		// 关键路径:发送前先压 — 尚未 push 本条 user,符合 spec
		const preCtx = plugin.createContext();
		await preCtx.load(sessionId);
		const preUsage = preCtx.getContextUsage(maxTokens, attachmentTokens);
		if (
			decidePreSendCompact({
				enabled: plugin.settings.autoCompactEnabled !== false,
				percentage: preUsage.percentage,
				circuitOpen: compactCircuit.isOpen(sessionId),
				isRunning,
				isCompacting,
			})
		) {
			await runCompactInChat({ auto: true });
		}

		// 关键路径:用 push + 从数组中取出 Proxy 引用,触发细粒度 DOM 更新
		const wasEmpty = messages.length === 0;
		messages.push({
			id: newMessageId(),
			role: 'user' as const,
			segments: [{ type: 'text', text }],
			attachments: currentAttachments.length > 0 ? currentAttachments : undefined,
		});
		messages.push({ id: newMessageId(), role: 'assistant' as const, segments: [] });
		if (wasEmpty) {
			echoEnterToken += 1;
		}
		let am = messages[messages.length - 1] as Message;

		// 关键路径:入队成功后递增令牌触发火花;gate 早退与 Stop 不触发。
		sendSparkTick += 1;

		input = '';
		mentionPaths = [];
		mentionQuery = null;
		mentionItems = [];
		sessionMenuOpen = false;
		// 关键路径:先挂 abortController 再翻 isRunning，避免停钮已显示但 abort 仍为 null
		const ac = new AbortController();
		abortController = ac;
		isRunning = true;
		// 关键路径:不在此 patch model=checking — 否则 StatusStrip「思考中」
		// 与 MessageList 打字指示双重叠;model 状态只由 FeedbackController 维护。
		let lastToolName: string | undefined;

		// 第 1 层:send 前精确估算(基于历史消息 segments)
		const baselineUsed = estimateMessagesTokens(messages);
		plugin.userStatus.patchContextUsage({
			usedTokens: baselineUsed,
			maxTokens,
			attachmentTokens,
			source: 'estimate',
		});

		// 第 2 层:流式中累计 delta token
		let streamingUsed = 0;
		/** 本轮 API usage 真值(若有) — 轮后自动压校准用 */
		let lastTurnApiTokens: number | null = null;

		// 关键路径:用户发新消息,强制滚到底(忽略之前的手动上滑)
		isUserNearBottom = true;
		scrollToBottom();

		try {
			const events = plugin.ask(sessionId, text, ac.signal);

			for await (const event of events) {
				switch (event.type) {
					case 'compact.applied': {
						if (event.payload.sessionId !== sessionId) break;
						const inFlight =
							am.role === 'assistant'
								? {
										id: am.id,
										role: 'assistant' as const,
										segments: [...am.segments],
										searchResults: am.searchResults,
										searchReranked: am.searchReranked,
										tokenUsage: am.tokenUsage,
										cancelled: am.cancelled,
									}
								: null;
						await rehydrateCompactMarkersInUi(sessionId);
						if (inFlight) {
							messages.push(inFlight);
							am = messages[messages.length - 1] as Message;
						}
						scrollToBottom();
						break;
					}
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
							displayName: formatToolDisplayName(event.payload.name, event.payload.args, {
								resolveMcpServerLabel,
							}),
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
						// 空数组表示本回合最新 search 无可用结果 — 清掉旧 chip / 精排标记
						am.searchResults = event.payload.results.length
							? event.payload.results
							: undefined;
						am.searchReranked = event.payload.results.length
							? event.payload.reranked
							: false;
						// 跟进回合可能不再 search;保留最近一次供正文 [n] 挂钩
						if (event.payload.results.length) {
							lastCiteSearchResults = event.payload.results;
						}
						scrollToBottom();
						break;
					case 'message.end':
						// 第 3 层:API 真值校准(若 LLM 返回 usage)
						if (event.payload.promptTokens && event.payload.completionTokens) {
							lastTurnApiTokens =
								event.payload.promptTokens + event.payload.completionTokens;
							am.tokenUsage = {
								promptTokens: event.payload.promptTokens,
								completionTokens: event.payload.completionTokens,
							};
							plugin.userStatus.patchContextUsage({
								usedTokens: lastTurnApiTokens,
								// 修复:禁止用回合开始时的闭包快照写回 store — 回合进行中改设置会被旧值盖掉,
								// 抽屉上限永远反映当前配置(回合预算仍按发送时快照,互不影响)
								maxTokens: getEffectiveChatModelMaxTokens(plugin.settings),
								source: 'api',
							});
						}
						sessionDirty = true;
						void maybeGenerateTitle();
						void refreshSessionIndex();
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

			// 关键路径:整轮结束后自动压 — 不在流式中途插队
			let postTurnPercentage: number;
			if (lastTurnApiTokens != null) {
				postTurnPercentage =
					maxTokens > 0 ? Math.round((lastTurnApiTokens / maxTokens) * 100) : 0;
			} else {
				const postCtx = plugin.createContext();
				await postCtx.load(sessionId);
				postTurnPercentage = postCtx.getContextUsage(maxTokens).percentage;
			}
			if (
				decidePostTurnCompact({
					enabled: plugin.settings.autoCompactEnabled !== false,
					percentage: postTurnPercentage,
					circuitOpen: compactCircuit.isOpen(sessionId),
				})
			) {
				await runCompactInChat({ auto: true });
			}
		}
	}

	function stopGeneration() {
		abortController?.abort();
	}

	const PERM_LEVELS: readonly ToolPermissionLevel[] = ['safe', 'auto', 'danger'];

	function permLabelKey(level: ToolPermissionLevel): StringKey {
		return `chat.perm.${level}` as StringKey;
	}

	function composerPermHintKey(level: ToolPermissionLevel): StringKey {
		return `chat.composer.permHint.${level}` as StringKey;
	}

	/** 聊天底栏分段开关 — 写 settings 并落盘,与设置页下拉同步。 */
	async function setToolPermissionLevel(level: ToolPermissionLevel): Promise<void> {
		plugin.settings.toolPermissionLevel = level;
		await plugin.saveSettings();
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

<div class="ratel-chat" class:is-empty-session={messages.length === 0} class:has-empty-motion={messages.length === 0 && chatMotionOn} bind:this={chatRoot}>
	<div class="ratel-stage">
	{#if messages.length === 0 && chatMotionOn}
		<div class="ratel-empty-aurora" aria-hidden="true">
			<OrbBackdrop color1="#e8c49a" color2="#c9956c" color3="#3a322c" backgroundColor="#000000" />
		</div>
	{/if}
	<!-- Header — 词标 + 副标同行(原型 brand baseline) + 历史菜单 + 静默 model chip -->
	<div class="ratel-header">
		<div class="ratel-header-left">
			{#if messages.length > 0}
			<div class="ratel-header-brand">
				<EchoText
					text={`${$t('chat.header.title')}.`}
					playToken={echoEnterToken > 0 ? echoEnterToken : 1}
					motionOn={chatMotionOn}
					echoes={8}
					offset={28}
					lag={0.22}
					fade={0.68}
					blur={1.4}
					duration={1100}
					direction="right"
					accentLast={true}
				/>
				<span class="ratel-header-tagline">{$t('chat.header.tagline')}</span>
			</div>
			{/if}
		</div>
		<!-- 对齐原型 .header-actions:chip + 编辑标题 + model + 菜单同层定位 -->
		<div class="ratel-header-right">
			<div class="ratel-session-chip-group">
				<button
					bind:this={historyBtnEl}
					type="button"
					class="ratel-session-chip"
					class:is-loading={sessionLoading}
					title={sessionFullTitle || emptyTitle()}
					aria-label={$t('chat.session.ariaChip', {
						short: sessionShortTitle || emptyTitle(),
					})}
					aria-expanded={sessionMenuOpen}
					aria-busy={sessionLoading}
					disabled={switching}
					onclick={(e) => {
						e.stopPropagation();
						sessionMenuOpen = !sessionMenuOpen;
						if (sessionMenuOpen) void refreshSessionIndex();
					}}
				>
					<span class="ratel-session-chip-label">
						<TitleDissolve
							text={sessionShortTitle || emptyTitle()}
							playToken={titleMotionToken}
							motionOn={chatMotionOn}
						/>
					</span>
					<svg class="ratel-session-chip-ico" viewBox="0 0 24 24" aria-hidden="true">
						<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.75"></circle>
						<path
							d="M12 8v4l2.5 1.5"
							fill="none"
							stroke="currentColor"
							stroke-width="1.75"
							stroke-linecap="round"
							stroke-linejoin="round"
						></path>
					</svg>
				</button>
				<button
					type="button"
					class="ratel-session-edit"
					title={$t('chat.session.rename')}
					aria-label={$t('chat.session.rename')}
					disabled={switching || sessionLoading}
					onclick={(e) => {
						e.stopPropagation();
						sessionMenuOpen = false;
						void editCurrentSessionTitle();
					}}
				>
					✎
				</button>
			</div>
			<button
				type="button"
				class="ratel-header-model"
				onclick={openModelInfo}
				aria-label={$t('chat.header.modelChip', { model: modelName })}
			>{modelName}</button>
			{#if sessionMenuOpen}
				<div class="ratel-session-menu-float" bind:this={sessionMenuFloatEl}>
					<SessionMenu
						entries={sessionEntries}
						currentId={sessionId}
						loadingId={sessionLoadingId}
						open={true}
						motionOn={chatMotionOn}
						onSelect={(id) => void switchToSession(id)}
						onNew={() => void createNewSession()}
						onDelete={(id) => void deleteSessionFromMenu(id)}
					/>
				</div>
			{/if}
		</div>
	</div>

	<!-- 消息流 shell:切换 loading / exit-enter -->
	<div class="ratel-messages-shell" class:is-loading={sessionLoading}>
		<div class="ratel-messages-overlay" aria-live="polite" aria-busy={sessionLoading}>
			<div class="ratel-session-spinner" aria-hidden="true"></div>
			<span class="ratel-session-load-label">{sessionLoadingLabel}</span>
		</div>
		<div
			class="ratel-messages-wrap {messagesAnimClass}"
			class:has-nav-rail={railVisible}
			data-nav-side={railVisible ? ($settingsStore.chatNavRailSide ?? 'right') : undefined}
		>
			<MessageList
				{messages}
				{sessionId}
				{isRunning}
				bind:containerRef={messagesEl}
				onScroll={handleScroll}
				onOpenPath={handleOpenPath}
				highlightId={navHighlightId}
				citeSearchFallback={lastCiteSearchResults}
				jumpRequest={navJumpRequest}
			/>
			{#if railVisible}
				<ChatNavRail
					enabled={$settingsStore.chatNavRailEnabled}
					side={$settingsStore.chatNavRailSide ?? 'right'}
					anchors={navAnchorsThinned}
					ratio={navRatio}
					showBackToBottom={!isUserNearBottom}
					onJump={jumpToMessage}
					onBackToBottom={forceScrollToBottom}
					onSideChange={setNavSide}
					onThumbSeek={seekByRatio}
				/>
			{/if}
		</div>
	</div>
	</div>

	<!-- composer: Strip → Drawer → input(Conversation-first,状态不夹在消息与输入之间) -->
	<div class="ratel-composer">
		<StatusLine
			status$={statusStore}
			contextUsage$={contextStore}
			expanded={drawerExpanded}
			chatBusy={isRunning}
			busyOverride={busyOverride}
			busyOrbKind={busyOrbKind}
			busyHard={workBar?.type === 'hard'}
			onToggle={() => (drawerExpanded = !drawerExpanded)}
		/>
		<StatusDrawer
			expanded={drawerExpanded}
			status$={statusStore}
			contextUsage$={contextStore}
			embedKind={embedKind}
			onCompact={handleCompact}
			onFeedback={openFeedback}
			onMemory={openMemory}
			onMcp={openMcp}
			onSponsor={openSponsor}
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
					<ClickSpark enabled={chatMotionOn} tick={sendSparkTick}>
						{#snippet children()}
							<GlareHover enabled={chatMotionOn && !isRunning}>
								{#snippet children()}
									{#if isRunning}
										<button
											class="ratel-send ratel-stop"
											type="button"
											onclick={stopGeneration}
											title={$t('chat.composer.stop')}
											aria-label={$t('chat.composer.stop')}
										>■</button>
									{:else}
										<button
											class="ratel-send"
											type="button"
											onclick={sendMessage}
											disabled={!input.trim() || !gate.canSend}
											title={$t('chat.composer.send')}
											aria-label={$t('chat.composer.send')}
										>↑</button>
									{/if}
								{/snippet}
							</GlareHover>
						{/snippet}
					</ClickSpark>
				</div>
			</div>
			<div class="ratel-perm-hint" data-level={permLevel}>
				<div class="ratel-perm-seg" role="radiogroup" aria-label={$t('chat.perm.aria')}>
					{#each PERM_LEVELS as lv (lv)}
						<button
							type="button"
							class="ratel-perm-btn"
							role="radio"
							class:is-active={permLevel === lv}
							aria-checked={permLevel === lv}
							data-level={lv}
							title={$t(composerPermHintKey(lv))}
							onclick={() => void setToolPermissionLevel(lv)}
						>{$t(permLabelKey(lv))}</button>
					{/each}
				</div>
				<span class="ratel-perm-keys">
					<span class="ratel-perm-desc">{$t(composerPermHintKey(permLevel))}</span>
				</span>
			</div>
		</div>
	</div>
</div>

<style>
	/*
	 * Header / session 对齐 docs/prototype/chat-ui-mockup.html(方案 A)。
	 * 不拉外网字体(隐私约束);栈首留 Instrument Sans 供本机已装时命中。
	 */
	* { box-sizing: border-box; }

	.ratel-chat {
		position: relative;
		display: flex;
		flex-direction: column;
		height: 100%;
		font-size: 13.5px;
		line-height: 1.5;
		color: var(--text-normal);
		font-family: 'Instrument Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI',
			sans-serif;
		/* Drawer 上下文 meter 渐变端点 — StatusDrawer 消费 */
		--ratel-meter-from: var(--interactive-accent);
		--ratel-meter-to: var(--text-success);
		/* 正文 [n] / cite-chip 共用(§5.10) */
		--ratel-cite: var(--interactive-accent);
		/* 对齐原型 --copper-soft / --copper-glow */
		--ratel-copper-soft: color-mix(
			in srgb,
			var(--ratel-cite, var(--interactive-accent)) 16%,
			transparent
		);
		--ratel-copper-glow: color-mix(
			in srgb,
			var(--ratel-cite, var(--interactive-accent)) 35%,
			transparent
		);
	}

	/* 空会话:顶栏浮在舞台上,不占一条实心底;柔光从顶铺下(与 styles.css leaf 同形) */
	.ratel-stage {
		position: relative;
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	.ratel-empty-aurora {
		position: absolute;
		inset: 0;
		z-index: 0;
		pointer-events: none;
	}

	.ratel-chat.is-empty-session .ratel-header {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		z-index: 2;
		border-bottom: none;
		background: transparent;
		pointer-events: none;
	}

	.ratel-chat.is-empty-session .ratel-header-right {
		margin-left: auto;
		pointer-events: auto;
	}

	.ratel-chat.is-empty-session .ratel-composer {
		position: relative;
		z-index: 2;
		border-top-color: color-mix(in srgb, var(--background-modifier-border) 45%, transparent);
	}

	.ratel-chat.is-empty-session .ratel-messages-wrap,
	.ratel-chat.is-empty-session :global(.ratel-messages) {
		overflow: visible;
	}

	/* ==================== Header — 原型极简(无毛玻璃) ==================== */
	.ratel-header {
		flex-shrink: 0;
		padding: 14px 16px 12px;
		border-bottom: 1px solid var(--background-modifier-border);
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		background: transparent;
		overflow: visible;
	}

	.ratel-header-left {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		overflow: visible;
	}

	.ratel-header-right {
		display: flex;
		align-items: center;
		gap: 6px;
		position: relative;
		min-width: 0;
		flex-shrink: 1;
	}

	/* 安全路径:原型 brand 用 baseline 横排,不是上下堆叠 */
	.ratel-header-brand {
		display: flex;
		align-items: baseline;
		gap: 8px;
		min-width: 0;
		overflow: visible;
	}

	.ratel-header-brand :global(.ratel-echo) {
		font-size: 15px;
		font-weight: 650;
		letter-spacing: -0.02em;
		color: var(--text-normal);
	}

	.ratel-header-tagline {
		font-size: 11px;
		font-weight: 450;
		line-height: 1;
		color: var(--text-faint, var(--text-muted));
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ratel-header-model {
		font-size: 10.5px;
		font-family: 'IBM Plex Mono', var(--font-monospace), ui-monospace, monospace;
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
		flex-shrink: 0;
		transition: border-color 0.15s, color 0.15s;
	}

	.ratel-header-model:hover {
		color: var(--ratel-cite, var(--interactive-accent));
		border-color: var(--ratel-copper-glow);
	}

	.ratel-session-menu-float {
		position: absolute;
		top: calc(100% + 8px);
		right: 0;
		z-index: 1000;
		isolation: isolate;
	}

	.ratel-session-chip-group {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		min-width: 0;
	}

	.ratel-session-chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		max-width: 132px;
		min-width: 0;
		height: 28px;
		padding: 0 8px 0 10px;
		border-radius: 999px;
		border: 1px solid var(--background-modifier-border);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		font: inherit;
		font-size: 12px;
		font-weight: 500;
		transition: color 0.15s, border-color 0.15s, background 0.15s;
	}

	.ratel-session-chip:hover:not(:disabled),
	.ratel-session-chip[aria-expanded='true']:not(:disabled) {
		color: var(--ratel-cite, var(--interactive-accent));
		border-color: var(--ratel-copper-glow);
		background: var(--ratel-copper-soft);
	}

	.ratel-session-chip:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.ratel-session-edit {
		width: 28px;
		height: 28px;
		min-height: 28px;
		padding: 0;
		border: 1px solid transparent;
		border-radius: 999px;
		background: transparent;
		color: var(--text-faint, var(--text-muted));
		cursor: pointer;
		font-size: 13px;
		line-height: 1;
		opacity: 0.55;
		flex-shrink: 0;
		transition: color 0.15s, opacity 0.15s, background 0.15s, border-color 0.15s;
	}

	.ratel-session-chip-group:hover .ratel-session-edit,
	.ratel-session-edit:hover:not(:disabled),
	.ratel-session-edit:focus-visible:not(:disabled) {
		opacity: 1;
		color: var(--text-muted);
	}

	.ratel-session-edit:hover:not(:disabled),
	.ratel-session-edit:focus-visible:not(:disabled) {
		color: var(--ratel-cite, var(--interactive-accent));
		border-color: var(--background-modifier-border);
		background: var(--ratel-copper-soft);
	}

	.ratel-session-edit:disabled {
		opacity: 0.3;
		cursor: not-allowed;
	}

	.ratel-session-chip-label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		line-height: 1.2;
	}

	.ratel-session-chip-ico {
		flex-shrink: 0;
		width: 14px;
		height: 14px;
		opacity: 0.85;
	}

	.ratel-session-chip.is-loading .ratel-session-chip-ico {
		animation: ratel-session-spin 0.8s linear infinite;
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-session-chip.is-loading .ratel-session-chip-ico {
			animation: none;
			opacity: 0.7;
		}
	}

	/* ==================== 消息流 shell(切换 loading / 动效) ==================== */
	.ratel-messages-shell {
		position: relative;
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	.ratel-messages-shell.is-loading .ratel-messages-wrap {
		pointer-events: none;
	}

	.ratel-messages-overlay {
		position: absolute;
		inset: 0;
		z-index: 5;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 10px;
		background: color-mix(in srgb, var(--background-primary) 55%, transparent);
		backdrop-filter: blur(2px);
		-webkit-backdrop-filter: blur(2px);
		opacity: 0;
		visibility: hidden;
		transition: opacity 0.18s ease, visibility 0.18s ease;
	}

	.ratel-messages-shell.is-loading .ratel-messages-overlay {
		opacity: 1;
		visibility: visible;
	}

	.ratel-session-spinner {
		width: 22px;
		height: 22px;
		border: 2px solid var(--background-modifier-border);
		border-top-color: var(--ratel-cite, var(--interactive-accent));
		border-radius: 50%;
		animation: ratel-session-spin 0.7s linear infinite;
	}

	.ratel-session-load-label {
		font-size: 12px;
		color: var(--text-muted);
		letter-spacing: 0.02em;
	}

	@keyframes ratel-session-spin {
		to {
			transform: rotate(360deg);
		}
	}

	.ratel-messages-wrap {
		position: relative;
		flex: 1;
		overflow: hidden;
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	/* 进度点列占位：正文不贴边，hover 变宽时也不压字 */
	.ratel-messages-wrap.has-nav-rail[data-nav-side='right'] :global(.ratel-messages) {
		padding-right: 24px;
	}

	.ratel-messages-wrap.has-nav-rail[data-nav-side='left'] :global(.ratel-messages) {
		padding-left: 24px;
	}

	.ratel-messages-wrap.is-exiting {
		animation: ratel-messages-exit 0.15s ease forwards;
	}

	.ratel-messages-wrap.is-entering {
		animation: ratel-messages-enter 0.22s ease forwards;
	}

	@keyframes ratel-messages-exit {
		from {
			opacity: 1;
			transform: translateY(0);
		}
		to {
			opacity: 0;
			transform: translateY(6px);
		}
	}

	@keyframes ratel-messages-enter {
		from {
			opacity: 0;
			transform: translateY(-8px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-session-spinner {
			animation: none;
			border-top-color: var(--background-modifier-border);
			opacity: 0.85;
		}

		.ratel-messages-wrap.is-exiting,
		.ratel-messages-wrap.is-entering {
			animation: none;
		}

		.ratel-messages-overlay {
			transition: none;
		}
	}

	/* ==================== composer(Strip → Drawer → input) ==================== */
	.ratel-composer {
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		border-top: 1px solid var(--background-modifier-border);
		padding-bottom: max(22px, env(safe-area-inset-bottom, 0px));
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

	/* Send — 对齐原型 .send:34×34 方钮、圆角 10px */
	.ratel-send {
		flex-shrink: 0;
		align-self: flex-end;
		width: 34px;
		min-width: 34px;
		height: 34px;
		padding: 0;
		border-radius: 10px;
		border: none;
		background: var(--interactive-accent);
		color: var(--text-on-accent, #fff);
		font-size: 14px;
		font-weight: 700;
		line-height: 1;
		font-family: inherit;
		cursor: pointer;
		transition:
			background 0.15s,
			opacity 0.15s,
			transform 0.12s,
			filter 0.15s;
		-webkit-appearance: none;
		appearance: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.ratel-send:hover:not(:disabled) {
		filter: brightness(1.08);
	}

	.ratel-send:active:not(:disabled) {
		transform: scale(0.96);
	}

	.ratel-send:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.ratel-stop {
		background: var(--text-error) !important;
		color: #fff !important;
	}

	/* 权限档位 hint — 对齐原型 .hint / .perm-seg */
	.ratel-perm-hint {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		font-size: 10.5px;
		color: var(--text-faint);
		padding: 0 4px;
		min-height: 22px;
	}

	.ratel-perm-keys {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ratel-perm-desc {
		color: var(--text-faint);
	}

	.ratel-perm-hint[data-level='auto'] .ratel-perm-desc {
		color: var(--ratel-cite, var(--interactive-accent));
	}

	.ratel-perm-hint[data-level='danger'] .ratel-perm-desc {
		color: var(--text-error);
	}

	/* 选中色仍 scoped(用 .ratel-chat 上的 --ratel-copper-*);几何重置见 styles.css */
	.ratel-perm-seg button:hover {
		color: var(--text-muted);
		background: color-mix(in srgb, var(--text-normal) 4%, transparent);
	}

	.ratel-perm-seg button.is-active[data-level='safe'] {
		color: var(--text-success);
		background: color-mix(in srgb, var(--text-success) 14%, transparent);
	}

	.ratel-perm-seg button.is-active[data-level='auto'] {
		color: var(--ratel-cite, var(--interactive-accent));
		background: var(--ratel-copper-soft);
	}

	.ratel-perm-seg button.is-active[data-level='danger'] {
		color: var(--text-error);
		background: color-mix(in srgb, var(--text-error) 14%, transparent);
	}

	.ratel-perm-seg button:focus-visible {
		outline: none;
		box-shadow: inset 0 0 0 1px var(--ratel-copper-glow);
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
