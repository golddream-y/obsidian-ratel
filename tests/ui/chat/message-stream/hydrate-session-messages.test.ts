/**
 * @file tests/ui/chat/message-stream/hydrate-session-messages.test.ts
 * @description hydrateSessionMessages 单元测试
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { setLang } from '../../../../src/i18n';
import { pathForCiteIndex } from '../../../../src/ui/chat/open-chat-note';
import { hydrateSessionMessages } from '../../../../src/ui/chat/message-stream/hydrate-session-messages';

describe('hydrateSessionMessages', async () => {
	beforeEach(() => setLang('zh'));

	it('hydrateSessionMessages - 纯文本一轮 - user+assistant text', async () => {
		const ui = await hydrateSessionMessages([
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

	it('hydrateSessionMessages - 一轮 search_vault - 含 tool 与 text 段', async () => {
		const ui = await hydrateSessionMessages([
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

	it('hydrateSessionMessages - 跳过 system - 不进 UI', async () => {
		const ui = await hydrateSessionMessages([
			{ role: 'system', content: 'ignore' },
			{ role: 'user', content: 'u' },
		]);
		expect(ui).toHaveLength(1);
		expect(ui[0]!.role).toBe('user');
	});

	it('hydrateSessionMessages - search_vault 标准结果 - 挂 searchResults', async () => {
		const toolBody = JSON.stringify([
			{
				docId: 'd1',
				score: 0.9,
				index: 1,
				metadata: { path: 'notes/a.md' },
				reranked: true,
			},
		]);
		const ui = await hydrateSessionMessages([
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

	it('hydrateSessionMessages - 两次 search_vault - 保留最后一次', async () => {
		const first = JSON.stringify([
			{ docId: 'd1', score: 0.5, index: 1, metadata: { path: 'old.md' } },
		]);
		const second = JSON.stringify([
			{ docId: 'd2', score: 0.8, index: 1, metadata: { path: 'new.md' } },
		]);
		const ui = await hydrateSessionMessages([
			{ role: 'user', content: 'q' },
			{ role: 'assistant', content: '', toolCallId: 't1', toolName: 'search_vault', toolArgs: {} },
			{ role: 'tool', content: first, toolCallId: 't1' },
			{ role: 'assistant', content: '', toolCallId: 't2', toolName: 'search_vault', toolArgs: {} },
			{ role: 'tool', content: second, toolCallId: 't2' },
			{ role: 'assistant', content: '答' },
		]);
		expect(ui[1]!.searchResults?.[0]?.path).toBe('new.md');
	});

	it('hydrateSessionMessages - user 带 createdAt - UI 消息保留', async () => {
		const ts = 1_700_000_000_000;
		const ui = await hydrateSessionMessages([
			{ role: 'user', content: 'hi', createdAt: ts },
			{ role: 'assistant', content: 'hello', createdAt: ts + 1 },
		]);
		expect(ui[0]!.createdAt).toBe(ts);
		expect(ui[1]!.createdAt).toBe(ts + 1);
	});

	it('hydrateSessionMessages - 缺 createdAt - 不抛且字段缺省', async () => {
		const ui = await hydrateSessionMessages([{ role: 'user', content: 'hi' }]);
		expect(ui[0]!.createdAt).toBeUndefined();
	});

	it('hydrateSessionMessages - 末次 search 空数组 - 不挂 searchResults', async () => {
		const first = JSON.stringify([
			{ docId: 'd1', score: 0.5, index: 1, metadata: { path: 'old.md' } },
		]);
		const ui = await hydrateSessionMessages([
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


describe('工具参数历史失败', () => {
  it.each(['invalid-json', 'invalid-shape', 'output-limit', 'legacy-unparsed'] as const)(
    'hydrateSessionMessages - %s - 展开文案与即时错误一致', async (kind) => {
      const { appendToolCall, attachToolResult } = await import('../../../../src/ui/chat/message-stream/segment-appender');
      const issue = { kind, raw: '*** Update File: notes/private.md', actualType: 'array' };
      for (const lang of ['zh', 'en'] as const) {
        setLang(lang);
        const live = { id: 'live', role: 'assistant' as const, segments: [] as import('../../../../src/ui/chat/message-stream/types').MessageSegment[] };
        appendToolCall(live, { name: 'apply_patch', displayName: '错误路径', args: {}, argsIssue: issue, status: 'calling', startAt: 1 });
        attachToolResult(live, 'apply_patch', 'Error: 输出被截断，改用移动复制', issue);
        const persisted = [
          { role: 'assistant' as const, content: '', toolCallId: 't1', toolName: 'apply_patch', toolArgs: {}, toolArgsIssue: issue },
          { role: 'tool' as const, content: 'Error: 输出被截断，改用移动复制', toolCallId: 't1' },
        ];
        const before = JSON.stringify(persisted);
        const ui = await hydrateSessionMessages(persisted);
        const seg = ui[0]!.segments[0]!;
        const liveSeg = live.segments[0]!;
        expect(seg.type).toBe('tool');
        if (seg.type !== 'tool' || liveSeg.type !== 'tool') return;
        expect(seg.toolCall).toMatchObject({ name: 'apply_patch', displayName: 'apply_patch', status: 'failed', argsIssue: issue, errorMessage: liveSeg.toolCall.errorMessage, result: liveSeg.toolCall.result });
        expect(JSON.stringify(seg.toolCall)).not.toContain('移动复制');
        expect(JSON.stringify(persisted)).toBe(before);
      }
      setLang('zh');
    });
  it('hydrateSessionMessages - 旧 raw 与合法 MCP raw/null - 保守区分', async () => {
    setLang('zh');
    const ui = await hydrateSessionMessages([
      { role: 'assistant', content: '', toolCallId: 'old', toolName: 'apply_patch', toolArgs: { raw: 'secret' } },
      { role: 'tool', content: 'Error: 输出被截断', toolCallId: 'old' },
      { role: 'assistant', content: '', toolCallId: 'mcp', toolName: 'mcp__raw', toolArgs: { raw: '合法参数' }, toolArgsIssue: null },
      { role: 'tool', content: '{"ok":true}', toolCallId: 'mcp' },
    ]);
    expect(ui[0]!.segments[0]).toMatchObject({ toolCall: { status: 'failed', args: {}, errorMessage: '旧调用的参数未解析，原因未知，未执行。' } });
    const legacy = ui[0]!.segments[0]!;
    if (legacy.type !== 'tool') throw new Error('缺少旧工具段');
    expect(legacy.toolCall.args).toEqual({});
    expect(ui[0]!.segments[1]).toMatchObject({ toolCall: { status: 'done', argsIssue: null, result: { ok: true } } });
  });
});


it('hydrateSessionMessages - 合法补丁与普通执行失败 - 保留友好名称和原结果', async () => {
  setLang('zh');
  const patch = '*** Begin Patch\n*** Update File: notes/a.md\n@@\n 甲\n-乙\n+乙二\n*** End Patch';
  const ui = await hydrateSessionMessages([
    { role: 'assistant', content: '', toolCallId: 'ok', toolName: 'apply_patch', toolArgs: { patch }, toolArgsIssue: null },
    { role: 'tool', content: '{"path":"notes/a.md"}', toolCallId: 'ok' },
    { role: 'assistant', content: '', toolCallId: 'fail', toolName: 'read_note', toolArgs: { path: 'missing.md' }, toolArgsIssue: null },
    { role: 'tool', content: 'Error: 文件不存在', toolCallId: 'fail' },
  ]);
  const ok = ui[0]!.segments[0]!;
  if (ok.type !== 'tool') throw new Error('缺少工具段');
  expect(ok.toolCall.displayName).toContain('notes/a.md');
  expect(ok.toolCall.args).toEqual({ patch });
  expect(ok.toolCall.status).toBe('done');
  expect(ui[0]!.segments[1]).toMatchObject({ toolCall: { status: 'failed', result: 'Error: 文件不存在' } });
});
