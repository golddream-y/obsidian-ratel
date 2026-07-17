/**
 * @file tests/ui/chat/message-stream/group-trace-segments.test.ts
 * @description Trace 段分组 — 连续 tool/think 合并
 * @module tests/ui/chat/message-stream/group-trace-segments
 */
import { describe, it, expect } from 'vitest';
import { groupTraceSegments } from '../../../../src/ui/chat/message-stream/group-trace-segments';
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
