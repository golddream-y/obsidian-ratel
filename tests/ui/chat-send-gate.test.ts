/**
 * @file tests/ui/chat-send-gate.test.ts
 * @description chat-send-gate 单元测试
 * @module tests/ui/chat-send-gate
 * @depends ui/chat-send-gate
 */

import { describe, it, expect } from 'vitest';
import { evaluateChatSendGate } from '../../src/ui/chat-send-gate';
import { DEFAULT_USER_STATUS } from '../../src/user-feedback/user-status';

describe('evaluateChatSendGate', () => {
	it('Chat API Key 缺失 - 硬拦', () => {
		const r = evaluateChatSendGate({ chatApiKey: '' }, DEFAULT_USER_STATUS);
		expect(r.canSend).toBe(false);
		expect(r.hardBlockReason).toContain('API Key');
	});

	it('索引未就绪 - 软拦,仍可发送', () => {
		const r = evaluateChatSendGate(
			{ chatApiKey: 'sk-test' },
			{ ...DEFAULT_USER_STATUS, index: 'queueing', embedding: 'loading' },
		);
		expect(r.canSend).toBe(true);
		expect(r.softHint).toContain('检索');
	});
});
