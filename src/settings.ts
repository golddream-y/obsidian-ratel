/**
 * @file src/settings.ts
 * @description Ratel Vault 设置项定义 + Obsidian 设置面板渲染
 * @module settings
 * @depends obsidian, ./main
 */

import { App, PluginSettingTab, Setting } from 'obsidian';
import RatelVaultPlugin from './main';

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
	chatApiKey: string;
	chatApiBase: string;

	// Embedding
	embedProvider: 'local' | 'api';
	embedLocalModel: string;
	embedLocalDimensions: number;
	embedApiBase: string;
	embedApiKey: string;
	embedApiModel: string;
	embedApiDimensions: number;

	// Reranker (optional — auto-enabled when apiKey is set)
	rerankerProvider: 'cohere' | 'jina' | 'siliconflow' | 'custom';
	rerankerApiBase: string;
	rerankerApiKey: string;
	rerankerModel: string;

	// Indexing
	chunkSize: number;
	chunkOverlap: number;
	autoIndex: boolean;

	// Link Suggestions
	autoSuggestLinks: boolean;
	linkConfidenceThreshold: number;
}

/**
 * 默认设置 — 首次安装时写入 data.json 的初值。
 *
 * 关键路径:`embedApiBase` 默认 `http://localhost:11434/v1` 适配本地 Ollama,
 * 用户无需任何配置就能跑通端到端检索。
 */
export const DEFAULT_SETTINGS: RatelVaultSettings = {
	chatModel: 'deepseek-chat',
	chatApiKey: '',
	chatApiBase: 'https://api.deepseek.com',

	embedProvider: 'local',
	embedLocalModel: 'Xenova/bge-small-zh-v1.5',
	embedLocalDimensions: 512,
	embedApiBase: 'http://localhost:11434/v1',
	embedApiKey: '',
	embedApiModel: 'bge-m3',
	embedApiDimensions: 1024,

	rerankerProvider: 'cohere',
	rerankerApiBase: 'https://api.cohere.ai/v1',
	rerankerApiKey: '',
	rerankerModel: 'rerank-v3.5',

	chunkSize: 500,
	chunkOverlap: 100,
	autoIndex: true,

	autoSuggestLinks: true,
	linkConfidenceThreshold: 0.75,
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
	 */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

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
					}),
			);

		new Setting(containerEl)
			.setName('API Key')
			.setDesc('Chat model API key')
			.addText((text) => {
				// 关键路径:inputEl.type 改为 password 让浏览器 / Obsidian 隐藏输入。
				text.inputEl.type = 'password';
				text
					.setPlaceholder('sk-...')
					.setValue(this.plugin.settings.chatApiKey)
					.onChange(async (value) => {
						this.plugin.settings.chatApiKey = value;
						await this.plugin.saveSettings();
					});
			});

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
					}),
			);

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
						// 关键路径:切 provider 后整体重渲染,显示对应字段组。
						this.display();
					}),
			);

		if (this.plugin.settings.embedProvider === 'local') {
			new Setting(containerEl)
				.setName('Model')
				.setDesc('Local ONNX model identifier (from HuggingFace Xenova/ namespace)')
				.addText((text) =>
					text
						.setPlaceholder('Xenova/bge-small-zh-v1.5')
						.setValue(this.plugin.settings.embedLocalModel)
						.onChange(async (value) => {
							this.plugin.settings.embedLocalModel = value;
							await this.plugin.saveSettings();
						}),
				);
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
						}),
				);

			new Setting(containerEl)
				.setName('API Key')
				.setDesc('Embedding API key (leave empty for Ollama)')
				.addText((text) => {
					text.inputEl.type = 'password';
					text
						.setPlaceholder('sk-...')
						.setValue(this.plugin.settings.embedApiKey)
						.onChange(async (value) => {
							this.plugin.settings.embedApiKey = value;
							await this.plugin.saveSettings();
						});
				});

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
						}),
				);
		}

		// ==================== Reranker ====================
		containerEl.createEl('h2', { text: 'Reranker (Optional)' });

		new Setting(containerEl)
			.setName('Provider')
			.setDesc('Reranker API provider. Auto-enabled when API Key is set.')
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						cohere: 'Cohere',
						jina: 'Jina',
						siliconflow: 'SiliconFlow',
						custom: 'Custom',
					})
					.setValue(this.plugin.settings.rerankerProvider)
					.onChange(async (value: string) => {
						this.plugin.settings.rerankerProvider = value as RatelVaultSettings['rerankerProvider'];
						// 关键路径:切 provider 时自动填入官方默认 base,降低用户输入成本。
						const bases: Record<string, string> = {
							cohere: 'https://api.cohere.ai/v1',
							jina: 'https://api.jina.ai/v1',
							siliconflow: 'https://api.siliconflow.cn/v1',
						};
						if (bases[value]) {
							this.plugin.settings.rerankerApiBase = bases[value];
						}
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		new Setting(containerEl)
			.setName('API Base URL')
			.setDesc('Reranker API base URL')
			.addText((text) =>
				text
					.setValue(this.plugin.settings.rerankerApiBase)
					.onChange(async (value) => {
						this.plugin.settings.rerankerApiBase = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('API Key')
			.setDesc('Reranker API key. Leave empty to disable reranking.')
			.addText((text) => {
				text.inputEl.type = 'password';
				text
					.setValue(this.plugin.settings.rerankerApiKey)
					.onChange(async (value) => {
						this.plugin.settings.rerankerApiKey = value;
						await this.plugin.saveSettings();
					});
			});

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
	}
}
