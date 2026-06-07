import { Notice, Plugin } from 'obsidian';
import {
	type RatelVaultSettings,
	DEFAULT_SETTINGS,
	RatelVaultSettingTab,
} from './settings';

export default class RatelVaultPlugin extends Plugin {
	settings!: RatelVaultSettings;

	async onload() {
		await this.loadSettings();

		// Ribbon icon
		this.addRibbonIcon('brain', 'Ratel Vault', () => {
			new Notice('Ratel Vault activated!');
		});

		// Command: ask vault
		this.addCommand({
			id: 'ask-vault',
			name: 'Ask vault',
			callback: () => {
				new Notice('Ratel Vault: Ask vault (coming soon)');
			},
		});

		// Command: index status
		this.addCommand({
			id: 'index-status',
			name: 'Show index status',
			callback: () => {
				new Notice('Ratel Vault: Index status (coming soon)');
			},
		});

		// Settings tab
		this.addSettingTab(new RatelVaultSettingTab(this.app, this));

		console.log('Ratel Vault loaded');
	}

	onunload() {
		console.log('Ratel Vault unloaded');
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<RatelVaultSettings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
