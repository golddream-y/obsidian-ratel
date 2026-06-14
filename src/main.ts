import { Notice, Plugin } from 'obsidian';
import { type RatelVaultSettings, DEFAULT_SETTINGS, RatelVaultSettingTab } from './settings';
import type { AgentEvent } from './types';
import { agentLoop } from './core/agent-loop';
import { ContextManager } from './core/context-manager';
import { HookRegistry } from './core/hooks';
import { ToolRegistry } from './core/tool-registry';
import { ObsidianVault } from './adapters/obsidian-vault';
import { PersistenceJson } from './adapters/persistence-json';
import { DeepSeekLLM } from './adapters/llm-deepseek';
import type { EmbeddingPort } from './ports/embedding';
import { EmbeddingLocal } from './adapters/embedding-local';
import { EmbeddingApi } from './adapters/embedding-api';
import { WorkerManager } from './worker/manager';
import { createReadNoteTool } from './tools/read-note';
import { ChatView, VIEW_TYPE_CHAT } from './ui/ChatView';
import path from 'path';

export default class RatelVaultPlugin extends Plugin {
	settings!: RatelVaultSettings;
	vault!: ObsidianVault;
	persistence!: PersistenceJson;
	llm!: DeepSeekLLM;
	embedding!: EmbeddingPort;
	tools!: ToolRegistry;
	hooks!: HookRegistry;
	workerManager!: WorkerManager;

	async onload() {
		await this.loadSettings();

		// Initialize adapters
		this.vault = new ObsidianVault(this.app);
		this.persistence = new PersistenceJson(
			() => this.loadData(),
			(data) => this.saveData(data),
		);
		this.llm = new DeepSeekLLM({
			apiBase: this.settings.chatApiBase,
			apiKey: this.settings.chatApiKey,
			model: this.settings.chatModel,
		});

		// Initialize embedding adapter
		if (this.settings.embedProvider === 'local') {
			this.embedding = new EmbeddingLocal(
				this.settings.embedLocalModel,
				this.settings.embedLocalDimensions,
			);
		} else {
			this.embedding = new EmbeddingApi({
				apiBase: this.settings.embedApiBase,
				apiKey: this.settings.embedApiKey,
				model: this.settings.embedApiModel,
				dimensions: this.settings.embedApiDimensions,
			});
		}

		// Initialize Worker
		const workerPath = path.join(__dirname, 'worker.js');
		const worker = new Worker(workerPath);
		this.workerManager = new WorkerManager(worker);

		// Initialize tools
		this.tools = new ToolRegistry();
		this.tools.register(createReadNoteTool(this.vault));

		// Initialize hooks
		this.hooks = new HookRegistry();

		// Register ChatView
		this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this));

		// Ribbon icon — opens chat sidebar
		this.addRibbonIcon('brain', 'Ratel', () => {
			this.activateChatView();
		});

		// Command: ask vault
		this.addCommand({
			id: 'ask-vault',
			name: 'Ask vault',
			callback: () => {
				this.activateChatView();
			},
		});

		// Command: index status
		this.addCommand({
			id: 'index-status',
			name: 'Show index status',
			callback: async () => {
				const response = await this.workerManager.request({
					type: 'index.status',
					payload: {},
				});
				if (response.type === 'index.status.result') {
					new Notice(`Index: ${response.payload.totalDocs} docs, last: ${new Date(response.payload.lastIndexTime).toLocaleString()}`);
				} else {
					new Notice('Index not available yet');
				}
			},
		});

		// Settings tab
		this.addSettingTab(new RatelVaultSettingTab(this.app, this));

		console.log('Ratel loaded');
	}

	onunload() {
		this.workerManager.destroy();
		console.log('Ratel unloaded');
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

	/**
	 * Main entry point for chat — called by ChatView.svelte.
	 * Returns an async iterable of AgentEvents for streaming UI updates.
	 */
	async *ask(sessionId: string, message: string): AsyncIterable<AgentEvent> {
		const ctx = new ContextManager(this.persistence);

		yield* agentLoop(
			{ sessionId, message },
			ctx,
			this.llm,
			this.tools,
			this.hooks,
		);
	}

	private async activateChatView() {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
		if (!leaf) {
			const rightLeaf = workspace.getRightLeaf(false);
			if (rightLeaf) {
				leaf = rightLeaf;
				await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
			}
		} else {
			workspace.revealLeaf(leaf);
		}
	}
}
