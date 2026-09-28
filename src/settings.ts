/**
 * @file src/settings.ts
 * @description Ratel Vault 设置项定义 + Obsidian 设置面板渲染
 * @module settings
 * @depends obsidian, ./main
 */

import {
	App,
	PluginSettingTab,
	type SettingDefinitionItem,
} from 'obsidian';
// 关键路径:RatelVaultPlugin 仅作类型标注使用,用 import type 避免运行时拉起 main.ts
// (main.ts 会载入 ChatView.svelte,在 vitest 环境无 svelte 插件无法解析)
import type RatelVaultPlugin from './main';
// 关键路径:声明式 settings 每次渲染重新调用 tNow,无需 store 订阅
import { tNow, type LangPreference, type StringKey } from './i18n';
import type { ToolPermission, ToolPermissionLevel } from './core/tool-permissions';
import type { ContextLengthPresetId } from './ui/tokens/context-length-presets';
import { inferPresetFromTokens, presetToTokens } from './ui/tokens/context-length-presets';
import type { OverrideMap } from './prompts/types';
// 关键路径:声明式 settings 子页面与 render wrapper
import { DiagnosticsSettingPage } from './ui/settings/diagnostics-setting-page';
import {
	renderChatSecretHint,
	renderEmbedSecretHint,
	renderRerankSecretHint,
} from './ui/settings/secret-hint-render';
// 关键路径(S-CHAT-SETUP CS-07):二级页声明式定义 — 长设置各占一页,主页只留入口
import { buildToolPermissionsSettingPage } from './ui/settings/tool-permissions-setting-page';
import { buildModelRegistrySettingPage } from './ui/settings/model-registry-setting-page';
import { buildEcosystemSettingPage } from './ui/settings/ecosystem-setting-page';
import { buildPromptOverridesSettingPage } from './ui/settings/prompt-overrides-setting-page';
import { buildMemoryLimitsSettingPage } from './ui/settings/memory-limits-setting-page';
import { buildDeveloperSettingPage } from './ui/settings/developer-setting-page';
import type { ChatPresetId } from './settings/chat-preset';
// 关键路径:setControlValue 写入与副作用统一走 settings-apply(与 update_app_config 工具共享)
import { applySettingValue } from './settings/settings-apply';
// 关键路径:外观类型从 presets 导入,避免 appearance-presets ↔ settings 循环依赖
import type { UiAccentId, UiColorScheme } from './ui/appearance/appearance-presets';
import { renderAppearanceSettings } from './ui/appearance/appearance-settings-render';
import { renderChatProfiles } from './ui/settings/chat-profiles-render';
import type { McpServerConfig } from './ports/mcp';

/** 设置顶栏 Tab ID 清单(仅 UI 态,不落盘)— focusTab 校验与顶部导航共用的单一事实源 */
export const SETTINGS_UI_TABS = ['chat', 'index', 'agent', 'appearance', 'advanced'] as const;
export type SettingsUiTab = (typeof SETTINGS_UI_TABS)[number];

/** 顶部导航 labelKey 本地映射 — Record 保证新增 tab 时编译期强制补齐文案 */
const SETTINGS_TAB_LABEL_KEYS: Record<SettingsUiTab, StringKey> = {
	chat: 'settings.tabs.chat',
	index: 'settings.tabs.index',
	agent: 'settings.tabs.agent',
	appearance: 'settings.tabs.appearance',
	advanced: 'settings.tabs.advanced',
};

/**
 * 全部用户可配置项。
 *
 * - Chat:DeepSeek / OpenAI 兼容协议的 LLM 配置。
 * - Embedding:本地 ONNX(`local`)或远端 OpenAI 兼容端点(`api`)。
 * - Reranker:可选,API Key 留空即视为关闭。
 * - Indexing:分块大小 / 重叠 / 是否自动重建。
 */
export interface RatelVaultSettings {
	// 关键路径:界面语言偏好,'auto' 跟随 navigator.language,显式 'zh'/'en' 覆盖
	language: LangPreference;
	// Chat
	/** 场景预设 — DeepSeek / Ollama / 自定义;手改模型或 Base 会置为 custom */
	chatPreset: ChatPresetId;
	chatModel: string;
	chatApiBase: string;
	/** 模型上下文窗口上限(token) — StatusLine 上下文使用率计算 */
	chatModelMaxTokens: number;
	/** 上下文接近上限时自动压缩(默认开) */
	autoCompactEnabled: boolean;
	/** Context Length 下拉预设;custom 时以 chatModelMaxTokens 为准 */
	contextLengthPreset: ContextLengthPresetId;
	/** 空字符串 = LiteLLM 默认映射表 URL */
	modelRegistryUrl: string;
	/** 多套对话配置;activeChatProfileId 指向当前这套 */
	chatProfiles: import('./settings/chat-profiles').ChatProfile[];
	activeChatProfileId: string;

	// Embedding
	embedProvider: 'local' | 'api';
	embedLocalModel: string;
	embedLocalDimensions: number;
	embedApiBase: string;
	embedApiModel: string;
	embedApiDimensions: number;

	// Reranker (百炼,可选 — 钥匙串有 ratel-rerank-bailian 即启用)
	rerankerApiBase: string;
	rerankerModel: string;

	// Indexing
	chunkSize: number;
	chunkOverlap: number;
	autoIndex: boolean;
	// 关键路径:indexPaused 由用户在设置面板切换;true 时 IndexManager 不消费队列但仍入队,供用户按需恢复。
	indexPaused: boolean;
	// 关键路径:embedModelActive 记录当前激活的本地 Embedding 模型 id(支持后续切模型)。
	embedModelActive: string;
	// 关键路径:embedAvailableModels 列出可下载的模型(尺寸/维度/推荐位),UI 设置面板展示。
	embedAvailableModels: Array<{ id: string; sizeBytes: number; dimensions: number; recommended: boolean }>;
	// 关键路径:embedDownloadedModels 记录用户已下载到本地的模型 id,切换/清理用。
	embedDownloadedModels: string[];

	// Developer
	debugLog: boolean;
	/** 崩溃面包屑落盘（S-RENDER-STABILITY 分期 A）；默认开，开发者区可关 */
	crashBreadcrumbs: boolean;
	/** Agent Loop 最大步数上限 — 防止工具调用死循环,默认 50(见 ADR-004) */
	agentMaxSteps: number;

	// Goal(S-GOAL — 目标模式预算与归档提醒)
	/** 跨回合轮数默认上限 — create 未指定 maxRounds 时使用 */
	goalMaxRounds: number;
	/** 单回合 token 软上限;0 = 关闭(spec 4.7) */
	goalRoundTokenSoftCap: number;
	/** 终态 goal 超过多少天标为待归档(不自动搬家,spec 4.9) */
	goalArchiveDays: number;

	/** 库外文件与本机命令。默认关。打开后仍走工具权限确认。 */
	hostAccessEnabled: boolean;
	toolPermissions: Record<string, ToolPermission>;
	/**
	 * 内置工具默认权限的代数。旧库没有这个字段时，把仍为 ask 的内置工具升到 allow。
	 * 用户之后再改成询问或拒绝会保留。
	 */
	toolPermissionDefaultsVersion: number;
	/** 工具权限档位 — safe/auto/danger；取代产品语义上的 trustMode */
	toolPermissionLevel: ToolPermissionLevel;
	// 关键路径:Prompt section 级覆盖(来自 Composer registry);空对象 = 全部用 zh.ts 默认。
	promptOverrides: OverrideMap;
	/** 旧 data.json 兼容字段；运行时以 toolPermissionLevel 为准 */
	trustMode: boolean;

	// Memory(P-MEMORY-UI — 用户记忆系统 6 个配置项,见 spec §8.3)
	// 关键路径:memoryEnabled=false 时 Agent 不读写记忆,记忆面板仍可查看(只读模式)。
	memoryEnabled: boolean;
	// 关键路径:memoryAutoWrite=false 时 Agent 仅在用户显式"记住"指令下写入,不主动推断。
	memoryAutoWrite: boolean;
	// 关键路径:memoryStorageLimitMB 是所有记忆文件磁盘占用上限(MB),remember 工具写入前校验。
	memoryStorageLimitMB: number;
	// 关键路径:memoryInjectLimitKB 是 global.md 注入系统提示的硬限制(KB),composer 截断用。
	memoryInjectLimitKB: number;
	// 关键路径:memoryDynamicLimitKB 是单次 search_memory 返回内容硬限制(KB)。
	memoryDynamicLimitKB: number;
	// 关键路径:memoryContextTotalLimitKB 是基础 + 动态记忆在上下文中的合计硬限制(KB)。
	memoryContextTotalLimitKB: number;
	// 关键路径(S-SR-LAYERING):topics 自动注入条数;0 = 关闭,默认 3。
	memoryTopicsAutoInjectK: number;
	// 关键路径(S-SKILL-UX):per-skill 开关持久化(name → 是否启用)。
	// 未登记的 skill 走 manifest.enabled 默认值;Registry 加载后 applyEnabledOverrides 应用。
	skillEnabled: Record<string, boolean>;
	/** 无心跳判定窗口(ms;ADR-017 v1.1)— 零心跳超此值判卡死;持续报进度超此值返回 still-running 交 LLM 决策 */
	skillScriptTimeout: number;
	/** 受信脚本白名单(`skillName/scriptPath`);首次授权 Modal 选「允许并记住」时写入 */
	trustedScripts: string[];

	// 关键路径(P-BASIC-ENV):日记约定路径 — get_daily_note 只探测不创建。
	dailyNoteFolder: string;
	dailyNoteFormat: string;

	// 关键路径(P-UI-APPEARANCE — Chat 外观配色与强调色)
	/** 配色方案:auto 跟随 Obsidian,light/dark 强制 */
	uiColorScheme: UiColorScheme;
	/** 强调色:follow 跟随 Obsidian,其余为 Material 预设 id */
	uiAccent: UiAccentId;

	// 关键路径(P-CHAT-NAV — 对话位置轨开关与靠边)
	/** 是否在消息区显示阅读位置轨与回到底部 */
	chatNavRailEnabled: boolean;
	/** 位置轨吸附在消息区左侧或右侧 */
	chatNavRailSide: 'left' | 'right';

	// 关键路径(P-CHAT-MOTION — 聊天装饰动效总闸门)
	/** 是否播放空态/入场/扫光等装饰动效（不含 ThinkingOrb 忙态） */
	chatMotionEnabled: boolean;

	// 关键路径(P-MASCOT-1 — 捣蛋鬼开关与归一化位置)
	/** 是否在消息区显示可拖动捣蛋鬼 */
	chatMascotEnabled: boolean;
	/** 捣蛋鬼水平位置(归一化 0~1,1 = 贴右) */
	chatMascotX: number;
	/** 捣蛋鬼垂直位置(归一化 0~1,1 = 贴底) */
	chatMascotY: number;

	/** MCP Server 列表；默认空 = 零出站 */
	mcpServers: McpServerConfig[];
	/** 用户已确认允许 spawn 的 stdio serverId 列表 */
	mcpApprovedSpawns: string[];
	/**
	 * 是否允许把社区插件写入当前库(ADR-018 R2)。false = 商店保守包 R3,只打开官方页。
	 */
	ecosystemWriteEnabled: boolean;
}

/**
 * 默认设置 — 首次安装时写入 data.json 的初值。
 *
 * 关键路径:`embedApiBase` 默认 `http://localhost:11434/v1` 适配本地 Ollama,
 * 用户无需任何配置就能跑通端到端检索。
 */
export const DEFAULT_SETTINGS: RatelVaultSettings = {
	// 关键路径:默认 auto,跟随系统语言(zh* → zh,其余 → en)
	language: 'auto',
	// 关键路径:默认 DeepSeek 预设,与官方 Base + deepseek-v4-flash 对齐
	chatPreset: 'deepseek',
	chatModel: 'deepseek-v4-flash',
	chatApiBase: 'https://api.deepseek.com',
	contextLengthPreset: '256k',
	chatModelMaxTokens: 256_000,
	autoCompactEnabled: true,
	modelRegistryUrl: '',
	chatProfiles: [],
	activeChatProfileId: '',

	embedProvider: 'local',
	embedLocalModel: 'Xenova/bge-small-zh-v1.5',
	embedLocalDimensions: 512,
	embedApiBase: 'http://localhost:11434/v1',
	embedApiModel: 'bge-m3',
	embedApiDimensions: 1024,

	// 关键路径:Rerank v1 仅支持百炼 DashScope compatible-api,密钥走钥匙串。
	rerankerApiBase: 'https://dashscope.aliyuncs.com/compatible-api/v1',
	rerankerModel: 'qwen3-rerank',

	chunkSize: 500,
	chunkOverlap: 100,
	autoIndex: true,
	// 关键路径:索引暂停默认关闭,起飞期 IndexManager 状态 = Init → Ready,正常消费队列。
	indexPaused: false,
	// 关键路径:默认激活 bge-small-zh-v1.5(ONNX 量化模型约 24MB,多数用户零感知下载)。
	embedModelActive: 'Xenova/bge-small-zh-v1.5',
	// 关键路径:本地模式仅内置 bge-small-zh-v1.5,ONNX 量化模型约 24MB;其他模型走 API 配置。
	embedAvailableModels: [
		{ id: 'Xenova/bge-small-zh-v1.5', sizeBytes: 24 * 1024 * 1024, dimensions: 512, recommended: true },
	],
	embedDownloadedModels: [],

	debugLog: false,
	crashBreadcrumbs: true,
	// 关键路径:50 步覆盖知识库场景(1 glob + N read + 分析 + write),见 ADR-004。
	agentMaxSteps: 50,

	goalMaxRounds: 10,
	goalRoundTokenSoftCap: 0,
	goalArchiveDays: 7,

	// 内置工具默认允许，设置里也是「允许」。外部 MCP 不在这张表里，解析时仍为询问。
	toolPermissions: {
		search_vault: 'allow',
		read_note: 'allow',
		grep: 'allow',
		glob: 'allow',
		list_files: 'allow',
		write_note: 'allow',
		append_note: 'allow',
		edit_note: 'allow',
		delete_note: 'allow',
		search_memory: 'allow',
		remember: 'allow',
		forget_memory: 'allow',
		activate_skill: 'allow',
		deactivate_skill: 'allow',
		read_skill_reference: 'allow',
		run_skill_script: 'allow',
		get_datetime: 'allow',
		get_active_note: 'allow',
		get_daily_note: 'allow',
		list_recent_notes: 'allow',
		get_note_outline: 'allow',
		get_links: 'allow',
		search_by_tag: 'allow',
		search_by_property: 'allow',
		get_vault_structure: 'allow',
		open_note: 'allow',
		open_settings: 'allow',
		get_app_config: 'allow',
		update_app_config: 'allow',
		manage_goal: 'allow',
		search_plugins: 'allow',
		install_plugin: 'allow',
		get_plugin_status: 'allow',
		list_ecosystem_changes: 'allow',
		update_plugin: 'allow',
		uninstall_plugin: 'allow',
		configure_plugin: 'allow',
		restore_backup: 'allow',
		apply_diary_host: 'allow',
		list_host_dir: 'ask',
		read_host_file: 'ask',
		import_host_file: 'ask',
		run_host_command: 'ask',
	},
	toolPermissionDefaultsVersion: 1,
	hostAccessEnabled: false,
	// 关键路径:默认无任何 override,使用 zh.ts 内置中文模板。
	promptOverrides: {},
	toolPermissionLevel: 'safe',
	trustMode: false,

	// Memory — 6 个配置项默认值(spec §8.3)
	// 关键路径:默认启用记忆 + 自动写入,让用户零感知 Agent 学习偏好。
	memoryEnabled: true,
	memoryAutoWrite: true,
	// 关键路径:10MB 上限与 MemoryStore 内部 MEMORY_STORAGE_MAX_BYTES 常量对齐(spec §7)。
	memoryStorageLimitMB: 10,
	// 关键路径:20KB 基础注入 ≈ 5k tokens,占 200k 上下文的 2.5%。
	memoryInjectLimitKB: 20,
	// 关键路径:30KB 动态注入 ≈ 7.5k tokens,留余地给工具结果与回复。
	memoryDynamicLimitKB: 30,
	// 关键路径:50KB 总记忆上限 ≈ 12.5k tokens,平衡记忆 vs 检索/回复空间。
	memoryContextTotalLimitKB: 50,
	// 关键路径(S-SR-LAYERING):每轮提问自动检索注入 top-K 相关主题(名称+摘要);0 = 关闭。
	memoryTopicsAutoInjectK: 3,
	// 关键路径(S-SKILL-UX):per-skill 开关持久化,默认空(全部走 manifest.enabled)。
	skillEnabled: {},
	skillScriptTimeout: 30_000,
	trustedScripts: [],
	// 关键路径:日记默认 vault 根 + YYYY-MM-DD.md,与常见 Daily Notes 约定对齐。
	dailyNoteFolder: '',
	dailyNoteFormat: 'YYYY-MM-DD',
	// 关键路径:默认跟随 Obsidian 主题配色与强调色。
	uiColorScheme: 'auto',
	uiAccent: 'follow',
	// 关键路径:默认开启位置轨并靠右,贴合常见阅读滚动条习惯。
	chatNavRailEnabled: true,
	chatNavRailSide: 'right',
	// 关键路径:默认开启装饰动效;系统 prefers-reduced-motion 时由 prefs 闸门兜底关闭。
	chatMotionEnabled: true,
	// 关键路径:默认开启捣蛋鬼并贴右下角(归一化 1,1)。
	chatMascotEnabled: true,
	chatMascotX: 1,
	chatMascotY: 1,
	// 关键路径:默认空列表 = 零 MCP 出站（ADR-014）
	mcpServers: [],
	mcpApprovedSpawns: [],
	ecosystemWriteEnabled: true,
};

/** 内置工具默认「允许」的代数。旧库没有该字段时做一次升级。 */
export const BUILTIN_TOOL_PERMISSION_DEFAULTS_VERSION = 1;

/**
 * 旧库里内置工具若仍是出厂的 ask，升成 allow。拒绝不动。MCP 不在默认表里，不改。
 *
 * @param settings - 已与 DEFAULT 合并的设置
 * @param loadedVersion - 磁盘上的代数；没有则视为 0
 */
export function applyBuiltinToolPermissionDefaults(
	settings: RatelVaultSettings,
	loadedVersion: number | undefined,
): void {
	const version = loadedVersion ?? 0;
	if (version >= BUILTIN_TOOL_PERMISSION_DEFAULTS_VERSION) return;
	for (const name of Object.keys(DEFAULT_SETTINGS.toolPermissions)) {
		if (settings.toolPermissions[name] === 'ask') {
			settings.toolPermissions[name] = 'allow';
		}
	}
	settings.toolPermissionDefaultsVersion = BUILTIN_TOOL_PERMISSION_DEFAULTS_VERSION;
}

/**
 * 规范化 Context Length 相关字段 — loadSettings 后调用(见 ADR-007)。
 *
 * @param settings - 合并 DEFAULT 后的设置对象
 * @param raw - 磁盘原始片段;用于判断旧版 data.json 是否缺少 contextLengthPreset
 */
export function normalizeContextLengthSettings(
	settings: RatelVaultSettings,
	raw?: Partial<RatelVaultSettings>,
): RatelVaultSettings {
	if (settings.modelRegistryUrl == null) {
		settings.modelRegistryUrl = '';
	}
	if (raw?.contextLengthPreset == null) {
		const inferred = inferPresetFromTokens(settings.chatModelMaxTokens);
		settings.contextLengthPreset = inferred.preset;
		settings.chatModelMaxTokens = inferred.chatModelMaxTokens;
	} else if (settings.contextLengthPreset !== 'custom') {
		settings.chatModelMaxTokens = presetToTokens(settings.contextLengthPreset);
	}
	// 修复(S-CHAT-SETUP):custom + 0 是「查表未命中,等用户填」的合法状态,不再静默回填 256k;
	// 运行时由 getEffectiveChatModelMaxTokens 回落默认档,设置页用数字框引导填写。
	return settings;
}

/**
 * Obsidian 设置面板 — 把 `RatelVaultSettings` 渲染为分组表单。
 *
 * 设计要点:
 * - 1.13.0 起用 `getSettingDefinitions()` 声明式 API,删除 deprecated `display()`
 * - 顶栏五 Tab(对话模型 / 笔记索引 / 记忆与权限 / 外观 / 高级)用声明式 `visible` 切换,
 *   搜索激活时全部展开;不用 CSS is-hidden(Obsidian 不随 refresh 更新 cls)
 * - `getControlValue`/`setControlValue` override 处理嵌套 key 与副作用(rebuild/sync)
 * - 长设置(工具权限、映射表、生态、提示词、记忆上限、开发者、诊断)各占一个
 *   `SettingDefinitionPage` 二级页,主页只留入口(S-CHAT-SETUP CS-07);
 *   页内控件与迁移前完全一致,返回栈由设置框架自带
 */
export class RatelVaultSettingTab extends PluginSettingTab {
	plugin: RatelVaultPlugin;

	/** 设置顶栏当前 Tab — 仅 UI 态,不落盘;默认对话模型 */
	private activeSettingsTab: SettingsUiTab = 'chat';

	/** 是否已绑定设置模态全局搜索 input 的 listener */
	private searchListenerBound = false;

	constructor(app: App, plugin: RatelVaultPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * 程序化切换设置 tab — open_settings 工具入口。
	 *
	 * @param tab - 目标 tab id;省略保持当前 tab;非法值拒绝
	 * @returns 合法或省略返回 true;非法 tab 返回 false
	 */
	focusTab(tab?: string): boolean {
		if (tab == null) {
			this.refreshDomState();
			return true;
		}
		if (!(SETTINGS_UI_TABS as readonly string[]).includes(tab)) return false;
		this.activeSettingsTab = tab as SettingsUiTab;
		// 关键路径:与顶部导航点击同路径 — visible 谓词重算用 refreshDomState 而非 update()
		this.refreshDomState();
		return true;
	}

	/**
	 * 当前是否为指定顶栏 Tab。
	 *
	 * @param tab - Tab ID
	 * @returns 是否激活
	 */
	private isSettingsTab(tab: SettingsUiTab): boolean {
		return this.activeSettingsTab === tab;
	}

	/**
	 * Obsidian 设置模态是否正在全局搜索。
	 *
	 * 关键路径:Tab 门控用 `visible: () => tab || search`,搜索时全部展开并可检索;
	 * `visible:false` 仅在该次 render 周期排除搜索(见 SettingDefinitionBase.visible)。
	 *
	 * @returns 搜索框有非空查询时为 true
	 */
	private isSettingsSearchActive(): boolean {
		const container = this.containerEl;
		if (!container || typeof container.closest !== 'function') {
			return false;
		}
		const modal = container.closest('.modal-container');
		if (!modal) {
			return false;
		}
		const input =
			modal.querySelector<HTMLInputElement>('.vertical-tab-header input') ??
			modal.querySelector<HTMLInputElement>('.search-input-container input');
		return !!input?.value?.trim();
	}

	/**
	 * 绑定设置全局搜索框 — 输入时 update() 以重算面板 is-hidden。
	 *
	 * 关键路径:只绑一次,避免每次 Tab 条 render 叠加 listener。
	 */
	private bindSettingsSearchListener(): void {
		if (this.searchListenerBound) {
			return;
		}
		const modal = this.containerEl?.closest?.('.modal-container');
		if (!modal) {
			return;
		}
		const input =
			modal.querySelector<HTMLInputElement>('.vertical-tab-header input') ??
			modal.querySelector<HTMLInputElement>('.search-input-container input');
		if (!input) {
			return;
		}
		this.searchListenerBound = true;
		input.addEventListener('input', () => {
			this.update();
		});
	}

	/**
	 * Tab 内容区静态 class — 仅作样式钩子,不承担显隐。
	 *
	 * @param tab - 所属顶栏 Tab
	 * @returns group.cls 字符串
	 */
	private panelCls(tab: SettingsUiTab): string {
		return `ratel-settings-panel ratel-settings-panel-${tab}`;
	}

	/**
	 * 当前是否应显示某 Tab 的内容区。
	 *
	 * 关键路径:用声明式 `visible` 而非 CSS `is-hidden`。
	 * Obsidian `refreshDomState`/`update` 会重算 `visible`,但**不会**可靠更新 `cls`,
	 * 用 is-hidden 会导致「Tab 条/诊断变了、主内容区不动」。
	 * 搜索激活时全部 visible=true,仍可进全局搜索(见 SettingDefinitionBase.visible)。
	 *
	 * @param tab - 所属顶栏 Tab
	 */
	private isPanelVisible(tab: SettingsUiTab): boolean {
		return this.isSettingsSearchActive() || this.isSettingsTab(tab);
	}

	/**
	 * 声明式设置定义 — Obsidian 1.13.0 起替代 display()。
	 *
	 * 关键路径:框架根据此返回值自动渲染设置面板;
	 * Tab 用 `visible` 切换内容区;embedProvider 等条件项仍用 visible();
	 * action/render 处理命令式逻辑。
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		const settings = this.plugin.settings;
		const chatCls = this.panelCls('chat');
		const indexCls = this.panelCls('index');
		const agentCls = this.panelCls('agent');
		const appearanceCls = this.panelCls('appearance');
		const chatVisible = () => this.isPanelVisible('chat');
		const indexVisible = () => this.isPanelVisible('index');
		const agentVisible = () => this.isPanelVisible('agent');
		const appearanceVisible = () => this.isPanelVisible('appearance');
		const advancedVisible = () => this.isPanelVisible('advanced');

		return [
			// ==================== 顶栏 Tab 条 ====================
			{
				type: 'group',
				cls: 'ratel-settings-tab-group',
				items: [
					{
						name: tNow('settings.tabs.strip'),
						searchable: false,
						render: (setting) => {
							this.bindSettingsSearchListener();
							const el = setting.settingEl;
							el.empty();
							el.addClass('ratel-settings-tab-strip');
							// 搜索展开全部分组时隐藏 Tab 条,避免与「扁平命中列表」抢注意力
							if (this.isSettingsSearchActive()) {
								el.hide();
								return;
							}
							el.show();
							const bar = el.createDiv({ cls: 'ratel-diag-tabs' });
							// 关键路径:id 从 SETTINGS_UI_TABS 派生,消除与 focusTab 校验的手写重复
							const tabs: Array<{ id: SettingsUiTab; labelKey: StringKey }> = SETTINGS_UI_TABS.map(
								(id) => ({ id, labelKey: SETTINGS_TAB_LABEL_KEYS[id] }),
							);
							for (const tab of tabs) {
								const active = this.activeSettingsTab === tab.id;
								const btn = bar.createEl('button', {
									text: tNow(tab.labelKey),
									cls: 'ratel-diag-tab' + (active ? ' ratel-diag-tab-active' : ''),
									attr: {
										type: 'button',
										role: 'tab',
										'aria-selected': active ? 'true' : 'false',
									},
								});
								btn.onclick = () => {
									this.activeSettingsTab = tab.id;
									// 立即切换按钮态,避免等整页重绘才变
									for (const child of Array.from(bar.children)) {
										const isActive = child === btn;
										child.classList.toggle('ratel-diag-tab-active', isActive);
										child.setAttribute('aria-selected', isActive ? 'true' : 'false');
									}
									// 关键路径:visible 谓词用 refreshDomState 即可,比 update() 轻,也避免诊断 page 整页闪烁
									this.refreshDomState();
								};
							}
						},
					},
				],
			},

			// ==================== Tab:对话模型 ====================
			{
				type: 'group',
				heading: tNow('settings.language.heading'),
				cls: chatCls,
				visible: chatVisible,
				items: [
					{
						name: tNow('settings.language.name'),
						desc: tNow('settings.language.desc'),
						control: {
							type: 'dropdown',
							key: 'language',
							options: {
								auto: tNow('settings.language.option.auto'),
								zh: tNow('settings.language.option.zh'),
								en: tNow('settings.language.option.en'),
							},
						},
					},
				],
			},
			{
				type: 'group',
				heading: tNow('settings.chatModel.heading'),
				cls: chatCls,
				visible: chatVisible,
				items: [
					{
						name: tNow('settings.chatProfiles.heading'),
						render: renderChatProfiles(this.app, this.plugin),
					},
					{
						name: tNow('settings.advanced.secretHint.title'),
						render: renderChatSecretHint(this.app, this.plugin),
					},
					{
						name: tNow('settings.autoCompactEnabled.name'),
						desc: tNow('settings.autoCompactEnabled.desc'),
						control: { type: 'toggle', key: 'autoCompactEnabled' },
					},
				],
			},

			// ==================== Tab:笔记索引 ====================
			{
				type: 'group',
				heading: tNow('settings.embedding.heading'),
				cls: indexCls,
				visible: indexVisible,
				items: [
					{
						name: tNow('settings.embedding.provider.name'),
						desc: tNow('settings.embedding.provider.desc'),
						control: {
							type: 'dropdown',
							key: 'embedProvider',
							options: {
								local: tNow('settings.embedding.provider.option.local'),
								api: tNow('settings.embedding.provider.option.api'),
							},
						},
					},
					{
						name: tNow('settings.embedding.localModel.name'),
						desc: tNow('settings.embedding.localModel.desc'),
						control: {
							type: 'text',
							key: 'embedLocalModel',
							disabled: true,
						},
						visible: () => settings.embedProvider === 'local',
					},
					{
						name: tNow('settings.embedding.apiBase.name'),
						control: {
							type: 'text',
							key: 'embedApiBase',
							placeholder: 'http://localhost:11434/v1',
						},
						visible: () => settings.embedProvider === 'api',
					},
					{
						name: tNow('settings.advanced.secretHint.title'),
						render: renderEmbedSecretHint(this.app, this.plugin),
						visible: () => settings.embedProvider === 'api',
					},
					{
						name: tNow('settings.embedding.apiModel.name'),
						control: {
							type: 'text',
							key: 'embedApiModel',
							placeholder: 'bge-m3',
						},
						visible: () => settings.embedProvider === 'api',
					},
				],
			},
			{
				type: 'group',
				heading: tNow('settings.indexing.heading'),
				cls: indexCls,
				visible: indexVisible,
				items: [
					{
						name: tNow('settings.indexing.chunkSize.name'),
						control: {
							type: 'slider',
							key: 'chunkSize',
							min: 100,
							max: 1000,
							step: 50,
						},
					},
					{
						name: tNow('settings.indexing.chunkOverlap.name'),
						control: {
							type: 'slider',
							key: 'chunkOverlap',
							min: 0,
							max: 200,
							step: 10,
						},
					},
					{
						name: tNow('settings.indexing.autoIndex.name'),
						desc: tNow('settings.indexing.autoIndex.desc'),
						control: { type: 'toggle', key: 'autoIndex' },
					},
				],
			},
			{
				type: 'group',
				heading: tNow('settings.reranker.heading'),
				cls: indexCls,
				visible: indexVisible,
				items: [
					{
						name: tNow('settings.reranker.apiBase.name'),
						control: { type: 'text', key: 'rerankerApiBase' },
					},
					{
						name: tNow('settings.reranker.model.name'),
						control: { type: 'text', key: 'rerankerModel' },
					},
					{
						name: tNow('settings.advanced.secretHint.title'),
						render: renderRerankSecretHint(this.app, this.plugin),
					},
				],
			},

			// ==================== Tab:记忆与权限 ====================
			{
				type: 'group',
				heading: tNow('settings.goal.heading'),
				cls: agentCls,
				visible: agentVisible,
				items: [
					{
						name: tNow('settings.goal.maxRounds.name'),
						desc: tNow('settings.goal.maxRounds.desc'),
						control: { type: 'number', key: 'goalMaxRounds', min: 1, max: 100 },
					},
					{
						name: tNow('settings.goal.roundTokenSoftCap.name'),
						desc: tNow('settings.goal.roundTokenSoftCap.desc'),
						control: { type: 'number', key: 'goalRoundTokenSoftCap', min: 0, max: 500000 },
					},
					{
						name: tNow('settings.goal.archiveDays.name'),
						desc: tNow('settings.goal.archiveDays.desc'),
						control: { type: 'number', key: 'goalArchiveDays', min: 1, max: 365 },
					},
					{
						name: tNow('goal.settings.openManage.name'),
						desc: tNow('goal.settings.openManage.desc'),
						action: () => this.plugin.openGoalManageModal(),
					},
				],
			},
			{
				type: 'group',
				heading: tNow('memory.settings.heading'),
				cls: agentCls,
				visible: agentVisible,
				items: [
					{
						name: tNow('memory.settings.enabled.name'),
						desc: tNow('memory.settings.enabled.desc'),
						control: { type: 'toggle', key: 'memoryEnabled' },
					},
					{
						name: tNow('memory.settings.autoWrite.name'),
						desc: tNow('memory.settings.autoWrite.desc'),
						control: { type: 'toggle', key: 'memoryAutoWrite' },
					},
					{
						name: tNow('memory.settings.viewMemory.name'),
						desc: tNow('memory.settings.viewMemory.desc'),
						action: () => this.plugin.openMemoryModal(),
					},
				],
			},
			{
				type: 'group',
				heading: tNow('settings.daily.heading'),
				cls: agentCls,
				visible: agentVisible,
				items: [
					{
						name: tNow('settings.daily.folder.name'),
						desc: tNow('settings.daily.folder.desc'),
						control: { type: 'text', key: 'dailyNoteFolder', placeholder: '' },
					},
					{
						name: tNow('settings.daily.format.name'),
						desc: tNow('settings.daily.format.desc'),
						control: { type: 'text', key: 'dailyNoteFormat', placeholder: 'YYYY-MM-DD' },
					},
				],
			},
			{
				type: 'group',
				cls: agentCls,
				visible: agentVisible,
				items: [
					{
						name: tNow('settings.hostAccess.name'),
						desc: tNow('settings.hostAccess.desc'),
						control: { type: 'toggle', key: 'hostAccessEnabled' },
					},
				],
			},
			// S-CHAT-SETUP(CS-07):工具权限收进二级页 — 主页只留入口,
			// 页内仍是权限档位 + 每个工具允许/询问/拒绝(含 MCP 工具),字段不减
			buildToolPermissionsSettingPage(this.plugin, agentVisible),
			{
				type: 'group',
				cls: agentCls,
				visible: agentVisible,
				items: [
					{
						name: tNow('settings.mcp.openManage'),
						desc: tNow('settings.mcp.openManage.desc'),
						action: () => {
							this.plugin.openMcpManageModal();
						},
					},
				],
			},

			// ==================== Tab:外观 ====================
			{
				type: 'group',
				heading: tNow('settings.appearance.heading'),
				cls: appearanceCls,
				visible: appearanceVisible,
				items: [
					{
						name: tNow('settings.appearance.previewLabel'),
						searchable: true,
						render: (setting) => {
							const el = setting.settingEl;
							el.empty();
							renderAppearanceSettings(el, this);
						},
					},
					{
						name: tNow('settings.chatNavRailEnabled.name'),
						desc: tNow('settings.chatNavRailEnabled.desc'),
						control: { type: 'toggle', key: 'chatNavRailEnabled' },
					},
					{
						name: tNow('settings.chatMotionEnabled.name'),
						desc: tNow('settings.chatMotionEnabled.desc'),
						control: { type: 'toggle', key: 'chatMotionEnabled' },
					},
					{
						name: tNow('settings.chatMascotEnabled.name'),
						desc: tNow('settings.chatMascotEnabled.desc'),
						control: { type: 'toggle', key: 'chatMascotEnabled' },
					},
					{
						name: tNow('settings.chatNavRailSide.name'),
						desc: tNow('settings.chatNavRailSide.desc'),
						control: {
							type: 'dropdown',
							key: 'chatNavRailSide',
							options: {
								left: tNow('settings.chatNavRailSide.left'),
								right: tNow('settings.chatNavRailSide.right'),
							},
						},
					},
				],
			},

			// ==================== Tab:高级 ====================
			// S-CHAT-SETUP(CS-07):映射表、生态、提示词覆盖、记忆上限、开发者、诊断
			// 各占一个二级页 — 主页只留入口,页内控件与迁移前完全一致,返回由框架自带
			buildModelRegistrySettingPage(this, advancedVisible),
			buildEcosystemSettingPage(advancedVisible),
			buildPromptOverridesSettingPage(this, advancedVisible),
			buildMemoryLimitsSettingPage(advancedVisible),
			buildDeveloperSettingPage(advancedVisible),
			{
				type: 'page',
				name: tNow('settings.diagnostics.page.name'),
				desc: tNow('settings.diagnostics.page.desc'),
				// 关键路径:page 无 cls,只能用 visible;搜索中放开以免诊断入口在索引外
				visible: advancedVisible,
				page: () => new DiagnosticsSettingPage(this.app, this.plugin),
			},
		];
	}

	/**
	 * 读取 control 值 — override 处理嵌套 key。
	 *
	 * 关键路径:`toolPermissions.<name>` 与 `promptOverrides.<sectionId>` 不是直接字段,
	 * 默认实现 `this.plugin.settings[key]` 会读到 undefined,必须手动分发。
	 *
	 * @param key - control key,可能是 "chatModel" 或 "toolPermissions.search_vault"
	 * @returns 当前值
	 */
	getControlValue(key: string): unknown {
		if (key.startsWith('toolPermissions.')) {
			const toolName = key.slice('toolPermissions.'.length);
			const stored = this.plugin.settings.toolPermissions[toolName];
			if (stored != null) return stored;
			// 关键路径:动态 MCP 工具未写入 settings 时默认 ask,与 spec 一致
			if (toolName.startsWith('mcp__')) return 'ask';
			return stored;
		}
		if (key.startsWith('promptOverrides.')) {
			const sectionId = key.slice('promptOverrides.'.length);
			// 关键路径:OverrideMap 是 Partial<Record<PromptSectionId, string>>,
			// sectionId 是运行时 string,需 cast 为 Record<string,...> 才能用任意 string 索引。
			return (this.plugin.settings.promptOverrides as Record<string, string | undefined>)[sectionId];
		}
		return (this.plugin.settings as unknown as Record<string, unknown>)[key];
	}

	/**
	 * 写入 control 值并持久化 + 刷新 UI;写入与副作用逻辑在 settings-apply.ts(与 update_app_config 工具共享)。
	 *
	 * @param key - control key
	 * @param value - 新值
	 */
	async setControlValue(key: string, value: unknown): Promise<void> {
		// 关键路径:写入与副作用统一走 settings-apply(与 update_app_config 工具共享,防止两处漂移)
		await applySettingValue(this.plugin, key, value);
		// 刷新统一由 saveSettings 触发(面板交互必然 isConnected,此处再调 update 会同 tick 双重渲染)
		await this.plugin.saveSettings();
	}
}
