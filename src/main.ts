/**
 * @file src/main.ts
 * @description Ratel Vault 插件入口 — 生命周期、命令、视图注册
 * @module main
 * @depends obsidian, settings, types, core/*, adapters/*, ports/*, worker/*, tools/*, ui/*
 */

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

/**
 * Ratel Vault 插件主类。
 *
 * 设计要点:
 * - `onload` 保持轻量:实例化适配器 / 注册命令 / 注册视图;重活(索引)推给 Worker。
 * - 所有 Obsidian API 访问都经过 `this.vault` / `this.persistence`,不直接 `import 'obsidian'` 调用。
 * - `onunload` 必须先 `workerManager.destroy()` 释放 Worker 进程。
 */
export default class RatelVaultPlugin extends Plugin {
	settings!: RatelVaultSettings;
	vault!: ObsidianVault;
	persistence!: PersistenceJson;
	llm!: DeepSeekLLM;
	embedding!: EmbeddingPort;
	tools!: ToolRegistry;
	hooks!: HookRegistry;
	workerManager!: WorkerManager;

	/**
	 * Obsidian 插件生命周期入口。
	 *
	 * 关键路径:
	 * 1. 先 `loadSettings` 拿到配置,再据此构造各适配器(避免重复重建)。
	 * 2. Embedding 适配器按 `embedProvider` 二选一,不在插件内做运行时切换。
	 * 3. Worker 路径必须是编译后的 `worker.js`,与 `main.js` 同目录。
	 */
	async onload() {
		await this.loadSettings();

		// ==================== 适配器装配 ====================
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

		// Embedding 适配器:本地 ONNX vs 远端 OpenAI 兼容端点,按设置二选一。
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

		// ==================== Worker ====================
		// 关键路径:`__dirname` 在 esbuild 编译后指向 main.js 同目录,worker.js 必须存在。
		const workerPath = path.join(__dirname, 'worker.js');
		const worker = new Worker(workerPath);
		this.workerManager = new WorkerManager(worker);

		// ==================== 工具与钩子 ====================
		this.tools = new ToolRegistry();
		this.tools.register(createReadNoteTool(this.vault));
		this.hooks = new HookRegistry();

		// ==================== 视图与命令 ====================
		this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this));

		// Ribbon 图标:点击打开聊天侧栏。
		this.addRibbonIcon('brain', 'Ratel', () => {
			this.activateChatView();
		});

		// 命令:Ask vault — 唤起聊天侧栏。
		this.addCommand({
			id: 'ask-vault',
			name: 'Ask vault',
			callback: () => {
				this.activateChatView();
			},
		});

		// 命令:索引状态 — 通过 Worker 拉取,UI 通过 Notice 提示。
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

		// 设置面板
		this.addSettingTab(new RatelVaultSettingTab(this.app, this));

		console.log('Ratel loaded');
	}

	/**
	 * 插件卸载 — 释放 Worker 进程,避免残留。
	 *
	 * 关键路径:Obsidian 热重载会触发 `onunload`,此时必须清理 Worker,
	 * 否则下次 onload 会创建第二个 Worker 进程,最终 OOM。
	 */
	onunload() {
		this.workerManager.destroy();
		console.log('Ratel unloaded');
	}

	/**
	 * 加载并合并默认设置与已存设置。
	 *
	 * 关键路径:用 `Object.assign` 浅合并 — 设置项都是原始类型,无需深拷贝。
	 */
	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<RatelVaultSettings>,
		);
	}

	/** 持久化当前设置到 Obsidian data.json。 */
	async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * 聊天入口 — ChatView 通过此方法流式消费 AgentEvent。
	 *
	 * 关键路径:每次调用都新建一个 `ContextManager`,不跨调用复用状态,
	 * 保证会话隔离。
	 *
	 * @param sessionId - 会话 ID,关联到 Persistence 存储。
	 * @param message - 用户最新一条消息。
	 * @returns 异步迭代的 `AgentEvent` 流。
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

	/**
	 * 唤起或聚焦聊天侧栏 — 幂等,已存在则 reveal,否则在右侧栏创建。
	 */
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
