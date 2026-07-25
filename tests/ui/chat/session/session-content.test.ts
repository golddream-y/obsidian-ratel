/**
 * @file tests/ui/chat/session/session-content.test.ts
 * @description sessionHasContent 单元测试
 */
import { describe, it, expect } from 'vitest';
import { sessionHasContent } from '../../../../src/ui/chat/session/session-content';

describe('sessionHasContent', () => {
	it('sessionHasContent - 空数组 - false', () => {
		expect(sessionHasContent([])).toBe(false);
	});
	it('sessionHasContent - 仅空 assistant - false', () => {
		expect(sessionHasContent([{ role: 'assistant', content: '' }])).toBe(false);
	});
	it('sessionHasContent - 有 user - true', () => {
		expect(sessionHasContent([{ role: 'user', content: 'hi' }])).toBe(true);
	});
	it('sessionHasContent - assistant 带 toolName - true', () => {
		expect(
			sessionHasContent([{ role: 'assistant', content: '', toolName: 'search_vault', toolCallId: '1' }]),
		).toBe(true);
	});
});
