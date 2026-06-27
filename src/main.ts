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
import { classifyIntent } from './core/intent-classifier';
import { ContextManager } from './core/context-manager';
import { HookRegistry } from './core/hooks';
import { ToolRegistry } from './core/tool-registry';
import { ObsidianVault } from './adapters/obsidian-vault';
import { PersistenceJson } from './adapters/persistence-json';
import { DeepSeekLLM } from './adapters/llm-deepseek';
import type { EmbeddingPort } from './ports/embedding';
import { EmbeddingApi } from './adapters/embedding-api';
import { EmbeddingLocal } from './adapters/embedding-local';
import { EmbeddingWorkerProxy } from './adapters/embedding-worker-proxy';
import { VectraStore } from './adapters/vector-vectra';
import type { EmbeddingsModel, EmbeddingsResponse } from 'vectra';
import { WorkerManager } from './worker/manager';
import { InlineWorker } from './worker/inline-worker';
import { createReadNoteTool } from './tools/read-note';
import { createSearchVaultTool } from './tools/search-vault';
import { createGrepTool } from './tools/grep';
import { createGlobTool } from './tools/glob';
import { createListFilesTool } from './tools/list-files';
import { createWriteNoteTool } from './tools/write-note';
import { createAppendNoteTool } from './tools/append-note';
import { createEditNoteTool } from './tools/edit-note';
import { createDeleteNoteTool } from './tools/delete-note';
import {
	ToolPermissionSessionGrants,
	resolveToolPermission,
	extractToolPath,
} from './core/tool-permissions';
import { showToolConfirmModal } from './ui/confirm-modal';
import { validateVaultPath } from './utils/path-safety';
import type { ToolCall } from './ports/llm';
import { ModelManager } from './core/model-manager';
import { IndexController } from './core/index-controller';
import { FeedbackController } from './core/feedback-controller';
import type { IndexBackend } from './core/index-manager';
import { devLogger } from './logging/dev-logger';
import { UserNotice } from './user-feedback/user-notice';
import { UserStatus } from './user-feedback/user-status';
import { isSearchReady } from './ui/chat-send-gate';
import {
	hasRerankApiKey,
	resolveChatApiKey,
	resolveEmbedApiKey,
	resolveRerankApiKey,
} from './secrets/ratel-secrets';
import { MultiQuerySearcher } from './core/multi-query-searcher';
import { rewriteQuery } from './core/query-rewriter';
import { BailianReranker } from './adapters/reranker-bailian';
import { Indexer } from './subagents/indexer';
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
	// 关键路径:EmbeddingWorkerProxy 把 ONNX 推理移入 Web Worker,onunload 时需 terminate 释放线程。
	private embeddingWorkerProxy?: EmbeddingWorkerProxy;
	// 关键路径:indexDir 在 onload 计算,onLayoutReady 初始化 InlineWorker 时需要复用。
	private indexDir!: string;
	modelManager!: ModelManager;
	indexController!: IndexController;
	// 关键路径:W4 — Indexer subagent 实例,供 Librarian 等子代理调用。
	indexer!: Indexer;
	toolSessionGrants = new ToolPermissionSessionGrants();
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

		// 关键路径:W4 — Indexer subagent,供其他子代理通过统一接口触发索引。
		this.indexer = new Indexer({ vault: this.vault, indexController: this.indexController });

		// ==================== 工具与钩子 ====================
		this.tools = new ToolRegistry();
		this.tools.register(createReadNoteTool(this.vault));

		// 关键路径:W4 — 构造 MultiQuerySearcher,编排改写 + 多查询 + RRF + 可选 Rerank。
		// Reranker 仅在钥匙串有 ratel-rerank-bailian 密钥时注入;无密钥自动降级为仅 RRF。
		const reranker = hasRerankApiKey(this.app)
			? new BailianReranker({
					apiBase: this.settings.rerankerApiBase,
					apiKey: resolveRerankApiKey(this.app) ?? '',
					model: this.settings.rerankerModel,
				})
			: undefined;

		// 关键路径:QueryRewriter 闭包捕获 this.llm,把 rewriteQuery 的 RewrittenQuery[] 适配为 string[]。
		// 关键路径:rewriteQuery 已返回 [{text: query, variant: 'original'}, ...rewrites],
		// 因此这里返回的 string[] 已含原始查询,MultiQuerySearcher 直接用,无需再前置 original。
		const queryRewriter = {
			rewrite: async (q: string) => {
				const rewritten = await rewriteQuery(q, { llm: this.llm });
				return rewritten.map((r) => r.text);
			},
		};

		const multiQuerySearcher = new MultiQuerySearcher({
			embedding: this.embedding,
			workerManager: this.workerManager,
			vault: this.vault,
			reranker,
			queryRewriter,
		});

		this.tools.register(
			createSearchVaultTool(multiQuerySearcher, () =>
				isSearchReady(get(this.userStatus.statusBar$)),
			),
		);
		this.tools.register(createGrepTool(this.vault));
		this.tools.register(createGlobTool(this.vault));
		this.tools.register(createListFilesTool(this.vault));
		this.tools.register(createWriteNoteTool(this.vault));
		this.tools.register(createAppendNoteTool(this.vault));
		this.tools.register(createEditNoteTool(this.vault));
		this.tools.register(createDeleteNoteTool(this.vault));
		this.hooks = new HookRegistry();
		this.hooks.register(
			'pre-tool-use',
			async (tc) => {
				const pathArg = extractToolPath(tc);
				if (!pathArg) return;
				try {
					validateVaultPath(pathArg);
				} catch (err) {
					return {
						allow: false,
						reason: err instanceof Error ? err.message : String(err),
					};
				}
				return;
			},
			'path-safety',
		);

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
	 * - 模型就绪后把 EmbeddingOnnx 同时设给主线程 embedding 占位器与 InlineWorker 的 VectraStore。
	 * - ONNX 推理移入 EmbeddingWorkerProxy(Web Worker),主线程零 CPU 阻塞;proxy 注入 InlineWorker。
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
				// 关键路径:ModelManager.download() 内 status$.set(Ready) 触发 FeedbackController
				// 时 setEmbedding 尚未执行,isReady 仍为 false;注入后需显式通知状态推进到 ready。
				this.feedbackController?.notifyEmbeddingReady();
				// 关键路径:InlineWorker 在主线程运行,模型就绪后注入 VectraStore,embeddings 由 EmbeddingWorkerProxy 提供。
			if (this.inlineWorker) {
				this.vectraStore = this.createEmbeddingsVectraStore(embedding);
				// 关键路径:创建 EmbeddingWorkerProxy,把 ONNX 推理移入 Web Worker,主线程零 CPU 阻塞。
				// Worker 创建/init 失败不降级,直接抛错提示用户接 API Embedding 端点。
				await this.initEmbeddingWorkerProxy(embedding);
			}
			}

			const indexResult = await this.indexController.onLayoutReady();
			indexProgressRef.handle?.hide();
			indexProgressRef.handle = null;
			// 修复:全量索引完成后清除 progress callback,
			// 避免后续增量索引的 index.progress 事件创建新 toast 却无人 hide。
			this.workerManager.clearProgressCallback();
			if (indexResult) {
				this.feedbackController?.notifyFullIndexComplete(indexResult.indexed, indexResult.errors);
			}
		} catch (err) {
			indexProgressRef.handle?.hide();
			indexProgressRef.handle = null;
			// 修复:同上,异常路径也要清除 callback。
			this.workerManager.clearProgressCallback();
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
		// 关键路径:重建适配器后需通知 FeedbackController 重评 embedding 状态
		// (API 模式立即可用→ready;local 占位需等模型下载→loading)。
		this.feedbackController?.refreshEmbeddingStatus();
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
		// 关键路径:terminate EmbeddingWorkerProxy 释放 Web Worker 线程,避免热重载后残留进程 OOM。
		this.embeddingWorkerProxy?.terminate();
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
		this.settings.toolPermissions = {
			...DEFAULT_SETTINGS.toolPermissions,
			...(loaded.toolPermissions ?? {}),
		};
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

		// 关键路径:注入意图分类器,让 agentLoop 在 addUserMessage 后判断意图。
		// 闭包捕获 this.llm,与 agentLoop 解耦。
		const intentClassifier = (msg: string) => classifyIntent(msg, { llm: this.llm });

		const toolPermissionCheck = (tc: ToolCall) =>
			resolveToolPermission(
				tc,
				{
					trustMode: this.settings.trustMode,
					toolPermissions: this.settings.toolPermissions,
				},
				this.toolSessionGrants,
				(call) => showToolConfirmModal(this.app, call),
			);

		yield* agentLoop(
			{ sessionId, message },
			ctx,
			this.llm,
			this.tools,
			this.hooks,
			signal,
			intentClassifier,
			toolPermissionCheck,
			this.settings.agentMaxSteps,
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
	 * 创建不带 embeddings 的 VectraStore。
	 *
	 * 关键路径:IndexProcessor 现在自己调 EmbeddingPort.embed 批量推理,
	 * vectra 的 upsertDocument 不再被调用(改用 upsertItem 写预计算向量),
	 * 所以 VectraStore 不需要 embeddings 配置。search 也用预计算查询向量。
	 *
	 * @returns 不带 embeddings 的 VectraStore 实例。
	 */
	private createVectraStore(): VectraStore {
		return new VectraStore(this.indexDir, { autoInit: true });
	}

	/**
	 * 创建并初始化 EmbeddingWorkerProxy,把 ONNX 推理移入 Web Worker。
	 *
	 * 关键路径:
	 * - Worker URL 用 getResourcePath 解析,适配 Obsidian app:// 协议。
	 * - 模型依赖(modelBuffer / wasmBinary)从 ModelManager.getDeps() 重新读盘,返回全新 ArrayBuffer;
	 *   transfer 给 Worker 后不影响主线程 EmbeddingOnnx 实例持有的 buffer。
	 * - Worker 创建/init 失败不降级,直接抛错,提示用户配置 API Embedding 端点。
	 * - proxy 就绪后注入 InlineWorker,IndexProcessor 后续 embed 调用都走 Worker 线程。
	 *
	 * @param embedding - 已加载的主线程 EmbeddingPort,用于读取 dimensions。
	 * @throws Error Worker 创建或 init 失败,错误消息引导用户切换到 API Embedding。
	 */
	private async initEmbeddingWorkerProxy(embedding: EmbeddingPort): Promise<void> {
		// 关键路径:getResourcePath 把插件目录内的相对路径转为 app:// 协议 URL,
		// 这是 Obsidian Electron 环境下 new Worker(url) 能正确加载的唯一方式。
		const workerUrl = this.app.vault.adapter.getResourcePath(
			this.manifest.dir + '/dist/embedding-worker.js',
		);

		// 关键路径:getDeps 重新读盘,返回全新 ArrayBuffer 副本;transfer 给 Worker 后主线程实例不受影响。
		const deps = await this.modelManager.getDeps();
		if (!deps) {
			throw new Error(
				'本地 Embedding Worker 初始化失败: 模型依赖不可用。请在设置中配置 API Embedding 端点(如 Ollama)后重启插件。',
			);
		}

		const proxy = new EmbeddingWorkerProxy(workerUrl, deps, embedding.dimensions);
		this.embeddingWorkerProxy = proxy;

		try {
			// 关键路径:await proxy.ready 确保 Worker 内 EmbeddingOnnx.init() 完成,
			// 否则后续 embed 调用会在 Worker 内因未初始化而失败。
			await proxy.ready;
		} catch (err) {
			// 关键路径:Worker init 失败需 terminate 释放线程资源,避免悬挂 Worker 进程。
			proxy.terminate();
			this.embeddingWorkerProxy = undefined;
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(
				`本地 Embedding Worker 初始化失败: ${message}。请在设置中配置 API Embedding 端点(如 Ollama)后重启插件。`,
			);
		}

		// 关键路径:用不带 embeddings 的 store 覆盖,因为 IndexProcessor 自己调 proxy.embed 批量推理,
		// vectra 的 upsertDocument 不再被调用(改用 upsertItem 写预计算向量)。
		this.vectraStore = this.createVectraStore();
		// 关键路径:proxy 实现 EmbeddingPort,InlineWorker 用它做批量 embed,索引与搜索都走 Worker 线程。
		this.inlineWorker!.initWithStore(this.vectraStore, proxy);
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
