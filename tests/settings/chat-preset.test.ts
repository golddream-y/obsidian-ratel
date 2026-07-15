/**
 * @file tests/settings/chat-preset.test.ts
 * @description 对话场景预设写入与旧版归一化
 * @module tests/settings/chat-preset
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, type RatelVaultSettings } from '../../src/settings';
import {
	applyChatPreset,
	normalizeChatPreset,
	DEEPSEEK_CHAT_API_BASE,
	DEEPSEEK_CHAT_MODEL,
	OLLAMA_CHAT_API_BASE,
	OLLAMA_CHAT_MODEL,
} from '../../src/settings/chat-preset';

function cloneSettings(): RatelVaultSettings {
	return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as RatelVaultSettings;
}

describe('applyChatPreset', () => {
	it('applyChatPreset - deepseek - 写入官方 Base 与 deepseek-v4-flash 及 256k', () => {
		const s = cloneSettings();
		s.chatModel = 'other';
		s.chatApiBase = 'https://example.com';
		s.contextLengthPreset = '128k';
		applyChatPreset(s, 'deepseek');
		expect(s.chatPreset).toBe('deepseek');
		expect(s.chatApiBase).toBe(DEEPSEEK_CHAT_API_BASE);
		expect(s.chatModel).toBe(DEEPSEEK_CHAT_MODEL);
		expect(s.contextLengthPreset).toBe('256k');
		expect(s.chatModelMaxTokens).toBe(256_000);
	});

	it('applyChatPreset - ollama - 写入本地 Base 与占位模型', () => {
		const s = cloneSettings();
		applyChatPreset(s, 'ollama');
		expect(s.chatPreset).toBe('ollama');
		expect(s.chatApiBase).toBe(OLLAMA_CHAT_API_BASE);
		expect(s.chatModel).toBe(OLLAMA_CHAT_MODEL);
	});

	it('applyChatPreset - custom - 不覆盖已有 Base/模型', () => {
		const s = cloneSettings();
		s.chatModel = 'my-model';
		s.chatApiBase = 'https://custom.example/v1';
		applyChatPreset(s, 'custom');
		expect(s.chatPreset).toBe('custom');
		expect(s.chatModel).toBe('my-model');
		expect(s.chatApiBase).toBe('https://custom.example/v1');
	});
});

describe('normalizeChatPreset', () => {
	it('normalizeChatPreset - raw 已有 chatPreset - 不覆盖', () => {
		const s = cloneSettings();
		s.chatPreset = 'ollama';
		normalizeChatPreset(s, { chatPreset: 'ollama' });
		expect(s.chatPreset).toBe('ollama');
	});

	it('normalizeChatPreset - 旧版 deepseek-chat - 推断为 custom', () => {
		const s = cloneSettings();
		s.chatModel = 'deepseek-chat';
		s.chatApiBase = DEEPSEEK_CHAT_API_BASE;
		s.chatPreset = 'deepseek';
		normalizeChatPreset(s, {});
		expect(s.chatPreset).toBe('custom');
	});

	it('normalizeChatPreset - 已对齐 v4-flash - 推断为 deepseek', () => {
		const s = cloneSettings();
		normalizeChatPreset(s, {});
		expect(s.chatPreset).toBe('deepseek');
	});

	it('normalizeChatPreset - Ollama Base 与占位模型 - 推断为 ollama', () => {
		const s = cloneSettings();
		s.chatApiBase = OLLAMA_CHAT_API_BASE;
		s.chatModel = OLLAMA_CHAT_MODEL;
		s.chatPreset = 'deepseek';
		normalizeChatPreset(s, {});
		expect(s.chatPreset).toBe('ollama');
	});

	it('normalizeChatPreset - localhost 无 /v1 - 仍可推断 ollama', () => {
		const s = cloneSettings();
		s.chatApiBase = 'http://localhost:11434';
		s.chatModel = OLLAMA_CHAT_MODEL;
		normalizeChatPreset(s, {});
		expect(s.chatPreset).toBe('ollama');
	});
});

describe('DEFAULT_SETTINGS 对话默认', () => {
	it('DEFAULT_SETTINGS - chatModel - 为 deepseek-v4-flash', () => {
		expect(DEFAULT_SETTINGS.chatModel).toBe('deepseek-v4-flash');
		expect(DEFAULT_SETTINGS.chatPreset).toBe('deepseek');
	});
});
