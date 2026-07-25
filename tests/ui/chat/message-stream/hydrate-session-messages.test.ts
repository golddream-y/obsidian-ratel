/**
 * @file tests/ui/chat/message-stream/hydrate-session-messages.test.ts
 * @description hydrateSessionMessages 单元测试
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { setLang } from '../../../../src/i18n';
import { hydrateSessionMessages } from '../../../../src/ui/chat/message-stream/hydrate-session-messages';

describe('hydrateSessionMessages', () => {
	beforeEach(() => setLang('zh'));

	it('hydrateSessionMessages - 纯文本一轮 - user+assistant text', () => {
		const ui = hydrateSessionMessages([
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content: 'hello' },
		]);
		expect(ui).toHaveLength(2);
		expect(ui[1]!.segments).toEqual([{ type: 'text', text: 'hello' }]);
	});

	it('hydrateSessionMessages - 一轮 search_vault - 含 tool 与 text 段', () => {
		const ui = hydrateSessionMessages([
			{ role: 'user', content: 'q' },
			{
				role: 'assistant',
				content: '',
				reasoning: '想一下',
				toolCallId: 't1',
				toolName: 'search_vault',
				toolArgs: { query: 'q' },
			},
			{ role: 'tool', content: '{"hits":1}', toolCallId: 't1' },
			{ role: 'assistant', content: '答' },
		]);
		expect(ui).toHaveLength(2);
		const asst = ui[1]!;
		expect(asst.segments.some((s) => s.type === 'think')).toBe(true);
		expect(asst.segments.some((s) => s.type === 'tool')).toBe(true);
		expect(asst.segments.some((s) => s.type === 'text' && s.text === '答')).toBe(true);
	});

	it('hydrateSessionMessages - 跳过 system - 不进 UI', () => {
		const ui = hydrateSessionMessages([
			{ role: 'system', content: 'ignore' },
			{ role: 'user', content: 'u' },
		]);
		expect(ui).toHaveLength(1);
		expect(ui[0]!.role).toBe('user');
	});
});
