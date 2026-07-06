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
	type SettingDefinitionItem,
	type SettingGroupItem,
} from 'obsidian';
// 关键路径:RatelVaultPlugin 仅作类型标注使用,用 import type 避免运行时拉起 main.ts
// (main.ts 会载入 ChatView.svelte,在 vitest 环境无 svelte 插件无法解析)
import type RatelVaultPlugin from './main';
import { devLogger } from './logging/dev-logger';
// 关键路径:声明式 settings 每次渲染重新调用 tNow,无需 store 订阅;applyLangPreference 用于 Language 下拉切换
import { tNow, applyLangPreference, type LangPreference, type StringKey } from './i18n';
import type { ToolPermission } from './core/tool-permissions';
import {
	hasChatApiKey,
	requiresChatApiKey,
	resolveChatApiKey,
} from './secrets/ratel-secrets';
import type { ContextLengthPresetId } from './ui/tokens/context-length-presets';
import {
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
	chatModel: string;
	chatApiBase: string;
	/** 模型上下文窗口上限(token) — StatusLine 上下文使用率计算 */
	chatModelMaxTokens: number;
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
	// 关键路径:Prompt section 级覆盖(来自 Composer registry);空对象 = 全部用 zh.ts 默认。
	promptOverrides: OverrideMap;
	trustMode: boolean;
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
	chatModel: 'deepseek-chat',
	chatApiBase: 'https://api.deepseek.com',
	contextLengthPreset: '256k',
	chatModelMaxTokens: 256_000,
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
	},
	// 关键路径:默认无任何 override,使用 zh.ts 内置中文模板。
	promptOverrides: {},
	trustMode: false,
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
 * - `getControlValue`/`setControlValue` override 处理嵌套 key 与副作用(rebuild/sync)
 * - 诊断 Tab 用 `SettingDefinitionPage` + `DiagnosticsSettingPage` 子类命令式渲染
 */
export class RatelVaultSettingTab extends PluginSettingTab {
	plugin: RatelVaultPlugin;

	constructor(app: App, plugin: RatelVaultPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * 声明式设置定义 — Obsidian 1.13.0 起替代 display()。
	 *
	 * 关键路径:框架根据此返回值自动渲染设置面板,visible() 控制条件项,
	 * action/render 回调处理命令式逻辑。删除所有 render* 私有方法。
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		const settings = this.plugin.settings;

		return [
			// ==================== General(语言) ====================
			{
				type: 'group',
				heading: tNow('settings.language.heading'),
				items: [
					{
						name: tNow('settings.language.name'),
						desc: tNow('settings.language.desc'),
						control: {
							type: 'dropdown',
							key: 'language',
							options: { auto: 'auto', zh: '中文', en: 'English' },
						},
					},
				],
			},

			// ==================== Chat ====================
			{
				type: 'group',
				heading: tNow('settings.chatModel.heading'),
				items: [
					{
						name: tNow('settings.chatModel.model.name'),
						desc: tNow('settings.chatModel.model.desc'),
						control: { type: 'text', key: 'chatModel', placeholder: 'deepseek-chat' },
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
				],
			},

			// ==================== Context length ====================
			{
				type: 'group',
				heading: tNow('settings.contextLength.heading'),
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

			// ==================== Advanced ====================
			{
				type: 'group',
				heading: tNow('settings.advanced.heading'),
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
					{
						name: tNow('settings.advanced.secretHint.title'),
						render: renderChatSecretHint(this.app, this.plugin),
					},
				],
			},

			// ==================== Embedding ====================
			{
				type: 'group',
				heading: tNow('settings.embedding.heading'),
				items: [
					{
						name: tNow('settings.embedding.provider.name'),
						desc: tNow('settings.embedding.provider.desc'),
						control: {
							type: 'dropdown',
							key: 'embedProvider',
							options: { local: 'Local (built-in)', api: 'API (external)' },
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

			// ==================== Reranker ====================
			{
				type: 'group',
				heading: tNow('settings.reranker.heading'),
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

			// ==================== Indexing ====================
			{
				type: 'group',
				heading: tNow('settings.indexing.heading'),
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

			// ==================== Tool permissions ====================
			{
				type: 'group',
				heading: tNow('settings.toolPermissions.heading'),
				items: this.buildToolPermissionItems(),
			},

			// ==================== Prompt overrides (advanced) ====================
			{
				type: 'group',
				heading: tNow('settings.promptOverrides.heading'),
				items: this.buildPromptOverrideItems(),
			},

			// ==================== Diagnostics (sub-page) ====================
			{
				type: 'page',
				name: tNow('settings.diagnostics.page.name'),
				desc: tNow('settings.diagnostics.page.desc'),
				page: () => new DiagnosticsSettingPage(this.app, this.plugin),
			},

			// ==================== Developer ====================
			{
				type: 'group',
				heading: tNow('settings.developer.heading'),
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
			};
			const key = map[toolName];
			return key ? tNow(key) : toolName;
		};
		const allTools = ['search_vault', 'read_note', 'grep', 'glob', 'list_files', 'write_note', 'append_note', 'edit_note', 'delete_note'];

		const items: SettingGroupItem[] = [
			{
				name: tNow('settings.developer.trustMode.name'),
				desc: tNow('settings.developer.trustMode.desc'),
				control: { type: 'toggle', key: 'trustMode' },
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
			return this.plugin.settings.toolPermissions[toolName];
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
		} else {
			(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		}

		// 副作用分发
		if (key === 'chatModel' || key === 'chatApiBase') {
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
