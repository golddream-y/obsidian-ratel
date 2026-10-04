/**
 * @file src/secrets/ratel-secrets.ts
 * @description Obsidian 钥匙串 API Key 解析 — 固定 ratel-* 密钥名 + 端点分类 + resolve/has 函数
 * @module secrets/ratel-secrets
 * @depends obsidian
 */

import type { App } from 'obsidian';
import { devLogger } from '../logging/dev-logger';

// ==================== 固定密钥名常量 ====================

/**
 * 全部 ratel-* 密钥名常量。
 *
 * 设计要点:
 * - 用户在 Obsidian「设置 → 钥匙串」中按这些固定名称录入密钥
 * - chatOllama / embedOllama 为 v1 预留,当前不读取(本地 Ollama 免 Key)
 * - 密钥名不含厂商名,DeepSeek 等归入 openai-compatible
 */
export const RATEL_SECRET_IDS = {
	/** Chat — OpenAI 兼容端点(DeepSeek / OpenAI / 硅基流动 Chat 等) */
	chatOpenAICompatible: 'ratel-chat-openai-compatible',
	/** Chat — 远端 Ollama(v1 预留,暂不强制读取) */
	chatOllama: 'ratel-chat-ollama',
	/** Embedding API — OpenAI 兼容远端 */
	embedOpenAICompatible: 'ratel-embed-openai-compatible',
	/** Embedding API — 远端 Ollama(v1 预留) */
	embedOllama: 'ratel-embed-ollama',
	/** Rerank — 阿里云百炼 DashScope */
	rerankBailian: 'ratel-rerank-bailian',
} as const;

// ==================== 类型定义 ====================

/**
 * 端点认证类型。
 *
 * - `builtin`:本地 ONNX 内置模型,无需 Key
 * - `ollama-local`:localhost / 127.0.0.1 的 Ollama,v1 免 Key
 * - `openai-compatible`:OpenAI 兼容 HTTP API,需要钥匙串密钥
 * - `rerank-bailian`:阿里云百炼 Rerank,需要钥匙串密钥(无 Key 则关闭)
 */
export type EndpointAuthKind = 'builtin' | 'ollama-local' | 'openai-compatible' | 'rerank-bailian';

/** Chat 密钥相关设置字段(最小接口抽取,避免 import main) */
export interface ChatSecretSettings {
	chatApiBase: string;
	chatProfiles?: Array<{ id: string; allowLegacyKeyFallback?: boolean }>;
	activeChatProfileId?: string;
}

/** Embedding 密钥相关设置字段 */
export interface EmbedSecretSettings {
	embedProvider: 'local' | 'api';
	embedApiBase: string;
}

// ==================== 端点分类 ====================

/**
 * 判断 hostname 是否为本地 Ollama。
 *
 * 缺协议时补 `http://`,解析 URL 后比较 hostname。
 *
 * @param baseUrl - 用户配置的 API base URL
 * @returns `true` 表示 localhost 或 127.0.0.1
 */
export function isLocalHost(baseUrl: string): boolean {
	if (!baseUrl || !baseUrl.trim()) return false;
	try {
		const url = new URL(baseUrl.includes('://') ? baseUrl : `http://${baseUrl}`);
		return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
	} catch {
		return false;
	}
}

/**
 * 对 Chat 端点进行认证分类。
 *
 * @param settings - 含 chatApiBase 的设置片段
 * @returns `ollama-local`(本地)或 `openai-compatible`(远端)
 */
export function classifyChatEndpoint(settings: ChatSecretSettings): EndpointAuthKind {
	return isLocalHost(settings.chatApiBase) ? 'ollama-local' : 'openai-compatible';
}

/**
 * 对 Embedding 端点进行认证分类。
 *
 * @param settings - 含 embedProvider / embedApiBase 的设置片段
 * @returns `builtin`(本地 ONNX)/ `ollama-local`(API+本地)/ `openai-compatible`(API+远端)
 */
export function classifyEmbedEndpoint(settings: EmbedSecretSettings): EndpointAuthKind {
	if (settings.embedProvider === 'local') return 'builtin';
	if (isLocalHost(settings.embedApiBase)) return 'ollama-local';
	return 'openai-compatible';
}

// ==================== requires ====================

/**
 * Chat 是否需要钥匙串密钥。
 *
 * @returns `true` 表示端点为 openai-compatible,需要 Key
 */
export function requiresChatApiKey(settings: ChatSecretSettings): boolean {
	return classifyChatEndpoint(settings) === 'openai-compatible';
}

/**
 * Embedding 是否需要钥匙串密钥。
 *
 * @returns `true` 表示端点为 openai-compatible,需要 Key
 */
export function requiresEmbedApiKey(settings: EmbedSecretSettings): boolean {
	return classifyEmbedEndpoint(settings) === 'openai-compatible';
}

// ==================== 内部读取 ====================

/**
 * 从 Obsidian secretStorage 读取密钥并 trim。
 *
 * 关键路径:
 * - SecretStorage API 缺失时兜底日志(minAppVersion 1.13.1 已阻止老版,理论上不可达)。
 * - OS 钥匙串异常(如 macOS Keychain 拒绝访问)不冒泡,视为未配置,避免阻断 rebuild。
 *
 * @param app - Obsidian App 实例
 * @param id - RATEL_SECRET_IDS 中的密钥名
 * @returns 密钥值(非空 trim 后),未配置或空白返回 null
 */
function getSecret(app: App, id: string): string | null {
	try {
		if (!app.secretStorage?.getSecret) {
			// 修复:SecretStorage API 缺失,理论上 minAppVersion 已阻止,兜底日志。
			devLogger.error('secrets', 'SecretStorage API 不可用,需 Obsidian ≥ 1.13.1');
			return null;
		}
		// 关键路径:直接在 secretStorage 上调用,避免提取方法导致 this 丢失。
		const value = app.secretStorage.getSecret(id);
		return value && value.trim() ? value.trim() : null;
	} catch (err) {
		// 修复:OS 钥匙串异常(权限拒绝 / Keychain 锁定)不冒泡,视为未配置。
		devLogger.error('secrets', `读取密钥 ${id} 失败`, err);
		return null;
	}
}

// ==================== Chat profile 密钥 ====================

/** 一套对话配置的钥匙串名：ratel-chat-供应商-序号。 */
export function chatProfileSecretId(profile: { id: string; providerId?: string; keySerial?: number }): string {
	const slug = providerSecretSlug(profile.providerId || 'custom');
	const serial = profile.keySerial && profile.keySerial > 0 ? profile.keySerial : 1;
	return `ratel-chat-${slug}-${serial}`;
}

/**
 * 钥匙串名里的供应商片段。只留小写字母和数字。
 *
 * @param providerId - 供应商 id
 * @returns 短横线连接的片段
 */
export function providerSecretSlug(providerId: string): string {
	const slug = providerId
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 32);
	return slug || 'custom';
}

/** 旧版按配置 id 命名的钥匙串项，读取时回退。 */
export function legacyChatProfileSecretId(profileId: string): string {
	return `ratel-chat-profile-${profileId}`;
}

/** 当前这套配置的密钥名(active profile 优先,无 profile 时回退旧槽位)。 */
function currentChatSecretId(settings: ChatSecretSettings): string {
	const s = settings as ChatSecretSettings & {
		chatProfiles?: Array<{ id: string; providerId?: string; keySerial?: number }>;
		activeChatProfileId?: string;
	};
	const active = s.chatProfiles?.find((p) => p.id === s.activeChatProfileId);
	return active ? chatProfileSecretId(active) : RATEL_SECRET_IDS.chatOpenAICompatible;
}

// ==================== resolve / has ====================

/**
 * 从钥匙串解析 Chat API Key。
 *
 * @param app - Obsidian App 实例
 * @param settings - 含 chatApiBase 的设置片段
 * @returns 密钥值;不需要 Key 或未配置时返回 null
 */
export function resolveChatApiKey(app: App, settings: ChatSecretSettings): string | null {
	if (!requiresChatApiKey(settings)) return null;
	const profileKey = getSecret(app, currentChatSecretId(settings));
	if (profileKey) return profileKey;
	const s = settings as ChatSecretSettings & {
		chatProfiles?: Array<{ id: string; allowLegacyKeyFallback?: boolean }>;
		activeChatProfileId?: string;
	};
	const active = s.chatProfiles?.find((p) => p.id === s.activeChatProfileId);
	const legacy = active ? getSecret(app, legacyChatProfileSecretId(active.id)) : null;
	// 关键路径:旧库仍用 ratel-chat-profile-<id>，读到后抄到新名字
	if (legacy && active) {
		setChatProfileSecret(app, active, legacy);
		return legacy;
	}
	// 修复:新建空配置不能悄悄借用上一套遗留的全局密钥。
	if (active?.allowLegacyKeyFallback === false) return null;
	return getSecret(app, RATEL_SECRET_IDS.chatOpenAICompatible);
}

/**
 * 判断 Chat 是否已配置密钥(或不需要密钥)。
 *
 * @returns `true` 表示可以发送(已配置 Key 或本地 Ollama)
 */
export function hasChatApiKey(app: App, settings: ChatSecretSettings): boolean {
	return !requiresChatApiKey(settings) || !!resolveChatApiKey(app, settings);
}

/**
 * 从钥匙串解析 Embedding API Key。
 *
 * @param app - Obsidian App 实例
 * @param settings - 含 embedProvider / embedApiBase 的设置片段
 * @returns 密钥值;不需要 Key 或未配置时返回 null
 */
export function resolveEmbedApiKey(app: App, settings: EmbedSecretSettings): string | null {
	if (!requiresEmbedApiKey(settings)) return null;
	return getSecret(app, RATEL_SECRET_IDS.embedOpenAICompatible);
}

/**
 * 判断 Embedding 是否已配置密钥(或不需要密钥)。
 *
 * @returns `true` 表示可用(已配置 Key 或本地模式)
 */
export function hasEmbedApiKey(app: App, settings: EmbedSecretSettings): boolean {
	return !requiresEmbedApiKey(settings) || !!resolveEmbedApiKey(app, settings);
}

/**
 * 从钥匙串解析 Rerank API Key(百炼)。
 *
 * @param app - Obsidian App 实例
 * @returns 密钥值;未配置时返回 null(Rerank 自动关闭)
 */
export function resolveRerankApiKey(app: App): string | null {
	return getSecret(app, RATEL_SECRET_IDS.rerankBailian);
}

/**
 * 判断 Rerank 百炼密钥是否已配置。
 *
 * @returns `true` 表示已配置
 */
export function hasRerankApiKey(app: App): boolean {
	return !!resolveRerankApiKey(app);
}

// ==================== 密钥 ID 查询(设置页用) ====================

/**
 * 获取当前 Chat 上下文需要的密钥 ID。
 *
 * @param settings - 含 chatApiBase 的设置片段
 * @returns 密钥名;无需 Key 时返回 null
 */
export function getChatSecretId(settings: ChatSecretSettings): string | null {
	return requiresChatApiKey(settings) ? currentChatSecretId(settings) : null;
}

/**
 * 获取当前 Embedding 上下文需要的密钥 ID。
 *
 * @param settings - 含 embedProvider / embedApiBase 的设置片段
 * @returns 密钥名;无需 Key 时返回 null
 */
export function getEmbedSecretId(settings: EmbedSecretSettings): string | null {
	return requiresEmbedApiKey(settings) ? RATEL_SECRET_IDS.embedOpenAICompatible : null;
}

/**
 * 获取 Rerank 百炼固定密钥 ID。
 *
 * @returns 固定为 `ratel-rerank-bailian`
 */
export function getRerankSecretId(): string {
	return RATEL_SECRET_IDS.rerankBailian;
}

// ==================== MCP 动态密钥 ====================

/**
 * 生成某 MCP Server 的钥匙串 ID：`ratel-mcp-<serverId>`。
 *
 * @param serverId - MCP Server id
 * @returns 钥匙串密钥名
 */
export function mcpSecretId(serverId: string): string {
	return `ratel-mcp-${serverId}`;
}

/**
 * 从钥匙串解析 MCP Server API Key。
 *
 * @param app - Obsidian App
 * @param serverId - MCP Server id
 * @returns 密钥或 null
 */
export function resolveMcpSecret(app: App, serverId: string): string | null {
	return getSecret(app, mcpSecretId(serverId));
}

/**
 * 判断 MCP Server 密钥是否已配置。
 *
 * @param app - Obsidian App
 * @param serverId - MCP Server id
 * @returns 是否已配置
 */
export function hasMcpSecret(app: App, serverId: string): boolean {
	return !!resolveMcpSecret(app, serverId);
}

/** 读取一套配置的密钥。先看新名字，没有再看旧的 ratel-chat-profile-<id>。 */
export function readChatProfileSecret(
	app: App,
	profile: { id: string; providerId?: string; keySerial?: number },
): string | null {
	return getSecret(app, chatProfileSecretId(profile)) ?? getSecret(app, legacyChatProfileSecretId(profile.id));
}

/** 写入一套配置的密钥。 */
export function setChatProfileSecret(
	app: App,
	profile: { id: string; providerId?: string; keySerial?: number },
	value: string,
): void {
	app.secretStorage?.setSecret?.(chatProfileSecretId(profile), value);
}

/** 删除一套配置的密钥，包括旧版按 id 命名的那一项。 */
export function deleteChatProfileSecret(app: App, profileId: string, profile?: { id: string; providerId?: string; keySerial?: number }): void {
	// 部分宿主扩展提供删除方法，公开类型未声明；保持可选调用而不假定其存在。
	const storage = app.secretStorage as (typeof app.secretStorage & { deleteSecret?: (id: string) => void }) | undefined;
	if (profile) storage?.deleteSecret?.(chatProfileSecretId(profile));
	storage?.deleteSecret?.(legacyChatProfileSecretId(profileId));
}
