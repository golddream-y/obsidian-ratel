/**
 * @file src/main.ts
 * @description Ratel Vault 插件入口 — 生命周期、命令、视图注册
 * @module main
 * @depends obsidian, settings, types, core/*, adapters/*, ports/*, worker/*, tools/*, ui/*
 */

import { EMBEDDING_WORKER_CODE } from '@ratel/embedding-worker-code';
import { FileSystemAdapter, Notice, Plugin } from 'obsidian';
import { type RatelVaultSettings, DEFAULT_SETTINGS, RatelVaultSettingTab, normalizeContextLengthSettings } from './settings';

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
// 关键路径:工具 description 由 Composer 注入(Task 7),用 ALL_TOOL_NAMES 一次性生成所有 definition。
import { composeToolDefinitions } from './prompts/composer';
import { ALL_TOOL_NAMES } from './prompts/tool-schemas';
import {
	ToolPermissionSessionGrants,
	resolveToolPermission,
	extractToolPath,
} from './core/tool-permissions';
import { showToolConfirmModal } from './ui/components/confirm-modal';
import { showReindexConfirm, showDropIndexConfirm } from './ui/confirm-modal';
import { validateVaultPath } from './utils/path-safety';
import { extractToolTargetPath, isDeleteTool } from './hooks/immediate-reindex';
import type { ToolCall } from './ports/llm';
import { ModelManager } from './core/model-manager';
import { OrtRuntimeAssets } from './core/ort-runtime-assets';
import { IndexController } from './core/index-controller';
import { FeedbackController } from './core/feedback-controller';
import type { IndexBackend } from './core/index-manager';
import { devLogger } from './logging/dev-logger';
import { UserNotice } from './user-feedback/user-notice';
import { UserStatus } from './user-feedback/user-status';
import { isSearchReady } from './ui/chat/chat-send-gate';
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
import { ChatView, VIEW_TYPE_CHAT } from './ui/chat/ChatView';
import { applyBadgerEmojiToElement, patchAllChatLeafIcons } from './utils/badger-icon';
import { get } from 'svelte/store';
import { ensurePluginGitignore } from './utils/gitignore-writer';
import { sha256 } from './utils/hash';
import { IndexManifest } from './core/index-manifest';
import { ModelContextRegistry } from './ui/tokens/model-context-registry';
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
	// 关键路径:Blob URL 在 onunload 需 revokeObjectURL 释放,避免内存泄漏。
	private embeddingWorkerUrl?: string;
	// 关键路径:indexDir 在 onload 计算,onLayoutReady 初始化 InlineWorker 时需要复用。
	private indexDir!: string;
	modelManager!: ModelManager;
	modelContextRegistry!: ModelContextRegistry;
	indexController!: IndexController;
	// 关键路径:索引 backend 引用 — smartReindex 直接调 this.indexBackend.fullReindex(),
	// 避免 this.indexController['indexManager']['backend'] 反模式访问私有字段。
	indexBackend!: IndexBackend;
	// 关键路径:索引清单 — 记每文件 hash + 全局 embedding 参数,启动期 hash diff。
	indexManifest!: IndexManifest;
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
		this.modelContextRegistry = new ModelContextRegistry(pluginDir);

		// ==================== Worker ====================
		// 关键路径:优先尝试 Node.js Worker Threads;Obsidian 渲染进程不支持时降级到 InlineWorker。
		// InlineWorker 在同线程执行,能解决 CORS/平台限制,但大索引会阻塞 UI。
		this.workerManager = this.createWorkerManager();

		// ==================== 模型与索引 ====================
		// 关键路径:本地模型缓存放到插件目录,与 index 同级,便于随插件清理。
		// ORT WASM 首次使用时从 jsDelivr 下载并缓存到 pluginDir(ADR-006);商店 release 只含 main.js。
		const ortAssets = new OrtRuntimeAssets(pluginDir);
		this.modelManager = new ModelManager(path.join(pluginDir, 'models'), ortAssets);

		this.indexBackend = {
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
					// 关键路径:incremental 后更新 manifest.chunkCount,修复 0 占位问题。
					// Worker index.done 协议未在 types.ts 扩展 chunkCount(避免影响 index.full),
					// 此处用类型断言安全访问可选字段。
					const chunkCount = (response.payload as { chunkCount?: number }).chunkCount;
					// 关键路径:errors>0 时索引失败,不写 manifest,避免污染 chunkCount(与 index.batch 路径 line 672 跳过 undefined 一致)
					if (chunkCount !== undefined && response.payload.errors === 0) {
						const manifestData = await this.indexManifest.load();
						if (manifestData) {
							const hash = await sha256(file.content);
							this.indexManifest.recordEntry(
								manifestData,
								file.path,
								hash,
								Date.now(),
								chunkCount,
							);
							await this.indexManifest.save(manifestData);
						}
					}
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
			// 关键路径:smart reindex — hash diff 后仅对变更文件 batch embed。
			isIndexCreated: async () => {
				return this.vectraStore.isIndexCreated();
			},
			listMarkdownFiles: async () => {
				const paths = this.vault.listMarkdownFiles();
				const files: Array<{ path: string; content: string }> = [];
				for (const p of paths) {
					const content = await this.vault.readFile(p);
					files.push({ path: p, content });
				}
				return files;
			},
			// 关键路径:箭头函数保留 this 绑定,委托给类方法 smartReindex。
		smartReindex: async () => {
			return this.smartReindex();
		},
			// 关键路径:reindex 命令需清 .index/(spec §4.4),委托给 vectraStore.dropIndex。
			dropIndex: async () => {
				await this.vectraStore.dropIndex();
			},
		};

		// 关键路径:manifest 与 .index/ 同目录同生命周期。
		this.indexManifest = new IndexManifest(path.join(pluginDir, 'index-manifest.json'));

		// 关键路径:ObsidianVault 已实现 VaultEventListener 接口,直接传入可保证所有 Obsidian API 访问都走外观层。
		this.indexController = new IndexController(this.vault, this.indexBackend, vaultBase);
		// 关键路径:注入 manifest 清理回调,供 IndexManager.reindex 调用(spec §4.4)。
		// 清理逻辑:加载现有 manifest(若存在),invalidate 清空 entries 但保留全局参数待重新填充。
		this.indexController.indexManager.setManifestResetCallback(async () => {
			const data = await this.indexManifest.load();
			if (data) {
				this.indexManifest.invalidate(data);
			}
		});

		// 关键路径:W4 — Indexer subagent,供其他子代理通过统一接口触发索引。
		this.indexer = new Indexer({ vault: this.vault, indexController: this.indexController });

		// ==================== 工具与钩子 ====================
		this.tools = new ToolRegistry();
		// 关键路径:用当前 settings.promptOverrides 生成 definition,让用户在设置面板的覆盖立即生效。
		const toolDefs = composeToolDefinitions(this.settings.promptOverrides, ALL_TOOL_NAMES);
		const toolDefMap = new Map(toolDefs.map((d) => [d.name, d]));
		this.tools.register(createReadNoteTool(this.vault, toolDefMap.get('read_note')!));

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
				// 关键路径:把 overrides 透传给 query-rewriter,让改写 system 也走 Composer。
				const rewritten = await rewriteQuery(q, { llm: this.llm, overrides: this.settings.promptOverrides });
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
			createSearchVaultTool(
				multiQuerySearcher,
				() => isSearchReady(get(this.userStatus.statusBar$)),
				toolDefMap.get('search_vault')!,
			),
		);
		this.tools.register(createGrepTool(this.vault, toolDefMap.get('grep')!));
		this.tools.register(createGlobTool(this.vault, toolDefMap.get('glob')!));
		this.tools.register(createListFilesTool(this.vault, toolDefMap.get('list_files')!));
		this.tools.register(createWriteNoteTool(this.vault, toolDefMap.get('write_note')!));
		this.tools.register(createAppendNoteTool(this.vault, toolDefMap.get('append_note')!));
		this.tools.register(createEditNoteTool(this.vault, toolDefMap.get('edit_note')!));
		this.tools.register(createDeleteNoteTool(this.vault, toolDefMap.get('delete_note')!));
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
		// 关键路径:写工具执行后立即触发索引刷新,绕过 FolderWatcher 5s 去抖
		this.hooks.register(
			'post-tool-use',
			async (tc) => {
				const targetPath = extractToolTargetPath(tc);
				if (targetPath) {
					await this.indexController.enqueue(
						targetPath,
						isDeleteTool(tc.name) ? 'delete' : 'upsert',
					);
				}
				return;
			},
			'immediate-reindex',
		);

		// ==================== 视图与命令 ====================
		this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this));

		// Ribbon 图标:点击打开聊天侧栏。
		// 关键路径:Lucide 图标集无獾,用 emoji 替换 SVG,贴合 Ratel 品牌形象。
		const ribbonEl = this.addRibbonIcon('paw-print', 'Ratel', () => {
			this.activateChatView();
		});
		const ribbonSvg = ribbonEl?.querySelector('svg');
		if (ribbonSvg?.parentElement) {
			applyBadgerEmojiToElement(ribbonSvg.parentElement);
		}

		// 关键路径:右侧边栏 tab 图标来自 ItemView.getIcon()(Lucide),需在 layout 后替换为 emoji。
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				patchAllChatLeafIcons(this.app.workspace);
			}),
		);

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

		// 命令:重建索引(危险操作 — 走二次确认 Modal,避免误触全量重建)
		this.addCommand({
			id: 'reindex',
			name: '重建索引(全量)',
			callback: () => showReindexConfirm(this.app, () => this.indexController.reindex()),
		});

		// 命令:暂停索引(文件事件不再触发增量索引)
		this.addCommand({
			id: 'pause-index',
			name: '暂停索引',
			callback: () => {
				this.indexController.pause();
				this.userNotice.toast('索引已暂停');
			},
		});

		// 命令:恢复索引(继续处理文件事件)
		this.addCommand({
			id: 'resume-index',
			name: '恢复索引',
			callback: () => {
				this.indexController.resume();
				this.userNotice.toast('索引已恢复');
			},
		});

		// 命令:清空索引(危险操作 — 强制输入 DELETE 确认,防止误删向量数据)
		this.addCommand({
			id: 'drop-index',
			name: '清空索引(危险)',
			callback: () => showDropIndexConfirm(this.app, () => this.vectraStore.dropIndex()),
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
		// 关键路径:进度回调 handle 跨 local 块与索引块共用,需在外层声明,
		// 索引完成后(成功或失败)统一 hide/clear,避免 toast 残留(P3 重构:模型下载与索引启动分离)。
		const indexProgressRef: {
			handle: ReturnType<UserNotice['toastProgress']> | null;
		} = { handle: null };

		// 关键路径:模型下载仅 local 模式需要;API 模式无本地模型,但仍要启动索引(P3 修复)。
		if (this.settings.embedProvider === 'local') {
			// 关键路径:全量索引进度由 Worker 回调驱动;FeedbackController 仅更新 statusBar,不弹 progress Notice。
			this.workerManager.setProgressCallback((done, total) => {
				const message = `Ratel: 正在索引... ${done}/${total} 个文件`;
				this.userStatus.patch({
					index: 'scanning',
					indexDetail: `${done}/${total}`,
				});
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
						// 关键路径:创建 EmbeddingWorkerProxy,把 ONNX 推理移入 Web Worker,主线程零 CPU 阻塞。
						// Worker 创建/init 失败不降级,直接抛错提示用户接 API Embedding 端点。
						// vectraStore 在 initEmbeddingWorkerProxy 内部用无 embeddings 版本创建(IndexProcessor 自己调 proxy.embed)。
						await this.initEmbeddingWorkerProxy(embedding);
					}
				}
			} catch (err) {
				indexProgressRef.handle?.hide();
				indexProgressRef.handle = null;
				this.workerManager.clearProgressCallback();
				const message = err instanceof Error ? err.message : String(err);
				devLogger.error('main', 'onLayoutReady 模型下载失败', err);
				this.userNotice.toastError(`Ratel 错误: ${message}`);
				// 关键路径:模型下载失败仍继续启动索引(API 模式不依赖本地模型)。
			}
		}

		// 关键路径:索引启动 — 两条 provider 都走(P3 修复)。
		// autoIndex=false 时仅启动 FolderWatcher,不跑 smartReindex(spec §5.7)。
		try {
			const indexResult = await this.indexController.onLayoutReady(this.settings.autoIndex);
			// 关键路径:索引完成后隐藏进度 toast 并清除 callback(成功路径)。
			indexProgressRef.handle?.hide();
			indexProgressRef.handle = null;
			this.workerManager.clearProgressCallback();
			this.feedbackController?.notifyFullIndexComplete(
				indexResult?.indexed ?? 0,
				indexResult?.errors ?? 0,
			);
		} catch (err) {
			// 关键路径:索引失败也要清理进度 toast 与 callback。
			indexProgressRef.handle?.hide();
			indexProgressRef.handle = null;
			this.workerManager.clearProgressCallback();
			const message = err instanceof Error ? err.message : String(err);
			devLogger.error('main', '索引启动失败', err);
			this.userNotice.toastError(`Ratel 索引错误: ${message}`);
		}
	}

	/**
	 * smart reindex — 启动期 hash diff,仅对变更文件 batch embed。
	 *
	 * 关键路径:
	 * 1. 索引不存在 → 委托 fullReindex(走 index.full)
	 * 2. manifest 不存在/损坏 → 全量
	 * 3. 全局参数(embedModelId/chunkSize)变 → 清 .index/ + manifest → 全量
	 * 4. 否则 → hash diff,仅 toAdd+toUpdate 走 index.batch,toDelete 走 index.delete
	 * 5. 失败时不清 manifest,下次启动重试
	 *
	 * @returns indexed 为本次实际写入的 chunk 所属文件数,errors 为失败计数,skipped 为未变更文件数。
	 */
	async smartReindex(): Promise<{ indexed: number; errors: number; skipped: number }> {
		try {
			return await this.doSmartReindex();
		} catch (err) {
			// 关键路径:.index/ 目录损坏(vectra 加载失败)或 smartReindex 任意步骤抛错时,
			// 降级为清 .index/ + manifest 后全量重建(spec §9)。
			// 失败时不清 manifest,保留旧 hash 表让下次启动重试(仅在索引损坏场景才清)。
			devLogger.error('index', 'smartReindex 失败,降级全量重建', err);
			try {
				await this.vectraStore.dropIndex();
				// 关键路径:索引损坏时 manifest 可能也指向损坏状态,一并清理。
				// manifest 可能加载失败(null),只在存在时 invalidate。
				const existingManifest = await this.indexManifest.load();
				if (existingManifest) {
					this.indexManifest.invalidate(existingManifest);
				}
			} catch (dropErr) {
				devLogger.error('index', '降级清理失败,仍继续全量', dropErr);
			}
			const result = await this.indexBackend.fullReindex();
			await this.writeManifestAfterFullReindex();
			return { indexed: result.indexed, errors: result.errors, skipped: 0 };
		}
	}

	/**
	 * smartReindex 实际实现 — 由 smartReindex 包裹降级 try-catch。
	 *
	 * 关键路径:五分支决策:
	 * 1. 索引不存在 → 全量 + 写 manifest
	 * 2. manifest 损坏/不存在 → 全量 + 写 manifest
	 * 3. 全局参数变 → 清 .index/ + manifest → 全量
	 * 4. 否则 → hash diff,仅 toAdd+toUpdate 走 index.batch,toDelete 走 index.delete
	 * 5. 失败时不清 manifest,下次启动重试
	 *
	 * @returns indexed 为本次实际写入的 chunk 所属文件数,errors 为失败计数,skipped 为未变更文件数。
	 */
	private async doSmartReindex(): Promise<{ indexed: number; errors: number; skipped: number }> {
		// 关键路径:先检查索引是否存在,不存在走全量。
		const indexExists = await this.vectraStore.isIndexCreated();
		if (!indexExists) {
			const result = await this.indexBackend.fullReindex();
			// 关键路径:全量后写新 manifest。
			await this.writeManifestAfterFullReindex();
			return { indexed: result.indexed, errors: result.errors, skipped: 0 };
		}

		// 关键路径:加载 manifest,损坏则全量。
		const manifestData = await this.indexManifest.load();
		if (!manifestData) {
			const result = await this.indexBackend.fullReindex();
			await this.writeManifestAfterFullReindex();
			return { indexed: result.indexed, errors: result.errors, skipped: 0 };
		}

		// 关键路径:全局参数变化 → 清索引 + manifest → 全量。
		const currentEmbedModelId = this.resolveCurrentEmbedModelId();
		if (this.indexManifest.shouldFullRebuild(manifestData, currentEmbedModelId, this.settings.chunkSize, this.settings.chunkOverlap)) {
			// 关键路径:清 .index/ 目录(vectra 没有清空 API,删目录重建)。
			await this.vectraStore.dropIndex();
			this.indexManifest.invalidate(manifestData);
			manifestData.embedModelId = currentEmbedModelId;
			manifestData.chunkSize = this.settings.chunkSize;
			manifestData.chunkOverlap = this.settings.chunkOverlap;
			const result = await this.indexBackend.fullReindex();
			try {
				await this.indexManifest.save(manifestData);
			} catch (err) {
				// 关键路径:manifest 写盘失败不阻塞索引(spec §9),下次启动重试。
				devLogger.error('index', 'manifest 写盘失败(参数变更后)', err);
			}
			return { indexed: result.indexed, errors: result.errors, skipped: 0 };
		}

		// 关键路径:读所有 markdown 文件 + mtime(vault 事件源是 ObsidianVault)。
		const paths = this.vault.listMarkdownFiles();
		const files: Array<{ path: string; content: string; mtime: number }> = [];
		for (const p of paths) {
			// 关键路径:mtime 快速跳过 — mtime 未变则不必读 content 与算 sha256(spec §4.2)。
			// 大库热启动时省 N 次文件读 + N 次 hash,只做 stat 比较。
			const stat = this.vault.stat(p);
			const mtime = stat?.mtime ?? Date.now();
			const existing = manifestData.entries[p];
			if (existing && existing.mtime === mtime) {
				// mtime 未变,直接复用旧 hash,不读 content。
				files.push({ path: p, content: '', mtime });
			} else {
				const content = await this.vault.readFile(p);
				files.push({ path: p, content, mtime });
			}
		}

		const fileHashes = await Promise.all(
			files.map(async (f) => {
				// 关键路径:mtime 未变的文件复用 manifest 旧 hash,跳过 sha256 计算。
				// 提取局部变量,避免 TS 索引访问 possibly undefined 误报。
				const existingEntry = manifestData.entries[f.path];
				const hash = f.content === '' && existingEntry
					? existingEntry.hash
					: await sha256(f.content);
				return {
					path: f.path,
					content: f.content,
					hash,
					mtime: f.mtime,
				};
			}),
		);

		const diff = this.indexManifest.diff(manifestData, fileHashes);
		const toEmbed = [...diff.toAdd, ...diff.toUpdate];

		let indexed = 0;
		let errors = 0;

		// 关键路径:批量 embed toAdd + toUpdate。
		if (toEmbed.length > 0) {
			const response = await this.workerManager.request({
				type: 'index.batch',
				payload: { files: toEmbed.map((f) => ({ path: f.path, content: f.content })) },
			});
			if (response.type === 'index.batch.done') {
				indexed = response.payload.indexed;
				errors = response.payload.errors;
				// 关键路径:批量记录 manifest(用返回的 chunkCount)。
				for (const f of toEmbed) {
					const chunkCount = response.payload.chunkCounts[f.path];
					// 关键路径:失败文件 chunkCounts 无此 key(undefined),不 recordEntry,
					// 保留旧 hash 供下次启动重试(spec §9)。空文件 chunkCount 为 0(已定义),照常记录。
					if (chunkCount === undefined) continue;
					const hash = fileHashes.find((h) => h.path === f.path)!.hash;
					this.indexManifest.recordEntry(manifestData, f.path, hash, f.mtime, chunkCount);
				}
			} else {
				errors += toEmbed.length;
			}
		}

		// 关键路径:逐个 delete。
		for (const delPath of diff.toDelete) {
			try {
				await this.workerManager.request({
					type: 'index.delete',
					payload: { filePath: delPath },
				});
				this.indexManifest.removeEntry(manifestData, delPath);
			} catch {
				// 删除失败不挂整批,下次启动重试。
				errors++;
			}
		}

		try {
			manifestData.lastIndexTime = Date.now();
			await this.indexManifest.save(manifestData);
		} catch (err) {
			// 关键路径:manifest 写盘失败不阻塞索引(spec §9),下次启动重试。
			devLogger.error('index', 'manifest 写盘失败(增量后)', err);
		}

		return { indexed, errors, skipped: diff.unchanged.length };
	}

	/** 全量重建后写新 manifest(首次/重置场景)。 */
	private async writeManifestAfterFullReindex(): Promise<void> {
		const files = this.vault.listMarkdownFiles();
		const entries: Record<string, import('./core/index-manifest').IndexManifestEntry> = {};
		for (const p of files) {
			const content = await this.vault.readFile(p);
			const hash = await sha256(content);
			// 关键路径:全量后 chunkCount 未知(未走 index.batch),填 0 占位,下次 incremental 时更新。
			entries[p] = { path: p, hash, mtime: Date.now(), chunkCount: 0 };
		}
		const data: import('./core/index-manifest').IndexManifestData = {
			version: 1,
			embedModelId: this.resolveCurrentEmbedModelId(),
			chunkSize: this.settings.chunkSize,
			chunkOverlap: this.settings.chunkOverlap,
			lastIndexTime: Date.now(),
			entries,
		};
		try {
			await this.indexManifest.save(data);
		} catch (err) {
			// 关键路径:manifest 写盘失败不阻塞索引(spec §9),下次启动重写。
			devLogger.error('index', 'manifest 写盘失败(全量后)', err);
		}
	}

	/** 解析当前 embedding 模型 ID(local 用 ModelManager id,api 用 apiBase::model)。 */
	private resolveCurrentEmbedModelId(): string {
		if (this.settings.embedProvider === 'local') {
			return this.settings.embedLocalModel || 'local-default';
		}
		return `${this.settings.embedApiBase}::${this.settings.embedApiModel}`;
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
		// 关键路径:revoke Blob URL 释放内存,避免热重载后泄漏 worker 脚本字符串。
		if (this.embeddingWorkerUrl) {
			URL.revokeObjectURL(this.embeddingWorkerUrl);
			this.embeddingWorkerUrl = undefined;
		}
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
		normalizeContextLengthSettings(this.settings, loaded);
	}

	/** 持久化当前设置到 Obsidian data.json。 */
	async saveSettings() {
		await this.saveData(this.settings);
		// 关键路径:settings 变更后热替换工具 definition,让 LLM 立即看到新 description。
		this.syncToolDefinitions();
	}

	/**
	 * 重新生成所有工具 definition 并热替换到 ToolRegistry。
	 *
	 * 关键路径:settings.promptOverrides 变化后,settings 面板调用此方法,
	 * 让 LLM 立即看到新的工具 description / param description,无需重启插件。
	 *
	 * 设计要点:
	 * - 仅在 `this.tools` 已初始化后执行(避免 onload 早期调用)
	 * - 用当前 settings.promptOverrides 重新走 Composer
	 * - 调用 `toolRegistry.updateDefinition` 替换每个工具的 definition(execute 逻辑不变)
	 */
	syncToolDefinitions(): void {
		if (!this.tools) return;
		const defs = composeToolDefinitions(this.settings.promptOverrides, [...ALL_TOOL_NAMES]);
		for (const def of defs) {
			this.tools.updateDefinition(def.name, def);
		}
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
		// 关键路径:注入 overrides + tools getter,让 ContextManager 调 Composer 拼系统提示词。
		const ctx = new ContextManager(this.persistence, {
			getOverrides: () => this.settings.promptOverrides,
			getTools: () => this.tools.definitions(),
		});

		// 关键路径:注入意图分类器,让 agentLoop 在 addUserMessage 后判断意图。
		// 闭包捕获 this.llm,与 agentLoop 解耦。
		// 关键路径:把 overrides 透传给 intent-classifier,让内部 LLM 也走 Composer + 用户自定义 section。
		const intentClassifier = (msg: string) =>
			classifyIntent(msg, { llm: this.llm, overrides: this.settings.promptOverrides });

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
	 * 构造一个独立 ContextManager,供 /compact 等非 agent-loop 流程复用。
	 *
	 * 关键路径:与 ask() 内部构造完全一致,避免重复初始化逻辑。
	 * 调用方拿到 ctx 后可独立 load/save session,不与 agent-loop 共享状态。
	 *
	 * @returns 新的 ContextManager 实例(已注入 overrides + tools)
	 */
	createContext(): ContextManager {
		return new ContextManager(this.persistence, {
			getOverrides: () => this.settings.promptOverrides,
			getTools: () => this.tools.definitions(),
		});
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
	 * - Worker URL 用 Blob URL 模式:构建期内联的 worker 脚本 → Blob → createObjectURL,
	 *   生成同源 blob:app://obsidian.md/<uuid> URL,绕过 app://<hash> 与 app://obsidian.md 跨 origin 的 SecurityError。
	 * - 模型依赖(modelBuffer / wasmBinary)从 ModelManager.getDeps() 重新读盘,返回全新 ArrayBuffer;
	 *   transfer 给 Worker 后不影响主线程 EmbeddingOnnx 实例持有的 buffer。
	 * - Worker 创建/init 失败不降级,直接抛错,提示用户配置 API Embedding 端点。
	 * - proxy 就绪后注入 InlineWorker,IndexProcessor 后续 embed 调用都走 Worker 线程。
	 *
	 * @param embedding - 已加载的主线程 EmbeddingPort,用于读取 dimensions。
	 * @throws Error Worker 创建或 init 失败,错误消息引导用户切换到 API Embedding。
	 */
	private async initEmbeddingWorkerProxy(embedding: EmbeddingPort): Promise<void> {
		// 关键路径: embedding worker 脚本在构建期内联进 main.js(ADR-006),不再读磁盘 embedding-worker.js。
		if (!EMBEDDING_WORKER_CODE) {
			throw new Error(
				'本地 Embedding Worker 脚本未内联(构建产物异常)。请重新 npm run build 或切换到 API Embedding。',
			);
		}
		const blob = new Blob([EMBEDDING_WORKER_CODE], { type: 'application/javascript' });
		const workerUrl = URL.createObjectURL(blob);
		this.embeddingWorkerUrl = workerUrl;

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
		requestAnimationFrame(() => patchAllChatLeafIcons(this.app.workspace));
	}
}
