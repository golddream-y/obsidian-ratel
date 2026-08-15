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

/**
 * 仅运行中助手消息的最后一个渲染块为 text 时,把它标记为活动流式块。
 *
 * 工具段/思考段出现在文本之后时,前一文本块不再是末尾块,streaming 立即变
 * false,触发一次富 Markdown 渲染(而不是等整轮结束)。
 *
 * @param blocks - 当前消息渲染块
 * @param blockIndex - 待判定块下标
 * @param assistantStreaming - 当前消息是否为运行中的最后一条助手消息
 * @returns 是否应使用轻量流式渲染
 * @example
 *   isStreamingTextBlock(blocks, 0, true);
 */
export function isStreamingTextBlock(
	blocks: SegmentBlock[],
	blockIndex: number,
	assistantStreaming: boolean,
): boolean {
	if (!assistantStreaming || blockIndex !== blocks.length - 1) return false;
	return blocks[blockIndex]?.kind === 'text';
}

/**
 * 仅运行中助手消息的最后一个 trace item 为 think 时,把它标记为流式思考。
 *
 * 修复:此前回合进行中消息内所有 think 段都带闪烁光标(读了几份文件、
 * 做了几件事后,历史思考末尾仍各挂一个光标)。现在只有紧跟消息末尾、
 * 且其后再无工具/文本的 think 才是"正在思考";被工具或正文打断的历史
 * think 立即落定为"想完了"。
 *
 * @param blocks - 当前消息渲染块
 * @param blockIndex - 待判定 trace 块下标
 * @param itemIndex - 块内 think 项下标
 * @param assistantStreaming - 当前切片是否处于运行中助手消息的活动末尾
 * @returns 该 think 是否正在流式输出
 * @example
 *   isStreamingThinkItem(blocks, 0, blocks[0].items.length - 1, true);
 */
export function isStreamingThinkItem(
	blocks: SegmentBlock[],
	blockIndex: number,
	itemIndex: number,
	assistantStreaming: boolean,
): boolean {
	if (!assistantStreaming || blockIndex !== blocks.length - 1) return false;
	const block = blocks[blockIndex];
	if (block?.kind !== 'trace') return false;
	return itemIndex === block.items.length - 1 && block.items[itemIndex]?.kind === 'think';
}
