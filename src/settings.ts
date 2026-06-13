import { App, PluginSettingTab, Setting } from 'obsidian';
import RatelVaultPlugin from './main';

export interface RatelVaultSettings {
	chatModel: string;
	chatApiKey: string;
	chatApiBase: string;
	embedModel: string;
	embedApiKey: string;
	embedApiBase: string;
	chunkSize: number;
	chunkOverlap: number;
	autoIndex: boolean;
	autoSuggestLinks: boolean;
	linkConfidenceThreshold: number;
}

export const DEFAULT_SETTINGS: RatelVaultSettings = {
	chatModel: 'deepseek-chat',
	chatApiKey: '',
	chatApiBase: 'https://api.deepseek.com',
	embedModel: 'BAAI/bge-m3',
	embedApiKey: '',
	embedApiBase: 'https://api.siliconflow.cn/v1',
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
			.addText((text) =>
				text
					.setPlaceholder('sk-...')
					.setValue(this.plugin.settings.chatApiKey)
					.onChange(async (value) => {
						this.plugin.settings.chatApiKey = value;
						await this.plugin.saveSettings();
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
					}),
			);

		// Embedding Model
		containerEl.createEl('h2', { text: 'Embedding Model' });

		new Setting(containerEl)
			.setName('Model')
			.setDesc('Embedding model identifier')
			.addText((text) =>
				text
					.setPlaceholder('BAAI/bge-m3')
					.setValue(this.plugin.settings.embedModel)
					.onChange(async (value) => {
						this.plugin.settings.embedModel = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('API Key')
			.setDesc('Embedding model API key')
			.addText((text) => {
				text.inputEl.type = 'password';
				text
					.setPlaceholder('sk-...')
					.setValue(this.plugin.settings.embedApiKey)
					.onChange(async (value) => {
						this.plugin.settings.embedApiKey = value;
						await this.plugin.saveSettings();
					});
			},
		);

		new Setting(containerEl)
			.setName('API Base URL')
			.setDesc('Embedding model API base URL')
			.addText((text) =>
				text
					.setPlaceholder('https://api.siliconflow.cn/v1')
					.setValue(this.plugin.settings.embedApiBase)
					.onChange(async (value) => {
						this.plugin.settings.embedApiBase = value;
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
