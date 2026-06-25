/**
 * @file src/main.ts
 * @description Ratel Vault 插件入口 — 生命周期、命令、视图注册
 * @module main
 * @depends obsidian, settings, types, core/*, adapters/*, ports/*, worker/*, tools/*, ui/*
 */

import { FileSystemAdapter, Plugin } from 'obsidian';
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
import { EmbeddingApi } from './adapters/embedding-api';
import { EmbeddingLocal } from './adapters/embedding-local';
import { VectraStore } from './adapters/vector-vectra';
import type { EmbeddingsModel, EmbeddingsResponse } from 'vectra';
import { WorkerManager } from './worker/manager';
import { InlineWorker } from './worker/inline-worker';
import { createReadNoteTool } from './tools/read-note';
import { createSearchVaultTool } from './tools/search-vault';
import { ModelManager } from './core/model-manager';
import { IndexController } from './core/index-controller';
import { FeedbackController } from './core/feedback-controller';
import type { IndexBackend } from './core/index-manager';
import { devLogger } from './logging/dev-logger';
import { UserNotice } from './user-feedback/user-notice';
import { UserStatus } from './user-feedback/user-status';
import { isSearchReady } from './ui/chat-send-gate';
import { resolveChatApiKey, resolveEmbedApiKey } from './secrets/ratel-secrets';
import { ChatView, VIEW_TYPE_CHAT } from './ui/ChatView';
import { get } from 'svelte/store';
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
	userNotice = new UserNotice();
	userStatus = new UserStatus();
	private feedbackController?: FeedbackController;
	private workerMode: 'thread' | 'inline' = 'inline';

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
			// 关键路径:apiKey 不再存 settings,从 Obsidian 钥匙串按 chatApiBase 端点类型解析;
			// localhost Ollama 免 Key 返回 null → 空串透传给 LLM(本地服务不校验)。
			apiKey: resolveChatApiKey(this.app, this.settings) ?? '',
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
		// 关键路径:本地模型缓存放到插件目录,与 index 同级,便于随插件清理。
		// onnxruntime-web 使用 wasm bundle 入口(JS wrapper 内联),WASM 二进制文件
		// (ort-wasm-simd-threaded.wasm)由 esbuild 复制到 dist/,部署时与 main.js 一起
		// 放到插件目录(pluginDir)。用 pluginDir 定位而不是 __dirname,因为 Obsidian/Electron
		// 环境中 __dirname 可能指向 electron.asar 内部,导致 readFile 报 Invalid package 错误。
		const wasmPath = path.join(pluginDir, 'ort-wasm-simd-threaded.wasm');
		this.modelManager = new ModelManager(path.join(pluginDir, 'models'), wasmPath);

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
		this.tools.register(
			createSearchVaultTool(this.embedding, this.workerManager, () =>
				isSearchReady(get(this.userStatus.statusBar$)),
			),
		);
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
		// 关键路径:这是用户**主动命令**触发的反馈,Toast 是合理的"命令结果通知",
		// 与"系统事件提示"(模型下载/索引完成)语义不同,保留 userNotice.toast 形式。
		// 实时索引状态由 FeedbackController 持续推送到 StatusBar,无需在此命令中重复同步。
		this.addCommand({
			id: 'index-status',
			name: 'Show index status',
			callback: async () => {
				const response = await this.workerManager.request({
					type: 'index.status',
					payload: {},
				});
				if (response.type === 'index.status.result') {
					this.userNotice.toast(
						`Index: ${response.payload.totalDocs} docs, last: ${new Date(response.payload.lastIndexTime).toLocaleString()}`,
					);
				} else {
					this.userNotice.toast('Index not available yet');
				}
			},
		});

		// 设置面板
		this.addSettingTab(new RatelVaultSettingTab(this.app, this));

		devLogger.setDebugEnabled(this.settings.debugLog);
		this.feedbackController = new FeedbackController({
			modelStatus$: this.modelManager.status$,
			indexStatus$: this.indexController.indexManager.status$,
			userNotice: this.userNotice,
			userStatus: this.userStatus,
			getEmbeddingReady: () => !(this.embedding instanceof EmbeddingLocal) || this.embedding.isReady,
			getWorkerMode: () => this.workerMode,
			getSettings: () => this.settings,
		});
		this.feedbackController.start();

		// 关键路径:Obsidian UI 布局就绪后再启动模型下载与索引,避免阻塞 onload。
		this.app.workspace.onLayoutReady(() => {
			// 关键路径:onLayoutReady 失败会更新 status$ = Failed,
			// 显式 catch 仅兜底日志,避免 void 包装吞错(原版:下载失败静默无提示)。
			this.onLayoutReady().catch((err) => {
				devLogger.error('main', 'onLayoutReady 失败', err);
			});
		});
	}

	/**
	 * 布局就绪后启动模型下载与自动索引。
	 *
	 * 关键路径:
	 * - 本地 Embedding 模型从 ModelScope 下载 ONNX + vocab.txt(约 24MB)。
	 * - 下载期间通过 Notice 实时显示进度,避免用户误以为插件无响应。
	 * - 模型就绪后把 EmbeddingOnnx 同时设给主线程 embedding 与 InlineWorker 的 VectraStore。
	 */
	async onLayoutReady(): Promise<void> {
		// 关键路径:API embedding 模式不需要本地模型,也不触发自动索引;用户提示由 FeedbackController 处理。
		if (this.settings.embedProvider !== 'local') {
			return;
		}

		// 关键路径:全量索引进度由 Worker 回调驱动;FeedbackController 仅更新 statusBar,不弹 progress Notice。
		const indexProgressRef: {
			handle: ReturnType<UserNotice['toastProgress']> | null;
		} = { handle: null };
		this.workerManager.setProgressCallback((done, total) => {
			const message = `Ratel: 正在索引... ${done}/${total} 个文件`;
			if (!indexProgressRef.handle) {
				indexProgressRef.handle = this.userNotice.toastProgress(message);
			} else {
				indexProgressRef.handle.update(message);
			}
		});

		try {
			await this.modelManager.download();

			const embedding = this.modelManager.getEmbedding();
			if (embedding) {
				// 关键路径:把 ONNX 适配器注入占位器,search-vault 等工具透明可用。
				if (this.embedding instanceof EmbeddingLocal) {
					this.embedding.setEmbedding(embedding);
				}
				// 关键路径:InlineWorker 在主线程运行,模型就绪后必须注入带 embeddings 的 VectraStore。
				if (this.inlineWorker) {
					this.vectraStore = this.createEmbeddingsVectraStore(embedding);
					this.inlineWorker.initWithStore(this.vectraStore);
				}
			}

			const indexResult = await this.indexController.onLayoutReady();
			indexProgressRef.handle?.hide();
			indexProgressRef.handle = null;
			if (indexResult) {
				this.feedbackController?.notifyFullIndexComplete(indexResult.indexed, indexResult.errors);
			}
		} catch (err) {
			indexProgressRef.handle?.hide();
			const message = err instanceof Error ? err.message : String(err);
			devLogger.error('main', 'onLayoutReady 失败', err);
			this.userNotice.toastError(`Ratel 错误: ${message}`);
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
			// 关键路径:apiKey 不再存 settings,从 Obsidian 钥匙串按 chatApiBase 端点类型解析;
			// localhost Ollama 免 Key 返回 null → 空串透传给 LLM(本地服务不校验)。
			apiKey: resolveChatApiKey(this.app, this.settings) ?? '',
			model: this.settings.chatModel,
		});
	}

	/**
	 * 重建 Embedding 适配器(按当前 `embedProvider` 二选一)。
	 *
	 * 关键路径:同 `rebuildLLM`,embedProvider 切换或 API 类字段改后必须重建。
	 * 本地模式使用占位适配器,真实 EmbeddingOnnx 在 ModelManager 下载完成后注入。
	 */
	rebuildEmbeddingAdapter(): void {
		if (this.settings.embedProvider === 'local') {
			this.embedding = new EmbeddingLocal();
		} else {
			this.embedding = new EmbeddingApi({
				apiBase: this.settings.embedApiBase,
				// 关键路径:apiKey 走钥匙串;builtin / ollama-local 返回 null → 空串透传。
				apiKey: resolveEmbedApiKey(this.app, this.settings) ?? '',
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
		this.feedbackController?.destroy();
		this.userStatus.reset();
		// 关键路径:先停 IndexController 释放 vault 事件订阅与 watcher,再终止 Worker。
		this.indexController.destroy();
		this.workerManager.destroy();
		// 修复:VectraStore 无显式 close,JS 垃圾回收会释放文件句柄;
		// 之前的 `void this.vectraStore;` 是空操作,已移除。
		devLogger.info('main', 'Ratel unloaded');
	}

	/**
	 * 加载并合并默认设置与已存设置。
	 *
	 * 关键路径:用 `Object.assign` 浅合并 — 设置项都是原始类型,无需深拷贝。
	 *
	 * 修复:S-KEYCHAIN 已将 API Key 迁至 Obsidian 钥匙串,旧版 data.json 可能残留
	 * `chatApiKey` / `embedApiKey` / `rerankerApiKey` / `rerankerProvider` 明文字段。
	 * 这里在合并后一次性清理内存对象,避免老字段污染 settings;下次 `saveSettings`
	 * 会用清理后的对象自然覆盖 data.json,完成一次性迁移。
	 */
	async loadSettings() {
		const loaded = (await this.loadData()) as Partial<RatelVaultSettings> & {
			chatApiKey?: string;
			embedApiKey?: string;
			rerankerApiKey?: string;
			rerankerProvider?: string;
		};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
		// 修复:S-KEYCHAIN 之前的明文残留字段,下次 saveSettings 会用清理后的对象自然覆盖 data.json。
		const legacy = this.settings as unknown as Record<string, unknown>;
		delete legacy.chatApiKey;
		delete legacy.embedApiKey;
		delete legacy.rerankerApiKey;
		delete legacy.rerankerProvider;
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
	 * 创建 WorkerManager,使用 InlineWorker。
	 *
	 * 关键路径:
	 * - Obsidian 渲染进程的 V8 平台禁用了 Worker Threads(见 ADR-002),
	 *   直接创建 InlineWorker,不做 try/catch 降级。
	 * - InlineWorker 复用主线程 VectraStore,避免双写;但初始化延迟到模型下载完成后。
	 */
	private createWorkerManager(): WorkerManager {
		this.workerMode = 'inline';
		this.inlineWorker = new InlineWorker();
		return new WorkerManager(this.inlineWorker);
	}

	/**
	 * 用已加载的本地 Embedding 适配器构造带 embeddings 的 VectraStore。
	 *
	 * 关键路径:vectra 需要 EmbeddingsModel 接口(createEmbeddings),本方法把 EmbeddingPort 包装进去。
	 */
	private createEmbeddingsVectraStore(embedding: EmbeddingPort): VectraStore {
		const embeddings: EmbeddingsModel = {
			maxTokens: 8192,
			async createEmbeddings(inputs: string | string[]): Promise<EmbeddingsResponse> {
				const arr = Array.isArray(inputs) ? inputs : [inputs];
				const output = await embedding.embed(arr);
				return { status: 'success', output };
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
