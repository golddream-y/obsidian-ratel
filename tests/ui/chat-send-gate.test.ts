/**
 * @file tests/ui/chat-send-gate.test.ts
 * @description chat-send-gate 单元测试 — 端点感知硬拦 + 检索软拦
 * @module tests/ui/chat-send-gate
 * @depends ui/chat-send-gate
 */

import { describe, it, expect } from 'vitest';
import { evaluateChatSendGate } from '../../src/ui/chat-send-gate';
import { DEFAULT_USER_STATUS } from '../../src/user-feedback/user-status';

describe('evaluateChatSendGate', () => {
	it('OpenAI 兼容端点且无钥匙串密钥 - 硬拦,文案含「钥匙串」', () => {
		// 关键路径:chatApiBase 指向远端(非 localhost),requiresChatApiKey=true。
		const r = evaluateChatSendGate(
			{ chatApiBase: 'https://api.deepseek.com' },
			DEFAULT_USER_STATUS,
			{ hasChatApiKey: false },
		);
		expect(r.canSend).toBe(false);
		expect(r.hardBlockReason).toContain('钥匙串');
	});

	it('OpenAI 兼容端点且已配置钥匙串密钥 - 可发送', () => {
		const r = evaluateChatSendGate(
			{ chatApiBase: 'https://api.deepseek.com' },
			DEFAULT_USER_STATUS,
			{ hasChatApiKey: true },
		);
		expect(r.canSend).toBe(true);
	});

	it('本地 Ollama 无 Key - 可发送,不读钥匙串', () => {
		// 关键路径:localhost 端点 requiresChatApiKey=false,opts.hasChatApiKey 不影响。
		const r = evaluateChatSendGate(
			{ chatApiBase: 'http://localhost:11434/v1' },
			DEFAULT_USER_STATUS,
			{ hasChatApiKey: false },
		);
		expect(r.canSend).toBe(true);
	});

	it('索引未就绪 - 软拦,仍可发送', () => {
		const r = evaluateChatSendGate(
			{ chatApiBase: 'https://api.deepseek.com' },
			{ ...DEFAULT_USER_STATUS, index: 'queueing', embedding: 'loading' },
			{ hasChatApiKey: true },
		);
		expect(r.canSend).toBe(true);
		expect(r.softHint).toContain('检索');
	});
});
