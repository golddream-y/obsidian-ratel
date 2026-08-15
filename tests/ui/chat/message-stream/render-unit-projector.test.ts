/**
 * @file tests/ui/chat/message-stream/render-unit-projector.test.ts
 * @description 消息、Markdown 块、工具段和活动尾部的统一 RenderUnit 投影
 * @module tests/ui/chat/message-stream/render-unit-projector
 */
import { describe, expect, it, vi } from 'vitest';
import {
	RenderUnitProjector,
	type MessageRenderUnit,
} from '../../../../src/ui/chat/message-stream/render-unit-projector';
import type { Message } from '../../../../src/ui/chat/message-stream/types';

function assistant(id: string, text: string): Message {
	return { id, role: 'assistant', segments: [{ type: 'text', text }] };
}

describe('RenderUnitProjector', () => {
	it('project - 静态长 Markdown - 按顶层 block 拆为多个稳定单元', () => {
		const projector = new RenderUnitProjector();
		const units = projector.project([assistant('a1', '# 标题\n\n正文\n\n- A\n- B')], false);
		const messageUnits = units.filter((u): u is MessageRenderUnit => u.kind === 'message');
		expect(messageUnits.length).toBeGreaterThan(1);
		expect(messageUnits[0]!.position).toBe('first');
		expect(messageUnits[messageUnits.length - 1]!.position).toBe('last');
		expect(messageUnits[0]!.anchor).toBe(true);
		expect(messageUnits.filter((u) => u.showFooter)).toHaveLength(1);
	});

	it('project - 活动末尾文本 - 稳定块与 tail 使用稳定 id', () => {
		const projector = new RenderUnitProjector();
		let msg = assistant('a1', '第一段\n\n第二');
		const first = projector.project([msg], true).filter((u): u is MessageRenderUnit => u.kind === 'message');
		const stableId = first.find((u) => !u.streaming)!.id;
		msg = assistant('a1', '第一段\n\n第二段继续');
		const second = projector.project([msg], true).filter((u): u is MessageRenderUnit => u.kind === 'message');
		expect(second.find((u) => !u.streaming)!.id).toBe(stableId);
		expect(second.filter((u) => u.streaming)).toHaveLength(1);
	});

	it('project - 文本后出现工具 - 前一文本立即变为静态单元', () => {
		const projector = new RenderUnitProjector();
		const msg: Message = {
			id: 'a1', role: 'assistant', segments: [
				{ type: 'text', text: '完成文本' },
				{ type: 'tool', toolCall: { name: 'x', displayName: 'x', args: {}, status: 'calling', startAt: 1 } },
			],
		};
		const units = projector.project([msg], true).filter((u): u is MessageRenderUnit => u.kind === 'message');
		expect(units.some((u) => u.streaming)).toBe(false);
		expect(units.some((u) => u.segments[0]?.type === 'tool')).toBe(true);
	});

	it('project - compact 与用户消息 - 保持独立逻辑单元', () => {
		const projector = new RenderUnitProjector();
		const messages: Message[] = [
			{ id: 'u1', role: 'user', segments: [{ type: 'text', text: '问题' }] },
			{ id: 'c1', role: 'compact', compactPhase: 'done', segments: [] },
		];
		expect(projector.project(messages, false).map((u) => u.kind)).toEqual(['message', 'compact']);
	});

	it('project - 空 segments 但有错误 - 仍保留一个 footer 单元', () => {
		const projector = new RenderUnitProjector();
		const msg: Message = {
			id: 'a1', role: 'assistant', segments: [],
			chatError: { type: 'runtime', message: '失败' },
		};
		const units = projector.project([msg], false);
		expect(units).toHaveLength(1);
		expect((units[0] as MessageRenderUnit).showFooter).toBe(true);
	});

	it('project - 引用定义跨块依赖 - 静态文本保持单一单元', () => {
		const projector = new RenderUnitProjector();
		const text = '参考 [文档][ref]\n\n[ref]: https://example.com';
		const units = projector.project([assistant('a1', text)], false);
		expect(units).toHaveLength(1);
	});

	it('project - 历史静态文本未变化 - 后续 delta 投影不重复 lexer', () => {
		const split = vi.fn((text: string) => ({
			stableBlocks: [text], tail: '', hasCrossBlockDependency: false,
		}));
		const projector = new RenderUnitProjector(split);
		const history = assistant('history', '历史正文');
		projector.project([history, assistant('live', 'a')], true);
		projector.project([history, assistant('live', 'ab')], true);
		expect(split.mock.calls.filter(([text]) => text === '历史正文')).toHaveLength(1);
	});

	it('project - 多块消息 - 附件只在首块且错误/引用 footer 只在末块', () => {
		const projector = new RenderUnitProjector();
		const msg = assistant('a1', '第一段\n\n第二段');
		msg.attachments = [{ fileName: 'a.png', mimeType: 'image/png', base64: 'AA==' }];
		msg.cancelled = true;
		const units = projector.project([msg], false).filter((u): u is MessageRenderUnit => u.kind === 'message');
		expect(units.filter((u) => u.showAttachments)).toHaveLength(1);
		expect(units.filter((u) => u.showFooter)).toHaveLength(1);
		expect(units[0]!.showAttachments).toBe(true);
		expect(units[units.length - 1]!.showFooter).toBe(true);
	});
});
