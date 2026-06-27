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
	return { role: 'assistant', segments: [] };
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
