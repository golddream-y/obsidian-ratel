/**
 * @file tests/ui/chat/message-stream/segment-appender.test.ts
 * @description segment-appender 单元测试 — 段追加/合并/工具结果回填
 */
import { describe, it, expect } from 'vitest';
import {
	appendText,
	appendThink,
	appendToolCall,
	attachToolResult,
	markToolFailed,
} from '../../../../src/ui/chat/message-stream/segment-appender';
import type { Message } from '../../../../src/ui/chat/message-stream/types';

function newAssistantMsg(): Message {
	return { id: 'test-asst', role: 'assistant', segments: [] };
}

describe('segment-appender', () => {
	it('appendText - 相邻 text 段自动合并', () => {
		const msg = newAssistantMsg();
		appendText(msg, 'Hello');
		appendText(msg, ' world');
		expect(msg.segments).toHaveLength(1);
		expect(msg.segments[0]).toEqual({ type: 'text', text: 'Hello world' });
	});

	it('appendText - 不同类型段之间新建 text 段', () => {
		const msg = newAssistantMsg();
		appendToolCall(msg, {
			name: 'read_note', displayName: 'read_note a.md', args: {},
			status: 'calling', startAt: 1,
		});
		appendText(msg, 'Done');
		expect(msg.segments).toHaveLength(2);
		expect(msg.segments[1]).toEqual({ type: 'text', text: 'Done' });
	});

	it('appendThink - 相邻 think 段自动合并', () => {
		const msg = newAssistantMsg();
		appendThink(msg, '思考1');
		appendThink(msg, '思考2');
		expect(msg.segments).toHaveLength(1);
		expect(msg.segments[0]).toEqual({ type: 'think', text: '思考1思考2' });
	});

	it('appendToolCall - 不合并,每次 push 新段', () => {
		const msg = newAssistantMsg();
		appendToolCall(msg, {
			name: 'list_files', displayName: 'list_files A', args: {},
			status: 'calling', startAt: 1,
		});
		appendToolCall(msg, {
			name: 'list_files', displayName: 'list_files B', args: {},
			status: 'calling', startAt: 2,
		});
		expect(msg.segments).toHaveLength(2);
		expect(msg.segments[0]!.type).toBe('tool');
		expect(msg.segments[1]!.type).toBe('tool');
	});

	it('attachToolResult - 回填到最近 calling 的同名工具段', () => {
		const msg = newAssistantMsg();
		appendToolCall(msg, {
			name: 'read_note', displayName: 'read_note a.md', args: {},
			status: 'calling', startAt: 1,
		});
		appendToolCall(msg, {
			name: 'read_note', displayName: 'read_note b.md', args: {},
			status: 'calling', startAt: 2,
		});
		attachToolResult(msg, 'read_note', ['content']);
		// 回填到最近的(b.md)
		const lastTool = msg.segments[1] as { type: 'tool'; toolCall: { status: string; result: unknown } };
		expect(lastTool.toolCall.status).toBe('done');
		expect(lastTool.toolCall.result).toEqual(['content']);
		// 第一个仍是 calling
		const firstTool = msg.segments[0] as { type: 'tool'; toolCall: { status: string } };
		expect(firstTool.toolCall.status).toBe('calling');
	});

	it('attachToolResult - 无匹配段时降级追加已完成工具段', () => {
		const msg = newAssistantMsg();
		attachToolResult(msg, 'read_note', 'result');
		expect(msg.segments).toHaveLength(1);
		const seg = msg.segments[0] as { type: 'tool'; toolCall: { status: string; result: unknown; name: string } };
		expect(seg.toolCall.status).toBe('done');
		expect(seg.toolCall.result).toBe('result');
	});

	it('attachToolResult - 结果以 Error 开头 - 标为失败', () => {
		const msg = newAssistantMsg();
		appendToolCall(msg, {
			name: 'write_note', displayName: 'write_note x.md', args: {},
			status: 'calling', startAt: 1,
		});
		attachToolResult(msg, 'write_note', 'Error: 未改动文件。');
		const seg = msg.segments[0] as { type: 'tool'; toolCall: { status: string; errorMessage?: string } };
		expect(seg.toolCall.status).toBe('failed');
		expect(seg.toolCall.errorMessage).toContain('未改动文件');
	});

	it('attachToolResult - 失败事件已标红 - 回填到同一行不再追加', () => {
		const msg = newAssistantMsg();
		appendToolCall(msg, {
			name: 'write_note', displayName: '写入 第004章.md', args: { path: '第004章.md' },
			status: 'calling', startAt: 1,
		});
		markToolFailed(msg, 'write_note', 'content 必须是字符串');
		attachToolResult(msg, 'write_note', 'Error: content 必须是字符串');
		expect(msg.segments).toHaveLength(1);
		const seg = msg.segments[0] as {
			type: 'tool';
			toolCall: { status: string; displayName: string; errorMessage?: string; result: unknown };
		};
		expect(seg.toolCall.status).toBe('failed');
		expect(seg.toolCall.displayName).toBe('写入 第004章.md');
		expect(seg.toolCall.errorMessage).toBe('content 必须是字符串');
		expect(seg.toolCall.result).toBe('Error: content 必须是字符串');
	});

	it('markToolFailed - 标记最近 calling 同名工具段为 failed', () => {
		const msg = newAssistantMsg();
		appendToolCall(msg, {
			name: 'write_note', displayName: 'write_note x.md', args: {},
			status: 'calling', startAt: 1,
		});
		markToolFailed(msg, 'write_note', '路径越界');
		const seg = msg.segments[0] as { type: 'tool'; toolCall: { status: string; errorMessage: string } };
		expect(seg.toolCall.status).toBe('failed');
		expect(seg.toolCall.errorMessage).toBe('路径越界');
	});
});


describe('工具参数即时失败', () => {
  it.each(['invalid-json', 'invalid-shape', 'output-limit', 'legacy-unparsed'] as const)(
    'appendToolCall - %s - 参数失败即时标红并替换展开结果', (kind) => {
      const msg = newAssistantMsg();
      const argsIssue = { kind, raw: 'secret notes/private.md', actualType: 'array' };
      appendToolCall(msg, { name: 'apply_patch', displayName: '猜测路径', args: {}, argsIssue, status: 'calling', startAt: 1 });
      const seg = msg.segments[0]!;
      expect(seg.type).toBe('tool');
      if (seg.type !== 'tool') return;
      expect(seg.toolCall.status).toBe('failed');
      expect(seg.toolCall.displayName).toBe('apply_patch');
      expect(seg.toolCall.errorMessage).toContain('未执行');
      attachToolResult(msg, 'apply_patch', 'Error: 输出被截断，改用移动复制');
      expect(msg.segments).toHaveLength(1);
      expect(seg.toolCall.result).toBe(`Error: ${seg.toolCall.errorMessage}`);
      expect(seg.toolCall.result).not.toContain('移动复制');
    });
  it('attachToolResult - 结果元数据与空降调用 - 显示本地化失败', () => {
    const msg = newAssistantMsg();
    attachToolResult(msg, 'apply_patch', 'raw error', { kind: 'invalid-json', raw: 'secret' });
    expect(msg.segments[0]).toMatchObject({ toolCall: { status: 'failed', result: 'Error: 工具参数不是合法 JSON，未执行。' } });
  });
  it('appendToolCall - 合法 MCP raw/null - 正常执行展示不变', () => {
    const msg = newAssistantMsg();
    appendToolCall(msg, { name: 'mcp__raw', displayName: 'MCP', args: { raw: '业务内容' }, argsIssue: null, status: 'calling', startAt: 1 });
    attachToolResult(msg, 'mcp__raw', { ok: true }, null);
    expect(msg.segments[0]).toMatchObject({ toolCall: { displayName: 'MCP', status: 'done', argsIssue: null, result: { ok: true } } });
  });
});


it('appendToolCall - 旧 raw 参数 - 展开视图不接收原文', () => {
  const msg = newAssistantMsg();
  appendToolCall(msg, { name: 'apply_patch', displayName: 'apply_patch', args: { raw: 'secret' }, argsIssue: { kind: 'legacy-unparsed', raw: 'secret' }, status: 'calling', startAt: 1 });
  const seg = msg.segments[0]!;
  if (seg.type !== 'tool') throw new Error('缺少工具段');
  expect(seg.toolCall.args).toEqual({});
});
