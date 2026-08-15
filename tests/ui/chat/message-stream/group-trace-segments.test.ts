/**
 * @file tests/ui/chat/message-stream/group-trace-segments.test.ts
 * @description Trace 段分组 — 连续 tool/think 合并
 * @module tests/ui/chat/message-stream/group-trace-segments
 */
import { describe, it, expect } from 'vitest';
import {
	groupTraceSegments,
	isStreamingTextBlock,
	isStreamingThinkItem,
} from '../../../../src/ui/chat/message-stream/group-trace-segments';
import type { MessageSegment } from '../../../../src/ui/chat/message-stream/types';

describe('groupTraceSegments', () => {
	it('分组 - 连续 tool/think - 收成一个 trace 块', () => {
		const segments: MessageSegment[] = [
			{ type: 'tool', toolCall: { name: 'a', displayName: 'a', args: {}, status: 'done', startAt: 1 } },
			{ type: 'tool', toolCall: { name: 'b', displayName: 'b', args: {}, status: 'done', startAt: 2 } },
			{ type: 'think', text: '思考' },
		];
		const blocks = groupTraceSegments(segments);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]!.kind).toBe('trace');
		if (blocks[0]!.kind === 'trace') {
			expect(blocks[0].items).toHaveLength(3);
		}
	});

	it('分组 - text 打断时间线 - 拆成多块', () => {
		const segments: MessageSegment[] = [
			{ type: 'tool', toolCall: { name: 'a', displayName: 'a', args: {}, status: 'done', startAt: 1 } },
			{ type: 'text', text: '正文' },
			{ type: 'think', text: '再想' },
		];
		const blocks = groupTraceSegments(segments);
		expect(blocks.map((b) => b.kind)).toEqual(['trace', 'text', 'trace']);
	});

	it('分组 - 空数组 - 返回空', () => {
		expect(groupTraceSegments([])).toEqual([]);
	});
});

describe('isStreamingTextBlock', () => {
	it('末尾块判定 - 文本后没有工具 - 只有最后一个 text 为 true', () => {
		const blocks = groupTraceSegments([
			{ type: 'text', text: '第一段' },
			{ type: 'tool', toolCall: { name: 'a', displayName: 'a', args: {}, status: 'done', startAt: 1 } },
			{ type: 'text', text: '第二段' },
		]);
		expect(isStreamingTextBlock(blocks, 0, true)).toBe(false);
		expect(isStreamingTextBlock(blocks, 2, true)).toBe(true);
	});

	it('末尾块判定 - 最后是 trace 或回合已结束 - 所有 text 为 false', () => {
		const blocks = groupTraceSegments([
			{ type: 'text', text: '完成段' },
			{ type: 'think', text: '思考' },
		]);
		expect(isStreamingTextBlock(blocks, 0, true)).toBe(false);
		expect(isStreamingTextBlock(blocks, 0, false)).toBe(false);
	});
});

describe('isStreamingThinkItem', () => {
	it('流式 think 判定 - 多轮 think/tool 交替进行中 - 只有消息末尾 think 为 true', () => {
		// 用户报告场景:回合进行中,历史 think 段结束后光标仍常驻闪烁
		const blocks = groupTraceSegments([
			{ type: 'think', text: '第一次思考' },
			{ type: 'tool', toolCall: { name: 'read', displayName: 'read', args: {}, status: 'done', startAt: 1 } },
			{ type: 'think', text: '第二次思考' },
			{ type: 'tool', toolCall: { name: 'grep', displayName: 'grep', args: {}, status: 'calling', startAt: 2 } },
			{ type: 'think', text: '第三次思考(正在流式)' },
		]);
		// 单一 trace 块:items = [think, tool, think, tool, think]
		expect(blocks).toHaveLength(1);
		expect(isStreamingThinkItem(blocks, 0, 0, true)).toBe(false);
		expect(isStreamingThinkItem(blocks, 0, 2, true)).toBe(false);
		expect(isStreamingThinkItem(blocks, 0, 4, true)).toBe(true);
	});

	it('流式 think 判定 - trace 块后被工具打断 - 历史 think 为 false', () => {
		const blocks = groupTraceSegments([
			{ type: 'think', text: '想完了' },
			{ type: 'tool', toolCall: { name: 'read', displayName: 'read', args: {}, status: 'calling', startAt: 1 } },
		]);
		expect(isStreamingThinkItem(blocks, 0, 0, true)).toBe(false);
	});

	it('流式 think 判定 - trace 后还有活动 text - think 为 false', () => {
		const blocks = groupTraceSegments([
			{ type: 'think', text: '思考' },
			{ type: 'text', text: '正在写正文' },
		]);
		expect(isStreamingThinkItem(blocks, 0, 0, true)).toBe(false);
	});

	it('流式 think 判定 - 回合已结束 - 全部 false', () => {
		const blocks = groupTraceSegments([{ type: 'think', text: '最后的思考' }]);
		expect(isStreamingThinkItem(blocks, 0, 0, false)).toBe(false);
	});

	it('流式 think 判定 - 唯一 think 末尾 - 为 true', () => {
		const blocks = groupTraceSegments([{ type: 'think', text: '思考中' }]);
		expect(isStreamingThinkItem(blocks, 0, 0, true)).toBe(true);
	});
});
