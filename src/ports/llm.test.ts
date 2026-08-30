/**
 * @file src/ports/llm.test.ts
 * @description 端口类型编译验证 — attachments 字段与能力声明(S-VISION)
 * @module ports/llm.test
 */
import { describe, it, expect } from 'vitest';
import type { ChatMessage, AttachmentRef } from './llm';

describe('ChatMessage attachments 类型', () => {
	it('AttachmentRef - 引用形态(id/mimeType)- 可赋值', () => {
		const ref: AttachmentRef = { id: 'h1', mimeType: 'image/png' };
		expect(ref.id).toBe('h1');
	});

	it('ChatMessage - attachments 可选 - 老消息形态不受影响', () => {
		const legacy: ChatMessage = { role: 'user', content: 'hi' };
		const withImg: ChatMessage = {
			role: 'user',
			content: '看这张图',
			attachments: [{ id: 'h1', mimeType: 'image/png' }],
		};
		expect(legacy.attachments).toBeUndefined();
		expect(withImg.attachments?.length).toBe(1);
	});
});
