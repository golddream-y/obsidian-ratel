/**
 * @file src/main.ts
 * @description Ratel Vault 插件入口 — 生命周期、命令、视图注册
 * @module main
 * @depends obsidian, settings, types, core/*, adapters/*, ports/*, worker/*, tools/*, ui/*
 */

import { EMBEDDING_WORKER_CODE } from '@ratel/embedding-worker-code';
import { GPU_EMBEDDING_WORKER_CODE } from '@ratel/gpu-embedding-worker-code';
import { BUILTIN_SKILLS, BUILTIN_SKILL_PROFILES, APP_VERSION } from '@ratel/builtin-skills-code';
import { FileSystemAdapter, Notice, Plugin, TFile, apiVersion, requestUrl } from 'obsidian';
import fs, { readdirSync } from 'node:fs';
import path from 'node:path';
import { type RatelVaultSettings, DEFAULT_SETTINGS, RatelVaultSettingTab, normalizeContextLengthSettings, applyBuiltinToolPermissionDefaults } from './settings';
import { normalizeChunkSizeSettings, CHUNK_SIZE_MAX_TOKENS } from './ui/tokens/chunk-size-presets';
import { PersistentIndexBackend } from './core/persistent-index-backend';
import type { IndexBuildStamp } from './core/index-build-stamp';
import { normalizeChatPreset } from './settings/chat-preset';
import { normalizeChatProfiles } from './settings/chat-profiles';
import { normalizeAppearanceSettings } from './ui/appearance/normalize-appearance-settings';
import { bumpAppearance } from './ui/appearance/appearance-store';
import { publishSettingsSnapshot } from './ui/settings-store';
import { getEffectiveChatModelMaxTokens } from './utils/context-window';
import { tailBudget } from './core/context-budget';
import { normalizeMcpServerConfig } from './core/mcp-config';
import { AttachmentStore } from './core/attachment-store';
import type { AttachmentRef, LlmRetryWait, LLMClient } from './ports/llm';

import type { AgentEvent, ChunkOptionsPayload } from './types';
import type { ChunkOptions } from './worker/chunker';
import { agentLoop } from './core/agent-loop';
import { classifyIntent } from './core/intent-classifier';
import { ContextManager } from './core/context-manager';
import { shouldReusePreloadedContext } from './core/preloaded-context';
import { HookRegistry } from './core/hooks';
import { ToolRegistry } from './core/tool-registry';
import { ObsidianVault } from './adapters/obsidian-vault';
import { PersistenceJson } from './adapters/persistence-json';
import { mergePluginData } from './adapters/data-json-merge';
import { OpenAICompatLLM } from './adapters/llm-openai-compat';
import { wrapLlmChatRetry } from './core/llm-chat-retry';
import type { EmbeddingPort } from './ports/embedding';
import { EmbeddingApi } from './adapters/embedding-api';
import { EmbeddingLocal } from './adapters/embedding-local';
import { EmbeddingWorkerProxy } from './adapters/embedding-worker-proxy';
import { VectraStore } from './adapters/vector-vectra';
import type { IndexVectorStore } from './adapters/vector-vectra-sharded';
import { AtomicIndexStorage } from './adapters/atomic-index-storage';
import { IndexWriteOwner } from './core/index-write-owner';
import { IndexGenerations } from './core/index-generations';
import { assembleIndexThreadRuntime } from './core/index-thread-assembly';
import { createThreadIndexBackend } from './core/index-thread-backend';
import { createThreadVisibilityGate } from './core/index-thread-visibility-gate';
import { IndexFileJournal } from './core/index-file-journal';
import type { IndexRoundState } from './core/persistent-index-backend';
import { IndexTaskCoordinator, type IndexStallWatchdog } from './core/index-task-coordinator';
import { ReadOnlySearchView } from './core/index-search-visibility';
import {
	ChunkingCoordinatorProcessor,
	type ResolveIndexGenerationResult,
} from './core/index-processor-port';
import { computeConfigFingerprint, type IndexConfigDescriptor } from './core/index-persistence-types';
// 关键路径(T8 装配下沉):索引运行时的装配/降级/重试/结论面算法都在
// `core/index-runtime-assembly`(不 import obsidian,依赖以参数注入);本文件只保留生命周期与接线。
import {
	INDEX_RUNTIME_STALL_AFTER_MS,
	assertIndexRuntimeDropOwnership,
	cancelIndexRun,
	configIdentityOf,
	createIndexRuntimeStorage,
	createIndexRuntimeStore,
	createSearchCandidateGate,
	dropInactiveGenerations,
	GenerationActivationPublisher,
	setupReadOnlyIndexRuntime,
	setupWritableIndexRuntime,
	summarizeIndexConclusion,
	type ReadOnlyIndexRuntime,
	type WritableIndexRuntime,
} from './core/index-runtime-assembly';
import { IndexRuntimeIdentityGuard } from './core/index-runtime-identity-guard';
import { IndexRuntimeClient } from './worker/index-runtime-client';
import { IndexThreadCoordinator } from './core/index-thread-coordinator';
import type { IndexTaskCoordinatorPort } from './core/index-manager';
// 关键路径:词表(约 109KB)只传一次 — 模型就绪后由主线程交给 Worker,不进每条索引消息;
// 协调器在主线程分块,必须与 Worker 读同一份词表才能得到一致的块边界。
import { currentProcessorStore, getVocabContent, setVocabContent } from './worker/handler';
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
import { createApplyPatchTool } from './tools/apply-patch';
import { createDeleteNoteTool } from './tools/delete-note';
import { createMoveNoteTool } from './tools/move-note';
import { createCopyNoteTool } from './tools/copy-note';
import { AGENTS_FILE_NAME } from './tools/note-agents';
// 关键路径:用户记忆系统 — MemoryStore 管理 .ratel/memory/ 文件 + .memory-index/ vectra 索引,
// 3 个工具(search_memory / remember / forget_memory)复用 memoryStore 与 embeddingPort。
import { MemoryStore } from './core/memory-store';
import { shouldAutoEmbedTopics } from './core/memory-topics-auto-inject';
// 关键路径(S-SR-LAYERING):使用统计 — Skill 激活与记忆 topics 自动注入命中计数
import { UsageStatsStore } from './core/usage-stats';
import { createSearchMemoryTool } from './tools/search-memory';
import { createRememberTool } from './tools/remember';
import { createForgetMemoryTool } from './tools/forget-memory';
// 关键路径:工具 description 由 Composer 注入(Task 7),用 ALL_TOOL_NAMES 一次性生成所有 definition。
import { composeToolDefinitions } from './prompts/composer';
import { ALL_TOOL_NAMES } from './prompts/tool-schemas';
import {
	ToolPermissionSessionGrants,
	resolveToolPermission,
	extractToolPath,
} from './core/tool-permissions';
import { showToolConfirmModal } from './ui/components/confirm-modal';
import { openReleaseNotesTab, ReleaseNotesView, VIEW_TYPE_RELEASE_NOTES } from './ui/release/release-notes-view';
import { shouldShowReleaseNotes } from './ui/release/should-show-release-notes';
import { showReindexConfirm, showDropIndexConfirm } from './ui/confirm-modal';
import { runIndexThreadExperiment } from './experiment/index-thread-probe';
import { validateVaultPath, setConfigDir } from './utils/path-safety';
import { isSafeVaultMentionPath } from './ui/chat/input/mention-parser';
import { extractToolTargetPath, isDeleteTool } from './hooks/immediate-reindex';
import type { ToolCall } from './ports/llm';
import type { RerankerPort } from './ports/reranker';
import { ModelManager } from './core/model-manager';
import { OrtRuntimeAssets } from './core/ort-runtime-assets';
import { IndexController } from './core/index-controller';
import {
	describeIndexError,
	isIndexDiskFailure,
	FeedbackController,
	type IndexDisplaySignals,
} from './core/feedback-controller';
import type { FeedbackIndexDiagnostics } from './ui/chat/feedback-modal';
import type { IndexBackend, IndexStatus } from './core/index-manager';
import { devLogger } from './logging/dev-logger';
import { UserNotice } from './user-feedback/user-notice';
import { UserStatus, type IndexConclusionDiagnostics } from './user-feedback/user-status';
import { CrashBreadcrumbs, type LastRunDiag } from './logging/breadcrumbs';
import { isSearchReady } from './ui/chat/chat-send-gate';
import { applyLangPreference, tNow } from './i18n';
import {
	hasRerankApiKey,
	getChatSecretId,
	getEmbedSecretId,
	hasChatApiKey,
	hasEmbedApiKey,
	resolveChatApiKey,
	resolveEmbedApiKey,
	resolveRerankApiKey,
	resolveMcpSecret,
} from './secrets/ratel-secrets';
import {
	MultiQuerySearcher,
	type SearchCandidateGate,
	type SearchCandidateSource,
} from './core/multi-query-searcher';
import { McpHost } from './core/mcp-host';
import { McpHttpTransport } from './adapters/mcp-http';
import { McpStdioTransport } from './adapters/mcp-stdio';
import type { McpServerConfig } from './ports/mcp';
import { rewriteQuery } from './core/query-rewriter';
import { BailianReranker } from './adapters/reranker-bailian';
// 关键路径(S-RETRIEVAL-QUALITY §4.4):对话模型精排适配器 + 开关/来源解析。
import { LlmReranker } from './adapters/reranker-llm';
import { resolveRerankMode } from './core/rerank-mode';
// 关键路径(S-RETRIEVAL-QUALITY §4.1/§4.2):token 计数入口 —
// 主线程只取模型输入上限,精确分词在 Worker 侧用词表做。
import { createTokenCounter, TOKEN_BUDGET_RESERVE } from './core/token-counter';
import { Indexer } from './subagents/indexer';
import { ChatView, VIEW_TYPE_CHAT } from './ui/chat/ChatView';
import { MemoryModal, shouldCreateMemoryModal } from './ui/memory-panel/MemoryModal';
import { McpManageModal, shouldCreateMcpManageModal } from './ui/mcp/McpManageModal';
import { SkillManageModal, shouldCreateSkillManageModal } from './ui/skills/SkillManageModal';
import { requestMcpSpawnConfirmation } from './ui/mcp/mcp-spawn-confirm-modal';
import { applyBadgerEmojiToElement, patchAllChatLeafIcons } from './utils/badger-icon';
import { get, type Readable } from 'svelte/store';
import { ensurePluginGitignore } from './utils/gitignore-writer';
import { IndexManifest, migrateLegacyIndexManifest, resolveIndexManifestPath, CURRENT_CHUNKER_VERSION } from './core/index-manifest';
import { ModelContextRegistry } from './ui/tokens/model-context-registry';
import { ModelsDevCatalogCache } from './settings/model-catalog-cache';
import os from 'os';
// 关键路径:P-SKILL-1-CORE — Skill 机制(三源加载 + 注册表 + 激活器 + 2 工具)。
import { SkillLoader } from './skills/skill-loader';
import { SkillRegistry } from './skills/skill-registry';
import { SkillActivator } from './skills/skill-activator';
import { syncBuiltinSkills } from './skills/builtin-writer';
import { SkillFsAdapter } from './adapters/skill-fs';
import { SkillVaultAdapter } from './adapters/skill-vault';
import { createActivateSkillTool } from './tools/activate-skill';
import { createDeactivateSkillTool } from './tools/deactivate-skill';
// 关键路径(P-SKILL-2/ADR-017):skill 脚本执行 — 沙箱 + 信任门 + 2 工具接线。
import { createReadSkillReferenceTool } from './tools/read-skill-reference';
import { createRunSkillScriptTool } from './tools/run-skill-script';
import { SkillScriptSandbox } from './skills/skill-script-sandbox';
import { ScriptTrustGate } from './skills/skill-script-permission';
import { showScriptTrustModal } from './ui/skills/ScriptTrustModal';
import { SKILL_SCRIPT_WORKER_CODE } from './adapters/skill-script-worker-code';
import { createGetDatetimeTool } from './tools/get-datetime';
import { createGetActiveNoteTool } from './tools/get-active-note';
import { createGetDailyNoteTool } from './tools/get-daily-note';
import { createListRecentNotesTool } from './tools/list-recent-notes';
import { createGetNoteOutlineTool } from './tools/get-note-outline';
import { createGetLinksTool } from './tools/get-links';
import { createSearchByTagTool } from './tools/search-by-tag';
import { createSearchByPropertyTool } from './tools/search-by-property';
import { createGetVaultStructureTool } from './tools/get-vault-structure';
import { createOpenNoteTool } from './tools/open-note';
import { createOpenSettingsTool } from './tools/open-settings';
import { createGetAppConfigTool } from './tools/get-app-config';
import { createUpdateAppConfigTool } from './tools/update-app-config';
import { ObsidianWorkspace } from './adapters/obsidian-workspace';
import type { WorkspacePort } from './ports/workspace';
import { compactSession } from './ui/chat/compact-session';
import { shouldRetryAfterOverflow } from './core/compact-overflow-retry';
import { GoalStore } from './core/goal-store';
import { GoalRunner, composeGoalAnchor } from './core/goal-runner';
import { createGoalGrantCheck } from './core/goal-grant';
import {
	createManageGoalTool,
	type ManageGoalPrompts,
} from './tools/manage-goal';
import { createSearchPluginsTool } from './tools/search-plugins';
import { createInstallPluginTool } from './tools/install-plugin';
import { createUpdatePluginTool } from './tools/update-plugin';
import { createUninstallPluginTool } from './tools/uninstall-plugin';
import { createConfigurePluginTool } from './tools/configure-plugin';
import { createGetPluginStatusTool } from './tools/get-plugin-status';
import { createListEcosystemChangesTool } from './tools/list-ecosystem-changes';
import { createRestoreBackupTool } from './tools/restore-backup';
import { createApplyDiaryHostTool } from './tools/apply-diary-host';
import {
	createImportHostFileTool,
	createListHostDirTool,
	createReadHostFileTool,
	createRunHostCommandTool,
} from './tools/host-access';
import { updateCommunityPlugin } from './adapters/ecosystem-update';
import { uninstallCommunityPlugin } from './adapters/ecosystem-uninstall';
import { inspectPluginData, applyPluginData, syncLoadedPluginSettings } from './adapters/ecosystem-configure';
import { listInstalledPlugins, getCommunityPluginStatus } from './adapters/ecosystem-status';
import { restoreEcosystemBackup } from './adapters/ecosystem-restore';
import { listEcosystemChanges } from './core/ecosystem-change-log';
import { EcosystemRegistry } from './adapters/ecosystem-registry';
import { AdapterEcosystemIo } from './adapters/ecosystem-vault';
import { installCommunityPlugin } from './adapters/ecosystem-install';
import { openExternalUrl } from './utils/open-external-url';
import { showGoalActionConfirmModal } from './ui/goal/GoalActionConfirmModal';
import {
	applyGoalTerminalChoice,
	showGoalCompletedNotice,
	showGoalTerminalChoiceModal,
	type GoalTerminalChoiceResult,
} from './ui/goal/GoalTerminalChoiceModal';
import { waitGoalModalGap } from './ui/goal/wait-goal-modal';
import { pickGoalStatusBarText } from './ui/goal/goal-status-bar';
import { GoalManageModal, shouldCreateGoalManageModal } from './ui/goal/GoalManageModal';
import { bumpGoalRevision } from './ui/goal/goal-revision';
import type { AgentGoal } from './core/goal-store';

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
	workspacePort!: WorkspacePort;
	persistence!: PersistenceJson;
	llm!: LLMClient;
	embedding!: EmbeddingPort;
	tools!: ToolRegistry;
	hooks!: HookRegistry;
	/** MCP Host — 多 Server 编排；默认空配置零出站 */
	mcpHost!: McpHost;
	workerManager!: WorkerManager;
	// 关键路径:vectraStore 持有向量索引目录的引用,需在 plugin 生命周期内常驻;
	// 布局按代际固定(分片为常态),上层只依赖两者共有的方法语义。
	vectraStore!: IndexVectorStore;
	// 关键路径:InlineWorker 在主线程模拟 Worker,用于 Obsidian 渲染进程不支持 Worker Threads 的环境。
	private inlineWorker?: InlineWorker;
	// 关键路径:EmbeddingWorkerProxy 把 ONNX 推理移入 Web Worker,onunload 时需 terminate 释放线程。
	private embeddingWorkerProxy?: EmbeddingWorkerProxy;
	/** 本会话是否选中 GPU 版嵌入 Worker;决定 deps 工厂取 jsep wasm。 */
	private gpuWorkerSelected = false;
	// 关键路径:Blob URL 在 onunload 需 revokeObjectURL 释放,避免内存泄漏。
	private embeddingWorkerUrl?: string;
	// 关键路径:indexDir 在 onload 计算,onLayoutReady 初始化 InlineWorker 时需要复用。
	private indexDir!: string;
	/**
	 * 索引根(`.index/`)—— 控制指针、owner 锁与 `generations/` 都在这里。
	 *
	 * 关键路径:日志与 `control` 在根、Vectra 数据在 `generations/<id>`;因此
	 * `indexDir` 是注入给存储与日志的**代际目录**,`indexRoot` 才是受保护的索引根。
	 * 任何清库都必须指向代际目录,不能是根(T6 §8.1)。
	 */
	private indexRoot!: string;
	/** 写所有权门面 — 同时持有 renderer 内 epoch 租约与索引根 `owner.lock`;只在自动索引开启时获取。 */
	private indexOwnerLease?: IndexWriteOwner;
	/** 代际与控制指针管理者。 */
	private indexGenerations?: IndexGenerations;
	/** 线程模式下的索引客户端;未启用或回落后为 undefined。 */
	private indexThreadClient?: IndexRuntimeClient;
	/** 线程模式下的协调器。 */
	private indexThreadCoordinator?: IndexThreadCoordinator;
	/** 线程模式下替换检索可见性门;主线程模式保持 undefined。 */
	private threadSearchGate?: SearchCandidateGate;
	/** 写运行时身份守卫 — 同一会话内不同配置的装配会被显式拒绝。 */
	private readonly indexIdentityGuard = new IndexRuntimeIdentityGuard();
	/** 本次装配登记的身份释放入口;卸载时调用。 */
	private releaseIndexIdentity?: () => void;
	/** 本实例写入的日志(既是后端记录端口,也是协调器提交端口)。 */
	private indexJournal?: IndexFileJournal;
	/** 持久任务协调器(T4 扫描/队列/新鲜度,T5 活动与取消)。 */
	private indexCoordinator?: IndexTaskCoordinator;
	/** 停滞看护(T5)。 */
	private indexStallWatchdog?: IndexStallWatchdog;
	/** 协调器处理器端口(分块 + 嵌入)。 */
	private indexProcessorPort?: ChunkingCoordinatorProcessor;
	/**
	 * 控制指针上的活动代际 ID;没有活动代际时为 null。
	 *
	 * 关键路径:配置变化时本实例解析出的是**隔离的** building/verifying 代际(见
	 * `resolvedGenerationId`),而本字段在原子切换完成前仍是那个可用的旧代际 ——
	 * 清库守卫(`isActiveGeneration`)与状态展示据此继续把它当作正在使用的索引。
	 */
	private activeGenerationId: string | null = null;
	/** 本实例解析出的代际 ID(可能是 building/verifying,等待首个提交或本轮核对完成)。 */
	private resolvedGenerationId: string | null = null;
	/** 当前配置指纹 — 协调器核对与可见性门共用同一份。 */
	private indexConfigFingerprint = '';
	/** 关闭自动索引时注入的只读可见性视图(检索侧消费,归 T7b)。 */
	private readOnlySearchView?: ReadOnlySearchView;
	/** 本轮是从旧索引迁移来的(T6 装配期结论)— 状态展示据此说明「迁移中/迁移后核对」。 */
	private indexMigrated = false;
	/** 当前解析出的索引目录是否可用(有活动代际或本实例已建代际)。 */
	private indexDirUsable = false;
	/** 活动代际登记器 — 登记算法在 `core/index-runtime-assembly`,此处只绑定实例闭包。 */
	private generationActivationPublisher?: GenerationActivationPublisher;
	/** 状态订阅句柄(活动代际登记用)。 */
	private generationActivationUnsub?: () => void;
	/**
	 * 索引运行时装配失败原因 — 非空表示索引处于**降级状态**(T7/I2)。
	 *
	 * 关键路径:迁移失败或没有可用代际时不再让 `onload` reject —— 那会让插件整体不可用
	 * (连聊天都打不开,且用户看不到原因)。降级只停索引,状态与 Notice 如实说明,并提供重试入口。
	 */
	private indexUnavailable: { error: unknown; message: string } | null = null;
	/**
	 * 本实例装配时的索引配置身份 — 会话内配置漂移检测的唯一依据(T7/I6)。
	 *
	 * 关键路径:`indexConfigFingerprint` 只在装配时算一次;`getBuildStamp()` 却读实时 settings,
	 * 因此会话内改嵌入模型会让「协调器按旧指纹写日志、清单/戳写新参数」静默混写。这里记住
	 * 装配期身份,任何一次 `rebuildEmbeddingAdapter` 后逐字比对。
	 */
	private indexConfigIdentity: string | null = null;
	/** 索引迁移/回收结论 — 诊断落点(T7/I4),只放结论面,不含笔记正文。 */
	private indexConclusion: IndexConclusionDiagnostics | null = null;
	/** vault 根绝对路径 — 索引对象装配(含降级重试)复用。 */
	private vaultBase = '';
	// 关键路径:用户记忆存储,管理 .ratel/memory/ 下的 markdown 文件与 .memory-index/ vectra 索引
	// P-MEMORY-UI:MemoryPanel 直接读写(查看/编辑/删除条目),故公开。
	memoryStore!: MemoryStore;
	// 关键路径(S-SR-LAYERING):使用统计存储(pluginDir/usage-stats.json);UI 管理面板读取展示
	usageStats!: UsageStatsStore;
	// 关键路径:P-SKILL-1-CORE — Skill 三源加载器、注册表、激活器。
	private skillLoader!: SkillLoader;
	// S-SKILL-UX:SkillManageModal 直接读写注册表(per-skill 开关),故公开。
	skillRegistry!: SkillRegistry;
	private skillActivator!: SkillActivator;
	/** ADR-012:当前 ask 的 ContextManager,供 activate/deactivate 工具写 transcript */
	private currentAskCtx: ContextManager | null = null;
	modelManager!: ModelManager;
	modelContextRegistry!: ModelContextRegistry;
	/** S-MODEL-CATALOG: models.dev 名单缓存。打开对话模型页时才拉取 */
	modelsDevCatalog!: ModelsDevCatalogCache;
	indexController!: IndexController;
	// 关键路径:索引 backend 引用 — 完成宣告(`isIndexComplete`)与诊断(`roundState`)都由
	// 装配层直接读取,避免 this.indexController['indexManager']['backend'] 反模式访问私有字段。
	// 扫描/提交入口不从这里转发:t7 起协调器持有逐文件核对,清库入口只剩 dropInactiveGenerations。
	indexBackend!: IndexBackend;
	// 关键路径:索引清单 — 记每文件 hash + 全局 embedding 参数,启动期 hash diff。
	indexManifest!: IndexManifest;
	// 关键路径:W4 — Indexer subagent 实例,供 Librarian 等子代理调用。
	indexer!: Indexer;
	toolSessionGrants = new ToolPermissionSessionGrants();
	private ecosystemRegistry!: EcosystemRegistry;
	/** 图片附件外置存储(S-VISION v1.3)— onload 装配,目录 <pluginDir>/attachments;会话删除时整目录清走 */
	attachments!: AttachmentStore;
	/** 崩溃面包屑（S-RENDER-STABILITY A）— onload 装配；可选链避免中途失败 */
	breadcrumbs?: CrashBreadcrumbs;
	lastRunDiag: LastRunDiag | null = null;
	memoryHigh = false;
	userNotice = new UserNotice();
	userStatus = new UserStatus();
	/** file-menu 插入 @mention 时若 ChatView 尚未 mount,先排队 */
	pendingChatMention?: string;
	private feedbackController?: FeedbackController;
	/** 记忆管理 Modal 单例 — 已打开则忽略再次 open */
	private memoryModal: MemoryModal | null = null;
	/** 目标管理 Modal 单例 — 已打开则忽略再次 open */
	private goalManageModal: GoalManageModal | null = null;
	/** MCP 管理 Modal 单例 — 已打开则忽略再次 open */
	private mcpManageModal: McpManageModal | null = null;
	/** Skill 管理 Modal 单例(S-SKILL-UX;已打开则忽略重复打开) */
	private skillManageModal: SkillManageModal | null = null;
	/** Skill 脚本沙箱(P-SKILL-2/ADR-017)— onunload 时 terminateAll 击杀活跃脚本 Worker */
	private skillScriptSandbox: SkillScriptSandbox | null = null;
	/** Goal 落盘与回合收口(S-GOAL) */
	goalStore!: GoalStore;
	goalRunner!: GoalRunner;
	/** UI 刷新令牌 — ChatView / 底栏订阅 */
	goalRevision = 0;
	private goalStatusBarEl?: HTMLElement;
	private goalStatusBarOpensSettings = false;
	private currentChatSessionId: string | null = null;
	/** 当前 ask 轮用户原文 — manage_goal 斜杠同回合硬拒 */
	lastAskUserText?: string;
	private pendingTerminalGoalId: string | null = null;
	private pendingTerminalKind: 'completed' | 'cancelled' | null = null;
	private pendingTerminalAllowWriteNote = false;
	// 关键路径:SettingTab 实例在 addSettingTab 时保存,ObsidianWorkspace 经 getter 读最新值定位 tab
	settingTab: RatelVaultSettingTab | null = null;
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
		// 关键路径:启动时根据 settings.language 解析界面语言并写入 langStore,
		// 必须在所有 tNow 调用之前执行(命令注册、Notice、错误消息都依赖 langStore)。
		applyLangPreference(this.settings.language);

		// ==================== 适配器装配 ====================
		this.vault = new ObsidianVault(this.app);
		this.workspacePort = new ObsidianWorkspace(this.app, () => this.settingTab);
		// 关键路径:Persistence 分文件 sessions 依赖 pluginDir,须在构造前解析绝对路径
		const adapter = this.app.vault.adapter as FileSystemAdapter;
		const vaultBase = adapter.getBasePath();
		// 关键路径:保留给降级重试复用 —— 重试时 IndexController 需要同一个 vault 根。
		this.vaultBase = vaultBase;
		const pluginDir = path.join(vaultBase, this.app.vault.configDir, 'plugins', 'ratel-vault');
		this.persistence = new PersistenceJson(
			() => this.loadData(),
			(data) => this.saveData(data),
			pluginDir,
		);
		this.llm = this.createChatLlm();

		// Embedding 适配器:本地 ONNX vs 远端 OpenAI 兼容端点,按设置二选一。
		this.rebuildEmbeddingAdapter();

		// ==================== 索引目录与代际(启动期) ====================
		// 关键路径:pluginDir / vaultBase 已在上方构造 Persistence 时解析。
		// 注入实际 configDir 名,供 path-safety 拦截配置目录访问(兼容用户自定义 configDir)。
		setConfigDir(this.app.vault.configDir);
		this.ecosystemRegistry = new EcosystemRegistry(pluginDir, async (url) => {
			const response = await requestUrl({ url, method: 'GET', throw: false });
			return { status: response.status, text: response.text };
		});
		// 关键路径:代际解析必须早于任何索引 store 构造 —— 注入给存储/日志/后端的 `indexDir`
		// 是 `generations/<activeGenerationId>`,`.index/` 根只承载 control、owner 锁与日志。
		// 方法内部会按「活动代际 → legacy 迁移 → 新建 building 代际」的顺序解析,并在
		// 本实例写入的 `owner.lock` 内完成;只读装配(`autoIndex=false`)不取锁、零写入。
		await this.setupIndexRuntime(pluginDir);
		ensurePluginGitignore(pluginDir);
		this.breadcrumbs = new CrashBreadcrumbs({
			pluginDir,
			enabled: () => this.settings.crashBreadcrumbs !== false,
			onMemoryHigh: () => {
				this.memoryHigh = true;
				new Notice(tNow('diag.memoryHigh'));
			},
		});
		this.lastRunDiag = this.breadcrumbs.inspectLastRun();
		this.breadcrumbs.mark('plugin.load');
		this.breadcrumbs.startHeartbeat();
		// S-VISION v1.3:附件外置根目录 — 必须用上方解析好的绝对 pluginDir
		// 修复: 曾误用相对的 manifest.dir,渲染进程 CWD 下 fs 相对解析直接 ENOENT
		this.attachments = new AttachmentStore(path.join(pluginDir, 'attachments'));
		this.goalStore = new GoalStore(pluginDir);
		this.goalRunner = new GoalRunner({
			goalStore: this.goalStore,
			vault: this.vault,
			settings: () => ({
				goalRoundTokenSoftCap: this.settings.goalRoundTokenSoftCap,
				agentMaxSteps: this.settings.agentMaxSteps,
			}),
		});
		this.modelContextRegistry = new ModelContextRegistry(pluginDir);
		this.modelsDevCatalog = new ModelsDevCatalogCache(pluginDir);

		// ==================== 用户记忆系统 ====================
		// 关键路径:记忆目录在 vault 内的 .ratel/memory/,用户可见可编辑;
		// 记忆索引在 pluginDir/.memory-index/,与 vault 索引物理隔离,避免记忆写入触发 vault 重建。
		const memoryDir = path.join(vaultBase, '.ratel', 'memory');
		const memoryIndexDir = path.join(pluginDir, '.memory-index');
		// 关键路径:记忆索引 VectraStore 用 autoInit: false — 等模型就绪后再 init,避免 onload 阶段阻塞。
		// 关键路径(C2 修复):不向 VectraStore 注入 embeddings 模型 — upsertToIndex 改用
		// embeddingPort.embed + upsertItem 预计算向量路径,绕过 vectra 内部 embeddings 调用。
		// embeddingPort(this.embedding)在上方 rebuildEmbeddingAdapter 已构造,与记忆索引共享同一份
		// ONNX FeatureExtractor,确保记忆向量化与 vault 索引向量化维度一致。
		// 关键路径(B3):记忆索引同样注入原子存储 —— `endUpdate` 的落盘走临时文件 + rename,
		// 提交失败时才能按写入结果区分「完整旧版」与「完整新版」,而不是一律报「状态不明」。
		const memoryVectraStore = new VectraStore(memoryIndexDir, {
			autoInit: false,
			storage: this.createIndexStorage(memoryIndexDir),
		});
		this.memoryStore = new MemoryStore(memoryDir, memoryVectraStore, this.embedding);
		this.memoryStore.ensureDir();
		// 关键路径(S-SR-LAYERING):使用统计与记忆索引同域放 pluginDir,不进 data.json / vault(spec §4)。
		this.usageStats = new UsageStatsStore(path.join(pluginDir, 'usage-stats.json'));

		// ==================== Skills(P-SKILL-1-CORE) ====================
		// 关键路径:三源路径 — builtin(pluginDir/skills 只读)/ global(~/.ratel/skills)/
		// vault 源走 VaultPort,rootDir 必须是 vault 相对路径(如 `.ratel/skills`),
		// 禁止 path.join(vaultBase, ...) 绝对路径 — Obsidian adapter.list 会再拼一次 vault 根,导致 ENOENT 双路径。
		const builtinSkillsDir = path.join(pluginDir, 'skills');
		const globalSkillsDir = path.join(os.homedir(), '.ratel', 'skills');
		const vaultSkillsDir = '.ratel/skills';
		const builtinPort = new SkillFsAdapter('builtin', builtinSkillsDir);
		const globalPort = new SkillFsAdapter('global', globalSkillsDir);
		const vaultPort = new SkillVaultAdapter(this.vault, vaultSkillsDir);
		this.skillLoader = new SkillLoader([builtinPort, globalPort, vaultPort]);
		this.skillRegistry = new SkillRegistry();
		this.skillActivator = new SkillActivator(this.skillRegistry);
		// 关键路径:内置 skill 分发(ADR-006 三文件约束) — 构建期内联,启动时幂等落盘;
		// 无条件执行,version 随应用版本,
		// 升级自动重写;用户在 vault 源放同名 skill 可覆盖内置版(三源合并 vault > builtin)。
		const builtinSync = syncBuiltinSkills(builtinSkillsDir, BUILTIN_SKILLS, APP_VERSION, BUILTIN_SKILL_PROFILES);
		if (builtinSync.written.length > 0) {
			devLogger.info('skill', `内置 skill 已更新: ${builtinSync.written.join(', ')}`);
		}
		// 关键路径:onload 异步加载 skills,不阻塞 Obsidian 启动(spec §6.6)。
		// S-SKILL-UX:技能装了就生效,无条件加载。
		void this.reloadSkills();

		// ==================== Worker ====================
		// 关键路径:优先尝试 Node.js Worker Threads;Obsidian 渲染进程不支持时降级到 InlineWorker。
		// InlineWorker 在同线程执行,能解决 CORS/平台限制,但大索引会阻塞 UI。
		this.workerManager = this.createWorkerManager();

		// ==================== 模型与索引 ====================
		// 关键路径:本地模型缓存放到插件目录,与 index 同级,便于随插件清理。
		// ORT WASM 首次使用时从 jsDelivr 下载并缓存到 pluginDir(ADR-006);商店 release 只含 main.js。
		const ortAssets = new OrtRuntimeAssets(pluginDir);
		this.modelManager = new ModelManager(path.join(pluginDir, 'models'), ortAssets);

		// 关键路径:索引侧对象装配集中在 assembleIndexObjects —— 降级重试(索引不可用后恢复)
// 与 onload 必须走同一处,否则两边的清单/后端/控制器装配会漂移。
		this.assembleIndexObjects();
		await this.preheatReadOnlyView();

		// ==================== 工具与钩子 ====================
		this.tools = new ToolRegistry();
		// 关键路径:用当前 settings.promptOverrides 生成 definition,让用户在设置面板的覆盖立即生效。
		const toolDefs = composeToolDefinitions(this.settings.promptOverrides, ALL_TOOL_NAMES);
		const toolDefMap = new Map(toolDefs.map((d) => [d.name, d]));
		this.tools.register(
			createReadNoteTool(this.vault, toolDefMap.get('read_note')!),
		);

		// 关键路径:W4 — 构造 MultiQuerySearcher,编排改写 + 多查询 + RRF + 可选 Rerank。
		// 关键路径(S-RETRIEVAL-QUALITY §4.4):Reranker 用工厂注入,每次检索时按当前设置解析 ——
		// 用户在设置里切换「启用精排 / 精排来源」后立即生效,无需重载插件;
		// 关闭或来源不可用时工厂返回 undefined,检索链路连全文都不读。
		//
		// 关键路径:hasLlm 必须用 hasChatApiKey(app, settings) ——
		// this.llm 启动时总是被构造,用 `!!this.llm` 恒为真。
		const reranker = (): RerankerPort | undefined => this.resolveReranker();

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
			embedding: this.effectiveEmbedding(),
			workerManager: this.workerManager,
			vault: this.vault,
			reranker,
			queryRewriter,
			// 关键路径(T7/A11):统一可见性门 —— 原始向量候选进入融合/重排前的唯一闸门;
			// 写路径用日志+协调器新鲜度,关闭自动索引时用只读视图+内存变更集。
			visibility: this.createSearchCandidateGate(),
			// 关键路径:线程模式下召回由线程存储提供;主线程模式保持 undefined(仍走 Worker)。
			...(this.settings.indexThreadMode === true ? { candidateSource: this.createThreadCandidateSource() } : {}),
		});

		this.tools.register(
			createSearchVaultTool(
				multiQuerySearcher,
				() => isSearchReady(get(this.userStatus.statusBar$)),
				toolDefMap.get('search_vault')!,
				this.vault,
			),
		);
		this.tools.register(createGrepTool(this.vault, toolDefMap.get('grep')!));
		this.tools.register(createGlobTool(this.vault, toolDefMap.get('glob')!));
		this.tools.register(createListFilesTool(this.vault, toolDefMap.get('list_files')!));
		this.tools.register(
			createWriteNoteTool(this.vault, toolDefMap.get('write_note')!),
		);
		this.tools.register(
			createAppendNoteTool(this.vault, toolDefMap.get('append_note')!),
		);
		this.tools.register(
			createEditNoteTool(this.vault, toolDefMap.get('edit_note')!),
		);
		this.tools.register(
			createApplyPatchTool(this.vault, toolDefMap.get('apply_patch')!),
		);
		this.tools.register(
			createDeleteNoteTool(this.vault, toolDefMap.get('delete_note')!),
		);
		this.tools.register(
			createMoveNoteTool(this.vault, toolDefMap.get('move_note')!),
		);
		this.tools.register(
			createCopyNoteTool(this.vault, toolDefMap.get('copy_note')!),
		);
		// 关键路径:记忆工具 — 3 个新工具,复用 memoryStore 与主线程 embeddingPort。
		// search_memory 是只读工具(查询记忆);remember / forget_memory 是写工具(触发 pre/post write hook)。
		this.tools.register(
			createSearchMemoryTool(
				this.memoryStore,
				this.embedding,
				toolDefMap.get('search_memory')!,
				// 关键路径:传 getter 现读 settings,设置面板改 memoryDynamicLimitKB 后立即生效,无需重载插件。
				() => this.settings.memoryDynamicLimitKB * 1024,
			),
		);
		this.tools.register(createRememberTool(this.memoryStore, toolDefMap.get('remember')!));
		this.tools.register(createForgetMemoryTool(this.memoryStore, toolDefMap.get('forget_memory')!));
		// 关键路径:P-SKILL / ADR-012 — skill 工具写入当前 ask 的 ContextManager(transcript)。
		const skillSessionHooks = {
			hasInSession: (name: string) => this.currentAskCtx?.hasSkillInstructions(name) ?? false,
			appendToSession: (name: string, instructions: string) => {
				this.currentAskCtx?.appendSkillInstructions(name, instructions);
			},
			supersedeInSession: (name: string) => {
				this.currentAskCtx?.appendSkillSupersede(name);
			},
		};
		this.tools.register(
			createActivateSkillTool(
				this.skillRegistry,
				toolDefMap.get('activate_skill')!,
				skillSessionHooks,
				// 关键路径(S-SR-LAYERING):激活成功后计数到 pluginDir/usage-stats.json
				this.usageStats,
			),
		);
		this.tools.register(
			createDeactivateSkillTool(
				this.skillRegistry,
				toolDefMap.get('deactivate_skill')!,
				skillSessionHooks,
			),
		);
		// 关键路径(P-SKILL-2/ADR-017):脚本沙箱 — Worker 一次性,runner 常驻管理串行与超时。
		const scriptSandbox = new SkillScriptSandbox(SKILL_SCRIPT_WORKER_CODE);
		this.skillScriptSandbox = scriptSandbox;
		const scriptTrustGate = new ScriptTrustGate({
			isTrusted: (scriptId) => this.settings.trustedScripts.includes(scriptId),
			confirm: async (scriptId) => {
				// scriptId = `skillName/scriptPath`,拆回 skillName 取来源标签
				const skillName = scriptId.split('/')[0] ?? scriptId;
				const skill = this.skillRegistry.get(skillName);
				return showScriptTrustModal(this.app, {
					scriptId,
					skillName,
					sourceLabel: skill ? tNow(`skill.source.${skill.source}`) : '—',
					skillDir: skill?.dir ?? '',
				});
			},
			persistTrust: (scriptId) => {
				// 关键路径:「允许并记住」= 写白名单 + 清熔断计数(用户显式重确认,ADR-017 恢复路径)
				if (!this.settings.trustedScripts.includes(scriptId)) {
					this.settings.trustedScripts.push(scriptId);
				}
				this.usageStats.clearScriptFailure(scriptId);
				void this.saveSettings();
			},
		});
		this.tools.register(
			createReadSkillReferenceTool(this.skillRegistry, toolDefMap.get('read_skill_reference')!),
		);
		this.tools.register(
			createRunSkillScriptTool(this.skillRegistry, toolDefMap.get('run_skill_script')!, {
				sandbox: scriptSandbox,
				trustGate: scriptTrustGate,
				failures: this.usageStats,
				// 关键路径:getter 现读 settings,设置面板改 skillScriptTimeout 立即生效
				timeoutMs: () => this.settings.skillScriptTimeout,
				vaultRoot: () => this.vault.getRootDir(),
				configDirName: () => this.app.vault.configDir,
				onSoftTimeout: () => new Notice(tNow('skill.script.softTimeoutNotice')),
				onCircuitBreak: (scriptId) => new Notice(tNow('skill.script.circuitNotice', { id: scriptId })),
			}),
		);
		// 关键路径(P-BASIC-ENV):环境感知工具 — 时间 / 活动笔记 / 日记 / 最近修改 / 大纲。
		this.tools.register(createGetDatetimeTool(toolDefMap.get('get_datetime')!));
		this.tools.register(
			createGetActiveNoteTool(this.workspacePort, this.vault, toolDefMap.get('get_active_note')!),
		);
		this.tools.register(
			createGetDailyNoteTool(
				this.vault,
				() => ({
					folder: this.settings.dailyNoteFolder,
					format: this.settings.dailyNoteFormat,
				}),
				toolDefMap.get('get_daily_note')!,
			),
		);
		this.tools.register(createListRecentNotesTool(this.vault, toolDefMap.get('list_recent_notes')!));
		this.tools.register(createGetNoteOutlineTool(this.vault, toolDefMap.get('get_note_outline')!));
		// 关键路径:P-EVO-A-READ — 图谱读侧工具复用 Obsidian metadataCache，不扫描全文。
		this.tools.register(createGetLinksTool(this.vault, toolDefMap.get('get_links')!));
		this.tools.register(createSearchByTagTool(this.vault, toolDefMap.get('search_by_tag')!));
		this.tools.register(createSearchByPropertyTool(this.vault, toolDefMap.get('search_by_property')!));
		this.tools.register(
			createGetVaultStructureTool(this.vault, toolDefMap.get('get_vault_structure')!),
		);
		// 关键路径(P-CFG):open_note 在对话中为用户打开笔记并定位标题/块,纯 UI 导航。
		this.tools.register(
			createOpenNoteTool(this.workspacePort, this.vault, toolDefMap.get('open_note')!),
		);
		// 关键路径(P-CFG):open_settings 把设置面板对应 tab 打开到用户眼前,
		// 密钥 / MCP 等白名单外配置 Agent 不能代改,靠本工具引导用户手动完成。
		this.tools.register(
			createOpenSettingsTool(this.workspacePort, toolDefMap.get('open_settings')!),
		);
		// 关键路径(P-CFG):get_app_config 读取脱敏配置快照,排查「为什么不工作」的第一步。
		// SecretProbe 内联绑定 ratel-secrets 散函数(签名一致,method 双变兼容);settings 传 live 引用。
		this.tools.register(
			createGetAppConfigTool(
				{
					app: this.app,
					secrets: {
						hasChatApiKey,
						hasEmbedApiKey,
						hasRerankApiKey,
						getChatSecretId,
						getEmbedSecretId,
					},
				},
				{ settings: this.settings },
				// 关键路径(T7/I2):工具的生命周期长于索引控制器 —— 经延迟解析视图读取,
				// 降级重试重建控制器后不会继续读旧状态机。
				this.currentIndexStatus(),
				toolDefMap.get('get_app_config')!,
			),
		);
		// 关键路径(P-CFG):update_app_config 白名单内代改设置;写入走 settings-apply,
		// 与设置面板同一套副作用(rebuildLLM / rebuildEmbeddingAdapter / preset 联动)。
		// RatelVaultPlugin 结构兼容 ConfigUpdateHost(SettingApplier + saveSettings),直接传 this。
		this.tools.register(
			createUpdateAppConfigTool(this, toolDefMap.get('update_app_config')!),
		);
		const manageGoalPrompts: ManageGoalPrompts = {
			promptCreate: async () => ({ confirmed: true }),
			promptConfirm: ({ action, goal }) => showGoalActionConfirmModal(this.app, action, goal),
			promptClose: ({ kind, goal }) =>
				showGoalTerminalChoiceModal(this.app, kind, goal, { alreadyTerminal: false }),
			onTerminal: (goal, kind) => this.handleGoalTerminal(goal, kind),
			onClosed: (goal, kind, result) => this.finishGoalTerminalUi(goal, kind, result),
			onChanged: () => this.bumpGoalUi(),
		};
		this.tools.register(
			createManageGoalTool(
				this.goalStore,
				toolDefMap.get('manage_goal')!,
				() => this.currentChatSessionId ?? '',
				manageGoalPrompts,
				() => this.settings.goalMaxRounds,
				() => this.lastAskUserText ?? '',
			),
		);

		const listInstalledPluginIds = (): Set<string> => {
			try {
				const dir = path.join(this.vault.getRootDir(), this.app.vault.configDir, 'plugins');
				return new Set(readdirSync(dir).filter((name) => name && !name.startsWith('.')));
			} catch {
				return new Set();
			}
		};

		this.tools.register(
			createSearchPluginsTool(toolDefMap.get('search_plugins')!, {
				registry: this.ecosystemRegistry,
				installedIds: () => listInstalledPluginIds(),
			}),
		);
		this.tools.register(
			createInstallPluginTool(toolDefMap.get('install_plugin')!, {
				run: async (pluginId) => {
					const catalog = await this.ecosystemRegistry.ensureCatalog();
					const catalogIds = new Set(catalog.plugins.map((p) => p.id));
					const installedIds = listInstalledPluginIds();
					const io = new AdapterEcosystemIo(this.app.vault.adapter, () => ({ catalogIds, installedIds }));
					return installCommunityPlugin(pluginId, {
						registry: this.ecosystemRegistry,
						io,
						configDir: this.app.vault.configDir,
						writeEnabled: this.settings.ecosystemWriteEnabled,
						apiVersion,
						openOfficialPage: (uri) => openExternalUrl(uri),
						appLike: this.app,
						pluginDir,
					});
				},
			}),
		);
		this.tools.register(createUpdatePluginTool(toolDefMap.get('update_plugin')!, {
			run: async (pluginId) => {
				const catalog = await this.ecosystemRegistry.ensureCatalog();
				const catalogIds = new Set(catalog.plugins.map((p) => p.id));
				const installedIds = listInstalledPluginIds();
				const io = new AdapterEcosystemIo(this.app.vault.adapter, () => ({ catalogIds, installedIds }));
				return updateCommunityPlugin(pluginId, {
					registry: this.ecosystemRegistry,
					io,
					configDir: this.app.vault.configDir,
					writeEnabled: this.settings.ecosystemWriteEnabled,
					apiVersion,
					openOfficialPage: (uri) => openExternalUrl(uri),
					appLike: this.app,
					pluginDir,
				});
			},
		}));
		this.tools.register(createUninstallPluginTool(toolDefMap.get('uninstall_plugin')!, {
			run: async (pluginId) => {
				const catalog = await this.ecosystemRegistry.ensureCatalog();
				const catalogIds = new Set(catalog.plugins.map((p) => p.id));
				const installedIds = listInstalledPluginIds();
				const io = new AdapterEcosystemIo(this.app.vault.adapter, () => ({ catalogIds, installedIds }));
				return uninstallCommunityPlugin(pluginId, {
					io,
					pluginDir,
					configDir: this.app.vault.configDir,
					writeEnabled: this.settings.ecosystemWriteEnabled,
					appLike: this.app,
				});
			},
		}));
		this.tools.register(createConfigurePluginTool(toolDefMap.get('configure_plugin')!, {
			inspect: async (id) => {
				const catalog = await this.ecosystemRegistry.ensureCatalog();
				const io = new AdapterEcosystemIo(this.app.vault.adapter, () => ({
					catalogIds: new Set(catalog.plugins.map((p) => p.id)),
					installedIds: listInstalledPluginIds(),
				}));
				return inspectPluginData(id, { io, configDir: this.app.vault.configDir });
			},
			apply: async (id, patch, confirmedNewKeys) => {
				const catalog = await this.ecosystemRegistry.ensureCatalog();
				const io = new AdapterEcosystemIo(this.app.vault.adapter, () => ({
					catalogIds: new Set(catalog.plugins.map((p) => p.id)),
					installedIds: listInstalledPluginIds(),
				}));
				const result = await applyPluginData(id, patch, {
					io,
					pluginDir,
					configDir: this.app.vault.configDir,
					writeEnabled: this.settings.ecosystemWriteEnabled,
					confirmedNewKeys,
				});
				const loaded = (this.app as { plugins?: { plugins?: Record<string, { settings?: Record<string, unknown>; saveSettings?: () => Promise<void>; saveData?: (data: unknown) => Promise<void> }> } }).plugins?.plugins?.[id];
				await syncLoadedPluginSettings(loaded, patch);
				return result;
			},
		}));
		this.tools.register(createGetPluginStatusTool(toolDefMap.get('get_plugin_status')!, {
			list: async () => {
				const catalog = await this.ecosystemRegistry.ensureCatalog();
				const io = new AdapterEcosystemIo(this.app.vault.adapter, () => ({
					catalogIds: new Set(catalog.plugins.map((p) => p.id)),
					installedIds: listInstalledPluginIds(),
				}));
				return listInstalledPlugins({ io, configDir: this.app.vault.configDir });
			},
			status: async (id, opts) => {
				const catalog = await this.ecosystemRegistry.ensureCatalog();
				const io = new AdapterEcosystemIo(this.app.vault.adapter, () => ({
					catalogIds: new Set(catalog.plugins.map((p) => p.id)),
					installedIds: listInstalledPluginIds(),
				}));
				return getCommunityPluginStatus(id, {
					io,
					configDir: this.app.vault.configDir,
					registry: this.ecosystemRegistry,
					...opts,
				});
			},
		}));
		this.tools.register(createListEcosystemChangesTool(toolDefMap.get('list_ecosystem_changes')!, {
			run: (opts) => listEcosystemChanges(pluginDir, opts),
		}));
		this.tools.register(createRestoreBackupTool(toolDefMap.get('restore_backup')!, {
			run: async (changeId) => {
				const catalog = await this.ecosystemRegistry.ensureCatalog();
				const io = new AdapterEcosystemIo(this.app.vault.adapter, () => ({
					catalogIds: new Set(catalog.plugins.map((p) => p.id)),
					installedIds: listInstalledPluginIds(),
				}));
				return restoreEcosystemBackup(changeId, {
					io,
					pluginDir,
					configDir: this.app.vault.configDir,
					writeEnabled: this.settings.ecosystemWriteEnabled,
				});
			},
		}));
		this.tools.register(createApplyDiaryHostTool(toolDefMap.get('apply_diary_host')!, {
			app: this.app,
		}));
		const hostAccess = {
			enabled: () => this.settings.hostAccessEnabled === true,
			vaultRoot: () => (this.app.vault.adapter as FileSystemAdapter).getBasePath(),
		};
		this.tools.register(createListHostDirTool(toolDefMap.get('list_host_dir')!, hostAccess));
		this.tools.register(createReadHostFileTool(toolDefMap.get('read_host_file')!, hostAccess));
		this.tools.register(createImportHostFileTool(toolDefMap.get('import_host_file')!, {
			...hostAccess,
			writeBinary: async (vaultPath, data) => {
				const adapter = this.app.vault.adapter as FileSystemAdapter;
				const dir = vaultPath.includes('/') ? vaultPath.slice(0, vaultPath.lastIndexOf('/')) : '';
				if (dir && !(await adapter.exists(dir))) {
					await this.app.vault.createFolder(dir);
				}
				const copy = new ArrayBuffer(data.byteLength);
				new Uint8Array(copy).set(data);
				await adapter.writeBinary(vaultPath, copy);
			},
		}));
		this.tools.register(createRunHostCommandTool(toolDefMap.get('run_host_command')!, hostAccess));

		// ==================== MCP Host（ADR-014）====================
		// 关键路径:stdio 首次 spawn 弹窗确认；已批准 id 直接放行。
		this.mcpHost = new McpHost({
			tools: this.tools,
			confirmSpawn: async (cfg) => {
				if (cfg.transport !== 'stdio') return true;
				if (this.settings.mcpApprovedSpawns.includes(cfg.id)) return true;
				const ok = await requestMcpSpawnConfirmation(this.app, cfg);
				if (!ok) return false;
				// 关键路径:只持久化 approved 列表,禁止 saveSettings→sync 在 bringUp 中间重入
				if (!this.settings.mcpApprovedSpawns.includes(cfg.id)) {
					this.settings.mcpApprovedSpawns = [
						...this.settings.mcpApprovedSpawns,
						cfg.id,
					];
					const existing = ((await this.loadData()) ?? {}) as Record<string, unknown>;
					await this.saveData(mergePluginData(existing, { ...this.settings }));
				}
				return true;
			},
			getApiKey: (id) => resolveMcpSecret(this.app, id),
			getEnvValue: (key) => process.env[key] ?? '',
			createTransport: (cfg) => this.createMcpTransport(cfg),
		});
		void this.mcpHost.sync(this.settings.mcpServers).catch((err) => {
			devLogger.error('mcp', '初始 sync 失败', err);
		});

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
		this.registerView(VIEW_TYPE_RELEASE_NOTES, (leaf) => new ReleaseNotesView(leaf, this));

		// 修复:旧版独立记忆 leaf 残留 — 合并到 Modal 后拆除
		for (const leaf of this.app.workspace.getLeavesOfType('ratel-memory-panel')) {
			leaf.detach();
		}

		// Ribbon 图标:点击打开聊天侧栏。
		// 关键路径:Lucide 图标集无獾,用 emoji 替换 SVG,贴合 Ratel 品牌形象。
		const ribbonEl = this.addRibbonIcon('paw-print', 'Ratel', () => {
			void this.activateChatView();
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

		// 文件菜单:md → 添加到 Ratel(@mention,策略 A 只插相对路径)
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (!(file instanceof TFile) || file.extension !== 'md') return;
				menu.addItem((item) => {
					item
						.setTitle(tNow('chat.mention.fileMenu'))
						.setIcon('file-plus')
						.onClick(() => {
							void this.insertChatMention(file.path);
						});
				});
			}),
		);

		// 命令:Ask vault — 唤起聊天侧栏。
	this.addCommand({
		id: 'ask-vault',
		name: tNow('cmd.askVault'),
		callback: () => {
			void this.activateChatView();
		},
	});

	this.addCommand({
		id: 'show-release-notes',
		name: tNow('cmd.showReleaseNotes'),
		callback: () => {
			void openReleaseNotesTab(this, false);
		},
	});

	// 命令:索引状态 — 通过 Worker 拉取,UI 通过 Notice 提示。
	// 关键路径:这是用户**主动命令**触发的反馈,Toast 是合理的"命令结果通知",
	// 与"系统事件提示"(模型下载/索引完成)语义不同,保留 userNotice.toast 形式。
	// 实时索引状态由 FeedbackController 持续推送到 StatusBar,无需在此命令中重复同步。
	this.addCommand({
		id: 'index-status',
		name: tNow('cmd.showIndexStatus'),
		callback: async () => {
			const response = await this.workerManager.request({
				type: 'index.status',
				payload: {},
			});
			if (response.type === 'index.status.result') {
				this.userNotice.toast(
					tNow('notice.indexStatus', {
						count: response.payload.totalDocs,
						time: new Date(response.payload.lastIndexTime).toLocaleString(),
					}),
				);
			} else {
				this.userNotice.toast(tNow('notice.indexNotReady'));
			}
		},
	});

	// 命令:重建当前索引(逐文件重新核对,不清库 — 危险操作走二次确认 Modal)
	this.addCommand({
		id: 'reindex',
		name: tNow('cmd.rebuildIndex'),
		callback: () => showReindexConfirm(this.app, async () => {
			try {
				// 关键路径(T7a 语义):reindex 只做「撤销在途调用 + 逐文件重新核对」,
				// 不清空当前有效索引。
				await this.indexController.reindex();
			} catch (err) {
				// 关键路径(T7/I1):`IndexController.reindex` 把失败态压成裸 Error(丢码),
				// 因此优先取管理器的失败态(带 `errorCode`)再映射,保证上屏文案走码表。
				const status = get(this.indexController.indexManager.status$);
				const failure: unknown = status.state === 'Failed' ? status : err;
				this.markIndexDiskFailure(failure);
				throw new Error(describeIndexError(failure));
			}
		}),
	});

	// 命令:暂停索引(取消在途调用并停止调度;文件事件继续入队但不消费)
	this.addCommand({
		id: 'pause-index',
		name: tNow('cmd.pauseIndex'),
		callback: () => {
			// 关键路径:取消入口复用既有控制命令 —— 先撤销在途调用(协调器 + Worker 侧取消),
			// 再暂停调度;不新增设置页导航。
			this.cancelIndexRun();
			this.indexController.pause();
			this.userNotice.toast(tNow('notice.indexPaused'));
		},
	});

	// 命令:恢复索引(继续处理文件事件;永久挂起的运行时在这里被重置)
	this.addCommand({
		id: 'resume-index',
		name: tNow('cmd.resumeIndex'),
		callback: () => {
			// 关键路径:T5 §6 裁定 —— `resetRuntime` 是「写操作永久挂起」的唯一出口:
			// 结束所有受影响的等待,让运行时回到可用状态后重新调度;不终止共享 Worker。
			if (this.workerManager?.isStalled()) {
				devLogger.warn('index', '恢复索引前重置挂起的索引运行时');
				this.workerManager.resetRuntime();
			}
			this.indexController.resume();
			this.userNotice.toast(tNow('notice.indexResumed'));
		},
	});

	// 命令:清理非活动索引代际(只删未生效代际;强制输入 DELETE 确认)
	this.addCommand({
		id: 'drop-index',
		name: tNow('cmd.dropIndex'),
		callback: () => showDropIndexConfirm(this.app, async () => {
			try {
				const dropped = await this.dropInactiveGenerations();
				if (dropped === null) {
					// 关键路径:没有写所有权时如实告知「拒绝清理、索引未改动」,不假装成功。
					this.userNotice.toastError(tNow('notice.dropIndexRefused'));
					return;
				}
				this.userNotice.toast(dropped > 0
					? tNow('notice.dropIndexDone', { count: dropped })
					: tNow('notice.dropIndexNothing'));
			} catch (err) {
				this.markIndexDiskFailure(err);
				throw new Error(describeIndexError(err));
			}
		}),
	});

	// 实验:T0 索引线程可行性 —— 仅在 RATEL_INDEX_EXPERIMENT=1 构建时注册,正常产物不含此入口。
	if (typeof __RATEL_INDEX_EXPERIMENT__ !== 'undefined' && __RATEL_INDEX_EXPERIMENT__) {
		this.addCommand({
			id: 'index-thread-experiment',
			name: tNow('cmd.indexThreadExperiment'),
			// 关键路径:实验入口必须整段留在 define 保护内 —— 抽成实例方法会让编译器保留
			// 对实验模块的引用,生产产物里就会带上探针代码(命令虽不注册,代码仍在)。
			callback: async () => {
				this.userNotice.toast(tNow('notice.indexThreadExperimentRunning'));
				try {
					const { report, reportPath } = await runIndexThreadExperiment();
					this.userNotice.toast(tNow('notice.indexThreadExperimentDone', {
						main: String(Math.round(report.mainThread.stall.maxGapMs)),
						worker: String(Math.round(report.webWorker.stall.maxGapMs)),
						path: reportPath,
					}));
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					this.userNotice.toastError(tNow('notice.indexThreadExperimentFailed', { message }));
				}
			},
		});
		// 关键路径:调试构建加载后自动跑一次,避免每次都去命令面板点 ——
		// 少一步人工操作,采集才更可能被真正执行;报告路径由提示给出。

		this.app.workspace.onLayoutReady(() => {
			window.setTimeout(() => {
				void (async () => {
					this.userNotice.toast(tNow('notice.indexThreadExperimentRunning'));
					try {
						const { report, reportPath } = await runIndexThreadExperiment();
						this.userNotice.toast(tNow('notice.indexThreadExperimentDone', {
							main: String(Math.round(report.mainThread.stall.maxGapMs)),
							worker: String(Math.round(report.webWorker.stall.maxGapMs)),
							path: reportPath,
						}));
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						this.userNotice.toastError(tNow('notice.indexThreadExperimentFailed', { message }));
					}
				})();
			}, 5000);
		});
	}

	// 命令:重试索引装配(降级状态下的恢复入口 —— 索引不可用但插件其余能力照常)
	this.addCommand({
		id: 'retry-index',
		name: tNow('cmd.retryIndex'),
		callback: () => {
			void this.retryIndexRuntime();
		},
	});

	// 命令:重新加载 Skills(手动刷新三源)
	this.addCommand({
		id: 'reload-skills',
		name: tNow('cmd.reloadSkills'),
		callback: async () => {
			try {
				const count = await this.reloadSkills();
				this.userNotice.toast(tNow('skill.notice.reloadDone', { count }));
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				this.userNotice.toastError(tNow('skill.notice.reloadFailed', { message }));
			}
		},
	});

		// 设置面板
		this.settingTab = new RatelVaultSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		const goalStatusItem = this.addStatusBarItem();
		goalStatusItem.hide();
		this.goalStatusBarEl = goalStatusItem;
		goalStatusItem.onClickEvent(() => {
			if (this.goalStatusBarOpensSettings) {
				this.openGoalManageModal();
			} else {
				void this.activateChatView();
			}
		});
		void this.initGoalUi(pluginDir);

		devLogger.setDebugEnabled(this.settings.debugLog);
		this.feedbackController = new FeedbackController({
			modelStatus$: this.modelManager.status$,
			indexStatus$: this.indexController.indexManager.status$,
			userNotice: this.userNotice,
			userStatus: this.userStatus,
			getEmbeddingReady: () => !(this.embedding instanceof EmbeddingLocal) || this.embedding.isReady,
			getSettings: () => this.settings,
			// 关键路径:迁移/epoch 保护/可信记录可判定性不随 IndexStatus 变化,由装配层提供。
			getIndexSignals: () => this.indexDisplaySignals(),
		});
		this.feedbackController.start();
		// 关键路径(T7 未接线项):装配完成后主动刷新一次索引展示信号 —— 迁移结论、缺少 epoch
		// 保护、可信记录可判定性都不随 `IndexStatus` 变化;不刷新就要等下一次状态派发才上屏。
		this.feedbackController.refreshIndexStatus();

		// 关键路径:Obsidian UI 布局就绪后再启动模型下载与索引,避免阻塞 onload。
		// 关键路径(研发期诊断):渲染进程是否暴露 WebGPU,以及能否拿到适配器。
		void (async () => {
			const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
			if (gpu === undefined) {
				devLogger.info('index', `渲染进程 WebGPU:navigator.gpu 不存在 (secureContext=${String(globalThis.isSecureContext ?? 'n/a')})`);
				return;
			}
			try {
				const adapter = (await gpu.requestAdapter()) as { info?: { vendor?: string; architecture?: string; device?: string; description?: string } } | null;
				// 关键路径(S-WEBGPU-EMBEDDING):必须区分真 GPU 与软件适配器(SwiftShader)。
				// 拿不到硬件适配器时 WebGPU 会在 CPU 上模拟,速度接近甚至不如 WASM,
				// 只报「adapter=ok」会把这种情况误当成 GPU 已启用。
				const info = adapter?.info;
				const detail = info === undefined
					? 'info 不可用'
					: `vendor=${info.vendor ?? '?'} architecture=${info.architecture ?? '?'} device=${info.device ?? '?'}`;
				devLogger.info('index', `渲染进程 WebGPU:可用 (${detail})`);
			} catch (error) {
				devLogger.info('index', `渲染进程 WebGPU:requestAdapter 失败 ${error instanceof Error ? error.message : String(error)}`);
			}
		})();

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
		if (shouldShowReleaseNotes(this.settings.lastSeenRelease, this.manifest.version)) {
			void openReleaseNotesTab(this, true);
		}
		// 关键路径:进度回调 handle 在「模型下载 → 索引启动」之间共用 —— 下载阶段的 progress
		// toast 必须由索引收口统一 hide/clear,否则成功路径会留下一个永不消失的进度条。
		const indexProgressRef: {
			handle: ReturnType<UserNotice['toastProgress']> | null;
		} = { handle: null };

		// 关键路径:模型下载仅 local 模式需要;API 模式无本地模型,但仍要启动索引(P3 修复)。
		if (this.settings.embedProvider === 'local') {
			// 关键路径:本地模型下载/编译期间索引还没开始;不先把阶段说清楚,用户只会看到
			// 「索引空闲」却点哪都卡,误判成索引卡死。
			this.userStatus?.patch({
				index: 'init',
				indexDetail: tNow('status.indexDetail.modelPreparing'),
			});
			// 关键路径:全量索引进度由 Worker 回调驱动;FeedbackController 仅更新 statusBar,不弹 progress Notice。
		this.workerManager.setProgressCallback((done, total) => {
			const message = tNow('notice.indexProgress', { done, total });
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

				// 关键路径(S-RETRIEVAL-QUALITY §4.1/§4.2):词表交给 Worker 一次(约 109KB)——
				// Worker 侧据此做精确 token 计数;没拿到词表时按字符上界估算(高估方向,宁可块小也不许截断)。
				// 关键路径:必须在索引启动之前设置,否则会出现「前几个文件用估算、后面用精确」的混用块。
				setVocabContent(this.modelManager.getVocabContent());

				const embedding = this.modelManager.getEmbedding();
				if (embedding) {
					// 关键路径:把 ONNX 适配器注入占位器,search-vault 等工具透明可用。
					if (this.embedding instanceof EmbeddingLocal) {
						this.embedding.setEmbedding(embedding);
					}
					// 关键路径:ModelManager.download() 内 status$.set(Ready) 触发 FeedbackController
					// 时 setEmbedding 尚未执行,isReady 仍为 false;注入后需显式通知状态推进到 ready。
					this.feedbackController?.notifyEmbeddingReady();
					// 关键路径(2026-11-06 卡顿根因):此前只在 `inlineWorker` 存在时创建代理,
					// 线程模式跳过了主线程处理器装配,于是 `EmbeddingLocal` 内的 ONNX 直接在
					// 主线程推理 —— 现场每 8 段约 5.9s、主线程长任务 5–20s 持续不断。
					// 代理必须与索引路径无关:本地模型就绪即把 ONNX 推理移入 Web Worker。
					await this.initEmbeddingWorkerProxy(embedding);
				}
			} catch (err) {
			indexProgressRef.handle?.hide();
			indexProgressRef.handle = null;
			this.workerManager.clearProgressCallback();
			const message = err instanceof Error ? err.message : String(err);
			devLogger.error('main', 'onLayoutReady 模型下载失败', err);
			this.userNotice.toastError(tNow('notice.ratelError', { message }));
			// 关键路径:模型下载失败仍继续启动索引(API 模式不依赖本地模型)。
		}
		}

		// 关键路径:模型就绪后清掉「加载模型」须知,由扫描/处理阶段接管显示。
		this.userStatus?.patch({ indexDetail: undefined });
		// 关键路径:索引启动 — 两条 provider 都走(P3 修复)。
		// autoIndex=false 时不装配写路径监听、不扫描、不嵌入、不写盘;事件只记入内存的
		// 「已变更」集合供检索侧过滤,恢复写事务必须由用户显式启用索引或执行重建(A11)。
		// 关键路径(T7/I2):装配降级时即使 autoIndex=true 也不进入写路径 —— 没有代际/没有写
		// 所有权时跑一轮扫描会尝试在索引根上重建。降级出口只有状态 + Notice + 重试命令。
		if (this.indexUnavailable) {
			this.reportIndexUnavailable();
			return;
		}
		await this.startIndexRound(this.settings.autoIndex === true, indexProgressRef);
	}

	/**
	 * 跑一轮索引启动 — 启动路径与降级重试共用同一条收口(进度清理、完成宣告、失败映射)。
	 *
	 * 关键路径:
	 * - 停滞看护只在会真正跑任务的写路径上启动 —— 只读通道零隐式副作用,不装定时器;
	 * - 完成宣告必须先确认 `isIndexComplete()` 为真(部分可用不得宣称全库完成);
	 * - 失败经 `describeIndexError` 映射错误码,开发向 message 不上屏。
	 *
	 * @param autoIndex - 是否进入写路径;只读装配传 false。
	 * @param progress - 可选的共用进度句柄(启动路径上由模型下载阶段创建)。
	 */
	private async startIndexRound(
		autoIndex: boolean,
		progress?: { handle: ReturnType<UserNotice['toastProgress']> | null },
	): Promise<void> {
		const indexProgressRef = progress ?? { handle: null as ReturnType<UserNotice['toastProgress']> | null };
		try {
			// 修复:API 模式同样需要共享检索处理器;复用既有 store,只读装配不触发预热或写盘。
			// 关键路径:local 必须等代理 ensureReady 完成,重试则把处理器重新绑定到本轮 store。
			const processorEmbedding = this.settings.embedProvider === 'local'
				? this.embeddingWorkerProxy
				: this.embedding;
			// 关键路径:线程模式下主线程没有 store(索引在 Worker 内),`initWithStore` 会拿
			// undefined 当 Proxy 目标直接抛错,把整轮启动打断成「索引启动失败」。检索走线程
			// 候选来源,不需要主线程处理器持有 store。
			if (this.indexDirUsable && processorEmbedding && this.vectraStore !== undefined) {
				this.inlineWorker?.initWithStore(this.vectraStore, processorEmbedding);
			} else if (processorEmbedding !== undefined && this.indexThreadClient !== undefined) {
				devLogger.info('index', '线程模式:跳过主线程处理器绑定(检索走线程候选来源)');
			}
			if (autoIndex) this.indexStallWatchdog?.start();
			const indexResult = await this.indexController.onLayoutReady(autoIndex);
			// 关键路径:索引完成后隐藏进度 toast 并清除 callback(成功路径)。
			indexProgressRef.handle?.hide();
			indexProgressRef.handle = null;
			this.workerManager.clearProgressCallback();
			if (indexResult && indexResult.errors === 0) {
				// 关键路径(A11/状态展示):只有当后端确认**本轮全库真的完成**时才宣告完成 ——
				// 扫描未结束、队列/在途/未决事务非空、本轮有失败或持久凭据不完整时为假。
				// 未注入该能力时按既有语义放行(向后兼容)。
				const complete = await (this.indexBackend?.isIndexComplete?.() ?? Promise.resolve(true));
				if (complete) {
					this.feedbackController?.notifyFullIndexComplete(indexResult.indexed, indexResult.errors);
				} else {
					devLogger.info('index', '本轮尚未全库完成,不宣告完成(部分可用)');
				}
			}
		} catch (err) {
			// 关键路径:索引失败也要清理进度 toast 与 callback。
			indexProgressRef.handle?.hide();
			indexProgressRef.handle = null;
			this.workerManager.clearProgressCallback();
			// 关键路径:错误码 → 用户文案(开发向 message 不上屏);磁盘/IO 类失败单独标记。
			const message = describeIndexError(err);
			devLogger.error('main', '索引启动失败', err);
			this.userNotice.toastError(tNow('notice.indexError', { message }));
			this.markIndexDiskFailure(err);
		}
	}

	/**
	 * 当前设置推导出的构建戳 — 与清单里的全局参数同源。
	 *
	 * @returns 本次构建应记录的规则
	 */
	private currentBuildStamp(): IndexBuildStamp {
		return {
			chunkerVersion: CURRENT_CHUNKER_VERSION,
			chunkSize: this.settings.chunkSize,
			chunkOverlap: this.settings.chunkOverlap,
			embedModelId: this.resolveCurrentEmbedModelId(),
		};
	}

	/**
	 * 解析当前 embedding 模型身份 — 与 T6 的代际身份约定同源。
	 *
	 * 关键路径:`IndexConfigDescriptor.embeddingModelId` 必须是 `local:<id>` / `api:<...>` 形式,
	 * 否则 `confirmsLegacyConfigIdentity` 一律按 `model-id-unrecognized` 判定不可确认,
	 * 旧索引迁移永远无法复用任何旧块(每次升级都全量重算)。
	 * 本方法同时是构建戳/清单的 `embedModelId` 来源:两侧必须逐字一致,否则「旧清单身份」
	 * 与「当前配置身份」不可比较。API 侧保留端点,避免两个同名模型的端点被当成同一配置。
	 *
	 * 影响面:旧版清单写的是无前缀形式(`local-default` 等),因此从旧版本升级会触发一次
	 * 全量重建 —— 这与仓库既有的「升级后自动重建一次」语义一致,不构成回归。
	 */
	private resolveCurrentEmbedModelId(): string {
		if (this.settings.embedProvider === 'local') {
			return `local:${this.settings.embedLocalModel || 'default'}`;
		}
		return `api:${this.settings.embedApiBase}::${this.settings.embedApiModel}`;
	}

	/**
	 * 解析当前实际生效的精排实现 — 装配处唯一入口。
	 *
	 * 关键路径(S-RETRIEVAL-QUALITY §4.4):
	 * - 开关关闭 → 不精排(返回 undefined,检索链路保持 RRF 顺序)。
	 * - 来源 native → 需要钥匙串有 `ratel-rerank-bailian`;缺密钥则不精排,
	 *   **不回落**到对话模型(避免用户以为在用便宜路径,实际悄悄换了更贵的)。
	 * - 来源 llm → 用当前对话模型精排,走已配置的供应商,不新增外发目的地。
	 *
	 * @returns 精排实现;未启用或来源不可用时为 undefined
	 */
	private resolveReranker(): RerankerPort | undefined {
		const effective = resolveRerankMode(
			this.settings.rerankEnabled,
			this.settings.rerankSource,
			{
				hasNativeKey: hasRerankApiKey(this.app),
				// 关键路径:必须用 hasChatApiKey(app, settings) ——
				// this.llm 启动时总是被构造,用 `!!this.llm` 恒为真。
				hasLlm: hasChatApiKey(this.app, this.settings),
			},
		);
		if (effective === 'native') {
			return new BailianReranker({
				apiBase: this.settings.rerankerApiBase,
				apiKey: resolveRerankApiKey(this.app) ?? '',
				model: this.settings.rerankerModel,
			});
		}
		if (effective === 'llm') {
			return new LlmReranker({
				llm: this.llm,
				maxCandidates: 12,
				maxCharsPerDoc: 400,
			});
		}
		return undefined;
	}

	/**
	 * 组装分块参数 — 设置项换算成 token 预算后随索引消息下发。
	 *
	 * 关键路径:单块预算不能超过模型输入上限,留 64 token 给 [CLS]/[SEP] 与余量,
	 * 否则块会被模型静默截断(spec §4.1)。
	 *
	 * @returns 分块参数(maxTokens / overlapTokens)
	 */
	private buildChunkOptions(): ChunkOptionsPayload {
		// 关键路径:主线程只取模型输入上限,不建分词器 ——
		// 词表约 109KB,精确计数在 Worker 侧做,主线程再建一份纯属浪费内存。
		const counter = createTokenCounter(null);
		return {
			maxTokens: Math.min(this.settings.chunkSize, counter.maxInputTokens - TOKEN_BUDGET_RESERVE, CHUNK_SIZE_MAX_TOKENS),
			overlapTokens: this.settings.chunkOverlap,
		};
	}

	/**
	 * 重建 LLM 适配器。
	 *
	 * 关键路径:LLM 在 onload 时一次性构造,内部捕获的是构造时的 apiKey / apiBase / model。
	 * 用户在设置面板改了这些字段后,内存里 settings 改了,data.json 也存了,
	 * 但已构造的 LLM 还指向旧值。重建一次让新 key 生效。
	 */
	rebuildLLM(): void {
		this.llm = this.createChatLlm();
	}

	/**
	 * 构造对话 LLM：适配器外包一层网络/429/5xx 退避（S-LLM-RETRY）。
	 */
	private createChatLlm() {
		return wrapLlmChatRetry(
			new OpenAICompatLLM({
				apiBase: this.settings.chatApiBase,
				// 关键路径:apiKey 不再存 settings,从钥匙串按 chatApiBase 端点类型解析;
				// localhost Ollama 免 Key 返回 null → 空串透传给 LLM(本地服务不校验)。
				apiKey: resolveChatApiKey(this.app, this.settings) ?? '',
				model: this.settings.chatModel,
			}),
		);
	}

	/**
	 * 重建 Embedding 适配器(按当前 `embedProvider` 二选一)。
	 *
	 * 关键路径:同 `rebuildLLM`,embedProvider 切换或 API 类字段改后必须重建。
	 * 本地模式使用占位适配器,真实 EmbeddingOnnx 在 ModelManager 下载完成后注入。
	 *
	 * 关键路径(T7/I6 — 会话内配置漂移):代际身份(指纹)、日志指纹与构建戳只在**装配时**
	 * 定一次,而 `getBuildStamp()` 读的是实时 settings。会话内改嵌入模型/维度会让协调器按旧
	 * 指纹写日志、清单与戳写新参数 —— 同维度换模型因此是**静默混写**。这里在装配层显式拒绝:
	 * 一旦检测到身份变化,立刻暂停索引写入(撤销在途调用 + 停止调度)、把状态打成配置漂移须知,
	 * 并提示重载插件;不做「本会话内重建代际」——那要重解析代际并重绑控制器,超出本轮范围。
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
		this.rejectIndexConfigDrift();
	}

	/**
	 * 会话内嵌入配置漂移的显式拒绝 — 检测到身份变化就暂停索引写入并上屏(T7/I6)。
	 *
	 * 关键路径:装配尚未发生(启动期 `rebuildEmbeddingAdapter` 早于 `setupIndexRuntime`)时
	 * `indexConfigIdentity` 为 null,不判定 —— 那时的身份由装配本身确定。
	 */
	private rejectIndexConfigDrift(): void {
		// 关键路径:假值判定 —— 装配尚未发生时身份为空(null/undefined),那时不判定漂移。
		const assembled = this.indexConfigIdentity;
		if (!assembled) return;
		const next = this.configIdentityOf(this.currentIndexConfig());
		if (next === assembled) return;
		devLogger.warn('index', '会话内嵌入配置漂移:暂停索引写入,要求重新加载插件后重建索引');
		// 关键路径:先撤销在途调用再停止调度(index-manager 的 pause 顺序契约),
		// 保证「暂停生效」时不会留下仍持旧指纹在写的调用。
		this.indexController?.pause();
		this.userStatus.patch({
			indexNotice: 'config-drift',
			indexDetail: tNow('status.detail.configDrift'),
		});
		this.userNotice.toastError(tNow('notice.indexConfigChanged'));
	}

	/**
	 * 开发者开关：崩溃面包屑写入。关则停心跳，开则恢复。
	 *
	 * @param enabled - 是否启用写入与心跳
	 */
	syncCrashBreadcrumbs(enabled: boolean): void {
		this.breadcrumbs?.setEnabled(enabled);
	}

	/**
	 * 插件卸载 — 释放 Worker 进程,避免残留。
	 *
	 * 关键路径:Obsidian 热重载会触发 `onunload`,此时必须清理 Worker,
	 * 否则下次 onload 会创建第二个 Worker 进程,最终 OOM。
	 */
	onunload() {
		this.breadcrumbs?.mark('plugin.unload');
		this.breadcrumbs?.stopHeartbeat();
		// 关键路径:onload 中途失败时(如 loadSettings 抛错)部分字段未初始化,
		// 全部用可选链,避免卸载时二次 TypeError 掩盖根因。
		this.feedbackController?.destroy();
		// 关键路径:热重载/禁用时若记忆 Modal 仍开,close 走 onClose→unmount,onClosed 清单例引用。
		this.memoryModal?.close();
		this.mcpManageModal?.close();
		this.skillManageModal?.close();
		// 关键路径:断开全部 MCP Client（stdio kill / HTTP session）
		void this.mcpHost?.dispose();
		this.userStatus?.reset();
		// 关键路径:先停 IndexController 释放 vault 事件订阅与 watcher,再终止 Worker。
		// 关键路径:停看护并撤销在途调用,避免卸载后仍有定时器与迟到提交。
		// 注意实际顺序:写所有权租约在 `workerManager.destroy()` **之后**释放(见下方)——
		// 因为 `destroy()` 只终止 Worker/清除进度回调,不等在途提交结算;真正等在途提交
		// 结算的是 `release()`(T2 的 closing 契约),因此它必须在 destroy 之后调用。
		// 新实例接管靠 `release()` 完成后的 owner 锁交接,不靠销毁顺序。
		this.indexStallWatchdog?.stop();
		// 关键路径:退订活动代际登记,避免旧实例在卸载后继续写控制指针。
		this.generationActivationUnsub?.();
		this.generationActivationUnsub = undefined;
		try {
			this.workerManager?.cancelIndex(this.indexOwnerLease === undefined ? {} : { epoch: this.indexOwnerLease.epoch });
		} catch (err) {
			devLogger.warn('index', '卸载时取消在途索引请求失败', err);
		}
		this.indexController?.destroy();
		// 关键路径:terminate EmbeddingWorkerProxy 释放 Web Worker 线程,避免热重载后残留进程 OOM。
		this.embeddingWorkerProxy?.terminate();
		// 关键路径:revoke Blob URL 释放内存,避免热重载后泄漏 worker 脚本字符串。
		if (this.embeddingWorkerUrl) {
			URL.revokeObjectURL(this.embeddingWorkerUrl);
			this.embeddingWorkerUrl = undefined;
		}
		// 关键路径(ADR-017 兜底三件套之二):unload 击杀活跃脚本 Worker,不留孤儿线程。
		this.skillScriptSandbox?.terminateAll();
		this.workerManager?.destroy();
		// 关键路径:释放写所有权租约(幂等;等 closing 结算),让下一个实例能立即接管。
		void this.indexOwnerLease?.release().catch((err) => devLogger.warn('index', '释放索引写所有权失败', err));
		this.indexOwnerLease = undefined;
		// 关键路径:线程客户端要显式关闭(撤销写权并终止线程),否则热重载会留下孤儿线程。
		if (this.indexThreadClient !== undefined) {
			void this.indexThreadClient.close('plugin unload').catch((err) => devLogger.warn('index', '关闭索引线程失败', err));
			this.indexThreadClient = undefined;
			this.indexThreadCoordinator = undefined;
			this.threadSearchGate = undefined;
		}
		// 关键路径:身份登记必须在租约释放后清掉,否则同一会话内换配置会被自己的旧登记挡住。
		this.releaseIndexIdentity?.();
		this.releaseIndexIdentity = undefined;
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
	 *
	 * 修复:首次安装或 data.json 缺失时 `loadData()` 返回 `null`。
	 * `loaded.toolPermissions` 会在 `??` 求值前抛 TypeError 导致插件「加载失败」;
	 * 必须先把 null 归一成 `{}`。
	 */
	async loadSettings() {
		type LegacySettings = Partial<RatelVaultSettings> & {
			chatApiKey?: string;
			embedApiKey?: string;
			rerankerApiKey?: string;
			rerankerProvider?: string;
		};
		// 修复:loadData() 无文件时返回 null,不能直接读属性。
		const loaded = ((await this.loadData()) ?? {}) as LegacySettings;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
		this.settings.toolPermissions = {
			...DEFAULT_SETTINGS.toolPermissions,
			...(loaded.toolPermissions ?? {}),
		};
		const legacyTrust = loaded.trustMode === true;
		const level = loaded.toolPermissionLevel;
		if (level === 'safe' || level === 'auto' || level === 'danger') {
			this.settings.toolPermissionLevel = level;
		} else if (legacyTrust) {
			this.settings.toolPermissionLevel = 'danger';
		} else {
			this.settings.toolPermissionLevel = 'safe';
		}
		// 修复:S-KEYCHAIN 之前的明文残留字段,下次 saveSettings 会用清理后的对象自然覆盖 data.json。
		const legacy = this.settings as unknown as Record<string, unknown>;
		delete legacy.chatApiKey;
		delete legacy.embedApiKey;
		delete legacy.rerankerApiKey;
		delete legacy.rerankerProvider;
		// S-SKILL-UX:enableSkills 总开关已废弃,主动清掉 data.json 残值。
		delete legacy.enableSkills;
		normalizeContextLengthSettings(this.settings, loaded);
		// 关键路径:分块大小改按 token 计后,旧值可能超出可用上限,钳制并反推档位。
		normalizeChunkSizeSettings(this.settings, loaded);
		// 关键路径:旧版无 chatPreset 字段时按 Base/模型推断,避免误显示 DeepSeek 预设
		normalizeChatPreset(this.settings, loaded);
		normalizeChatProfiles(this.settings, loaded);
		applyBuiltinToolPermissionDefaults(this.settings, loaded.toolPermissionDefaultsVersion);
		// 关键路径:旧版无外观字段或非法值时回落 auto/follow
		normalizeAppearanceSettings(this.settings);
		// 契约:stdio 整行 command / mcp-remote → 规范化（常改写为 HTTP）
		this.settings.mcpServers = (this.settings.mcpServers ?? []).map(normalizeMcpServerConfig);
		publishSettingsSnapshot(this.settings);
	}

	/** 持久化当前设置到 Obsidian data.json(与 Persistence 字段 merge,互不覆盖)。 */
	async saveSettings(options?: { refreshSettingsTab?: boolean }) {
		// 契约:落盘前再规范化，避免 UI 把整行 shell 写回 data.json
		this.settings.mcpServers = (this.settings.mcpServers ?? []).map(normalizeMcpServerConfig);
		const existing = ((await this.loadData()) ?? {}) as Record<string, unknown>;
		await this.saveData(mergePluginData(existing, { ...this.settings }));
		// 关键路径:settings 变更后热替换工具 definition,让 LLM 立即看到新 description。
		this.syncToolDefinitions();
		publishSettingsSnapshot(this.settings);
		// 关键路径:扇出上下文上限，抽屉即使漏订 settings$ 也不易陈旧
		this.userStatus.patchContextUsage({
			maxTokens: getEffectiveChatModelMaxTokens(this.settings),
		});
		// 关键路径:MCP 启停必须 await — Modal 里 toggle/添加后立刻 render，void sync 会竞态显示「无工具」
		if (this.mcpHost) {
			try {
				await this.mcpHost.sync(this.settings.mcpServers);
			} catch (err) {
				devLogger.error('mcp', 'settings 变更后 sync 失败', err);
			}
		}
		// 关键路径:通知 Chat / Memory 等视图重跑 applyRatelAppearance(热更新外观)。
		bumpAppearance();
		// 关键路径:Agent 工具(update_app_config)改配置后,设置面板若正打开需重渲染 —
		// 数据层已 mutate 同一 settings 对象,但声明式控件非响应式,显示层会陈旧。
		if (options?.refreshSettingsTab !== false && this.settingTab?.containerEl?.isConnected) {
			this.settingTab.update();
		}
	}

	/**
	 * 按配置构造 MCP Transport（HTTP 用 requestUrl；stdio 用 spawn）。
	 *
	 * @param cfg - Server 配置
	 * @returns 可注入 McpClient 的 Transport
	 */
	private createMcpTransport(cfg: McpServerConfig) {
		if (cfg.transport === 'http') {
			return new McpHttpTransport({
				url: cfg.url!,
				getApiKey: () => resolveMcpSecret(this.app, cfg.id),
				timeoutMs: cfg.timeoutMs,
			});
		}
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) {
			if (typeof v === 'string') env[k] = v;
		}
		// 契约:Obsidian GUI 进程 PATH 常缺 nvm/homebrew；补常见目录让 npx 可被找到
		const pathExtra = [
			'/opt/homebrew/bin',
			'/usr/local/bin',
			path.join(os.homedir(), '.nvm/versions/node/v24.11.0/bin'),
		];
		// 也尝试扫描 ~/.nvm/versions/node/*/bin 最新版
		try {
			const nvmNode = path.join(os.homedir(), '.nvm/versions/node');
			const vers = readdirSync(nvmNode).filter((v) => v.startsWith('v')).sort().reverse();
			for (const v of vers.slice(0, 3)) {
				pathExtra.push(path.join(nvmNode, v, 'bin'));
			}
		} catch {
			// ignore
		}
		env.PATH = [...pathExtra, env.PATH ?? ''].filter(Boolean).join(path.delimiter);
		const secret = resolveMcpSecret(this.app, cfg.id);
		for (const key of cfg.envKeys ?? []) {
			if (secret && /api[_-]?key|token|secret/i.test(key)) {
				env[key] = secret;
			} else {
				env[key] = process.env[key] ?? '';
			}
		}
		return new McpStdioTransport({
			command: cfg.command!,
			args: cfg.args ?? [],
			env,
			timeoutMs: cfg.timeoutMs,
		});
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
	 * 关键路径:不跨发送缓存 ctx;一次 ask 结束即丢弃。
	 * 若传入同 session 的 `preloadedContext`,直接复用,不再 `new ContextManager`
	 * (预发送压缩判断已 load 过同一场 JSON)。goal/env/skills/memory setter 仍照常执行。
	 *
	 * @param sessionId - 会话 ID,关联到 Persistence 存储。
	 * @param message - 用户最新一条消息。
	 * @param attachments - 可选图片附件引用(S-VISION v1.3);KB 级 {id, mimeType},base64 由 AttachmentStore 外置。
	 * @returns 异步迭代的 `AgentEvent` 流。
	 */
	async *ask(
		sessionId: string,
		message: string,
		signal?: AbortSignal,
		attachments?: AttachmentRef[],
		opts?: {
			goalRound?: boolean;
			modelMessage?: string;
			preloadedContext?: ContextManager;
			onRetryWait?: (state: LlmRetryWait | null) => void;
		},
	): AsyncIterable<AgentEvent> {
		this.currentChatSessionId = sessionId;
		this.lastAskUserText = message;
		const collectedEvents: AgentEvent[] = [];
		// 关键路径:注入 overrides + tools + skills getter,让 ContextManager 调 Composer 拼系统提示词。
		const ctx = shouldReusePreloadedContext(opts?.preloadedContext, sessionId)
			? opts!.preloadedContext!
			: new ContextManager(this.persistence, {
				getOverrides: () => this.settings.promptOverrides,
				getTools: () => this.tools.definitions(),
				// ADR-012:仅 Discovery;Active 指令写入 Session.messages。
				// 关键路径(S-SR-LAYERING):传当前提问做相关性排序(两处 composeDiscovery 同步)。
				getSkillsDiscovery: () =>
					this.skillActivator.composeDiscovery(this.settings.promptOverrides, message),
				getSkillsActive: () => '',
			},
			// 关键路径(S-CTX-TRIM):历史上限随窗口推导,替换写死的 8000
			tailBudget(getEffectiveChatModelMaxTokens(this.settings)));

		this.breadcrumbs?.mark('ask.begin', sessionId);

		ctx.setGoalAnchorProvider(() => {
			const g = this.goalStore.getBoundActive(sessionId);
			return g ? composeGoalAnchor(g) : null;
		});

		// 关键路径(S-CHAT-TIME):env 由 agentLoop 在 load 后 refreshEnvContext,避免双源。

		// 关键路径:会话启动时注入 Discovery 目录(activate 写进 messages)。
		// 关键路径(S-SR-LAYERING):传当前提问做 Discovery 相关性排序。
		ctx.setSkillsContext(
			this.skillActivator.composeDiscovery(this.settings.promptOverrides, message),
			'',
		);

		// 关键路径:会话启动时加载记忆并注入到 ContextManager,
		// 让 Agent 从一开始就"认识"用户,并知道何时调 search_memory。
		// 记忆加载失败不阻塞会话,仅记录日志 — 用户仍可正常对话(只是无记忆注入)。
		try {
			const globalContent = this.memoryStore.readGlobal();
			const indexEntries = this.memoryStore.readIndex();
			if (globalContent.trim()) {
				// 关键路径(S-SR-LAYERING):topics 自动检索 — 当前用户消息 embed 一次,
				// 命中的主题只注入「名称 + 摘要」,全文仍走 search_memory(两种供给不重复)。
				let relatedTopics: Array<{ name: string; summary: string }> = [];
				const K = this.settings.memoryTopicsAutoInjectK;
				const embeddingReady =
					!(this.embedding instanceof EmbeddingLocal) || this.embedding.isReady;
				if (
					shouldAutoEmbedTopics({
						k: K,
						message,
						indexCount: indexEntries.length,
						embeddingReady,
					})
				) {
					try {
						this.breadcrumbs?.mark('ask.embed.begin', sessionId, 1);
						const vectors = await this.embedding.embed([message]);
						this.breadcrumbs?.mark('ask.embed.end', sessionId, 1);
						const queryVector = vectors[0];
						if (queryVector) {
							const hits = await this.memoryStore.searchIndex(queryVector, K);
							const summaryByName = new Map(indexEntries.map((e) => [e.name, e.summary]));
							// 性能:先凑齐本轮命中,批量计数只落盘一次(逐条 bump 会同步写盘 K 次)。
							const hitNames: string[] = [];
							for (const hit of hits) {
								const name = hit.docId.replace(/^topics\//, '').replace(/\.md$/, '');
								const summary = summaryByName.get(name);
								if (summary !== undefined) {
									relatedTopics.push({ name, summary });
									hitNames.push(name);
								}
							}
							// 统计口径:自动注入命中才计数,search_memory 手动检索不计。
							this.usageStats.bumpMemoryTopicsBatch(hitNames);
						}
					} catch (embedErr) {
						// 修复:检索失败静默降级为无相关主题,不阻断会话(spec §2)。
						devLogger.warn('memory', 'topics 自动注入检索失败,降级为无相关主题', embedErr);
					}
				}
				ctx.setMemoryContext(globalContent, indexEntries, this.settings.promptOverrides, {
					injectLimitBytes: this.settings.memoryInjectLimitKB * 1024,
					totalLimitBytes: this.settings.memoryContextTotalLimitKB * 1024,
					relatedTopics,
				});
			}
		} catch (err) {
			devLogger.error('memory', '记忆加载失败,会话继续无记忆注入', err);
		}

		try {
			const rootAgentsPath = AGENTS_FILE_NAME;
			if (await this.vault.fileExists(rootAgentsPath)) {
				ctx.setNoteAgentsRoot(await this.vault.readFile(rootAgentsPath));
				this.breadcrumbs?.mark('agents.file', sessionId, rootAgentsPath);
			} else {
				ctx.setNoteAgentsRoot('');
				this.breadcrumbs?.mark('agents.file', sessionId, `${rootAgentsPath}:none`);
			}
		} catch (err) {
			devLogger.warn('noteAgents', '库根 AGENTS.md 读取失败,跳过注入', err);
			ctx.setNoteAgentsRoot('');
		}

		ctx.setNoteAgentsReader(async (dir: string) => {
			if (dir === '') return null;
			const rel = `${dir}/${AGENTS_FILE_NAME}`;
			try {
				if (!(await this.vault.fileExists(rel))) return null;
				const text = await this.vault.readFile(rel);
				this.breadcrumbs?.mark('agents.file', sessionId, rel);
				return text;
			} catch {
				return null;
			}
		});

		// 关键路径:注入意图分类器,让 agentLoop 在 addUserMessage 后判断意图。
		// 闭包捕获 this.llm,与 agentLoop 解耦。
		// 关键路径:把 overrides 透传给 intent-classifier,让内部 LLM 也走 Composer + 用户自定义 section。
		const intentClassifier = (msg: string) =>
			classifyIntent(msg, {
				llm: this.llm,
				overrides: this.settings.promptOverrides,
				signal,
			});

		const goalGrantCheck = createGoalGrantCheck({
			goalStore: this.goalStore,
			currentSessionId: sessionId,
		});

		const toolPermissionCheck = (tc: ToolCall) =>
			resolveToolPermission(
				tc,
				{
					toolPermissionLevel: this.settings.toolPermissionLevel,
					toolPermissions: this.settings.toolPermissions,
				},
				this.toolSessionGrants,
				(call) => showToolConfirmModal(this.app, call),
				goalGrantCheck,
			);

		// 关键路径:绑定当前 ctx 供 activate_skill / deactivate_skill 写 transcript。
		this.currentAskCtx = ctx;
		try {
			let skipAdd = false;
			for (let attempt = 0; attempt < 2; attempt++) {
				let overflow = false;
				for await (const ev of agentLoop(
					{
						sessionId,
						message,
						attachments,
						modelMessage: opts?.modelMessage,
						onBreadcrumb: (phase, n) => this.breadcrumbs?.mark(phase, sessionId, n),
						onRetryWait: opts?.onRetryWait,
					},
					ctx,
					this.llm,
					this.tools,
					this.hooks,
					signal,
					intentClassifier,
					toolPermissionCheck,
					this.settings.agentMaxSteps,
					this.skillActivator,
					skipAdd,
					this.attachments, // S-VISION v1.3:出站前把附件引用解析回 base64(仅内存瞬态)
				)) {
					if (
						ev.type === 'error' &&
						shouldRetryAfterOverflow({
							code: ev.payload.code,
							toolsAlreadyRun: false,
							alreadyRetried: attempt > 0,
						})
					) {
						overflow = true;
						break;
					}
					collectedEvents.push(ev);
					yield ev;
				}
				if (!overflow) break;

				try {
					// 关键路径:必须压当前 ask 的 ctx。另 new+load 时同 id 幂等不会把 marker 读回,
					// agentLoop 结束 save 还会把磁盘上刚写的压缩盖掉。
					const transcript = ctx.getTranscript();
					const last = transcript.at(-1);
					let compactOpts: { untilIndex: number } | undefined;
					if (last?.role === 'user' && last.content === message) {
						const untilIndex = transcript.length - 2;
						if (untilIndex >= 0) {
							compactOpts = { untilIndex };
						}
					}
					const r = await compactSession(
						ctx,
						this.llm,
						sessionId,
						this.settings.promptOverrides,
						compactOpts,
					);
					if (r.skipped) {
						collectedEvents.push({
							type: 'error',
							payload: { code: 'LLM_ERROR', message: '上下文过长且无法压缩' },
						});
						yield collectedEvents[collectedEvents.length - 1]!;
						break;
					}
					const compactEv = { type: 'compact.applied' as const, payload: { sessionId } };
					collectedEvents.push(compactEv);
					yield compactEv;
				} catch (e) {
					const errEv = {
						type: 'error' as const,
						payload: {
							code: 'LLM_ERROR' as const,
							message: e instanceof Error ? e.message : String(e),
						},
					};
					collectedEvents.push(errEv);
					yield errEv;
					break;
				}
				skipAdd = true;
			}
		} finally {
			const failed = collectedEvents.some((e) => e.type === 'error');
			if (failed) this.breadcrumbs?.mark('ask.error', sessionId);
			this.breadcrumbs?.mark('ask.end', sessionId);
			this.currentAskCtx = null;
			ctx.setNoteAgentsReader(undefined);
			// 关键路径:消费方提前结束 for-await 或 agentLoop 抛错也要记账(C1)
			await this.finalizeAskRound(sessionId, signal, opts, collectedEvents);
		}
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
		return new ContextManager(
			this.persistence,
			{
				getOverrides: () => this.settings.promptOverrides,
				getTools: () => this.tools.definitions(),
			},
			// 关键路径(S-CTX-TRIM):历史上限随窗口推导,与 ask() 路径保持一致
			tailBudget(getEffectiveChatModelMaxTokens(this.settings)),
		);
	}

	// ==================== 索引运行时装配(代际 / owner / 日志 / 协调器 / 看护)====================

	/** 当前配置描述 — 与 T6 的代际身份约定同源(`local:<id>` / `api:<端点::模型>`)。 */
	private currentIndexConfig(): IndexConfigDescriptor {
		return {
			embeddingModelId: this.resolveCurrentEmbedModelId(),
			embeddingModelRevision: null,
			embeddingDimension: this.embedding.dimensions,
			chunkerVersion: CURRENT_CHUNKER_VERSION,
			chunkSize: this.settings.chunkSize,
			chunkOverlap: this.settings.chunkOverlap,
			embeddingTextVersion: null,
		};
	}

	/**
	 * 解析代际目录并装配写所有权、日志、协调器与停滞看护。
	 *
	 * 关键路径(T6 §8.1,本任务最高优先级):
	 * - `.index/` 根只放 `control.json`、`owner.lock` 与 `generations/`;
	 *   注入给 `VectraStore` / `AtomicIndexStorage` / 日志 / 后端的目录**必须是代际目录**,
	 *   否则一次全量重建会递归删除控制指针、owner 锁与全部代际;
	 * - 只有本实例真的会写时才取 owner 锁;`autoIndex=false` 走只读装配,不建 `owner.lock`、
	 *   **不执行任何写迁移**(旧版清单的 mkdir/rename/unlink 只属于写路径,T7/I3);
	 * - 旧索引在 owner 锁内迁移;身份不可确认时走显式重建入口,绝不静默复用旧块;
	 * - 装配失败(含迁移失败、无可用代际)一律**降级**(T7/I2):记录原因、释放已取到的租约、
	 *   把 `indexDir` 退回索引根,由 `indexUnavailable` 驱动状态与重试入口,不让 onload reject。
	 *
	 * @param pluginDir - 插件目录绝对路径。
	 */
	private async setupIndexRuntime(pluginDir: string): Promise<void> {
		this.indexRoot = path.join(pluginDir, '.index');
		this.indexDir = this.indexRoot;
		try {
			const config = this.currentIndexConfig();
			this.indexConfigFingerprint = await computeConfigFingerprint(config);
			this.indexConfigIdentity = this.configIdentityOf(config);

			if (this.settings.autoIndex === false) {
				// 关键路径(T7/I3):只读装配不执行 legacy 清单迁移 —— 该函数在存在旧文件时会
				// mkdir + rename(甚至 unlink),与「零写入」契约直接冲突,必须在判定之后才调用。
				await this.setupReadOnlyIndexRuntime(config);
				return;
			}
			// 关键路径:线程模式先尝试线程装配;失败则完整回落到主线程路径并如实记录,
			// 不留下「一半线程、一半主线程」的中间态。
			const threadReady = this.settings.indexThreadMode === true
				&& await this.trySetupThreadIndexRuntime(config);
			if (!threadReady) {
				await this.migrateLegacyManifestIntoIndexRoot(pluginDir);
				await this.setupWritableIndexRuntime(config);
			}
		} catch (err) {
			this.degradeIndexRuntime(err);
		}
	}

	/**
	 * 把旧版插件根 `index-manifest.json` 迁入 `.index/` 根 — 只在写路径执行。
	 *
	 * 关键路径:它是 T6 迁移要读的 legacy 清单位置,不能迁进代际目录(迁移输入要求它在索引根上可枚举)。
	 *
	 * @param pluginDir - 插件目录绝对路径。
	 */
	private async migrateLegacyManifestIntoIndexRoot(pluginDir: string): Promise<void> {
		try {
			await migrateLegacyIndexManifest(pluginDir, this.indexRoot);
		} catch (err) {
			devLogger.warn('index', '旧版 index-manifest 迁移失败(可忽略)', err);
		}
	}

	/**
	 * 写路径装配 — 取写所有权、解析代际、装配管线并恢复未决事务。
	 *
	 * 关键路径:算法整体在 `core/index-runtime-assembly`(不 import obsidian);这里只做接线 ——
	 * 把注入端口与结果字段对上。失败由 `setupIndexRuntime` 捕获后降级。
	 *
	 * @param config - 当前配置。
	 * @throws {Error} 取锁失败、迁移失败或无可用代际。
	 */
	/**
	 * 线程模式装配 — 取写所有权、解析代际、拉起常驻 Worker 并把字段切到线程路径。
	 *
	 * 关键路径:失败必须干净回滚(释放租约与身份登记),由调用方回落到主线程装配;
	 * 不能返回「部分成功」,否则上层会在没有存储的情况下继续启动。
	 *
	 * @param config - 当前配置
	 * @returns 是否成功切到线程路径
	 */
	private async trySetupThreadIndexRuntime(config: IndexConfigDescriptor): Promise<boolean> {
		let lease: IndexWriteOwner | null = null;
		try {
			this.indexIdentityGuard.register(this.indexConfigFingerprint);
			lease = await IndexWriteOwner.acquire({
				root: this.indexRoot,
				instanceToken: crypto.randomUUID(),
			});
			const generations = new IndexGenerations({ indexRoot: this.indexRoot, owner: lease });
			const assembled = await assembleIndexThreadRuntime({
				indexRoot: this.indexRoot,
				generations,
				config,
				owner: lease,
				expectedDimension: this.embedding.dimensions,
				embedding: this.effectiveEmbedding(),
				vault: {
					listMarkdownFiles: () => this.vault.listMarkdownFiles(),
					readFile: (filePath) => this.vault.readFile(filePath),
				},
				chunkLimits: { chunkSize: this.settings.chunkSize, chunkOverlap: this.settings.chunkOverlap },
				legacy: null,
			});
			if (assembled.resolved === null || assembled.pipeline === null) {
				devLogger.warn('index', '线程装配未解析出可用代际,回落到主线程索引路径');
				await lease.release().catch(() => undefined);
				this.indexIdentityGuard.release(this.indexConfigFingerprint);
				return false;
			}
			const control = await generations.readControl();
			this.indexDir = assembled.resolved.generationRoot;
			this.resolvedGenerationId = assembled.resolved.generationId;
			this.activeGenerationId = control.activeGenerationId;
			this.indexMigrated = false;
			this.indexDirUsable = true;
			this.indexOwnerLease = lease;
			this.indexGenerations = generations;
			this.indexThreadClient = assembled.pipeline.client;
			this.indexThreadCoordinator = assembled.pipeline.coordinator;
			this.threadSearchGate = createThreadVisibilityGate(assembled.pipeline.client);
			this.releaseIndexIdentity = () => this.indexIdentityGuard.release(this.indexConfigFingerprint);
			devLogger.info('index', `索引线程模式已启用:代际 ${assembled.resolved.generationId}`);
			return true;
		} catch (err) {
			devLogger.warn('index', '线程装配失败,回落到主线程索引路径', err);
			this.indexThreadClient = undefined;
			this.indexThreadCoordinator = undefined;
			this.threadSearchGate = undefined;
			if (lease !== null) await lease.release().catch(() => undefined);
			this.indexIdentityGuard.release(this.indexConfigFingerprint);
			return false;
		}
	}

	private async setupWritableIndexRuntime(config: IndexConfigDescriptor): Promise<void> {
		const runtime = await setupWritableIndexRuntime({
			indexRoot: this.indexRoot,
			config,
			configFingerprint: this.indexConfigFingerprint,
			vault: this.vault,
			embedding: this.effectiveEmbedding(),
			getChunkOptions: () => this.buildCoordinatorChunkOptions(),
			chunkLimits: { chunkSize: this.settings.chunkSize, chunkOverlap: this.settings.chunkOverlap },
			expectedDimension: this.embedding.dimensions,
			// 关键路径:存储仍经本实例工厂构造 —— 既有守卫按注入点分类计数,替换成模块内直连会
			// 让「只读装配不落盘」等断言失去可观测入口。
			createStorage: (root) => this.createIndexStorage(root),
			isExcluded: (p) => this.indexController?.isExcluded(p) ?? false,
			fileExists: (p) => this.vault.fileExists(p),
			getActiveStore: () => currentProcessorStore() ?? undefined,
			onGenerationPromoted: (generationId, record) => {
				// 关键路径(T7 数据风险):登记成功的同一刻更新本实例的 `activeGenerationId`,
				// 让「活动代际目录不可删除」的断言不存在「清单已登记、内存仍为 null」的空窗。
				const promoted = record.activeGenerationId ?? generationId;
				if (this.activeGenerationId === null) this.activeGenerationId = promoted;
				devLogger.info('index', `活动代际已登记:${promoted}(清库入口对该目录一律拒绝)`);
			},
			publishConclusion: (summary) => this.publishIndexConclusion(summary),
			stallAfterMs: INDEX_RUNTIME_STALL_AFTER_MS,
			identityGuard: this.indexIdentityGuard,
		});
		this.releaseIndexIdentity = runtime.releaseIdentity;
		this.applyWritableIndexRuntime(runtime);
	}

	/**
	 * 把装配结果写回实例字段 — 接线唯一入口,避免各处字段赋值漂移。
	 *
	 * @param runtime - `setupWritableIndexRuntime` 的返回值。
	 */
	private applyWritableIndexRuntime(runtime: WritableIndexRuntime): void {
		this.indexDir = runtime.indexDir;
		this.resolvedGenerationId = runtime.generationId;
		this.activeGenerationId = runtime.activeGenerationId;
		this.indexDirUsable = true;
		this.indexMigrated = runtime.migrated;
		this.indexConclusion = runtime.conclusion;
		this.indexOwnerLease = runtime.lease;
		this.indexGenerations = runtime.generations;
		this.vectraStore = runtime.pipeline.store;
		this.indexJournal = runtime.pipeline.journal;
		this.readOnlySearchView = runtime.pipeline.readOnlySearchView;
		this.indexProcessorPort = runtime.pipeline.processorPort;
		this.indexCoordinator = runtime.pipeline.coordinator;
		this.indexStallWatchdog = runtime.pipeline.stallWatchdog;
	}

	/**
	 * 协调器分块参数 — 与 Worker 侧 `buildChunkOptions` 同一算法与同一份词表。
	 *
	 * 关键路径:计数函数不能过 postMessage,主线程按 Worker 已设置的那份词表重建。
	 *
	 * @returns 协调器使用的分块参数。
	 */
	private buildCoordinatorChunkOptions(): ChunkOptions {
		const budget = this.buildChunkOptions();
		const counter = createTokenCounter(getVocabContent());
		return {
			maxTokens: budget.maxTokens,
			overlapTokens: budget.overlapTokens,
			count: (text: string) => counter.count(text),
		};
	}

	/**
	 * 装配失败时的降级 — 索引不可用,插件其余能力照常。
	 *
	 * 关键路径(T7/I2):
	 * - 已经取到的写所有权必须立刻释放,降级实例不能再持锁;
	 * - `indexDir` 退回索引根,严格归属断言对「根」一律拒绝 —— 即使后续误走清库路径也不可能
	 *   递归删除任何代际目录;
	 * - 协调器/看护/日志清空,避免半装配状态被后续流程当成可用。
	 *
	 * @param error - 装配失败原因(保留原始对象,供错误码映射)。
	 */
	private degradeIndexRuntime(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.indexUnavailable = { error, message };
		devLogger.error('index', '索引运行时装配失败,插件以降级状态继续启动', error);
		const lease = this.indexOwnerLease;
		this.indexOwnerLease = undefined;
		if (lease !== undefined) {
			void lease.release().catch((err) => devLogger.warn('index', '降级时释放索引写所有权失败', err));
		}
		this.indexGenerations = undefined;
		this.indexJournal = undefined;
		this.indexCoordinator = undefined;
		this.indexStallWatchdog = undefined;
		this.readOnlySearchView = undefined;
		this.resolvedGenerationId = null;
		this.activeGenerationId = null;
		this.indexDir = this.indexRoot;
		this.indexDirUsable = false;
		this.indexMigrated = false;
	}

	/**
	 * 由配置描述派生会话内配置身份 — 与配置指纹同源的五个输入,用于同步比对。
	 *
	 * @param config - 当前配置描述。
	 * @returns 身份字符串(仅用于比对,不参与指纹/清单)。
	 */
	private configIdentityOf(config: IndexConfigDescriptor): string {
		return configIdentityOf(config);
	}

	/**
	 * 索引侧对象装配 — 清单、后端、控制器、活动代际订阅与 Indexer。
	 *
	 * 关键路径:onload 与降级重试共用同一处装配,不让两边的清单/后端/控制器接线漂移。
	 * 只读预热(`preheatReadOnlyView`)不在本方法内 —— 它需要 vault 事件通路已装配。
	 */
	private assembleIndexObjects(): void {
		// 关键路径:线程模式下后端与协调器都来自线程;不能同时构造主线程后端,
		// 否则两套写入者会各自持有存储视图。
		if (this.settings.indexThreadMode === true && this.indexThreadClient !== undefined && this.indexThreadCoordinator !== undefined) {
			this.indexBackend = createThreadIndexBackend(this.indexThreadClient, this.indexThreadCoordinator);
			this.indexController = new IndexController(this.vault, this.indexBackend, this.vaultBase, {
				coordinator: this.indexThreadCoordinator,
			});
			this.indexer = new Indexer({ vault: this.vault, indexController: this.indexController });
			return;
		}
		// 关键路径:清单落在代际目录内的 ratel-manifest.json(派生视图,只由后端写);
		// 旧版插件根的 index-manifest.json 已在 setupIndexRuntime 迁入 `.index/` 根,
		// 它是 T6 迁移读的 legacy 清单,不再作为本代际的清单路径。
		this.indexManifest = new IndexManifest(resolveIndexManifestPath(this.indexDir));
		this.indexBackend = new PersistentIndexBackend({
			indexDir: this.indexDir,
			manifest: this.indexManifest,
			worker: this.workerManager,
			getStore: () => this.vectraStore,
			vault: this.vault,
			getBuildStamp: () => this.currentBuildStamp(),
			getChunkOptions: () => this.buildChunkOptions(),
			// 关键路径:可见性门的记录端口必须与门**同批**注入 —— 未注入时
			// `searchableFileRecords()` 返回 null,门对 `unjudgeable` 一律 deny,
			// 等于把检索全量归零(不是收紧)。
			fileRecords: this.indexJournal,
			// 关键路径:协调器模式下本轮扫描/失败计数只能来自协调器;不注入时
			// `roundState().scanComplete` 恒 false、`isIndexComplete()` 恒假。
			getRoundCounters: () => this.activeTaskCoordinator?.counters() ?? { queued: 0, active: 0, pendingTransactions: 0 },
			// 关键路径:关闭 T6 的 epoch fail-open —— 缺省 epoch 被省略后管理器按 0 处理,
			// 旧实例的活动不会被拒绝。租约 epoch 从 1 开始,注入后 `epochSourceMissing` 恒为 false。
			// 注意回落语义:`?? 0` 表示**本实例没有写所有权**时的取值(只读装配、降级状态、
			// 卸载之后)。它不是「0 也是合法 epoch」,而是「没有租约可校验」;T6 的 fail-open
			// 关闭只覆盖「有租约但活动没盖章」这一种情况,不能把它读成「已具备 epoch 保护」。
			getEpoch: () => this.indexOwnerLease?.epoch ?? 0,
			// 完成记录重建派生清单前必须证明属于本轮配置,不能由当前清单反推身份。
			getConfigFingerprint: () => this.indexConfigFingerprint,
			// 关键路径:协调器 `taskId` 轮内恒定,只做稳定任务身份;后端内部另用每请求唯一键。
			getTaskId: () => String(this.activeTaskCoordinator?.counters().taskId ?? 0),
			// 关键路径(T6 §8.2 + T7 收口):严格版归属断言 —— 只允许删除本索引根 generations/ 下的
			// **非活动**代际目录;把缺省的「形状白名单」收紧成「代际白名单 + 活动代际例外」。
			assertDropOwnership: (indexDir) => this.assertIndexDropOwnership(indexDir),
			onLateTerminalCommitted: (info) => this.handleLateTerminalCommitted(info),
		});

		// 关键路径:ObsidianVault 已实现 VaultEventListener 接口,直接传入可保证所有 Obsidian API 访问都走外观层。
		// 协调器与只读可见性视图由装配层注入(IndexControllerOptions),控制器据此决定写/只读通路。
		this.indexController = new IndexController(this.vault, this.indexBackend, this.vaultBase, {
			coordinator: this.indexCoordinator,
			readOnlyView: this.readOnlySearchView,
		});
		// 关键路径(T7 修复):只要本实例解析出的代际**还不是**控制指针上的活动代际,就必须安装
		// 发布订阅 —— 它可能处于 building(隔离新建)或 verifying(切回旧配置的重新核对),
		// 两者都要等本轮核对完成后走 `configured-switch` 才切指针。
		// 不能用「内存里的 activeGenerationId 为 null」判定:配置变化时内存指针仍指向旧活动代际,
		// 若据此不安装订阅,T6 §8.5 的原子切换在生产启动路径就永远不可达。
		// 未 ready 前旧活动索引保持可用,绝不提前切换。重复装配先去订阅,否则会叠加。
		this.generationActivationUnsub?.();
		this.generationActivationUnsub = undefined;
		if (this.resolvedGenerationId !== null && this.activeGenerationId !== this.resolvedGenerationId) {
			this.watchGenerationActivation(this.resolvedGenerationId);
		}

		// 关键路径:W4 — Indexer subagent,供其他子代理通过统一接口触发索引。
		this.indexer = new Indexer({ vault: this.vault, indexController: this.indexController });
	}

	/**
	 * 只读装配下预热可见性视图 — 让展示与第一次检索看到同一份判定。
	 *
	 * 关键路径(A11):只读、不写盘、不取锁;失败只记录,不影响启动。
	 */
	private async preheatReadOnlyView(): Promise<void> {
		if (this.settings.autoIndex !== false || this.readOnlySearchView === undefined) return;
		try {
			await this.readOnlySearchView.refresh(this.indexController.readOnlyChanged());
		} catch (err) {
			devLogger.warn('index', '只读可见性视图预热失败,检索按不可判定处理', err);
		}
	}

	/**
	 * 汇总迁移/回收结论面 — 算法在 `core/index-runtime-assembly`;保留方法名供既有测试调用。
	 *
	 * @param resolution - 代际解析结论。
	 * @returns 结构化结论面(不含笔记正文、路径与密钥)。
	 */
	private summarizeIndexConclusion(resolution: ResolveIndexGenerationResult): IndexConclusionDiagnostics {
		return summarizeIndexConclusion(resolution);
	}

	/**
	 * 把迁移/回收结论写进状态诊断落点 — 不要求上屏,但必须可查看(T7/I4)。
	 *
	 * @param summary - 结论面;缺省用本实例最近一次装配结论。
	 */
	private publishIndexConclusion(summary?: IndexConclusionDiagnostics): void {
		const conclusion = summary ?? this.indexConclusion;
		if (conclusion === null || conclusion === undefined) return;
		// 关键路径:装配期不得依赖状态 store 已就绪(装配早于 FeedbackController 与部分宿主字段),
		// 因此这里可缺省 —— 结论面同时保留在 `indexConclusion` 供诊断读取。
		this.userStatus?.patch({ indexDiagnostics: conclusion });
	}

	/**
	 * 重新解析的索引状态视图 — 装配期被长期捕获的消费方必须经它读当前实例。
	 *
	 * 关键路径(T7/I2):降级重试会重建 `IndexController`(连带换掉 `status$` 实例),
	 * 工具等长生命周期消费方若直接捕获旧 store,重试后就会一直读已被替换的状态机。
	 * 这里给出一个**延迟解析**的可读视图:每次 `get()` / 订阅都转发到当前实例。
	 *
	 * @returns 与 `IndexManager.status$` 契约一致的只读视图。
	 */
	private currentIndexStatus(): Readable<IndexStatus> {
		return {
			subscribe: (run: (value: IndexStatus) => void) => this.indexController.indexManager.status$.subscribe(run),
		};
	}

	/**
	 * 读取当前降级原因 — 经方法调用读取,绕开控制流窄化。
	 *
	 * 关键路径:同一函数内先把 `indexUnavailable` 置空再 `await` 重试时,控制流分析不会因
	 * 异步调用而失效,直接在 `if` 里读属性会被推成 `never`;方法调用给出声明类型。
	 *
	 * @returns 降级原因;索引可用时为 null。
	 */
	private indexUnavailableFailure(): { error: unknown; message: string } | null {
		// 修复:实例字段在部分宿主形态(仅原型装配)下可能是 undefined;统一按「没有原因」处理。
		return this.indexUnavailable ?? null;
	}

	/**
	 * 索引运行时降级时的用户可见出口 — 状态 + Notice,都走 i18n(T7/I2)。
	 *
	 * 关键路径:错误对象优先经 `describeIndexError` 映射稳定错误码;没有码时退回说明性文案。
	 * 插件其余能力不受影响,重试入口是 `retryIndexRuntime`(命令面板)。
	 */
	private reportIndexUnavailable(): void {
		// 关键路径:用假值判定 —— 装配路径上任何「没有降级原因」的形态(null/undefined)都不上报。
		const unavailable = this.indexUnavailableFailure();
		if (!unavailable) return;
		const reason = describeIndexError(unavailable.error);
		this.userStatus.patch({
			index: 'failed',
			indexNotice: 'index-unavailable',
			indexDetail: `${tNow('status.detail.indexUnavailable')} ${reason}`,
		});
		this.userNotice.toastError(tNow('notice.indexUnavailable', { reason }));
	}

	/**
	 * 重试索引运行时装配 — 降级状态下的恢复入口(T7/I2)。
	 *
	 * 关键路径:
	 * - 重新跑 `setupIndexRuntime`(内部已 catch → 再次失败仍保持降级,不抛出);
	 * - 成功则重建清单/后端/控制器并把 FeedbackController 重新绑到新状态机;
	 * - `indexUnavailable` 非空时本方法才有意义(用户明确重试)。
	 *
	 * @returns 装配后索引是否可用。
	 */
	async retryIndexRuntime(): Promise<boolean> {
		const pluginDir = path.join(this.vaultBase, this.app.vault.configDir, 'plugins', 'ratel-vault');
		this.indexUnavailable = null;
		this.indexConclusion = null;
		await this.setupIndexRuntime(pluginDir);
		const failure = this.indexUnavailableFailure();
		if (failure) {
			this.reportIndexUnavailable();
			this.userNotice.toastError(tNow('notice.indexRetryFailed', { reason: describeIndexError(failure.error) }));
			return false;
		}
		this.assembleIndexObjects();
		await this.preheatReadOnlyView();
		this.feedbackController?.rebindIndexStatus(this.indexController.indexManager.status$);
		this.userStatus.patch({ indexNotice: undefined, indexDetail: undefined });
		this.userNotice.toast(tNow('notice.indexRetryOk'));
		// 关键路径:恢复后立刻跑一轮(与启动同一条路径),不再重复模型下载。
		await this.startIndexRound(this.settings.autoIndex === true);
		return true;
	}

	/**
	 * 只读装配(`autoIndex=false`)— 零写入契约。
	 *
	 * 关键路径(A11):不取 owner 锁(不建 `owner.lock`)、不迁移、不新建代际。
	 * 用只读哨兵构造日志与可见性视图:有活动代际时读它的可信记录,没有时记录集为空 ——
	 * 「没有可信记录则不可检索」,而不是伪造一个合法空索引。
	 *
	 * @param config - 当前配置。
	 */
	private async setupReadOnlyIndexRuntime(config: IndexConfigDescriptor): Promise<void> {
		const runtime: ReadOnlyIndexRuntime = await setupReadOnlyIndexRuntime({
			indexRoot: this.indexRoot,
			config,
			configFingerprint: this.indexConfigFingerprint,
			vault: this.vault,
			fileExists: (p) => this.vault.fileExists(p),
			isExcluded: (p) => this.indexController?.isExcluded(p) ?? false,
			createStorage: (root) => this.createIndexStorage(root),
			// 关键路径:只读装配与迁移前一致 —— 日志存储与 store 存储是两个实例,store 走本实例
			// 工厂(`createVectraStore`),`autoInit:false` 是「不落盘」的唯一保证。
			createStore: (dir, options) => this.createVectraStore(options.autoInit, dir),
		});
		this.indexDir = runtime.indexDir;
		this.indexDirUsable = runtime.indexDirUsable;
		this.indexGenerations = runtime.generations;
		this.activeGenerationId = runtime.activeGenerationId;
		this.resolvedGenerationId = runtime.activeGenerationId;
		if (runtime.store !== undefined) this.vectraStore = runtime.store;
		if (runtime.journal !== undefined) this.indexJournal = runtime.journal;
		if (runtime.readOnlySearchView !== undefined) this.readOnlySearchView = runtime.readOnlySearchView;
	}

	/**
	 * 检索候选可见性门 — 算法在 `core/index-runtime-assembly`;这里只注入闭包读取的判定依据。
	 *
	 * @returns 与 `MultiQuerySearcher` 契约一致的门。
	 */
	private createSearchCandidateGate(): SearchCandidateGate {
		const fallback = createSearchCandidateGate({
			isReadOnly: () => this.settings.autoIndex === false,
			readOnlyChanged: () => this.indexController?.readOnlyChanged() ?? new Set<string>(),
			getReadOnlySearchView: () => this.readOnlySearchView,
			getJournal: () => this.indexJournal,
			getCoordinator: () => this.indexCoordinator,
			getConfigFingerprint: () => this.indexConfigFingerprint,
			isExcluded: (path) => this.indexController?.isExcluded(path) ?? false,
			fileExists: (path) => this.vault.fileExists(path),
		});
		// 关键路径:门在检索器构造时就固定下来,而线程客户端要到装配阶段才有;
		// 因此返回一个委派门:线程就绪用线程门,否则保持主线程语义。
		return {
			refresh: async () => {
				const gate = this.threadSearchGate ?? fallback;
				if (gate.refresh !== undefined) await gate.refresh();
			},
			decide: (path) => (this.threadSearchGate ?? fallback).decide(path),
			// 关键路径:缺省按「不可判定」而不是「已知为空」。
			recordsKind: () => (this.threadSearchGate ?? fallback).recordsKind?.() ?? 'unjudgeable',
		};
	}

	/**
	 * 线程模式下的召回来源;线程尚未就绪或已回退时退回 Worker 召回。
	 *
	 * 关键路径:回退必须仍能检索,否则「线程装配失败」会连带把检索打挂。
	 */
	private createThreadCandidateSource(): SearchCandidateSource {
		return {
			search: async (queryVector, topK) => {
				const client = this.indexThreadClient;
				if (client !== undefined) {
					const hits = await client.searchByVector(queryVector, topK);
					return hits.map((hit) => ({
						docId: hit.docId ?? hit.path,
						score: hit.score,
						metadata: { path: hit.path, chunkIndex: hit.chunkIndex },
					}));
				}
				const response = await this.workerManager.request({
					type: 'vector.search',
					payload: { queryVector, topK },
				});
				if (response.type !== 'vector.search.result') return [];
				return response.payload;
			},
		};
	}

	/**
	 * 本轮索引运行状态 — `IndexBackend` 端口未声明该方法,装配层按可选能力读取。
	 *
	 * 关键路径:`epochSourceMissing` 是「本轮是否缺少 epoch 保护」的结构化事实,
	 * 后端未装配该方法时按「无此信号」处理(不猜测为 true)。
	 *
	 * @returns 本轮运行状态;后端未提供时为 undefined。
	 */
	private indexRoundState(): IndexRoundState | undefined {
		const backend = this.indexBackend as { roundState?: () => IndexRoundState } | undefined;
		return backend?.roundState?.();
	}

	/**
	 * 索引展示信号 — 迁移结论/缺少 epoch 保护/可信记录可判定性(不属于 IndexManager 状态机)。
	 *
	 * 关键路径:只读装配才用只读视图的判定结果;写路径下该视图不随写路径刷新,不能拿来显示。
	 *
	 * @returns 供 `FeedbackController` 组装状态展示的信号。
	 */
	private indexDisplaySignals(): IndexDisplaySignals {
		const round = this.indexRoundState();
		const readOnly = this.settings.autoIndex === false;
		const view = readOnly ? this.readOnlySearchView : undefined;
		return {
			migrating: this.indexMigrated,
			epochSourceMissing: round?.epochSourceMissing === true,
			...(readOnly
				? {
					recordsKind: view?.recordsKind() ?? 'unjudgeable',
					recordsConfig: view?.recordsConfig() ?? 'unknown',
				}
				: {}),
		};
	}

	/**
	 * 索引诊断切片 — 反馈诊断摘要只放状态/计数/代际 ID,不含笔记正文与密钥。
	 *
	 * 关键路径:`epochSourceMissing` 为真时如实列出「本轮缺少 epoch 保护」,不静默;
	 * 记录不可判定时列出 `unjudgeable`,避免被读成「0 篇可检索」。
	 *
	 * @returns 诊断切片(反馈 Modal 读取)。
	 */
	indexDiagnostics(): FeedbackIndexDiagnostics {
		const status = get(this.userStatus.statusBar$);
		const round = this.indexRoundState();
		const readOnly = this.settings.autoIndex === false;
		const view = readOnly ? this.readOnlySearchView : undefined;
		return {
			phase: status.indexPhase,
			committed: status.indexCommittedFiles,
			total: status.indexTotalFiles,
			pending: status.indexPendingFiles,
			failed: status.indexFailedFiles,
			epochSourceMissing: round?.epochSourceMissing === true,
			...(readOnly
				? {
					recordsKind: view?.recordsKind() ?? 'unjudgeable',
					recordsConfig: view?.recordsConfig() ?? 'unknown',
				}
				: {}),
			activeGenerationId: this.activeGenerationId,
			...(this.indexMigrated ? { migrationPhase: 'migrated' } : {}),
		};
	}

	/**
	 * 严格归属断言 — 只允许删除本索引根 `generations/` 下的**非活动**代际目录(T6 §8.2 + T7 收口)。
	 *
	 * @param indexDir - 待删除目录。
	 */
	private assertIndexDropOwnership(indexDir: string): void {
		assertIndexRuntimeDropOwnership(
			{ indexRoot: this.indexRoot, isActiveGeneration: (generationId) => generationId === this.activeGenerationId },
			indexDir,
		);
	}

	/** 迟到终态的提交诊断 — 只记录事实,不含正文、路径与向量。 */
	private handleLateTerminalCommitted(info: { requestType: string; taskId: string; epoch: number; indexed: number }): void {
		devLogger.info('index', `迟到终态已提交:${info.requestType} task=${info.taskId} epoch=${info.epoch} indexed=${info.indexed}`);
	}

	/** 活动代际登记器 — 算法在 `core/index-runtime-assembly`,这里只绑定本实例的读写闭包。 */
	private generationPublisher(): GenerationActivationPublisher {
		this.generationActivationPublisher ??= new GenerationActivationPublisher({
			getGenerations: () => this.indexGenerations,
			getLease: () => this.indexOwnerLease,
			getActiveGenerationId: () => this.activeGenerationId,
			setActiveGenerationId: (generationId) => { this.activeGenerationId = generationId; },
		});
		return this.generationActivationPublisher;
	}

	/**
	 * 等待本轮核对完成后登记活动代际(`configured-switch`)。
	 *
	 * 关键路径(T6 checkbox 5):配置变化建隔离代际,全部核对/提交后才切活动指针。
	 * 未 ready 时绝不切换,`reverifying` 期间旧活动索引保持可用。
	 *
	 * @param generationId - 本实例解析出的代际 ID。
	 */
	private watchGenerationActivation(generationId: string): void {
		const manager = this.indexController?.indexManager;
		if (!manager || this.generationActivationUnsub) return;
		const publisher = this.generationPublisher();
		this.generationActivationUnsub = manager.status$.subscribe((status) => {
			if (status.state !== 'Ready') return;
			void publisher.publish(generationId);
		});
		// 关键路径:退订在 `onunload` 统一执行(与其它索引资源同一处收口),不依赖宿主 register。
	}

	/**
	 * 取消在途索引任务 — 算法在 `core/index-runtime-assembly`。
	 *
	 * 关键路径(T5 接线):先撤销在途可取消的调用(协调器 + Worker 侧取消),再停止调度新文件。
	 * 写保护保留到真实终态;不终止共享 Worker,其他查询继续可用。
	 */
	private cancelIndexRun(): void {
		// 关键路径:线程模式下撤销的是线程内调用,主线程 Worker 的取消与之无关;
		// 两者共用同一段逻辑,由「当前协调器」决定撤销谁。
		cancelIndexRun({
			worker: this.indexThreadClient === undefined ? this.workerManager : undefined,
			coordinator: this.activeTaskCoordinator,
			...(this.indexOwnerLease === undefined ? {} : { epoch: this.indexOwnerLease.epoch }),
		});
	}

	/** 当前生效的任务协调器 — 线程模式优先,主线程模式回落。 */
	private get activeTaskCoordinator(): IndexTaskCoordinatorPort | undefined {
		return this.indexThreadCoordinator ?? this.indexCoordinator;
	}

	/**
	 * 清理非活动代际 — 算法在 `core/index-runtime-assembly`;本方法只做接线。
	 *
	 * @returns 实际清理的代际数量;没有写所有权时为 null(调用方据此显示「拒绝清理」)。
	 */
	private async dropInactiveGenerations(): Promise<number | null> {
		return dropInactiveGenerations({ generations: this.indexGenerations, lease: this.indexOwnerLease });
	}

	/**
	 * 标记磁盘/IO 类索引失败 — 状态里如实呈现,不静默。
	 *
	 * 关键路径:已就绪后再次发布状态时不会覆盖本须知(只有真实 Ready 才清除),
	 * 因此磁盘失败不会被后续无关的状态更新抹掉。
	 *
	 * @param error - 捕获到的错误;非磁盘/IO 类时为 no-op。
	 */
	private markIndexDiskFailure(error: unknown): void {
		if (!isIndexDiskFailure(error)) return;
		this.userStatus.patch({
			indexNotice: 'disk-failure',
			indexDetail: tNow('status.detail.diskFailure'),
		});
	}

	/**
	 * 创建 WorkerManager,使用 InlineWorker。
	 *
	 * 关键路径:
	 * - Obsidian 渲染进程的 V8 平台禁用了 Worker Threads(见 ADR-002),
	 *   直接创建 InlineWorker,不做 try/catch 降级。
	 * - InlineWorker 复用主线程 VectraStore,避免双写;处理器在启动索引轮次前统一接线。
	 */
	private createWorkerManager(): WorkerManager {
		this.workerMode = 'inline';
		this.inlineWorker = new InlineWorker();
		// 关键路径(T5 接线):真实完成的活动推进协调器进展,无进展的停滞与恢复同步到协调器阶段。
		// 用闭包延迟读取 —— manager 的构造可能早于协调器装配完成。
		return new WorkerManager(this.inlineWorker, {
			onActivity: (activity) => { this.indexCoordinator?.observeActivity(activity); },
			onStall: (info) => {
				devLogger.warn('index', `Worker 索引请求无有效活动 ${info.stalledMs}ms(阈值 ${info.timeoutMs}ms),标记停滞`, info);
				this.indexCoordinator?.markStalled();
			},
			onResume: () => { this.indexCoordinator?.markResumed(); },
		});
	}

	/**
	 * 创建不带 embeddings 的 VectraStore。
	 *
	 * 关键路径:IndexProcessor 现在自己调 EmbeddingPort.embed 批量推理,
	 * vectra 的 upsertDocument 不再被调用(改用 upsertItem 写预计算向量),
	 * 所以 VectraStore 不需要 embeddings 配置。search 也用预计算查询向量。
	 *
	 * 关键路径(只读装配):`autoInit:false` 是不落盘的唯一保证 —— 关闭自动索引时
	 * 构造存储本身不得写出 `index.json`。
	 *
	 * @param autoInit - 是否在构造期初始化存储;只读装配传 false。
	 * @param indexDir - 目标目录;缺省用本实例当前索引目录(只读装配传入代际目录)。
	 * @returns 不带 embeddings 的 VectraStore 实例。
	 */
	private createVectraStore(autoInit = true, indexDir = this.indexDir): VectraStore {
		return createIndexRuntimeStore(indexDir, {
			autoInit,
			storage: this.createIndexStorage(indexDir),
		});
	}

	/**
	 * 创建索引用的原子存储 — 所有生产 VectraStore 构造点共用同一个装配入口。
	 *
	 * 关键路径(B3):
	 * - 注入后 `endUpdate` 的落盘走「同目录临时文件 → rename」,失败时不会留下半截索引;
	 * - `VectraStore` 通过 `getLastWriteOutcome` 读回本次写入结果,才能区分
	 *   「完整旧版」(`failed-before-rename`)与「完整新版」(`renamed`/`unknown-after-rename`);
	 * - 不注入时该读取恒为 null,任何提交失败都只能报「磁盘状态不明」。
	 *
	 * 关键路径:代际根是该**索引目录本身** —— 读、写、列举、删除全部限定在其内。
	 * vault 索引必须传 `generations/<generationId>`(不是 `.index/` 根);
	 * 记忆索引(`.memory-index`)与 vault 索引各自独立,不共用一个根。
	 * 唯一例外是 legacy 只读枚举:它按 `autoInit:false` 指向 `.index/` 根且只读,不写盘。
	 *
	 * @param generationRoot - 该索引目录的绝对路径。
	 * @returns 原子索引存储实例。
	 */
	private createIndexStorage(generationRoot: string): AtomicIndexStorage {
		return createIndexRuntimeStorage(generationRoot);
	}

	/**
	 * 创建并初始化 EmbeddingWorkerProxy,把 ONNX 推理移入 Web Worker。
	 *
	 * 关键路径:
	 * - Worker URL 用 Blob URL 模式:构建期内联的 worker 脚本 → Blob → createObjectURL,
	 *   生成同源 blob:app://obsidian.md/<uuid> URL,绕过 app://<hash> 与 app://obsidian.md 跨 origin 的 SecurityError。
	 * - 模型依赖走工厂:每次 ensureWorker 都 ModelManager.getDeps() 重新读盘,返回全新 ArrayBuffer;
	 *   transfer 会掏空旧 buffer,空闲回收后再 embed 必须再取一份。
	 * - create / idle-terminate / crash 打 heartbeat + n=worker.*,不改 lastPhase。
	 * - Worker 创建/init 失败不降级,直接抛错,提示用户配置 API Embedding 端点。
	 * - proxy 就绪后注入 InlineWorker,IndexProcessor 后续 embed 调用都走 Worker 线程。
	 *
	 * @param embedding - 已加载的主线程 EmbeddingPort,用于读取 dimensions。
	 * @throws Error Worker 创建或 init 失败,错误消息引导用户切换到 API Embedding。
	 */
	/**
	 * 供装配与查询链路共用的嵌入端口 — **惰性**解析 Worker 代理。
	 *
	 * 关键路径(2026-11-06 两次事故):`EmbeddingWorkerProxy` 在 onLayoutReady 才创建,
	 * 而主线程/线程装配、查询器都在 onload 阶段构造。若在装配时立即求值
	 * `proxy ?? embedding`,代理此刻为 undefined,会永久绑定 `EmbeddingLocal` 内的
	 * ONNX 本体,推理回到主线程 —— 现场表现为每 8 段约 5.9s 长任务、界面严重卡顿。
	 * 因此必须把解析推迟到每次 `embed` 调用时。
	 */
	private effectiveEmbedding(): EmbeddingPort {
		return {
			dimensions: this.embedding.dimensions,
			modelId: this.embedding.modelId,
			embed: (texts: string[], options?: Parameters<EmbeddingPort['embed']>[1]) =>
				(this.embeddingWorkerProxy ?? this.embedding).embed(texts, options),
		};
	}

	/**
	 * 探测 GPU 版嵌入 Worker 能否初始化。
	 *
	 * 关键路径(S-WEBGPU-EMBEDDING):两个独立 Worker、两个独立 ORT 实例。
	 * GPU 版 init 失败时直接 terminate 换 WASM 版,绝不在同一实例里回退 ——
	 * 1.4.0 实测 webgpu 尝试失败会污染 initWasm(),导致 WASM 也不可用。
	 *
	 * @param gpuCode - GPU 版 Worker 源码(ESM)
	 * @param embedding - 当前嵌入端口,提供维度
	 * @returns 可用的 Blob URL;失败返回 null
	 */
	private async probeGpuWorker(gpuCode: string, embedding: EmbeddingPort): Promise<string | null> {
		// 关键路径(研发期):每一步都留痕,任何一次静默早退都会让结论无法判断。
		devLogger.info('index', `GPU 探测开始:Worker 代码 ${gpuCode.length} 字节`);
		if (gpuCode.length === 0) {
			devLogger.warn('index', 'GPU 探测跳过:Worker 代码未内联');
			return null;
		}
		const deps = await this.modelManager.getDeps({ gpu: true });
		if (deps === null) {
			devLogger.warn('index', 'GPU 探测跳过:模型依赖不可用');
			return null;
		}
		let url: string;
		let worker: Worker;
		try {
			url = URL.createObjectURL(new Blob([gpuCode], { type: 'text/javascript' }));
			// 关键路径:ESM Worker 必须 type:'module',否则 import.meta.url 仍不可用。
			worker = new Worker(url, { type: 'module' });
		} catch (error) {
			devLogger.warn('index', `GPU 探测跳过:Worker 创建失败 ${error instanceof Error ? error.message : String(error)}`);
			return null;
		}
		let ok = false;
		let warmupTimer: number | undefined;
		try {
			ok = await new Promise<boolean>((resolve) => {
				const timer = window.setTimeout(() => {
					devLogger.warn('index', 'GPU 嵌入 Worker 探测超时(30 秒),回退 WASM');
					resolve(false);
				}, 30_000);
				worker.onmessage = (event: MessageEvent) => {
					const data = event.data as { type?: string; error?: string; stack?: string };
					if (data.type === 'ready') {
						// 关键路径:就绪后再跑一次 warmup 量真实单块耗时,
						// 必须等它回包再 resolve —— 否则 finally 里的 terminate 会把
						// 热身中的 Worker 直接杀掉,日志里永远看不到耗时。
						worker.postMessage({ type: 'warmup', maxBatchSize: 8 });
						warmupTimer = window.setTimeout(() => {
							window.clearTimeout(timer);
							resolve(true);
						}, 20_000);
					} else if (data.type === 'error') {
						window.clearTimeout(timer);
						// 关键路径:把真实失败原因写进日志,研发期不必再猜是 EP 未注册、
						// glue 加载失败还是 wasm 版本不匹配。
						const stack = data.stack === undefined ? '' : `\n${data.stack.split('\n').slice(0, 8).join('\n')}`;
						devLogger.warn('index', `GPU 嵌入 Worker 初始化失败:${data.error ?? 'unknown'}${stack}`);
						resolve(false);
					}
				};
				worker.onerror = (event: ErrorEvent) => {
					window.clearTimeout(timer);
					devLogger.warn('index', `GPU 嵌入 Worker 加载失败:${event.message}`);
					resolve(false);
				};
				worker.postMessage(
					{ type: 'init', deps, dimensions: embedding.dimensions, maxBatchSize: 16 },
					[deps.modelBuffer, deps.wasmBinary],
				);
				// warmup 回包:记录真实速度后立刻结算探测。
				worker.addEventListener('message', (warm: MessageEvent) => {
					const payload = warm.data as { type?: string; blocks?: number; elapsedMs?: number; error?: string };
					if (payload.type === 'warmup:done') {
						const blocks = payload.blocks ?? 1;
						const ms = payload.elapsedMs ?? 0;
						devLogger.info(
							'index',
							`GPU 预热完成:${blocks} 块 / ${ms} ms(${(ms / blocks / 1000).toFixed(2)} 秒/块)`,
						);
						window.clearTimeout(warmupTimer);
						window.clearTimeout(timer);
						resolve(true);
					} else if (payload.type === 'warmup:error') {
						devLogger.warn('index', `GPU 预热失败:${payload.error ?? 'unknown'}`);
						window.clearTimeout(warmupTimer);
						window.clearTimeout(timer);
						resolve(true);
					}
				});
			});
		} catch (error) {
			devLogger.warn('index', `GPU 探测异常:${error instanceof Error ? error.message : String(error)}`);
			ok = false;
		} finally {
			// 关键路径:探测用的 Worker 一定要关掉,正式实例由 proxy 惰性新建。
			worker.terminate();
		}
		if (!ok) {
			URL.revokeObjectURL(url);
			devLogger.warn('index', 'GPU 嵌入 Worker 初始化失败,回退 WASM');
			return null;
		}
		devLogger.info('index', 'GPU 探测成功:使用 WebGPU 执行器');
		return url;
	}

	private async initEmbeddingWorkerProxy(embedding: EmbeddingPort): Promise<void> {
		// 关键路径: embedding worker 脚本在构建期内联进 main.js(ADR-006),不再读磁盘 embedding-worker.js。
		if (!EMBEDDING_WORKER_CODE) {
			throw new Error(tNow('error.worker.notInlined'));
		}
		const wasmUrl = URL.createObjectURL(new Blob([EMBEDDING_WORKER_CODE], { type: 'application/javascript' }));
		// 关键路径:先探测 GPU;失败一律回退到 1.4.0 的稳定 WASM 路径。
		const gpuUrl = await this.probeGpuWorker(GPU_EMBEDDING_WORKER_CODE, embedding);
		const workerUrl = gpuUrl ?? wasmUrl;
		const workerType: 'classic' | 'module' = gpuUrl !== null ? 'module' : 'classic';
		this.gpuWorkerSelected = gpuUrl !== null;
		if (gpuUrl !== null) URL.revokeObjectURL(wasmUrl);
		this.embeddingWorkerUrl = workerUrl;

		// 关键路径:工厂每次 ensureWorker 都 getDeps,避免 transfer 掏空 ArrayBuffer 后空闲重建失败。
		const proxy = new EmbeddingWorkerProxy(
			workerUrl,
			async () => {
				const fresh = await this.modelManager.getDeps({ gpu: this.gpuWorkerSelected });
				if (!fresh) throw new Error(tNow('error.embedding.notInit'));
				return fresh;
			},
			embedding.dimensions,
			16,
			(kind) => this.breadcrumbs?.mark('heartbeat', undefined, `worker.${kind}`),
			workerType,
		);
		this.embeddingWorkerProxy = proxy;

		try {
			// 关键路径:惰性后 ready 在无 worker 时立即 resolve;onload 必须 ensureReady 才真正 init。
			await proxy.ensureReady();
		} catch (err) {
			// 关键路径:Worker init 失败需 terminate 释放线程资源,避免悬挂 Worker 进程。
			proxy.terminate();
			this.embeddingWorkerProxy = undefined;
			const message = err instanceof Error ? err.message : String(err);
			// 复用 error.probe.requestFailed:消息含 {message} 占位,语义为"请求失败"
			throw new Error(tNow('error.probe.requestFailed', { message }));
		}

		// 关键路径:共享处理器统一在 startIndexRound 接线,不重建已被日志与协调器绑定的 store。
	}

	/**
	 * ask 尾部统一记账与收口 — 外审 C1,所有路径必经。
	 */
	private async finalizeAskRound(
		sessionId: string,
		signal: AbortSignal | undefined,
		opts: { goalRound?: boolean } | undefined,
		collectedEvents: AgentEvent[],
	): Promise<void> {
		const result = await this.goalRunner.finalizeRound({
			sessionId,
			aborted: !!signal?.aborted,
			goalRoundFlag: opts?.goalRound === true,
			events: collectedEvents,
		});
		this.bumpGoalUi();

		if (result.completed && result.completedGoalId) {
			const goal = await this.goalStore.get(result.completedGoalId);
			if (goal) {
				showGoalCompletedNotice(goal);
			}
		}

		if (this.pendingTerminalGoalId && this.pendingTerminalAllowWriteNote) {
			const goal = await this.goalStore.get(this.pendingTerminalGoalId);
			if (goal && (goal.status === 'completed' || goal.status === 'cancelled')) {
				await this.handleGoalTerminal(goal, this.pendingTerminalKind ?? 'completed');
				this.pendingTerminalGoalId = null;
				this.pendingTerminalKind = null;
				this.pendingTerminalAllowWriteNote = false;
			}
		}
	}

	/** 当前 Chat 会话 id — manage_goal 与设置页恢复用 */
	getCurrentChatSessionId(): string | null {
		return this.currentChatSessionId;
	}

	/** 递增 revision 并刷新底栏 */
	bumpGoalUi(): void {
		this.goalRevision++;
		bumpGoalRevision();
		void this.refreshGoalStatusBar();
	}

	private async refreshGoalStatusBar(): Promise<void> {
		if (!this.goalStatusBarEl) return;
		const goals = await this.goalStore.list();
		const incomplete = goals.filter((g) => g.status !== 'completed' && g.status !== 'cancelled');
		const stale = await this.goalStore.listStaleTerminal(this.settings.goalArchiveDays);
		if (incomplete.length === 0 && stale.length === 0) {
			this.goalStatusBarEl.hide();
			return;
		}
		const picked = pickGoalStatusBarText(goals, stale.length);
		if (!picked) {
			this.goalStatusBarEl.hide();
			return;
		}
		this.goalStatusBarOpensSettings = picked.openSettings;
		this.goalStatusBarEl.setText(picked.text);
		this.goalStatusBarEl.show();
	}

	/**
	 * 打开目标列表 Modal(单例) — 底栏待归档 / 多条遗留 pending chip / 抽屉「目标」。
	 *
	 * 关键路径:已打开则忽略,避免叠窗。
	 */
	openGoalManageModal(): void {
		if (!shouldCreateGoalManageModal(this.goalManageModal)) return;
		const modal = new GoalManageModal(this.app, this);
		this.goalManageModal = modal;
		modal.onClosed = () => {
			if (this.goalManageModal === modal) this.goalManageModal = null;
		};
		modal.open();
	}

	/**
	 * 初始化 Goal UI — 扫描损坏文件并刷新底栏。
	 */
	private async initGoalUi(pluginDir: string): Promise<void> {
		const corruptDir = path.join(pluginDir, 'goals', 'corrupt');
		let corruptBefore = 0;
		try {
			corruptBefore = fs.existsSync(corruptDir) ? fs.readdirSync(corruptDir).length : 0;
		} catch {
			// ignore
		}
		await this.goalStore.list();
		let corruptAfter = corruptBefore;
		try {
			corruptAfter = fs.existsSync(corruptDir) ? fs.readdirSync(corruptDir).length : 0;
		} catch {
			// ignore
		}
		if (corruptAfter > corruptBefore) {
			new Notice(tNow('goal.notice.corrupt', { count: corruptAfter - corruptBefore }));
		}
		this.bumpGoalUi();
	}

	/** 终态去留一框 — runner 自动 complete 时目标已落盘 */
	async handleGoalTerminal(goal: AgentGoal, kind: 'completed' | 'cancelled'): Promise<void> {
		// 关键路径:落盘已是终态,先刷侧栏再弹去留,避免条/chip 残留
		this.bumpGoalUi();
		await waitGoalModalGap();
		const result = await showGoalTerminalChoiceModal(this.app, kind, goal, {
			alreadyTerminal: true,
		});
		if (!result) return;
		await applyGoalTerminalChoice(this.goalStore, goal, result);
		await this.finishGoalTerminalUi(goal, kind, result);
	}

	/**
	 * 关闭/完成后的 Notice 与写笔记跟进 — 不负责弹窗与归档落盘。
	 */
	async finishGoalTerminalUi(
		goal: AgentGoal,
		kind: 'completed' | 'cancelled',
		result: GoalTerminalChoiceResult,
	): Promise<void> {
		if (result.choice === 'writeNote') {
			new Notice(tNow('goal.notice.writeNoteHint'));
			this.pendingTerminalGoalId = goal.id;
			this.pendingTerminalKind = kind;
			this.pendingTerminalAllowWriteNote = true;
			void this.activateChatView();
		} else {
			this.pendingTerminalGoalId = null;
			this.pendingTerminalKind = null;
			this.pendingTerminalAllowWriteNote = false;
			if (result.showCompletedNotice && kind === 'completed') {
				const fresh = await this.goalStore.get(goal.id);
				if (fresh) showGoalCompletedNotice(fresh);
			}
		}
		this.bumpGoalUi();
	}

	/**
	 * 唤起或聚焦聊天侧栏 — 幂等,已存在则 reveal,否则在右侧栏创建。
	 */
	async activateChatView() {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
		if (!leaf) {
			const rightLeaf = workspace.getRightLeaf(false);
			if (rightLeaf) {
				leaf = rightLeaf;
				await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
			}
		} else {
			// 关键路径:revealLeaf 返回 Promise,显式 void 标记不等待,避免浮动 Promise。
			void workspace.revealLeaf(leaf);
		}
		window.requestAnimationFrame(() => patchAllChatLeafIcons(this.app.workspace));
	}

	/**
	 * 向聊天输入插入 `@vault相对路径`(策略 A,不读文件)。
	 *
	 * @param path - 必须是 vault 相对路径(如 TFile.path)
	 */
	async insertChatMention(path: string): Promise<void> {
		if (!isSafeVaultMentionPath(path)) {
			new Notice(tNow('chat.mention.absoluteRejected'), 4000);
			return;
		}
		// 关键路径:先排队再 activate — onOpen 冲刷 pending,避免 mount 竞态双插
		this.pendingChatMention = path;
		await this.activateChatView();
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
		if (!leaf) {
			// 修复:侧栏无法创建时清掉 pending,避免永久泄漏
			this.pendingChatMention = undefined;
			devLogger.warn('main', 'insertChatMention: 无法打开 Chat 侧栏');
			return;
		}
		const view = leaf.view;
		if (view instanceof ChatView && this.pendingChatMention === path) {
			if (view.insertChatMention(path)) {
				this.pendingChatMention = undefined;
			}
			// 组件尚未 mount 时保留 pending,由 ChatView.onOpen 冲刷
		}
	}

	/**
	 * 打开记忆管理 Modal(单例)。
	 *
	 * 关键路径:已打开则忽略,避免叠多个记忆窗。
	 */
	openMemoryModal(): void {
		if (!shouldCreateMemoryModal(this.memoryModal)) return;
		const modal = new MemoryModal(this.app, this);
		this.memoryModal = modal;
		modal.onClosed = () => {
			if (this.memoryModal === modal) this.memoryModal = null;
		};
		modal.open();
	}

	/**
	 * 打开 MCP 管理 Modal(单例)。
	 *
	 * 关键路径:已打开则忽略,避免叠多个管理窗。
	 */
	openMcpManageModal(): void {
		if (!shouldCreateMcpManageModal(this.mcpManageModal)) return;
		const modal = new McpManageModal(this.app, this);
		this.mcpManageModal = modal;
		modal.onClosed = () => {
			if (this.mcpManageModal === modal) this.mcpManageModal = null;
		};
		modal.open();
	}

	/**
	 * 打开技能管理 Modal(单例,S-SKILL-UX — 状态抽屉「技能」入口)。
	 *
	 * 关键路径:已打开则忽略,避免叠多个管理窗。
	 */
	openSkillManageModal(): void {
		if (!shouldCreateSkillManageModal(this.skillManageModal)) return;
		const modal = new SkillManageModal(this.app, this);
		this.skillManageModal = modal;
		modal.onClosed = () => {
			if (this.skillManageModal === modal) this.skillManageModal = null;
		};
		modal.open();
	}

	/**
	 * 重新加载 skills — 扫描三源 + 解析 frontmatter + 合并 + 写入 registry。
	 *
	 * 关键路径:
	 * - 加载 warnings 通过 devLogger 输出(非阻塞)
	 * - 加载完成后 registry 状态全量替换
	 *
	 * @returns 加载到的 skill 数量
	 */
	async reloadSkills(): Promise<number> {
		const { skills, warnings } = await this.skillLoader.loadAll();
		this.skillRegistry.reload(skills, warnings);
		// S-SKILL-UX:应用持久化的 per-skill 开关(settings.skillEnabled)。
		this.skillRegistry.applyEnabledOverrides(this.settings.skillEnabled);
		if (warnings.length > 0) {
			for (const w of warnings) {
				devLogger.warn('skill', `${w.path}: ${w.message}`);
			}
		}
		// 安全路径:0 个 skill 是常态(未建 .ratel/skills),勿每次启动刷 info 干扰排障
		if (skills.length > 0) {
			devLogger.info('skill', `已加载 ${skills.length} 个 skill`);
		} else {
			devLogger.debug('skill', '未加载任何 skill(目录为空或不存在)');
		}
		return skills.length;
	}
}
