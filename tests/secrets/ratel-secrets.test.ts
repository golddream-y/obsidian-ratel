/**
 * @file tests/secrets/ratel-secrets.test.ts
 * @description ratel-secrets 钥匙串解析模块单元测试
 * @module tests/secrets/ratel-secrets
 */

import { describe, it, expect } from 'vitest';
import {
	RATEL_SECRET_IDS,
	isLocalHost,
	classifyChatEndpoint,
	classifyEmbedEndpoint,
	requiresChatApiKey,
	requiresEmbedApiKey,
	resolveChatApiKey,
	resolveEmbedApiKey,
	hasChatApiKey,
	hasEmbedApiKey,
	hasRerankApiKey,
	getChatSecretId,
	getEmbedSecretId,
	getRerankSecretId,
	chatProfileSecretId,
	providerSecretSlug,
	mcpSecretId,
	resolveMcpSecret,
	hasMcpSecret,
} from '../../src/secrets/ratel-secrets';
import type { ChatSecretSettings } from '../../src/secrets/ratel-secrets';
import type { App } from 'obsidian';

/**
 * 构造带 secretStorage mock 的 App。
 *
 * @param secrets - 密钥 ID → 值的映射;未列入的 ID 返回 null
 */
function mockApp(secrets: Record<string, string | null>): App {
	return {
		secretStorage: {
			getSecret: (id: string) => secrets[id] ?? null,
		},
	} as unknown as App;
}

describe('ratel-secrets', () => {
	// ==================== isLocalHost ====================
	describe('isLocalHost', () => {
		it('isLocalHost - localhost / 127.0.0.1 - 返回 true', () => {
			expect(isLocalHost('http://localhost:11434/v1')).toBe(true);
			expect(isLocalHost('http://127.0.0.1:8080')).toBe(true);
			expect(isLocalHost('localhost:3000')).toBe(true);
			expect(isLocalHost('127.0.0.1')).toBe(true);
		});

		it('isLocalHost - 远端域名 - 返回 false', () => {
			expect(isLocalHost('https://api.deepseek.com')).toBe(false);
			expect(isLocalHost('https://api.siliconflow.cn/v1')).toBe(false);
		});

		it('isLocalHost - 非法 URL - 返回 false', () => {
			expect(isLocalHost('')).toBe(false);
			expect(isLocalHost('not-a-url')).toBe(false);
		});
	});

	// ==================== Chat 端点分类 ====================
	describe('Chat 端点分类', () => {
		it('Chat 远端 - 分类为 openai-compatible', () => {
			expect(classifyChatEndpoint({ chatApiBase: 'https://api.deepseek.com' })).toBe('openai-compatible');
			expect(requiresChatApiKey({ chatApiBase: 'https://api.deepseek.com' })).toBe(true);
		});

		it('Chat localhost Ollama - 分类为 ollama-local,免 Key', () => {
			expect(classifyChatEndpoint({ chatApiBase: 'http://localhost:11434/v1' })).toBe('ollama-local');
			expect(requiresChatApiKey({ chatApiBase: 'http://localhost:11434/v1' })).toBe(false);
		});

		it('getChatSecretId - 远端返回 chatOpenAICompatible', () => {
			expect(getChatSecretId({ chatApiBase: 'https://api.deepseek.com' })).toBe(
				RATEL_SECRET_IDS.chatOpenAICompatible,
			);
		});

		it('getChatSecretId - 本地返回 null', () => {
			expect(getChatSecretId({ chatApiBase: 'http://localhost:11434/v1' })).toBeNull();
		});
	});

	// ==================== Embed 端点分类 ====================
	describe('Embed 端点分类', () => {
		it('Embed local - 分类为 builtin,免 Key', () => {
			expect(classifyEmbedEndpoint({ embedProvider: 'local', embedApiBase: '' })).toBe('builtin');
			expect(requiresEmbedApiKey({ embedProvider: 'local', embedApiBase: '' })).toBe(false);
		});

		it('Embed API 远端 - 分类为 openai-compatible,需要密钥', () => {
			expect(
				classifyEmbedEndpoint({ embedProvider: 'api', embedApiBase: 'https://api.siliconflow.cn/v1' }),
			).toBe('openai-compatible');
			expect(
				requiresEmbedApiKey({ embedProvider: 'api', embedApiBase: 'https://api.siliconflow.cn/v1' }),
			).toBe(true);
		});

		it('Embed API localhost - 分类为 ollama-local,免 Key', () => {
			expect(
				classifyEmbedEndpoint({ embedProvider: 'api', embedApiBase: 'http://localhost:11434/v1' }),
			).toBe('ollama-local');
			expect(
				requiresEmbedApiKey({ embedProvider: 'api', embedApiBase: 'http://localhost:11434/v1' }),
			).toBe(false);
		});

		it('getEmbedSecretId - 远端 API 返回 embedOpenAICompatible', () => {
			expect(getEmbedSecretId({ embedProvider: 'api', embedApiBase: 'https://api.siliconflow.cn/v1' })).toBe(
				RATEL_SECRET_IDS.embedOpenAICompatible,
			);
		});

		it('getEmbedSecretId - local 返回 null', () => {
			expect(getEmbedSecretId({ embedProvider: 'local', embedApiBase: '' })).toBeNull();
		});
	});

	// ==================== resolve / has ====================
	describe('resolveChatApiKey', () => {
		it('resolveChatApiKey - 从钥匙串读取密钥', () => {
			const app = mockApp({ [RATEL_SECRET_IDS.chatOpenAICompatible]: 'sk-test' });
			expect(resolveChatApiKey(app, { chatApiBase: 'https://api.deepseek.com' })).toBe('sk-test');
			expect(hasChatApiKey(app, { chatApiBase: 'https://api.deepseek.com' })).toBe(true);
		});

		it('resolveChatApiKey - 钥匙串无值返回 null', () => {
			const app = mockApp({});
			expect(resolveChatApiKey(app, { chatApiBase: 'https://api.deepseek.com' })).toBeNull();
			expect(hasChatApiKey(app, { chatApiBase: 'https://api.deepseek.com' })).toBe(false);
		});

		it('resolveChatApiKey - 本地 Ollama 不需要 Key,返回 null', () => {
			const app = mockApp({});
			expect(resolveChatApiKey(app, { chatApiBase: 'http://localhost:11434/v1' })).toBeNull();
			// 关键路径:本地 Ollama hasChatApiKey 仍为 true(不需要 Key 即视为"有")
			expect(hasChatApiKey(app, { chatApiBase: 'http://localhost:11434/v1' })).toBe(true);
		});

		it('resolveChatApiKey - 空白字符串视为未配置', () => {
			const app = mockApp({ [RATEL_SECRET_IDS.chatOpenAICompatible]: '   ' });
			expect(resolveChatApiKey(app, { chatApiBase: 'https://api.deepseek.com' })).toBeNull();
			expect(hasChatApiKey(app, { chatApiBase: 'https://api.deepseek.com' })).toBe(false);
		});
	});

	describe('resolveEmbedApiKey', () => {
		it('resolveEmbedApiKey - 远端 API 从钥匙串读取', () => {
			const app = mockApp({ [RATEL_SECRET_IDS.embedOpenAICompatible]: 'sk-embed' });
			expect(
				resolveEmbedApiKey(app, { embedProvider: 'api', embedApiBase: 'https://api.siliconflow.cn/v1' }),
			).toBe('sk-embed');
		});

		it('hasEmbedApiKey - local 模式视为已配置', () => {
			const app = mockApp({});
			expect(hasEmbedApiKey(app, { embedProvider: 'local', embedApiBase: '' })).toBe(true);
		});
	});

	describe('Rerank 密钥', () => {
		it('hasRerankApiKey - 百炼密钥已配置', () => {
			const app = mockApp({ [RATEL_SECRET_IDS.rerankBailian]: 'dash-key' });
			expect(hasRerankApiKey(app)).toBe(true);
		});

		it('hasRerankApiKey - 未配置返回 false', () => {
			const app = mockApp({});
			expect(hasRerankApiKey(app)).toBe(false);
		});

		it('getRerankSecretId - 返回百炼固定 ID', () => {
			expect(getRerankSecretId()).toBe(RATEL_SECRET_IDS.rerankBailian);
		});
	});

	describe('MCP 动态密钥', () => {
		it('mcpSecretId - 生成 ratel-mcp-<id>', () => {
			expect(mcpSecretId('tavily')).toBe('ratel-mcp-tavily');
		});

		it('resolveMcpSecret - 有密钥 - 返回值', () => {
			const app = mockApp({ 'ratel-mcp-tavily': 'k' });
			expect(resolveMcpSecret(app, 'tavily')).toBe('k');
		});

		it('resolveMcpSecret - 无密钥 - 返回 null', () => {
			const app = mockApp({});
			expect(resolveMcpSecret(app, 'tavily')).toBeNull();
		});

		it('hasMcpSecret - 有/无', () => {
			expect(hasMcpSecret(mockApp({ 'ratel-mcp-tavily': 'k' }), 'tavily')).toBe(true);
			expect(hasMcpSecret(mockApp({}), 'tavily')).toBe(false);
		});
	});

	// ==================== RATEL_SECRET_IDS 完整性 ====================
	describe('chat profile 密钥', () => {
		const settingsWithProfile = (activeId: string) => ({
			chatApiBase: 'https://api.deepseek.com',
			chatProfiles: [
				{ id: 'p1', name: 'A', providerId: 'custom', keySerial: 1, apiBase: 'https://a', model: 'm1', contextLengthPreset: '128k', chatModelMaxTokens: 128_000 },
				{ id: 'p2', name: 'B', providerId: 'deepseek', keySerial: 1, apiBase: 'https://b', model: 'm2', contextLengthPreset: '128k', chatModelMaxTokens: 128_000 },
			],
			activeChatProfileId: activeId,
		}) as unknown as ChatSecretSettings;

		it('当前套有自己的密钥 - 用 profile 槽位', () => {
			const app = mockApp({ 'ratel-chat-profile-p2': 'sk-b', [RATEL_SECRET_IDS.chatOpenAICompatible]: 'sk-old' });
			expect(resolveChatApiKey(app, settingsWithProfile('p2'))).toBe('sk-b');
		});

		it('当前套无 profile 密钥 - 回退旧槽位', () => {
			const app = mockApp({ [RATEL_SECRET_IDS.chatOpenAICompatible]: 'sk-old' });
			expect(resolveChatApiKey(app, settingsWithProfile('p1'))).toBe('sk-old');
		});

		it('getChatSecretId - 返回当前套的 profile 密钥名', () => {
			expect(getChatSecretId(settingsWithProfile('p2'))).toBe('ratel-chat-deepseek-1');
		});

		it('chatProfileSecretId - 供应商名含空格或符号 - 名称里没有空格', () => {
			expect(providerSecretSlug('Z AI')).toBe('z-ai');
			expect(providerSecretSlug('z.ai')).toBe('z-ai');
			expect(chatProfileSecretId({ id: 'p', providerId: 'Z AI', keySerial: 2 })).toBe('ratel-chat-z-ai-2');
			expect(chatProfileSecretId({ id: 'p', providerId: 'Z AI', keySerial: 2 })).not.toMatch(/\s/);
		});
	});

	describe('RATEL_SECRET_IDS', () => {
		it('RATEL_SECRET_IDS - 包含全部 5 个密钥名', () => {
			expect(RATEL_SECRET_IDS.chatOpenAICompatible).toBe('ratel-chat-openai-compatible');
			expect(RATEL_SECRET_IDS.chatOllama).toBe('ratel-chat-ollama');
			expect(RATEL_SECRET_IDS.embedOpenAICompatible).toBe('ratel-embed-openai-compatible');
			expect(RATEL_SECRET_IDS.embedOllama).toBe('ratel-embed-ollama');
			expect(RATEL_SECRET_IDS.rerankBailian).toBe('ratel-rerank-bailian');
		});
	});
});
