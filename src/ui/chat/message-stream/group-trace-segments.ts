/**
 * @file src/ui/chat/message-stream/group-trace-segments.ts
 * @description 将连续 tool/think 段收成同一 Trace 时间线块
 * @module ui/chat/message-stream/group-trace-segments
 */

import type { MessageSegment } from './types';

/** 时间线内一行(工具或思考) */
export type TraceItem =
	| { kind: 'tool'; seg: Extract<MessageSegment, { type: 'tool' }> }
	| { kind: 'think'; seg: Extract<MessageSegment, { type: 'think' }> };

/** MessageBubble 渲染块 — text 独立,连续 tool/think 合并 */
export type SegmentBlock =
	| { kind: 'text'; seg: Extract<MessageSegment, { type: 'text' }> }
	| { kind: 'trace'; items: TraceItem[] }
	| { kind: 'image'; seg: Extract<MessageSegment, { type: 'image' }> }
	| { kind: 'citation'; seg: Extract<MessageSegment, { type: 'citation' }> };

/**
 * 按原型「一条脊柱」分组:连续 tool/think 进同一 trace 块,text 打断时间线。
 *
 * @param segments - 消息有序段
 * @returns 渲染块列表
 */
export function groupTraceSegments(segments: MessageSegment[]): SegmentBlock[] {
	const blocks: SegmentBlock[] = [];
	let traceBuf: TraceItem[] = [];

	const flushTrace = () => {
		if (traceBuf.length === 0) return;
		blocks.push({ kind: 'trace', items: traceBuf });
		traceBuf = [];
	};

	for (const seg of segments) {
		if (seg.type === 'tool') {
			traceBuf.push({ kind: 'tool', seg });
			continue;
		}
		if (seg.type === 'think') {
			traceBuf.push({ kind: 'think', seg });
			continue;
		}
		flushTrace();
		if (seg.type === 'text') {
			blocks.push({ kind: 'text', seg });
		} else if (seg.type === 'image') {
			blocks.push({ kind: 'image', seg });
		} else if (seg.type === 'citation') {
			blocks.push({ kind: 'citation', seg });
		}
	}
	flushTrace();
	return blocks;
}
