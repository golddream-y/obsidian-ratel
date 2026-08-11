/**
 * @file tests/ui/chat/message-stream/chat-message-to-ui.test.ts
 * @description preservedChatMessagesToUi 单元测试 — 验证 ChatMessage → Message 转换与过滤行为
 */

import { describe, it, expect } from 'vitest';
import { preservedChatMessagesToUi } from '../../../../src/ui/chat/message-stream/chat-message-to-ui';
import type { ChatMessage } from '../../../../src/ports/llm';

describe('preservedChatMessagesToUi', () => {
	it('user 消息 - 转成 segments 数组', () => {
		const input: ChatMessage[] = [{ role: 'user', content: 'hello' }];
		const result = preservedChatMessagesToUi(input);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({
			id: expect.any(String),
			role: 'user',
			segments: [{ type: 'text', text: 'hello' }],
		});
	});

	it('assistant 消息 - 转成 segments 数组', () => {
		const input: ChatMessage[] = [{ role: 'assistant', content: 'world' }];
		const result = preservedChatMessagesToUi(input);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({
			id: expect.any(String),
			role: 'assistant',
			segments: [{ type: 'text', text: 'world' }],
		});
	});

	it('混合消息 - 过滤 system 和 tool,只保留 user/assistant', () => {
		const input: ChatMessage[] = [
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'u1' },
			{ role: 'assistant', content: 'a1' },
			{ role: 'tool', content: 'tool result', toolCallId: 'tc1' },
			{ role: 'user', content: 'u2' },
		];
		const result = preservedChatMessagesToUi(input);
		expect(result).toHaveLength(3);
		expect(result.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
		expect(result[0]?.segments[0]?.text).toBe('u1');
	});

	it('空数组 - 返回空数组', () => {
		const result = preservedChatMessagesToUi([]);
		expect(result).toEqual([]);
	});
});
