/**
 * @file src/main.ts
 * @description Ratel Vault 插件入口 — 生命周期、命令、视图注册
 * @module main
 * @depends obsidian, settings, types, core/*, adapters/*, ports/*, worker/*, tools/*, ui/*
 */

import { FileSystemAdapter, Notice, Plugin } from 'obsidian';
import { Worker } from 'worker_threads';
import { type RatelVaultSettings, DEFAULT_SETTINGS, RatelVaultSettingTab } from './settings';

type FeatureExtractor = (texts: string[], options: Record<string, unknown>) => Promise<{ tolist: () => number[][] }>;
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
import { VectraStore } from './adapters/vector-vectra';
import type { EmbeddingsModel, EmbeddingsResponse } from 'vectra';
import { WorkerManager } from './worker/manager';
import { InlineWorker } from './worker/inline-worker';
import { createReadNoteTool } from './tools/read-note';
import { createSearchVaultTool } from './tools/search-vault';
import { ModelManager } from './core/model-manager';
import { IndexController } from './core/index-controller';
import { ModelDownloader } from './core/model-downloader';
import type { IndexBackend } from './core/index-manager';
import { ChatView, VIEW_TYPE_CHAT } from './ui/ChatView';
import { ensurePluginGitignore } from './utils/gitignore-writer';
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
	// 关键路径:vectraStore 持有 vectra 索引目录的引用,需在 plugin 生命周期内常驻。
	vectraStore!: VectraStore;
	// 关键路径:InlineWorker 在主线程模拟 Worker,用于 Obsidian 渲染进程不支持 Worker Threads 的环境。
	private inlineWorker?: InlineWorker;
	// 关键路径:indexDir 在 onload 计算,onLayoutReady 初始化 InlineWorker 时需要复用。
	private indexDir!: string;
	modelManager!: ModelManager;
	indexController!: IndexController;

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
		this.rebuildEmbeddingAdapter();

		// ==================== 索引目录(启动期) ====================
		// 关键路径:`app.vault.adapter` 实际运行时是 `FileSystemAdapter`,
		// `getBasePath()` 是 FileSystemAdapter 的方法,DataAdapter 基类不暴露,需要类型断言。
		const adapter = this.app.vault.adapter as FileSystemAdapter;
		const vaultBase = adapter.getBasePath();
		const pluginDir = path.join(vaultBase, '.obsidian', 'plugins', 'ratel-vault');
		this.indexDir = path.join(pluginDir, '.index');
		// 关键路径:启动期 vectraStore 可能尚无 embeddings(本地模型在 onLayoutReady 才下载),
		// 因此只做目录占位;InlineWorker 场景下会在模型就绪后重新创建带 embeddings 的 store。
		this.vectraStore = new VectraStore(this.indexDir);
		ensurePluginGitignore(pluginDir);

		// ==================== Worker ====================
		// 关键路径:优先尝试 Node.js Worker Threads;Obsidian 渲染进程不支持时降级到 InlineWorker。
		// InlineWorker 在同线程执行,能解决 CORS/平台限制,但大索引会阻塞 UI。
		this.workerManager = this.createWorkerManager();

		// ==================== 模型与索引 ====================
		const modelBackend = new ModelDownloader();
		this.modelManager = new ModelManager(modelBackend);

		const indexBackend: IndexBackend = {
			fullReindex: async () => {
				const files = this.vault.listMarkdownFiles();
				const filtered: Array<{ path: string; content: string }> = [];
				for (const f of files) {
					const content = await this.vault.readFile(f);
					filtered.push({ path: f, content });
				}
				const response = await this.workerManager.request({
					type: 'index.full',
					payload: { files: filtered },
				});
				if (response.type === 'index.done') {
					return { indexed: response.payload.indexed, errors: response.payload.errors };
				}
				return { indexed: 0, errors: 1 };
			},
			incrementalIndex: async (file) => {
				const response = await this.workerManager.request({
					type: 'index.incremental',
					payload: { file },
				});
				if (response.type === 'index.done') {
					return { indexed: response.payload.indexed, errors: response.payload.errors };
				}
				return { indexed: 0, errors: 1 };
			},
			deleteFile: async (filePath) => {
				const response = await this.workerManager.request({
					type: 'index.delete',
					payload: { filePath },
				});
				if (response.type === 'index.done') {
					return response.payload.indexed;
				}
				return 0;
			},
		};

		// 关键路径:ObsidianVault 已实现 VaultEventListener 接口,直接传入可保证所有 Obsidian API 访问都走外观层。
		this.indexController = new IndexController(this.vault, indexBackend, vaultBase);

		// ==================== 工具与钩子 ====================
		this.tools = new ToolRegistry();
		this.tools.register(createReadNoteTool(this.vault));
		this.tools.register(createSearchVaultTool(this.embedding, this.workerManager));
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

		// 关键路径:Obsidian UI 布局就绪后再启动模型下载与索引,避免阻塞 onload。
		this.app.workspace.onLayoutReady(() => {
			void this.onLayoutReady();
		});
	}

	/**
	 * 布局就绪后启动模型下载与自动索引。
	 *
	 * 关键路径:
	 * - S-RAG-LOOP 仅支持本地 Embedding;API 模式跳过索引,避免 Worker 内发 HTTP。
	 * - 模型下载完成后把 extractor 注入 EmbeddingLocal,主线程与 Worker 才能生成向量。
	 */
	async onLayoutReady(): Promise<void> {
		// S-RAG-LOOP 仅支持本地 Embedding;API 模式跳过索引,避免 Worker 内发 HTTP。
		if (this.settings.embedProvider !== 'local') {
			new Notice('Ratel: API embedding 模式暂不支持自动索引,请切换到本地模型');
			return;
		}

		try {
			await this.modelManager.download(this.settings.embedLocalModel);
			const extractor = this.modelManager.getExtractor?.();
			if (extractor) {
				if (this.embedding instanceof EmbeddingLocal) {
					this.embedding.setExtractor(extractor as Parameters<EmbeddingLocal['setExtractor']>[0]);
				}
				// 关键路径:InlineWorker 在主线程运行,模型就绪后必须注入带 embeddings 的 VectraStore。
				if (this.inlineWorker) {
					this.vectraStore = this.createEmbeddingsVectraStore(extractor);
					this.inlineWorker.initWithStore(this.vectraStore);
				}
			}
			await this.indexController.onLayoutReady();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			new Notice(`Ratel 模型下载失败: ${message}`);
		}
	}

	/**
	 * 重建 LLM 适配器。
	 *
	 * 关键路径:LLM 在 onload 时一次性构造,内部捕获的是构造时的 apiKey / apiBase / model。
	 * 用户在设置面板改了这些字段后,内存里 settings 改了,data.json 也存了,
	 * 但已构造的 LLM 还指向旧值。重建一次让新 key 生效。
	 */
	rebuildLLM(): void {
		this.llm = new DeepSeekLLM({
			apiBase: this.settings.chatApiBase,
			apiKey: this.settings.chatApiKey,
			model: this.settings.chatModel,
		});
	}

	/**
	 * 重建 Embedding 适配器(按当前 `embedProvider` 二选一)。
	 *
	 * 关键路径:同 `rebuildLLM`,embedProvider 切换或 API 类字段改后必须重建。
	 */
	rebuildEmbeddingAdapter(): void {
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
	}

	/**
	 * 插件卸载 — 释放 Worker 进程,避免残留。
	 *
	 * 关键路径:Obsidian 热重载会触发 `onunload`,此时必须清理 Worker,
	 * 否则下次 onload 会创建第二个 Worker 进程,最终 OOM。
	 */
	onunload() {
		// 关键路径:先停 IndexController 释放 vault 事件订阅与 watcher,再终止 Worker。
		this.indexController.destroy();
		this.workerManager.destroy();
		// 关键路径:vectra 内部句柄释放,否则 reload 后会泄漏旧 index 引用。
		void this.vectraStore;
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
	async *ask(sessionId: string, message: string, signal?: AbortSignal): AsyncIterable<AgentEvent> {
		const ctx = new ContextManager(this.persistence);

		yield* agentLoop(
			{ sessionId, message },
			ctx,
			this.llm,
			this.tools,
			this.hooks,
			signal,
		);
	}

	/**
	 * 创建 WorkerManager,优先 Node.js Worker Threads,失败则降级 InlineWorker。
	 *
	 * 关键路径:
	 * - Obsidian 渲染进程的 V8 平台禁用了 Worker Threads,`new Worker()` 会抛错。
	 * - InlineWorker 复用主线程 VectraStore,避免双写;但初始化延迟到模型下载完成后。
	 */
	private createWorkerManager(): WorkerManager {
		const workerPath = path.join(__dirname, 'worker.js');
		const workerData =
			this.settings.embedProvider === 'local'
				? { indexDir: this.indexDir, modelId: this.settings.embedLocalModel }
				: { indexDir: this.indexDir };

		try {
			const worker = new Worker(workerPath, { workerData });
			return new WorkerManager(worker);
		} catch (err) {
			console.log('Ratel: Worker Threads 不可用,降级到 InlineWorker', err instanceof Error ? err.message : String(err));
			this.inlineWorker = new InlineWorker();
			return new WorkerManager(this.inlineWorker);
		}
	}

	/**
	 * 用已下载的 extractor 构造带 embeddings 的 VectraStore。
	 *
	 * 关键路径:worker/index.ts 在 Worker 线程内用同样方式包装 extractor;
	 * 主线程内复用该逻辑,保证 InlineWorker 与 Node Worker 行为一致。
	 */
	private createEmbeddingsVectraStore(extractor: unknown): VectraStore {
		const embeddings: EmbeddingsModel = {
			maxTokens: 8192,
			async createEmbeddings(inputs: string | string[]): Promise<EmbeddingsResponse> {
				const arr = Array.isArray(inputs) ? inputs : [inputs];
				const output = await (extractor as FeatureExtractor)(arr, { pooling: 'mean', normalize: true });
				return { status: 'success', output: output.tolist() };
			},
		};
		return new VectraStore(this.indexDir, { embeddings, autoInit: true });
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
