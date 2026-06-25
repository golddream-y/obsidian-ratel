/**
 * @file src/secrets/ratel-secrets.ts
 * @description Obsidian 钥匙串 API Key 解析 — 固定 ratel-* 密钥名 + 端点分类 + resolve/has 函数
 * @module secrets/ratel-secrets
 * @depends obsidian
 */

import type { App } from 'obsidian';

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
 * @param app - Obsidian App 实例
 * @param id - RATEL_SECRET_IDS 中的密钥名
 * @returns 密钥值(非空 trim 后),未配置或空白返回 null
 */
function getSecret(app: App, id: string): string | null {
	const value = app.secretStorage?.getSecret?.(id);
	return value && value.trim() ? value.trim() : null;
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
	return requiresChatApiKey(settings) ? RATEL_SECRET_IDS.chatOpenAICompatible : null;
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
