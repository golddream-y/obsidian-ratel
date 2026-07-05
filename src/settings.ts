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

const CONTEXT_LENGTH_PRESET_OPTIONS: Record<ContextLengthPresetId, string> = {
	'128k': '128k (128,000)',
	'200k': '200k (200,000)',
	'256k': '256k (256,000)',
	'1M': '1M (1,048,576)',
	custom: '自定义',
};

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
			// ==================== Chat ====================
			{
				type: 'group',
				heading: 'Chat model',
				items: [
					{
						name: 'Model',
						desc: 'Chat model identifier',
						control: { type: 'text', key: 'chatModel', placeholder: 'deepseek-chat' },
					},
					{
						name: 'API base URL',
						desc: 'Chat model API base URL',
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
				heading: 'Context length',
				items: [
					{
						name: 'Context length',
						desc: '模型上下文窗口上限。点击「获取推荐」将验证配置并从公开模型库填入推荐值。',
						control: {
							type: 'dropdown',
							key: 'contextLengthPreset',
							options: CONTEXT_LENGTH_PRESET_OPTIONS,
						},
					},
					{
						name: '获取推荐',
						action: (el) => void this.handleProbeContext(el),
					},
					{
						name: '自定义 token 数',
						desc: `范围 ${CUSTOM_TOKEN_MIN.toLocaleString()} – ${CUSTOM_TOKEN_MAX.toLocaleString()}`,
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
				heading: 'Advanced',
				items: [
					{
						name: '模型映射表 URL',
						desc: '留空使用 LiteLLM 默认源。可填企业镜像或 pin 版本地址。',
						control: {
							type: 'text',
							key: 'modelRegistryUrl',
							placeholder: DEFAULT_MODEL_REGISTRY_URL,
						},
					},
					{
						name: '恢复默认',
						action: () => {
							this.plugin.settings.modelRegistryUrl = '';
							void this.plugin.saveSettings().then(() => this.update());
						},
					},
					{
						name: 'Chat API Key',
						render: renderChatSecretHint(this.app, this.plugin),
					},
				],
			},

			// ==================== Embedding ====================
			{
				type: 'group',
				heading: 'Embedding model',
				items: [
					{
						name: 'Provider',
						desc: 'Local uses built-in ONNX model (zero-config). API uses OpenAI-compatible endpoint (Ollama/SiliconFlow/etc). 更改此项需重启 Obsidian 生效(下次启动 smartReindex 检测模型变化自动全量重建)。',
						control: {
							type: 'dropdown',
							key: 'embedProvider',
							options: { local: 'Local (built-in)', api: 'API (external)' },
						},
					},
					{
						name: 'Model',
						desc: '本地默认模型为 bge-small-zh-v1.5,首次启用时自动从 ModelScope 下载 ONNX 权重与词表。',
						control: {
							type: 'text',
							key: 'embedLocalModel',
							disabled: true,
						},
						visible: () => settings.embedProvider === 'local',
					},
					{
						name: 'API base URL',
						desc: 'Embedding API base URL (Ollama: http://localhost:11434/v1)',
						control: {
							type: 'text',
							key: 'embedApiBase',
							placeholder: 'http://localhost:11434/v1',
						},
						visible: () => settings.embedProvider === 'api',
					},
					{
						name: 'Embedding API Key',
						render: renderEmbedSecretHint(this.app, this.plugin),
						visible: () => settings.embedProvider === 'api',
					},
					{
						name: 'Model',
						desc: 'Embedding model identifier',
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
				heading: 'Reranker (百炼,可选)',
				items: [
					{
						name: 'API base URL',
						desc: 'Reranker API base URL(百炼 DashScope compatible-api)',
						control: { type: 'text', key: 'rerankerApiBase' },
					},
					{
						name: 'Model',
						desc: 'Reranker model identifier',
						control: { type: 'text', key: 'rerankerModel' },
					},
					{
						name: 'Rerank API Key',
						render: renderRerankSecretHint(this.app, this.plugin),
					},
				],
			},

			// ==================== Indexing ====================
			{
				type: 'group',
				heading: 'Indexing',
				items: [
					{
						name: 'Chunk size (tokens)',
						desc: 'Number of tokens per chunk. 更改此项需重启 Obsidian 生效(下次启动 smartReindex 检测参数变化自动全量重建)。',
						control: {
							type: 'slider',
							key: 'chunkSize',
							min: 100,
							max: 1000,
							step: 50,
						},
					},
					{
						name: 'Chunk overlap (tokens)',
						desc: 'Overlap between chunks. 更改此项需重启 Obsidian 生效(下次启动 smartReindex 检测参数变化自动全量重建)。',
						control: {
							type: 'slider',
							key: 'chunkOverlap',
							min: 0,
							max: 200,
							step: 10,
						},
					},
					{
						name: 'Auto index',
						desc: 'Automatically re-index on file changes',
						control: { type: 'toggle', key: 'autoIndex' },
					},
				],
			},

			// ==================== Tool permissions ====================
			{
				type: 'group',
				heading: 'Tool permissions',
				items: this.buildToolPermissionItems(),
			},

			// ==================== Prompt overrides (advanced) ====================
			{
				type: 'group',
				heading: 'Prompt overrides (advanced)',
				items: this.buildPromptOverrideItems(),
			},

			// ==================== Diagnostics (sub-page) ====================
			{
				type: 'page',
				name: 'Diagnostics',
				desc: '调试工具:验证 Embedding、LLM、Rerank 适配器是否正常工作',
				page: () => new DiagnosticsSettingPage(this.app, this.plugin),
			},

			// ==================== Developer ====================
			{
				type: 'group',
				heading: 'Developer',
				items: [
					{
						name: 'Debug 日志',
						desc: '在控制台输出 [Ratel:*] debug 级日志',
						control: { type: 'toggle', key: 'debugLog' },
					},
					{
						name: 'Agent 最大步数',
						desc: 'Agent Loop 工具调用循环上限,防止死循环',
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
		const labels: Record<string, string> = {
			search_vault: '语义搜索',
			read_note: '读取笔记',
			grep: '精确搜索',
			glob: '文件名匹配',
			list_files: '列目录',
			write_note: '创建/覆盖',
			append_note: '追加内容',
			edit_note: '精确替换',
			delete_note: '移到回收站',
		};
		const allTools = ['search_vault', 'read_note', 'grep', 'glob', 'list_files', 'write_note', 'append_note', 'edit_note', 'delete_note'];

		const items: SettingGroupItem[] = [
			{
				name: '信任模式',
				desc: '开启后所有工具直接执行,不再弹出确认对话框',
				control: { type: 'toggle', key: 'trustMode' },
			},
		];

		for (const name of allTools) {
			items.push({
				name: labels[name] ?? name,
				desc: name,
				control: {
					type: 'dropdown',
					key: `toolPermissions.${name}`,
					options: { allow: '允许', ask: '询问', deny: '拒绝' },
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
				name: '说明',
				desc: '按段落自定义 LLM 系统提示词。检索结果安全外框不可编辑。',
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
			name: '预览',
			desc: '使用当前工具列表与 overrides 合成(点击后弹出模态框)',
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
			new Notice('请先在钥匙串配置 Chat API 密钥', 5000);
			return;
		}
		const originalText = btnEl.textContent ?? '获取推荐';
		btnEl.textContent = '获取中…';
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
			new Notice(`✗ ${result.error}`, 5000);
			return;
		}

		if (result.recommendedTokens != null) {
			const applied = applyContextRecommendation(result.recommendedTokens);
			await this.setControlValue('contextLengthPreset', applied.preset);
			await this.setControlValue('chatModelMaxTokens', applied.chatModelMaxTokens);
			new Notice(
				`✓ 已获取推荐:${result.recommendedTokens.toLocaleString()} tokens`,
				4000,
			);
		} else {
			new Notice('✓ 配置有效,但模型库未命中推荐值,请手动选择或填写', 5000);
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

		await this.plugin.saveSettings();
		this.update();
	}
}
