import { App, PluginSettingTab, Setting } from 'obsidian';
import RatelVaultPlugin from './main';

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

export class RatelVaultSettingTab extends PluginSettingTab {
	plugin: RatelVaultPlugin;

	constructor(app: App, plugin: RatelVaultPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Chat Model
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

		// Embedding Model
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
						this.display(); // Refresh to show/hide fields
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

		// Reranker (optional — auto-enabled when API Key is provided)
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
						// Auto-fill API base for known providers
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

		// Indexing
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

		// Link Suggestions
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
