/**
 * @file tests/ui/chat/message-stream/hydrate-session-messages.test.ts
 * @description hydrateSessionMessages 单元测试
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { setLang } from '../../../../src/i18n';
import { pathForCiteIndex } from '../../../../src/ui/chat/open-chat-note';
import { hydrateSessionMessages } from '../../../../src/ui/chat/message-stream/hydrate-session-messages';

describe('hydrateSessionMessages', () => {
	beforeEach(() => setLang('zh'));

	it('hydrateSessionMessages - 纯文本一轮 - user+assistant text', () => {
		const ui = hydrateSessionMessages([
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content: 'hello' },
		]);
		expect(ui).toHaveLength(2);
		expect(ui[0]!.id).toEqual(expect.any(String));
		expect(ui[0]!.id.length).toBeGreaterThan(0);
		expect(ui[1]!.id).toEqual(expect.any(String));
		expect(ui[1]!.id).not.toBe(ui[0]!.id);
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

	it('hydrateSessionMessages - search_vault 标准结果 - 挂 searchResults', () => {
		const toolBody = JSON.stringify([
			{
				docId: 'd1',
				score: 0.9,
				index: 1,
				metadata: { path: 'notes/a.md' },
				reranked: true,
			},
		]);
		const ui = hydrateSessionMessages([
			{ role: 'user', content: 'q' },
			{
				role: 'assistant',
				content: '',
				toolCallId: 't1',
				toolName: 'search_vault',
				toolArgs: { query: 'q' },
			},
			{ role: 'tool', content: toolBody, toolCallId: 't1' },
			{ role: 'assistant', content: '见[1]' },
		]);
		const asst = ui[1]!;
		expect(asst.searchResults).toEqual([
			{ docId: 'd1', score: 0.9, path: 'notes/a.md', index: 1 },
		]);
		expect(asst.searchReranked).toBe(true);
		expect(pathForCiteIndex(asst.searchResults, 1)).toBe('notes/a.md');
	});

	it('hydrateSessionMessages - 两次 search_vault - 保留最后一次', () => {
		const first = JSON.stringify([
			{ docId: 'd1', score: 0.5, index: 1, metadata: { path: 'old.md' } },
		]);
		const second = JSON.stringify([
			{ docId: 'd2', score: 0.8, index: 1, metadata: { path: 'new.md' } },
		]);
		const ui = hydrateSessionMessages([
			{ role: 'user', content: 'q' },
			{ role: 'assistant', content: '', toolCallId: 't1', toolName: 'search_vault', toolArgs: {} },
			{ role: 'tool', content: first, toolCallId: 't1' },
			{ role: 'assistant', content: '', toolCallId: 't2', toolName: 'search_vault', toolArgs: {} },
			{ role: 'tool', content: second, toolCallId: 't2' },
			{ role: 'assistant', content: '答' },
		]);
		expect(ui[1]!.searchResults?.[0]?.path).toBe('new.md');
	});

	it('hydrateSessionMessages - 末次 search 空数组 - 不挂 searchResults', () => {
		const first = JSON.stringify([
			{ docId: 'd1', score: 0.5, index: 1, metadata: { path: 'old.md' } },
		]);
		const ui = hydrateSessionMessages([
			{ role: 'user', content: 'q' },
			{ role: 'assistant', content: '', toolCallId: 't1', toolName: 'search_vault', toolArgs: {} },
			{ role: 'tool', content: first, toolCallId: 't1' },
			{ role: 'assistant', content: '', toolCallId: 't2', toolName: 'search_vault', toolArgs: {} },
			{ role: 'tool', content: '[]', toolCallId: 't2' },
			{ role: 'assistant', content: '无结果' },
		]);
		expect(ui[1]!.searchResults).toBeUndefined();
	});
});
