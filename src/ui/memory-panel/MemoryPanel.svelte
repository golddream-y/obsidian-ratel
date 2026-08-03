<script lang="ts">
	/**
	 * @file src/ui/memory-panel/MemoryPanel.svelte
	 * @description 记忆管理面板 — 显示 global + topics,支持筛选 / 搜索 / 行内编辑 / 清理模型记忆
	 * @module ui/memory-panel/MemoryPanel
	 * @depends main, obsidian, i18n, types
	 *
	 * 设计要点:
	 * - Svelte 5 runes:$props() 接收 plugin,$state 管理 UI 状态,$derived 计算过滤列表。
	 * - 数据流:plugin.memoryStore.readGlobal() / readIndex() / readTopic() / getTotalSize()。
	 * - 行内编辑:editingId state 切换为 textarea,blur 或按钮保存 → writeGlobal/writeTopic。
	 * - 清理模型记忆:Modal 二次确认 → 遍历 global + 所有 topic 文件,正则删除 source=model 条目。
	 * - 样式:复用 Obsidian 主题变量,圆角 ≤8px,无 box-shadow,所有 class 用 'ratel-' 前缀。
	 */
	import type RatelVaultPlugin from '../../main';
	import { onMount, onDestroy } from 'svelte';
	import { Modal, Notice } from 'obsidian';
	import { t, tNow } from '../../i18n';
	import type { TopicIndexEntry, MemoryEntry } from '../../types';
	import { applyRatelAppearance } from '../appearance/apply-ratel-appearance';
	import { appearanceRevision } from '../appearance/appearance-store';
	import { memoryRevision } from '../../core/memory-revision';
	import { settings$ as settingsStore } from '../settings-store';

	let {
		plugin,
		embeddedInModal = false,
	}: {
		plugin: RatelVaultPlugin;
		/** 嵌在 MemoryModal 内时隐藏面板自带标题,避免与 Modal titleEl 重复 */
		embeddedInModal?: boolean;
	} = $props();

	// ==================== 外观热更新 ====================
	let panelRoot: HTMLElement | undefined;
	let appearanceUnsub: (() => void) | undefined;
	let memoryUnsub: (() => void) | undefined;

	/** 把当前 settings 外观写到 Memory 面板根节点。 */
	function syncAppearance() {
		if (!panelRoot) return;
		applyRatelAppearance(panelRoot, {
			uiColorScheme: plugin.settings.uiColorScheme,
			uiAccent: plugin.settings.uiAccent,
		});
	}

	onMount(() => {
		syncAppearance();
		// 关键路径:subscribe 立即回调一次(与 onMount sync 重复无害);后续 bump 触发热更新。
		appearanceUnsub = appearanceRevision.subscribe(() => syncAppearance());
		// 关键路径:agent remember / forget 写盘后 bumpMemory → 重读列表(含主题记忆)。
		// subscribe 首次回调会再 load 一次,与顶层 loadMemories 重复无害。
		memoryUnsub = memoryRevision.subscribe(() => {
			void loadMemories();
		});
	});
	onDestroy(() => {
		appearanceUnsub?.();
		memoryUnsub?.();
	});

	// ==================== 响应式状态 ====================
	let searchQuery = $state('');
	let filter = $state<'all' | 'user' | 'model'>('all');
	let globalEntries = $state<MemoryEntry[]>([]);
	let topicIndex = $state<TopicIndexEntry[]>([]);
	// 关键路径:topicEntries 缓存按 topic name 索引的已解析条目,展开时直接读,避免重复解析。
	let topicEntries = $state<Record<string, MemoryEntry[]>>({});
	let totalSize = $state(0);
	// 关键路径:行内编辑 — editingId 形如 'global-3' 或 'topic-GraphQL-1',对应条目位置。
	let editingId = $state<string | null>(null);
	let editBuffer = $state('');
	// 关键路径:加载失败标志,显示错误提示而非空白。
	let loadError = $state<string | null>(null);

	// ==================== 数据加载 ====================
	/**
	 * 加载所有记忆数据 — 同步调 readGlobal + readIndex + getTotalSize,然后串行读 topic 内容。
	 *
	 * 关键路径:MemoryStore 的 read* / getTotalSize 是同步 fs API,无 async 必要;
	 * 但声明为 async 以便 catch 块统一处理(且未来若改异步 IO 不破坏调用方)。
	 * topic 文件读取串行 — readTopic 同步返回 string | null,缺失主题用空数组兜底。
	 */
	async function loadMemories() {
		try {
			const memoryStore = plugin.memoryStore;
			// 关键路径:三个独立同步 IO,顺序读取即可(都是 fs.readFileSync)。
			const globalContent = memoryStore.readGlobal();
			const topics = memoryStore.readIndex();
			const size = memoryStore.getTotalSize();

			globalEntries = parseEntries(globalContent);
			topicIndex = topics;
			totalSize = size;

			// 关键路径:遍历 topic 并读取内容,缓存到 topicEntries。
			const entriesMap: Record<string, MemoryEntry[]> = {};
			for (const topic of topics) {
				const content = memoryStore.readTopic(topic.name);
				entriesMap[topic.name] = content !== null ? parseEntries(content) : [];
			}
			topicEntries = entriesMap;
			loadError = null;
		} catch (err) {
			// 关键路径:加载失败显示错误,不让 UI 显示空白造成误解。
			loadError = err instanceof Error ? err.message : String(err);
		}
	}

	/**
	 * 解析 markdown 为 MemoryEntry[] — 按 `- {content}` + `  source: {user|model}` 两行一对解析。
	 *
	 * 关键路径:与 remember.ts 的 appendEntryToSection 写入格式严格对齐。
	 * 缺失 source 行时默认 'user'(向前兼容旧文件或手写条目)。
	 *
	 * @param text - markdown 全文(frontmatter + sections + 条目)。
	 * @returns 解析出的条目数组;空文件返回空数组。
	 */
	function parseEntries(text: string): MemoryEntry[] {
		const entries: MemoryEntry[] = [];
		const lines = text.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!line) continue;
			// 关键路径:匹配 `- {content}` 行(条目起始),忽略 `## section` 标题与 frontmatter。
			const match = line.match(/^-\s+(.+)$/);
			if (!match || !match[1]) continue;
			const content = match[1];
			// 关键路径:下一行 `  source: {user|model}` 是来源标记;缺失时默认 user。
			const nextLine = lines[i + 1];
			const sourceMatch = nextLine?.match(/^\s+source:\s+(user|model)$/);
			const source: 'user' | 'model' = sourceMatch && sourceMatch[1] === 'model' ? 'model' : 'user';
			entries.push({ text: content, source });
			// 关键路径:source 行已消费,跳过下一行避免误解析。
			if (sourceMatch) i++;
		}
		return entries;
	}

	// ==================== 派生状态 ====================
	/**
	 * 全局条目按 filter + searchQuery 过滤。
	 *
	 * 关键路径:$derived.by 让 Svelte 自动追踪依赖,searchQuery / filter / globalEntries 变化自动重算。
	 */
	const filteredGlobalEntries = $derived.by(() => {
		const q = searchQuery.trim().toLowerCase();
		return globalEntries.filter((e) => {
			if (filter !== 'all' && e.source !== filter) return false;
			if (q && !e.text.toLowerCase().includes(q)) return false;
			return true;
		});
	});

	// ==================== 工具函数 ====================
	/**
	 * 格式化字节数为人类可读字符串(B / KB / MB)。
	 */
	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
	}

	/**
	 * 生成稳定条目 ID — 'global-{idx}' 或 'topic-{name}-{idx}'。
	 *
	 * 关键路径:用位置索引而非内容哈希,避免编辑后 ID 变化导致编辑态丢失。
	 */
	function entryId(scope: 'global' | string, idx: number): string {
		return scope === 'global' ? `global-${idx}` : `topic-${scope}-${idx}`;
	}

	/**
	 * 获取指定作用域 + 索引的条目数组引用 — 用于行内编辑时定位。
	 */
	function getEntries(scope: 'global' | string): MemoryEntry[] {
		return scope === 'global' ? globalEntries : (topicEntries[scope] ?? []);
	}

	// ==================== 行内编辑 ====================
	/**
	 * 进入编辑模式 — 切换 textarea 显示,加载当前条目内容到 buffer。
	 */
	function startEdit(scope: 'global' | string, idx: number) {
		const entries = getEntries(scope);
		const entry = entries[idx];
		if (!entry) return;
		editingId = entryId(scope, idx);
		editBuffer = entry.text;
	}

	/**
	 * 取消编辑 — 清空 editingId,丢弃 buffer。
	 */
	function cancelEdit() {
		editingId = null;
		editBuffer = '';
	}

	/**
	 * 保存编辑 — 写回 markdown 文件,刷新内存中的条目。
	 *
	 * 关键路径:替换 markdown 中匹配 `- {oldContent}` 的行为 `- {newContent}`,
	 * source 行保持不变。写回后重新解析整个文件,确保内存与磁盘一致。
	 */
	function saveEdit(scope: 'global' | string, idx: number) {
		const entries = getEntries(scope);
		const entry = entries[idx];
		if (!entry) return;
		const newText = editBuffer.trim();
		if (!newText) {
			cancelEdit();
			return;
		}

		const memoryStore = plugin.memoryStore;
		try {
			if (scope === 'global') {
				const content = memoryStore.readGlobal();
				const updated = replaceEntryLine(content, entry.text, newText);
				memoryStore.writeGlobal(updated);
			} else {
				const content = memoryStore.readTopic(scope);
				if (content === null) return;
				const updated = replaceEntryLine(content, entry.text, newText);
				memoryStore.writeTopic(scope, updated);
			}
			// 关键路径:写回后重新加载,刷新内存条目。
			void loadMemories();
			editingId = null;
			editBuffer = '';
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			new Notice(tNow('notice.operationFailed', { message }), 5000);
		}
	}

	/**
	 * 替换 markdown 中第一个匹配 `- {oldContent}` 的行为 `- {newContent}`。
	 *
	 * 关键路径:用 split + join 而非 String.replace,避免 content 含正则元字符($ 等)导致误匹配。
	 *
	 * @throws 当条目在文件中找不到时抛错(可能被外部修改),由调用方 catch 后 Notice 提示用户。
	 */
	function replaceEntryLine(text: string, oldContent: string, newContent: string): string {
		const oldLine = `- ${oldContent}`;
		const newLine = `- ${newContent}`;
		const lines = text.split('\n');
		const idx = lines.indexOf(oldLine);
		// 关键路径:idx === -1 说明磁盘内容已被外部修改,与内存不一致 — 抛错让调用方提示用户刷新。
		if (idx === -1) throw new Error('条目在文件中未找到,可能已被外部修改,请刷新面板后重试');
		lines[idx] = newLine;
		return lines.join('\n');
	}

	/**
	 * 删除单条条目 — 从 markdown 中移除 `- {content}` 行 + 紧跟的 `  source: ...` 行。
	 *
	 * 关键路径:用 Modal 二次确认,避免误删。
	 */
	function deleteEntry(scope: 'global' | string, idx: number) {
		const entries = getEntries(scope);
		const entry = entries[idx];
		if (!entry) return;

		const modal = new Modal(plugin.app);
		modal.titleEl.setText(tNow('memory.panel.delete'));
		modal.contentEl.createEl('p', { text: tNow('memory.panel.confirmClear') });

		const btnRow = modal.contentEl.createDiv({ cls: 'ratel-memory-modal-btns' });
		const cancelBtn = btnRow.createEl('button', { text: tNow('memory.panel.cancel') });
		const confirmBtn = btnRow.createEl('button', { text: tNow('memory.panel.delete'), cls: 'mod-warning' });

		cancelBtn.onclick = () => modal.close();
		confirmBtn.onclick = () => {
			modal.close();
			try {
				const memoryStore = plugin.memoryStore;
				if (scope === 'global') {
					const content = memoryStore.readGlobal();
					const updated = removeEntryBlock(content, entry.text);
					memoryStore.writeGlobal(updated);
				} else {
					const content = memoryStore.readTopic(scope);
					if (content === null) return;
					const updated = removeEntryBlock(content, entry.text);
					memoryStore.writeTopic(scope, updated);
				}
				// 关键路径:写回后重新加载,刷新内存条目。
				void loadMemories();
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				new Notice(tNow('notice.operationFailed', { message }), 5000);
			}
		};
		modal.open();
	}

	/**
	 * 从 markdown 中移除 `- {content}` 行 + 紧跟的 `  source: ...` 行。
	 *
	 * 关键路径:用 split + join 而非正则,避免 content 含特殊字符。
	 *
	 * @throws 当条目在文件中找不到时抛错(可能被外部修改),由调用方 catch 后 Notice 提示用户。
	 */
	function removeEntryBlock(text: string, content: string): string {
		const targetLine = `- ${content}`;
		const lines = text.split('\n');
		const idx = lines.indexOf(targetLine);
		// 关键路径:idx === -1 说明磁盘内容已被外部修改,与内存不一致 — 抛错让调用方提示用户刷新。
		if (idx === -1) throw new Error('条目在文件中未找到,可能已被外部修改,请刷新面板后重试');
		// 关键路径:删除条目行 + 紧跟的 source 行(若存在)。
		lines.splice(idx, 1);
		// 关键路径:若下一行是 source 标记,一并删除。
		const nextLine = lines[idx];
		if (nextLine && /^\s+source:\s+(user|model)$/.test(nextLine)) {
			lines.splice(idx, 1);
		}
		return lines.join('\n');
	}

	// ==================== 清理模型推断的记忆 ====================
	/**
	 * 清理所有 source=model 的条目 — 遍历 global.md + 所有 topic 文件。
	 *
	 * 关键路径:
	 * 1. Modal 二次确认(plan 要求 Notice 确认,但 Notice 是单向通知,改用 Modal 交互确认)。
	 * 2. 遍历 global.md + 所有 topic 文件,正则删除 `- {content}\n  source: model` 对。
	 * 3. 写回所有文件,统计删除条目数,Notice 提示用户清理结果。
	 */
	function clearModelMemories() {
		const modal = new Modal(plugin.app);
		modal.titleEl.setText(tNow('memory.panel.clearModelMemories'));
		modal.contentEl.createEl('p', { text: tNow('memory.panel.confirmClear') });

		const btnRow = modal.contentEl.createDiv({ cls: 'ratel-memory-modal-btns' });
		const cancelBtn = btnRow.createEl('button', { text: tNow('memory.panel.cancel') });
		const confirmBtn = btnRow.createEl('button', { text: tNow('memory.panel.delete'), cls: 'mod-warning' });

		cancelBtn.onclick = () => modal.close();
		confirmBtn.onclick = async () => {
			modal.close();
			try {
				const memoryStore = plugin.memoryStore;
				let clearedCount = 0;

				// 关键路径:global.md — 用正则删除所有 source=model 条目对。
				const globalContent = memoryStore.readGlobal();
				const { text: cleanedGlobal, count: globalCount } = removeModelEntries(globalContent);
				if (globalCount > 0) {
					memoryStore.writeGlobal(cleanedGlobal);
					clearedCount += globalCount;
				}

				// 关键路径:遍历所有 topic 文件,逐个清理。
				for (const topic of topicIndex) {
					const content = memoryStore.readTopic(topic.name);
					if (content === null) continue;
					const { text: cleaned, count } = removeModelEntries(content);
					if (count > 0) {
						memoryStore.writeTopic(topic.name, cleaned);
						clearedCount += count;
					}
				}

				// 关键路径:刷新内存数据,显示 Notice 反馈。
				await loadMemories();
				if (clearedCount === 0) {
					new Notice(tNow('memory.panel.noModelMemories'), 4000);
				} else {
					new Notice(tNow('memory.panel.cleared', { count: clearedCount }), 4000);
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				new Notice(tNow('notice.operationFailed', { message }), 5000);
			}
		};
		modal.open();
	}

	/**
	 * 从 markdown 中删除所有 source=model 条目对(`- {content}\n  source: model`)。
	 *
	 * 关键路径:正则匹配 `- {content}` + 换行 + `  source: model` 三段,
	 * 删除整对(含可能的 leading empty line)。
	 *
	 * @returns { text: 清理后的 markdown, count: 删除的条目数 }
	 */
	function removeModelEntries(text: string): { text: string; count: number } {
		// 关键路径:匹配 `- {content}` 行 + 换行 + `\s+source: model` 行,
		// 用 \s+ 与 parseEntries / removeEntryBlock 的解析口径对齐(用户手动改缩进也能匹配)。
		// 用 [^\n]* 匹配 content(避免跨行),用 \n 连接确保两行成对。
		const pattern = /^- ([^\n]+)\n\s+source:\s+model$/gm;
		const matches = text.match(pattern) ?? [];
		const count = matches.length;
		if (count === 0) return { text, count: 0 };
		// 关键路径:删除匹配对,清理可能残留的连续空行(避免 markdown 累积空段)。
		const cleaned = text.replace(pattern, '').replace(/\n{3,}/g, '\n\n');
		return { text: cleaned, count };
	}

	// 关键路径:组件挂载后立即加载数据 — mount() 后 Svelte 5 自动执行顶层语句。
	loadMemories();
</script>

<div class="ratel-memory-panel" bind:this={panelRoot}>
	<!-- 顶部:标题 + 搜索框 -->
	<div class="ratel-memory-header">
		{#if !embeddedInModal}
			<span class="ratel-memory-title">{$t('memory.panel.title')}</span>
		{/if}
		<input
			type="text"
			class="ratel-memory-search"
			placeholder={$t('memory.panel.searchPlaceholder')}
			bind:value={searchQuery}
		/>
	</div>

	<!-- 筛选标签 -->
	<div class="ratel-memory-filters">
		<button class:active={filter === 'all'} onclick={() => filter = 'all'}>
			{$t('memory.panel.filterAll')}
		</button>
		<button class:active={filter === 'user'} onclick={() => filter = 'user'}>
			{$t('memory.panel.filterUser')}
		</button>
		<button class:active={filter === 'model'} onclick={() => filter = 'model'}>
			{$t('memory.panel.filterModel')}
		</button>
	</div>

	<!-- 加载错误提示 -->
	{#if loadError}
		<div class="ratel-memory-error">⚠ {loadError}</div>
	{/if}

	<!-- 内容主体 -->
	<div class="ratel-memory-body">
		<!-- 全局基础 -->
		<details open>
			<summary>📌 {$t('memory.panel.globalSection')}</summary>
			{#if filteredGlobalEntries.length === 0}
				<div class="ratel-memory-empty">{$t('memory.panel.empty')}</div>
			{:else}
				{#each filteredGlobalEntries as entry, idx (entryId('global', idx))}
					<div class="ratel-memory-entry">
						<span class="ratel-memory-icon" title={entry.source === 'user' ? $t('memory.panel.sourceUser') : $t('memory.panel.sourceModel')} aria-label={entry.source === 'user' ? $t('memory.panel.sourceUser') : $t('memory.panel.sourceModel')}>{entry.source === 'user' ? '👤' : '🤖'}</span>
						{#if editingId === entryId('global', idx)}
							<div class="ratel-memory-edit">
								<textarea bind:value={editBuffer} placeholder={$t('memory.panel.editPlaceholder')}></textarea>
								<div class="ratel-memory-edit-actions">
									<button onclick={() => saveEdit('global', idx)}>{$t('memory.panel.save')}</button>
									<button onclick={cancelEdit}>{$t('memory.panel.cancel')}</button>
								</div>
							</div>
						{:else}
							<span class="ratel-memory-content">{entry.text}</span>
							<div class="ratel-memory-actions">
								<button onclick={() => startEdit('global', idx)}>✎</button>
								<button class="mod-warning" onclick={() => deleteEntry('global', idx)}>✕</button>
							</div>
						{/if}
					</div>
				{/each}
			{/if}
		</details>

		<!-- 主题列表 -->
		<details>
			<summary>📂 {$t('memory.panel.topicSection')} ({topicIndex.length})</summary>
			{#if topicIndex.length === 0}
				<div class="ratel-memory-empty">{$t('memory.panel.empty')}</div>
			{:else}
				{#each topicIndex as topic}
				<details>
					<summary>📂 {topic.name} <span class="ratel-memory-summary">{topic.summary}</span></summary>
						{#if (topicEntries[topic.name] ?? []).length === 0}
							<div class="ratel-memory-empty">{$t('memory.panel.topicEmpty')}</div>
						{:else}
							{#each topicEntries[topic.name] ?? [] as entry, idx (entryId(topic.name, idx))}
								<div class="ratel-memory-entry">
									<span class="ratel-memory-icon" title={entry.source === 'user' ? $t('memory.panel.sourceUser') : $t('memory.panel.sourceModel')} aria-label={entry.source === 'user' ? $t('memory.panel.sourceUser') : $t('memory.panel.sourceModel')}>{entry.source === 'user' ? '👤' : '🤖'}</span>
									{#if editingId === entryId(topic.name, idx)}
										<div class="ratel-memory-edit">
											<textarea bind:value={editBuffer} placeholder={$t('memory.panel.editPlaceholder')}></textarea>
											<div class="ratel-memory-edit-actions">
												<button onclick={() => saveEdit(topic.name, idx)}>{$t('memory.panel.save')}</button>
												<button onclick={cancelEdit}>{$t('memory.panel.cancel')}</button>
											</div>
										</div>
									{:else}
										<span class="ratel-memory-content">{entry.text}</span>
										<div class="ratel-memory-actions">
											<button onclick={() => startEdit(topic.name, idx)}>✎</button>
											<button class="mod-warning" onclick={() => deleteEntry(topic.name, idx)}>✕</button>
										</div>
									{/if}
								</div>
							{/each}
						{/if}
					</details>
				{/each}
			{/if}
		</details>
	</div>

	<!-- 底部状态栏 -->
	<div class="ratel-memory-footer">
		<span class="ratel-memory-size">
			{$t('memory.panel.totalSize')}: {formatBytes(totalSize)} / {$settingsStore.memoryStorageLimitMB} MB
		</span>
		<button class="mod-warning ratel-memory-clear" onclick={clearModelMemories}>
			{$t('memory.panel.clearModelMemories')}
		</button>
	</div>
</div>

<style>
	/*
	 * 设计 Token:
	 * - 圆角 ≤8px(符合设计系统上限)
	 * - 不用 box-shadow,用 border + 半透明背景做层次
	 * - CSS 变量复用 Obsidian 主题变量(--background-primary 等)
	 */
	* { box-sizing: border-box; }

	.ratel-memory-panel {
		display: flex;
		flex-direction: column;
		height: 100%;
		font-size: 13px;
		line-height: 1.5;
		color: var(--text-normal);
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
		padding: 10px 12px;
	}

	/* ==================== Header ==================== */
	.ratel-memory-header {
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding-bottom: 8px;
		border-bottom: 1px solid var(--background-modifier-border);
	}

	.ratel-memory-title {
		font-size: 13px;
		font-weight: 600;
		color: var(--text-normal);
		letter-spacing: 0.3px;
	}

	.ratel-memory-search {
		width: 100%;
		padding: 6px 10px;
		border-radius: 6px;
		border: 1px solid var(--background-modifier-border);
		background: var(--background-modifier-form-field);
		color: var(--text-normal);
		font-family: inherit;
		font-size: 12px;
		outline: none;
		transition: border-color 0.15s;
	}

	.ratel-memory-search:focus {
		border-color: var(--interactive-accent);
	}

	.ratel-memory-search::placeholder {
		color: var(--text-faint);
	}

	/* ==================== 筛选标签 ==================== */
	.ratel-memory-filters {
		flex-shrink: 0;
		display: flex;
		gap: 4px;
		padding: 8px 0;
	}

	.ratel-memory-filters button {
		padding: 4px 10px;
		border-radius: 6px;
		border: 1px solid var(--background-modifier-border);
		background: var(--background-secondary);
		color: var(--text-muted);
		font-size: 11px;
		font-family: inherit;
		cursor: pointer;
		transition: all 0.15s;
	}

	.ratel-memory-filters button:hover {
		color: var(--text-normal);
		border-color: var(--interactive-accent);
	}

	.ratel-memory-filters button.active {
		background: color-mix(in srgb, var(--interactive-accent) 15%, transparent);
		color: var(--interactive-accent);
		border-color: var(--interactive-accent);
		font-weight: 500;
	}

	/* ==================== 错误提示 ==================== */
	.ratel-memory-error {
		flex-shrink: 0;
		padding: 8px 10px;
		border-radius: 6px;
		background: color-mix(in srgb, var(--text-error) 8%, transparent);
		border: 1px solid color-mix(in srgb, var(--text-error) 15%, transparent);
		color: var(--text-error);
		font-size: 11px;
		margin-bottom: 8px;
	}

	/* ==================== 内容主体 ==================== */
	.ratel-memory-body {
		flex: 1;
		overflow-y: auto;
		padding: 4px 0;
	}

	.ratel-memory-body details {
		margin-bottom: 8px;
	}

	.ratel-memory-body summary {
		padding: 4px 6px;
		font-size: 12px;
		font-weight: 600;
		color: var(--text-normal);
		cursor: pointer;
		border-radius: 4px;
		transition: background 0.15s;
	}

	.ratel-memory-body summary:hover {
		background: var(--background-modifier-hover);
	}

	.ratel-memory-summary {
		font-weight: 400;
		color: var(--text-muted);
		font-size: 11px;
		margin-left: 6px;
	}

	/* ==================== 条目 ==================== */
	.ratel-memory-entry {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		padding: 6px 8px 6px 16px;
		border-radius: 6px;
		transition: background 0.15s;
	}

	.ratel-memory-entry:hover {
		background: var(--background-modifier-hover);
	}

	.ratel-memory-entry:hover .ratel-memory-actions {
		opacity: 1;
	}

	.ratel-memory-icon {
		flex-shrink: 0;
		font-size: 12px;
		line-height: 1.4;
	}

	.ratel-memory-content {
		flex: 1;
		word-break: break-word;
		color: var(--text-normal);
	}

	.ratel-memory-actions {
		flex-shrink: 0;
		display: flex;
		gap: 2px;
		opacity: 0;
		transition: opacity 0.15s;
	}

	.ratel-memory-actions button {
		width: 22px;
		height: 22px;
		padding: 0;
		border: none;
		border-radius: 4px;
		background: transparent;
		color: var(--text-muted);
		font-size: 12px;
		cursor: pointer;
		transition: background 0.15s, color 0.15s;
	}

	.ratel-memory-actions button:hover {
		background: var(--background-modifier-hover);
		color: var(--text-normal);
	}

	.ratel-memory-actions button.mod-warning:hover {
		color: var(--text-error);
	}

	/* ==================== 行内编辑 ==================== */
	.ratel-memory-edit {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.ratel-memory-edit textarea {
		width: 100%;
		min-height: 50px;
		padding: 6px 8px;
		border-radius: 6px;
		border: 1px solid var(--interactive-accent);
		background: var(--background-modifier-form-field);
		color: var(--text-normal);
		font-family: inherit;
		font-size: 12px;
		resize: vertical;
		outline: none;
	}

	.ratel-memory-edit-actions {
		display: flex;
		gap: 4px;
		justify-content: flex-end;
	}

	.ratel-memory-edit-actions button {
		padding: 3px 10px;
		border-radius: 5px;
		border: 1px solid var(--background-modifier-border);
		background: var(--background-secondary);
		color: var(--text-normal);
		font-size: 11px;
		font-family: inherit;
		cursor: pointer;
		transition: all 0.15s;
	}

	.ratel-memory-edit-actions button:first-child {
		background: var(--interactive-accent);
		color: var(--text-on-accent);
		border-color: var(--interactive-accent);
	}

	.ratel-memory-edit-actions button:hover {
		opacity: 0.85;
	}

	/* ==================== 空状态 ==================== */
	.ratel-memory-empty {
		padding: 8px 16px;
		color: var(--text-faint);
		font-size: 11px;
		font-style: italic;
	}

	/* ==================== 底部状态栏 ==================== */
	.ratel-memory-footer {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding-top: 8px;
		border-top: 1px solid var(--background-modifier-border);
	}

	.ratel-memory-size {
		font-size: 11px;
		color: var(--text-muted);
		font-family: var(--font-monospace);
	}

	.ratel-memory-clear {
		padding: 4px 10px;
		border-radius: 6px;
		border: 1px solid color-mix(in srgb, var(--text-error) 30%, transparent);
		background: color-mix(in srgb, var(--text-error) 8%, transparent);
		color: var(--text-error);
		font-size: 11px;
		font-family: inherit;
		cursor: pointer;
		transition: all 0.15s;
	}

	.ratel-memory-clear:hover {
		background: color-mix(in srgb, var(--text-error) 15%, transparent);
		border-color: var(--text-error);
	}

	/* ==================== Modal 按钮(inline 编辑用) ==================== */
	:global(.ratel-memory-modal-btns) {
		display: flex;
		gap: 8px;
		justify-content: flex-end;
		margin-top: 12px;
	}

	:global(.ratel-memory-modal-btns button) {
		padding: 5px 14px;
		border-radius: 6px;
		border: 1px solid var(--background-modifier-border);
		background: var(--background-secondary);
		color: var(--text-normal);
		font-size: 12px;
		cursor: pointer;
	}

	:global(.ratel-memory-modal-btns button.mod-warning) {
		background: var(--text-error);
		color: var(--text-on-accent);
		border-color: var(--text-error);
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-memory-search,
		.ratel-memory-filters button,
		.ratel-memory-body summary,
		.ratel-memory-entry,
		.ratel-memory-actions button,
		.ratel-memory-clear {
			transition: none;
		}
	}
</style>
