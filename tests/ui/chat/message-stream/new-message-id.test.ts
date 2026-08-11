/**
 * @file tests/ui/chat/message-stream/new-message-id.test.ts
 * @description newMessageId 单元测试 — 会话内消息锚点 id
 */
import { describe, it, expect } from 'vitest';
import { newMessageId } from '../../../../src/ui/chat/message-stream/new-message-id';

describe('newMessageId', () => {
	it('newMessageId - 连续调用 - 返回非空且互不相同', () => {
		const a = newMessageId();
		const b = newMessageId();
		expect(a.length).toBeGreaterThan(0);
		expect(b.length).toBeGreaterThan(0);
		expect(a).not.toBe(b);
	});
});
