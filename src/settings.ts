/**
 * @file src/settings.ts
 * @description Ratel Vault 设置项定义 + Obsidian 设置面板渲染
 * @module settings
 * @depends obsidian, ./main
 */

import { App, PluginSettingTab, Setting } from 'obsidian';
import RatelVaultPlugin from './main';
import { createTabBar } from './ui/diagnostics/tab-bar';
import { renderEmbeddingTest } from './ui/diagnostics/embedding-test';
import { renderLLMTest } from './ui/diagnostics/llm-test';
import { renderRerankPlaceholder } from './ui/diagnostics/rerank-placeholder';
import { ensureDiagStyles } from './ui/diagnostics/diag-utils';
import { devLogger } from './logging/dev-logger';
import type { ToolPermission } from './core/tool-permissions';
import { renderSecretHint, renderNoKeyNeeded } from './ui/secret-hint';
import {
	getChatSecretId,
	getEmbedSecretId,
	getRerankSecretId,
	hasChatApiKey,
	hasEmbedApiKey,
	hasRerankApiKey,
} from './secrets/ratel-secrets';

/**
 * 全部用户可配置项。
 *
 * - Chat:DeepSeek / OpenAI 兼容协议的 LLM 配置。
 * - Embedding:本地 ONNX(`local`)或远端 OpenAI 兼容端点(`api`)。
 * - Reranker:可选,API Key 留空即视为关闭。
 * - Indexing:分块大小 / 重叠 / 是否自动重建。
 * - Link Suggestions:写笔记后是否自动建议链接 + 阈值。
 */
export interface RatelVaultSettings {
	// Chat
	chatModel: string;
	chatApiBase: string;
	/** 模型上下文窗口上限(token) — 用于 StatusLine 上下文使用率计算,默认 32000 */
	chatModelMaxTokens: number;

	// Embedding
	embedProvider: 'local' | 'api';
	embedLocalModel: string;
	embedLocalDimensions: number;
	embedApiBase: string;
	embedApiModel: string;
	embedApiDimensions: number;

	// Reranker (百炼,可选 — 钥匙串有 ratel-rerank-bailian 即启用)
	rerankerApiBase: string;
	rerankerModel: string;

	// Indexing
	chunkSize: number;
	chunkOverlap: number;
	autoIndex: boolean;
	// 关键路径:indexPaused 由用户在设置面板切换;true 时 IndexManager 不消费队列但仍入队,供用户按需恢复。
	indexPaused: boolean;
	// 关键路径:embedModelActive 记录当前激活的本地 Embedding 模型 id(支持后续切模型)。
	embedModelActive: string;
	// 关键路径:embedAvailableModels 列出可下载的模型(尺寸/维度/推荐位),UI 设置面板展示。
	embedAvailableModels: Array<{ id: string; sizeBytes: number; dimensions: number; recommended: boolean }>;
	// 关键路径:embedDownloadedModels 记录用户已下载到本地的模型 id,切换/清理用。
	embedDownloadedModels: string[];

	// Link Suggestions
	autoSuggestLinks: boolean;
	linkConfidenceThreshold: number;

	// Developer
	debugLog: boolean;
	/** Agent Loop 最大步数上限 — 防止工具调用死循环,默认 50(见 ADR-004) */
	agentMaxSteps: number;

	// Tool permissions (S-VAULT-TOOLS)
	toolPermissions: Record<string, ToolPermission>;
	trustMode: boolean;
}

/**
 * 默认设置 — 首次安装时写入 data.json 的初值。
 *
 * 关键路径:`embedApiBase` 默认 `http://localhost:11434/v1` 适配本地 Ollama,
 * 用户无需任何配置就能跑通端到端检索。
 */
export const DEFAULT_SETTINGS: RatelVaultSettings = {
	chatModel: 'deepseek-chat',
	chatApiBase: 'https://api.deepseek.com',
	// 关键路径:多数 OpenAI 兼容端点(deepseek-chat、qwen-plus)窗口 32K-128K,默认 32K 安全值。
	chatModelMaxTokens: 32000,

	embedProvider: 'local',
	embedLocalModel: 'Xenova/bge-small-zh-v1.5',
	embedLocalDimensions: 512,
	embedApiBase: 'http://localhost:11434/v1',
	embedApiModel: 'bge-m3',
	embedApiDimensions: 1024,

	// 关键路径:Rerank v1 仅支持百炼 DashScope compatible-api,密钥走钥匙串。
	rerankerApiBase: 'https://dashscope.aliyuncs.com/compatible-api/v1',
	rerankerModel: 'qwen3-rerank',

	chunkSize: 500,
	chunkOverlap: 100,
	autoIndex: true,
	// 关键路径:索引暂停默认关闭,起飞期 IndexManager 状态 = Init → Ready,正常消费队列。
	indexPaused: false,
	// 关键路径:默认激活 bge-small-zh-v1.5(ONNX 量化模型约 24MB,多数用户零感知下载)。
	embedModelActive: 'Xenova/bge-small-zh-v1.5',
	// 关键路径:本地模式仅内置 bge-small-zh-v1.5,ONNX 量化模型约 24MB;其他模型走 API 配置。
	embedAvailableModels: [
		{ id: 'Xenova/bge-small-zh-v1.5', sizeBytes: 24 * 1024 * 1024, dimensions: 512, recommended: true },
	],
	embedDownloadedModels: [],

	autoSuggestLinks: true,
	linkConfidenceThreshold: 0.75,

	debugLog: false,
	// 关键路径:50 步覆盖知识库场景(1 glob + N read + 分析 + write),见 ADR-004。
	agentMaxSteps: 50,

	toolPermissions: {
		search_vault: 'allow',
		read_note: 'allow',
		grep: 'allow',
		glob: 'allow',
		list_files: 'allow',
		write_note: 'ask',
		append_note: 'ask',
		edit_note: 'ask',
		delete_note: 'ask',
	},
	trustMode: false,
};

/**
 * Obsidian 设置面板 — 把 `RatelVaultSettings` 渲染为分组表单。
 *
 * 设计要点:
 * - 切换 Embedding Provider 时调 `this.display()` 整体重渲染,显示对应字段。
 * - Reranker Provider 切换时自动填入官方默认 `apiBase`,减少用户输入。
 * - `onChange` 立即写盘(`saveSettings`),无需"保存"按钮。
 */
export class RatelVaultSettingTab extends PluginSettingTab {
	plugin: RatelVaultPlugin;

	constructor(app: App, plugin: RatelVaultPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * 渲染整个设置面板。
	 *
	 * 关键路径:每次 Provider 切换会再调一次 `display()`,
	 * 整体清空再重建,保证字段组互斥显示(local / api 二选一)。
	 *
	 * 面板分为两个主 Tab:
	 * - 「常规设置」:所有配置项(原有内容)
	 * - 「诊断测试」:Embedding / LLM / Rerank 调试工具
	 */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		ensureDiagStyles();

		// 主 Tab 栏
		const mainTabBar = containerEl.createDiv({ cls: 'diag-tabs' });
		const mainContent = containerEl.createDiv();

		const settingsBtn = mainTabBar.createEl('button', { cls: 'diag-tab diag-tab-active', text: '常规设置' });
		const diagBtn = mainTabBar.createEl('button', { cls: 'diag-tab', text: '诊断测试' });

		const activateMain = (which: 'settings' | 'diag') => {
			mainContent.empty();
			if (which === 'settings') {
				settingsBtn.addClass('diag-tab-active');
				diagBtn.removeClass('diag-tab-active');
				this.renderSettings(mainContent);
			} else {
				diagBtn.addClass('diag-tab-active');
				settingsBtn.removeClass('diag-tab-active');
				this.renderDiagnostics(mainContent);
			}
		};

		settingsBtn.addEventListener('click', () => activateMain('settings'));
		diagBtn.addEventListener('click', () => activateMain('diag'));

		activateMain('settings');
	}

	/**
	 * 渲染常规设置面板(原有配置项)。
	 *
	 * 关键路径:display() 中切到"常规设置"Tab 时调用;
	 * Provider 切换触发的 display() 重入也会回到这里。
	 */
	private renderSettings(containerEl: HTMLElement): void {
		// ==================== Chat ====================
		containerEl.createEl('h2', { text: 'Chat Model' });

		new Setting(containerEl)
			.setName('Model')
			.setDesc('Chat model identifier')
			.addText((text) =>
				text
					.setPlaceholder('deepseek-chat')
					.setValue(this.plugin.settings.chatModel)
					.onChange(async (value) => {
						this.plugin.settings.chatModel = value;
						await this.plugin.saveSettings();
						// 关键路径:模型标识变更需重建 LLM,新值才在请求里生效。
						this.plugin.rebuildLLM();
					}),
			);

		new Setting(containerEl)
		.setName('API Base URL')
		.setDesc('Chat model API base URL')
		.addText((text) =>
			text
				.setPlaceholder('https://api.deepseek.com')
				.setValue(this.plugin.settings.chatApiBase)
				.onChange(async (value) => {
					this.plugin.settings.chatApiBase = value;
					await this.plugin.saveSettings();
					// 关键路径:换 base URL(切到其他 OpenAI 兼容端点)需重建 LLM。
					this.plugin.rebuildLLM();
				}),
		);

	// 关键路径:API Key 从 Obsidian 钥匙串读取,设置页只展示密钥名与状态。
	{
		const chatSecretId = getChatSecretId(this.plugin.settings);
		if (chatSecretId) {
			renderSecretHint(containerEl, {
				secretId: chatSecretId,
				hasKey: hasChatApiKey(this.app, this.plugin.settings),
			});
		} else {
			renderNoKeyNeeded(containerEl, '当前为本地 Ollama,无需 API Key。');
		}
	}

		// ==================== Embedding ====================
		containerEl.createEl('h2', { text: 'Embedding Model' });

		new Setting(containerEl)
			.setName('Provider')
			.setDesc('Local uses built-in ONNX model (zero-config). API uses OpenAI-compatible endpoint (Ollama/SiliconFlow/etc).')
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({ local: 'Local (built-in)', api: 'API (external)' })
					.setValue(this.plugin.settings.embedProvider)
					.onChange(async (value: string) => {
						this.plugin.settings.embedProvider = value as 'local' | 'api';
						await this.plugin.saveSettings();
						// 关键路径:切 provider 需重建 Embedding 适配器(local / api 是不同实现)。
						this.plugin.rebuildEmbeddingAdapter();
						// 关键路径:切 provider 后整体重渲染,显示对应字段组。
						this.display();
					}),
			);

		if (this.plugin.settings.embedProvider === 'local') {
			new Setting(containerEl)
				.setName('Model')
				.setDesc('本地默认模型为 bge-small-zh-v1.5,首次启用时自动从 ModelScope 下载 ONNX 权重与词表。')
				.addText((text) => {
					// 关键路径:当前仅内置一个本地模型,输入框只读展示,避免用户误改为未实现的模型。
					text.setValue(this.plugin.settings.embedLocalModel).setDisabled(true);
				});
		} else {
			new Setting(containerEl)
				.setName('API Base URL')
				.setDesc('Embedding API base URL (Ollama: http://localhost:11434/v1)')
				.addText((text) =>
					text
						.setPlaceholder('http://localhost:11434/v1')
						.setValue(this.plugin.settings.embedApiBase)
						.onChange(async (value) => {
							this.plugin.settings.embedApiBase = value;
							await this.plugin.saveSettings();
							// 关键路径:换 base URL 需重建 Embedding 适配器。
							this.plugin.rebuildEmbeddingAdapter();
						}),
				);

			// 关键路径:Embed API Key 从钥匙串读取,设置页展示密钥名与状态。
			{
				const embedSecretId = getEmbedSecretId(this.plugin.settings);
				if (embedSecretId) {
					renderSecretHint(containerEl, {
						secretId: embedSecretId,
						hasKey: hasEmbedApiKey(this.app, this.plugin.settings),
					});
				} else {
					renderNoKeyNeeded(containerEl, '当前为本地 Ollama Embedding,无需 API Key。');
				}
			}

			new Setting(containerEl)
				.setName('Model')
				.setDesc('Embedding model identifier')
				.addText((text) =>
					text
						.setPlaceholder('bge-m3')
						.setValue(this.plugin.settings.embedApiModel)
						.onChange(async (value) => {
							this.plugin.settings.embedApiModel = value;
							await this.plugin.saveSettings();
							// 关键路径:换 API 模型需重建 Embedding 适配器。
							this.plugin.rebuildEmbeddingAdapter();
						}),
				);
		}

		// ==================== Reranker ====================
		containerEl.createEl('h2', { text: 'Reranker (百炼,可选)' });

		new Setting(containerEl)
			.setName('API Base URL')
			.setDesc('Reranker API base URL(百炼 DashScope compatible-api)')
			.addText((text) =>
				text
					.setValue(this.plugin.settings.rerankerApiBase)
					.onChange(async (value) => {
						this.plugin.settings.rerankerApiBase = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Model')
			.setDesc('Reranker model identifier')
			.addText((text) =>
				text
					.setValue(this.plugin.settings.rerankerModel)
					.onChange(async (value) => {
						this.plugin.settings.rerankerModel = value;
						await this.plugin.saveSettings();
					}),
			);

		// 关键路径:Rerank 密钥走钥匙串,未配置时 Rerank 自动关闭。
	renderSecretHint(containerEl, {
		secretId: getRerankSecretId(),
		hasKey: hasRerankApiKey(this.app),
		note: '未配置密钥时 Rerank 自动关闭。',
	});

		// ==================== Indexing ====================
		containerEl.createEl('h2', { text: 'Indexing' });

		new Setting(containerEl)
			.setName('Chunk size (tokens)')
			.setDesc('Number of tokens per chunk')
			.addSlider((slider) =>
				slider
					.setLimits(100, 1000, 50)
					.setValue(this.plugin.settings.chunkSize)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.chunkSize = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Chunk overlap (tokens)')
			.setDesc('Overlap between chunks')
			.addSlider((slider) =>
				slider
					.setLimits(0, 200, 10)
					.setValue(this.plugin.settings.chunkOverlap)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.chunkOverlap = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Auto index')
			.setDesc('Automatically re-index on file changes')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoIndex)
					.onChange(async (value) => {
						this.plugin.settings.autoIndex = value;
						await this.plugin.saveSettings();
					}),
			);

		// ==================== Link Suggestions ====================
		containerEl.createEl('h2', { text: 'Link Suggestions' });

		new Setting(containerEl)
			.setName('Auto suggest links')
			.setDesc('Automatically suggest links after writing')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoSuggestLinks)
					.onChange(async (value) => {
						this.plugin.settings.autoSuggestLinks = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Confidence threshold')
			.setDesc('Minimum similarity to suggest a link')
			.addSlider((slider) =>
				slider
					.setLimits(0.5, 1.0, 0.05)
					.setValue(this.plugin.settings.linkConfidenceThreshold)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.linkConfidenceThreshold = value;
						await this.plugin.saveSettings();
					}),
			);

		// ==================== Tool Permissions ====================
		this.renderToolPermissions(containerEl);

		// ==================== Developer ====================
		containerEl.createEl('h2', { text: '开发者' });

		new Setting(containerEl)
			.setName('Debug 日志')
			.setDesc('在控制台输出 [Ratel:*] debug 级日志')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.debugLog)
					.onChange(async (value) => {
						this.plugin.settings.debugLog = value;
						await this.plugin.saveSettings();
						devLogger.setDebugEnabled(value);
					}),
			);

		new Setting(containerEl)
			.setName('Agent 最大步数')
			.setDesc('Agent Loop 工具调用循环上限,防止死循环(见 ADR-004)')
			.addSlider((slider) =>
				slider
					.setLimits(5, 200, 5)
					.setValue(this.plugin.settings.agentMaxSteps)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.agentMaxSteps = value;
						await this.plugin.saveSettings();
					}),
			);
	}

	private renderToolPermissions(container: HTMLElement): void {
		container.createEl('h2', { text: '工具权限' });

		new Setting(container)
			.setName('信任模式')
			.setDesc('开启后所有工具直接执行,不再弹出确认对话框')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.trustMode).onChange(async (v) => {
					this.plugin.settings.trustMode = v;
					await this.plugin.saveSettings();
				}),
			);

		const readonlyTools = ['search_vault', 'read_note', 'grep', 'glob', 'list_files'];
		const writeTools = ['write_note', 'append_note', 'edit_note', 'delete_note'];
		const labels: Record<string, string> = {
			search_vault: '语义搜索',
			read_note: '读取笔记',
			grep: '精确搜索',
			glob: '文件名匹配',
			list_files: '列目录',
			write_note: '创建/覆盖',
			append_note: '追加内容',
			edit_note: '精确替换',
			delete_note: '移到回收站',
		};
		const options: Record<ToolPermission, string> = { allow: '允许', ask: '询问', deny: '拒绝' };

		for (const name of [...readonlyTools, ...writeTools]) {
			new Setting(container)
				.setName(labels[name] ?? name)
				.setDesc(name)
				.addDropdown((dropdown) => {
					dropdown.addOption('allow', options.allow);
					dropdown.addOption('ask', options.ask);
					dropdown.addOption('deny', options.deny);
					dropdown.setValue(this.plugin.settings.toolPermissions[name] ?? 'ask');
					dropdown.onChange(async (v) => {
						this.plugin.settings.toolPermissions[name] = v as ToolPermission;
						await this.plugin.saveSettings();
					});
				});
		}
	}

	/**
	 * 渲染诊断测试面板 — Embedding / LLM / Rerank 三个子 Tab。
	 */
	private renderDiagnostics(containerEl: HTMLElement): void {
		containerEl.createEl('p', {
			text: '调试工具:用于验证 Embedding、LLM、Rerank 适配器是否正常工作。所有参数仅临时生效,不会修改插件配置。',
			attr: { style: 'color: var(--text-muted); margin-bottom: 16px; font-size: 13px;' },
		});

		createTabBar(containerEl, [
			{
				id: 'embedding',
				label: 'Embedding',
				render: (el) => renderEmbeddingTest(el, this.plugin),
			},
			{
				id: 'llm',
				label: 'LLM',
				render: (el) => renderLLMTest(el, this.plugin),
			},
			{
				id: 'rerank',
				label: 'Rerank',
				render: (el) => renderRerankPlaceholder(el, this.plugin),
			},
		], 'embedding');
	}
}
