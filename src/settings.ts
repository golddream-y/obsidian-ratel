/**
 * @file src/settings.ts
 * @description Ratel Vault 设置项定义 + Obsidian 设置面板渲染
 * @module settings
 * @depends obsidian, ./main
 */

import {
	App,
	Notice,
	PluginSettingTab,
	Setting,
	type SettingDefinitionItem,
	type SettingGroupItem,
} from 'obsidian';
// 关键路径:RatelVaultPlugin 仅作类型标注使用,用 import type 避免运行时拉起 main.ts
// (main.ts 会载入 ChatView.svelte,在 vitest 环境无 svelte 插件无法解析)
import type RatelVaultPlugin from './main';
import { devLogger } from './logging/dev-logger';
// 关键路径:声明式 settings 每次渲染重新调用 tNow,无需 store 订阅;applyLangPreference 用于 Language 下拉切换
import { tNow, applyLangPreference, type LangPreference, type StringKey } from './i18n';
import type { ToolPermission, ToolPermissionLevel } from './core/tool-permissions';
import {
	hasChatApiKey,
	requiresChatApiKey,
	resolveChatApiKey,
} from './secrets/ratel-secrets';
import type { ContextLengthPresetId } from './ui/tokens/context-length-presets';
import {
	applyContextLengthPreset,
	applyContextRecommendation,
	CUSTOM_TOKEN_MAX,
	CUSTOM_TOKEN_MIN,
	inferPresetFromTokens,
	presetToTokens,
} from './ui/tokens/context-length-presets';
import { DEFAULT_MODEL_REGISTRY_URL } from './ui/tokens/model-context-registry';
import { probeChatConnection } from './ui/tokens/probe-model';
import type { OverrideMap } from './prompts/types';
import { listEditableSections } from './prompts';
// 关键路径:声明式 settings 子页面与 render wrapper
import { DiagnosticsSettingPage } from './ui/settings/diagnostics-setting-page';
import {
	renderChatSecretHint,
	renderEmbedSecretHint,
	renderRerankSecretHint,
} from './ui/settings/secret-hint-render';
import {
	renderPromptOverrideSection,
	renderPromptPreviewButton,
} from './ui/settings/prompt-override-render';
import {
	applyChatPreset,
	type ChatPresetId,
} from './settings/chat-preset';
// 关键路径:外观类型从 presets 导入,避免 appearance-presets ↔ settings 循环依赖
import type { UiAccentId, UiColorScheme } from './ui/appearance/appearance-presets';
import { renderAppearanceSettings } from './ui/appearance/appearance-settings-render';
import type { McpServerConfig } from './ports/mcp';
import { parseMcpToolName } from './ui/mcp/parse-mcp-tool-name';

/** 设置顶栏 Tab ID(仅 UI 态,不落盘) */
export type SettingsUiTab = 'chat' | 'index' | 'agent' | 'appearance' | 'advanced';

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
	/** Agent Loop 最大步数上限 — 防止工具调用死循环,默认 50(见 ADR-004) */
	agentMaxSteps: number;

	// Tool permissions (S-VAULT-TOOLS)
	toolPermissions: Record<string, ToolPermission>;
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
	// 关键路径(P-SKILL-1-CORE):Skill 机制总开关,false 时 Agent 不加载 skill。
	enableSkills: boolean;

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

	/** MCP Server 列表；默认空 = 零出站 */
	mcpServers: McpServerConfig[];
	/** 用户已确认允许 spawn 的 stdio serverId 列表 */
	mcpApprovedSpawns: string[];
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
	// 关键路径:50 步覆盖知识库场景(1 glob + N read + 分析 + write),见 ADR-004。
	agentMaxSteps: 50,

	toolPermissions: {
		search_vault: 'allow',
		read_note: 'allow',
		grep: 'allow',
		glob: 'allow',
		list_files: 'allow',
		write_note: 'ask',
		append_note: 'ask',
		edit_note: 'ask',
		delete_note: 'ask',
		// 关键路径:3 个 memory 工具 — search_memory 只读放行;remember / forget_memory 写操作需确认。
		search_memory: 'allow',
		remember: 'ask',
		forget_memory: 'ask',
		// 关键路径:2 个 skill 工具只读放行(不写文件,只改 system prompt)。
		activate_skill: 'allow',
		deactivate_skill: 'allow',
		// 关键路径(P-BASIC-ENV):环境感知工具只读放行。
		get_datetime: 'allow',
		get_active_note: 'allow',
		get_daily_note: 'allow',
		list_recent_notes: 'allow',
		get_note_outline: 'allow',
		// 关键路径:图谱读侧工具只读放行。
		get_links: 'allow',
		search_by_tag: 'allow',
		search_by_property: 'allow',
		get_vault_structure: 'allow',
	},
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
	// 关键路径:默认启用 skill 机制,让用户零感知 Discovery 注入。
	enableSkills: true,
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
	// 关键路径:默认空列表 = 零 MCP 出站（ADR-014）
	mcpServers: [],
	mcpApprovedSpawns: [],
};

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
	} else if (settings.chatModelMaxTokens <= 0) {
		const inferred = inferPresetFromTokens(0);
		settings.contextLengthPreset = inferred.preset;
		settings.chatModelMaxTokens = inferred.chatModelMaxTokens;
	}
	return settings;
}

// 关键路径:封装为函数,每次 getSettingDefinitions 调用时重新求值 tNow,语言切换后立即生效
function contextLengthPresetOptions(): Record<ContextLengthPresetId, string> {
	return {
		'128k': '128k (128,000)',
		'200k': '200k (200,000)',
		'256k': '256k (256,000)',
		'1M': '1M (1,048,576)',
		custom: tNow('settings.contextLength.preset.custom'),
	};
}

/**
 * Obsidian 设置面板 — 把 `RatelVaultSettings` 渲染为分组表单。
 *
 * 设计要点:
 * - 1.13.0 起用 `getSettingDefinitions()` 声明式 API,删除 deprecated `display()`
 * - 顶栏四 Tab(对话模型 / 笔记索引 / 记忆与权限 / 高级)用声明式 `visible` 切换,
 *   搜索激活时全部展开;不用 CSS is-hidden(Obsidian 不随 refresh 更新 cls)
 * - `getControlValue`/`setControlValue` override 处理嵌套 key 与副作用(rebuild/sync)
 * - 诊断放在「高级」末尾的 `SettingDefinitionPage`
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
		const advancedCls = this.panelCls('advanced');
		const chatVisible = () => this.isPanelVisible('chat');
		const indexVisible = () => this.isPanelVisible('index');
		const agentVisible = () => this.isPanelVisible('agent');
		const appearanceVisible = () => this.isPanelVisible('appearance');
		const advancedVisible = () => this.isPanelVisible('advanced');
		const onAdvancedOrSearch = () => this.isPanelVisible('advanced');

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
							const tabs: Array<{ id: SettingsUiTab; labelKey: StringKey }> = [
								{ id: 'chat', labelKey: 'settings.tabs.chat' },
								{ id: 'index', labelKey: 'settings.tabs.index' },
								{ id: 'agent', labelKey: 'settings.tabs.agent' },
								{ id: 'appearance', labelKey: 'settings.tabs.appearance' },
								{ id: 'advanced', labelKey: 'settings.tabs.advanced' },
							];
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
				heading: tNow('settings.chatPreset.heading'),
				cls: chatCls,
				visible: chatVisible,
				items: [
					{
						name: tNow('settings.chatPreset.name'),
						desc: tNow('settings.chatPreset.desc'),
						control: {
							type: 'dropdown',
							key: 'chatPreset',
							options: {
								deepseek: tNow('settings.chatPreset.deepseek'),
								ollama: tNow('settings.chatPreset.ollama'),
								custom: tNow('settings.chatPreset.custom'),
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
						name: tNow('settings.chatModel.model.name'),
						desc: tNow('settings.chatModel.model.desc'),
						control: { type: 'text', key: 'chatModel', placeholder: 'deepseek-v4-flash' },
					},
					{
						name: tNow('settings.chatModel.apiBase.name'),
						desc: tNow('settings.chatModel.apiBase.desc'),
						control: {
							type: 'text',
							key: 'chatApiBase',
							placeholder: 'https://api.deepseek.com',
						},
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
				heading: tNow('skill.settings.heading'),
				cls: agentCls,
				visible: agentVisible,
				items: [
					{
						name: tNow('skill.settings.enableSkills.name'),
						desc: tNow('skill.settings.enableSkills.desc'),
						control: { type: 'toggle', key: 'enableSkills' },
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
				heading: tNow('settings.toolPermissions.heading'),
				cls: agentCls,
				visible: agentVisible,
				items: this.buildToolPermissionItems(),
			},
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
			{
				type: 'group',
				heading: tNow('settings.contextLength.heading'),
				cls: advancedCls,
				visible: advancedVisible,
				items: [
					{
						name: tNow('settings.contextLength.dropdown.name'),
						desc: tNow('settings.contextLength.dropdown.desc'),
						control: {
							type: 'dropdown',
							key: 'contextLengthPreset',
							options: contextLengthPresetOptions(),
						},
					},
					{
						name: tNow('settings.contextLength.probeButton'),
						action: (el) => void this.handleProbeContext(el),
					},
					{
						name: tNow('settings.contextLength.customTokens.name'),
						desc: tNow('settings.contextLength.customTokens.desc'),
						control: {
							type: 'number',
							key: 'chatModelMaxTokens',
							min: CUSTOM_TOKEN_MIN,
							max: CUSTOM_TOKEN_MAX,
						},
						visible: () => this.plugin.settings.contextLengthPreset === 'custom',
					},
				],
			},
			{
				type: 'group',
				heading: tNow('settings.advanced.heading'),
				cls: advancedCls,
				visible: advancedVisible,
				items: [
					{
						name: tNow('settings.advanced.registryUrl.name'),
						desc: tNow('settings.advanced.registryUrl.desc'),
						control: {
							type: 'text',
							key: 'modelRegistryUrl',
							placeholder: DEFAULT_MODEL_REGISTRY_URL,
						},
					},
					{
						name: tNow('settings.advanced.resetButton'),
						action: () => {
							this.plugin.settings.modelRegistryUrl = '';
							void this.plugin.saveSettings().then(() => this.update());
						},
					},
				],
			},
			{
				type: 'group',
				heading: tNow('settings.promptOverrides.heading'),
				cls: advancedCls,
				visible: advancedVisible,
				items: this.buildPromptOverrideItems(),
			},
			{
				type: 'group',
				heading: tNow('memory.settings.limitsHeading'),
				cls: advancedCls,
				visible: advancedVisible,
				items: [
					{
						name: tNow('memory.settings.storageLimit.name'),
						desc: tNow('memory.settings.storageLimit.desc'),
						control: { type: 'number', key: 'memoryStorageLimitMB', min: 1, max: 1000 },
					},
					{
						name: tNow('memory.settings.injectLimit.name'),
						desc: tNow('memory.settings.injectLimit.desc'),
						control: { type: 'number', key: 'memoryInjectLimitKB', min: 1, max: 500 },
					},
					{
						name: tNow('memory.settings.dynamicLimit.name'),
						desc: tNow('memory.settings.dynamicLimit.desc'),
						control: { type: 'number', key: 'memoryDynamicLimitKB', min: 1, max: 500 },
					},
					{
						name: tNow('memory.settings.contextTotalLimit.name'),
						desc: tNow('memory.settings.contextTotalLimit.desc'),
						control: { type: 'number', key: 'memoryContextTotalLimitKB', min: 1, max: 500 },
					},
				],
			},
			{
				type: 'group',
				heading: tNow('settings.developer.heading'),
				cls: advancedCls,
				visible: advancedVisible,
				items: [
					{
						name: tNow('settings.developer.debugLog.name'),
						control: { type: 'toggle', key: 'debugLog' },
					},
					{
						name: tNow('settings.developer.agentMaxSteps.name'),
						desc: tNow('settings.developer.agentMaxSteps.desc'),
						control: {
							type: 'slider',
							key: 'agentMaxSteps',
							min: 5,
							max: 200,
							step: 5,
						},
					},
				],
			},
			{
				type: 'page',
				name: tNow('settings.diagnostics.page.name'),
				desc: tNow('settings.diagnostics.page.desc'),
				// 关键路径:page 无 cls,只能用 visible;搜索中放开以免诊断入口在索引外
				visible: onAdvancedOrSearch,
				page: () => new DiagnosticsSettingPage(this.app, this.plugin),
			},
		];
	}

	/**
	 * 构建 Tool permissions group 的 items。
	 *
	 * 关键路径:信任模式 toggle + 9 个工具 dropdown,
	 * key 用 `toolPermissions.<name>` 嵌套格式,getControlValue/setControlValue 会分发。
	 */
	private buildToolPermissionItems(): SettingGroupItem[] {
		// 关键路径:工具名 → i18n key 映射,tNow 运行时读取当前语言
		const labelByKey = (toolName: string): string => {
			const map: Record<string, StringKey> = {
			search_vault: 'settings.toolPermissions.search_vault',
			read_note: 'settings.toolPermissions.read_note',
			grep: 'settings.toolPermissions.grep',
			glob: 'settings.toolPermissions.glob',
			list_files: 'settings.toolPermissions.list_files',
			write_note: 'settings.toolPermissions.write_note',
			append_note: 'settings.toolPermissions.append_note',
			edit_note: 'settings.toolPermissions.edit_note',
			delete_note: 'settings.toolPermissions.delete_note',
			// 关键路径:3 个 memory 工具友好名(与 ui.tool_name.* 区分,这是设置面板的权限标签)
			search_memory: 'settings.toolPermissions.search_memory',
			remember: 'settings.toolPermissions.remember',
			forget_memory: 'settings.toolPermissions.forget_memory',
			activate_skill: 'settings.toolPermissions.activate_skill',
			deactivate_skill: 'settings.toolPermissions.deactivate_skill',
			get_datetime: 'settings.toolPermissions.get_datetime',
			get_active_note: 'settings.toolPermissions.get_active_note',
			get_daily_note: 'settings.toolPermissions.get_daily_note',
			list_recent_notes: 'settings.toolPermissions.list_recent_notes',
			get_note_outline: 'settings.toolPermissions.get_note_outline',
			get_links: 'settings.toolPermissions.get_links',
			search_by_tag: 'settings.toolPermissions.search_by_tag',
			search_by_property: 'settings.toolPermissions.search_by_property',
			get_vault_structure: 'settings.toolPermissions.get_vault_structure',
		};
		const key = map[toolName];
		return key ? tNow(key) : toolName;
	};
		const allTools = [
			'search_vault', 'read_note', 'grep', 'glob', 'list_files',
			'write_note', 'append_note', 'edit_note', 'delete_note',
			'search_memory', 'remember', 'forget_memory',
			'activate_skill', 'deactivate_skill',
			'get_datetime', 'get_active_note', 'get_daily_note', 'list_recent_notes', 'get_note_outline',
			'get_links', 'search_by_tag', 'search_by_property', 'get_vault_structure',
		];

		const items: SettingGroupItem[] = [
			{
				name: tNow('settings.toolPermissionLevel.name'),
				desc: tNow('settings.toolPermissionLevel.desc'),
				control: {
					type: 'dropdown',
					key: 'toolPermissionLevel',
					options: {
						safe: tNow('settings.toolPermissionLevel.safe'),
						auto: tNow('settings.toolPermissionLevel.auto'),
						danger: tNow('settings.toolPermissionLevel.danger'),
					},
				},
			},
		];

		for (const name of allTools) {
			items.push({
				name: labelByKey(name),
				desc: name,
				control: {
					type: 'dropdown',
					key: `toolPermissions.${name}`,
					options: {
						allow: tNow('settings.toolPermissions.allow'),
						ask: tNow('settings.toolPermissions.ask'),
						deny: tNow('settings.toolPermissions.deny'),
					},
				},
			});
		}

		const mcpToolNames = (this.plugin.tools?.definitions() ?? [])
			.map((d) => d.name)
			.filter((name) => name.startsWith('mcp__'))
			.sort();

		if (mcpToolNames.length > 0) {
			items.push({
				name: tNow('settings.toolPermissions.mcpSection'),
				searchable: false,
				render: (setting) => {
					new Setting(setting.settingEl)
						.setName(tNow('settings.toolPermissions.mcpSection'))
						.setHeading();
				},
			});

			const permissionOptions = {
				allow: tNow('settings.toolPermissions.allow'),
				ask: tNow('settings.toolPermissions.ask'),
				deny: tNow('settings.toolPermissions.deny'),
			};

			for (const name of mcpToolNames) {
				const parsed = parseMcpToolName(name);
				const label = parsed
					? `${parsed.serverId} · ${parsed.toolName}`
					: name;
				items.push({
					name: label,
					desc: name,
					control: {
						type: 'dropdown',
						key: `toolPermissions.${name}`,
						options: permissionOptions,
					},
				});
			}
		}

		return items;
	}

	/**
	 * 构建 Prompt overrides group 的 items。
	 *
	 * 关键路径:
	 * - 说明段用 SettingDefinitionEmpty(只有 name + desc)
	 * - 每个 section 用 SettingDefinitionRender,内部 toggle + textarea + warn + 恢复按钮
	 * - 预览按钮用 SettingDefinitionRender(内部 new Setting + addButton)
	 */
	private buildPromptOverrideItems(): SettingGroupItem[] {
		const items: SettingGroupItem[] = [
			{
				name: tNow('settings.promptOverrides.instructions'),
				desc: tNow('settings.promptOverrides.instructionsDesc'),
			},
		];

		for (const meta of listEditableSections()) {
			items.push({
				name: `${meta.label} (${meta.zone})`,
				desc: meta.description,
				render: renderPromptOverrideSection(this, this.plugin, meta),
			});
		}

		items.push({
			name: tNow('settings.promptOverrides.previewButton'),
			desc: tNow('settings.promptOverrides.previewDesc'),
			render: renderPromptPreviewButton(this.plugin),
		});

		return items;
	}

	/**
	 * 处理「获取推荐」按钮点击。
	 *
	 * 关键路径:发送 probe 请求,成功后 setControlValue + update。
	 *
	 * @param btnEl - action 行元素,用于显示「获取中…」加载态
	 */
	private async handleProbeContext(btnEl: HTMLElement): Promise<void> {
		if (
			requiresChatApiKey(this.plugin.settings) &&
			!hasChatApiKey(this.app, this.plugin.settings)
		) {
			new Notice(tNow('settings.notice.noChatKey'), 5000);
			return;
		}
		const originalText = btnEl.textContent ?? tNow('settings.contextLength.probeButton');
		btnEl.textContent = tNow('settings.contextLength.probeLoading');
		btnEl.setAttribute('disabled', 'true');

		const registryUrl = this.plugin.settings.modelRegistryUrl || DEFAULT_MODEL_REGISTRY_URL;
		const result = await probeChatConnection({
			apiBase: this.plugin.settings.chatApiBase,
			apiKey: resolveChatApiKey(this.app, this.plugin.settings) ?? '',
			model: this.plugin.settings.chatModel,
			registry: this.plugin.modelContextRegistry,
			registryUrl,
		});

		btnEl.textContent = originalText;
		btnEl.removeAttribute('disabled');

		if (!result.ok) {
			new Notice(tNow('settings.notice.probeFailed', { message: result.error }), 5000);
			return;
		}

		if (result.recommendedTokens != null) {
			const applied = applyContextRecommendation(result.recommendedTokens);
			await this.setControlValue('contextLengthPreset', applied.preset);
			await this.setControlValue('chatModelMaxTokens', applied.chatModelMaxTokens);
			new Notice(
				tNow('settings.notice.probeSuccess', { value: `${result.recommendedTokens.toLocaleString()} tokens` }),
				4000,
			);
		} else {
			new Notice(tNow('settings.notice.probeNoRecommendation'), 5000);
		}
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
	 * 写入 control 值并触发副作用 — override 处理嵌套 key + rebuild/sync。
	 *
	 * 关键路径:
	 * - 嵌套 key 必须分发到嵌套对象,否则会写入字面量字段 `settings["toolPermissions.xxx"]`
	 * - chatPreset 变更需 applyChatPreset(多字段)+rebuildLLM
	 * - contextLengthPreset 变更需同步 chatModelMaxTokens(抽屉读上限)
	 * - chatModel / chatApiBase 变更需 rebuildLLM
	 * - embed* 变更(除 embedLocalModel)需 rebuildEmbeddingAdapter
	 * - promptOverrides.* 变更需 syncToolDefinitions
	 * - debugLog 变更需 setDebugEnabled
	 * - 替代原 onChange 回调里散落的 this.display(),改用 this.update()
	 *
	 * @param key - control key
	 * @param value - 新值
	 */
	async setControlValue(key: string, value: unknown): Promise<void> {
		// 嵌套 key 分发
		if (key.startsWith('toolPermissions.')) {
			const toolName = key.slice('toolPermissions.'.length);
			this.plugin.settings.toolPermissions[toolName] = value as ToolPermission;
		} else if (key.startsWith('promptOverrides.')) {
			const sectionId = key.slice('promptOverrides.'.length);
			// 关键路径:OverrideMap 是 Partial<Record<PromptSectionId, string>>,
			// sectionId 是运行时 string,需 cast 为 Record<string,...> 才能用任意 string 索引。
			(this.plugin.settings.promptOverrides as Record<string, string | undefined>)[sectionId] = value as string;
			this.plugin.syncToolDefinitions();
		} else if (key === 'chatPreset') {
			// 关键路径:预设写入多字段,不能只赋 chatPreset 一个 key
			applyChatPreset(this.plugin.settings, value as ChatPresetId);
			this.plugin.rebuildLLM();
		} else if (key === 'contextLengthPreset') {
			// 修复:下拉只写 preset 时 chatModelMaxTokens 仍是旧值,抽屉上限不跟着变
			applyContextLengthPreset(this.plugin.settings, value as ContextLengthPresetId);
		} else if (key === 'toolPermissionLevel') {
			// 关键路径:仅接受三档枚举,防止 UI 写入非法字符串
			if (value === 'safe' || value === 'auto' || value === 'danger') {
				this.plugin.settings.toolPermissionLevel = value;
			}
		} else if (key === 'chatNavRailSide') {
			// 关键路径:仅接受 left|right,防止 UI 写入非法字符串
			if (value === 'left' || value === 'right') {
				this.plugin.settings.chatNavRailSide = value;
			}
		} else {
			(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		}

		// 副作用分发
		if (key === 'chatModel' || key === 'chatApiBase') {
			// 关键路径:手改模型或 Base → 场景预设自动切到 custom
			this.plugin.settings.chatPreset = 'custom';
			this.plugin.rebuildLLM();
		}
		// 关键路径:embedLocalModel 当前是只读字段(内置模型),不会触发 setControlValue,
		// 但保险起见排除,避免未来误触发 rebuild。
		if (key.startsWith('embed') && key !== 'embedLocalModel') {
			this.plugin.rebuildEmbeddingAdapter();
		}
		if (key === 'debugLog') {
			devLogger.setDebugEnabled(value as boolean);
		}
		// 关键路径:language 切换后立即应用,触发 langStore 更新,Svelte 组件自动重渲染
		if (key === 'language') {
			applyLangPreference(value as LangPreference);
		}

		await this.plugin.saveSettings();
		this.update();
	}
}
