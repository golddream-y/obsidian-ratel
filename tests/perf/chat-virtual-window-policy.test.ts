/**
 * @file tests/perf/chat-virtual-window-policy.test.ts
 * @description 长会话虚拟窗口节点上界与单条长消息拆块合同
 * @module tests/perf/chat-virtual-window-policy
 */
import { describe, expect, it } from 'vitest';
import { RenderUnitProjector } from '../../src/ui/chat/message-stream/render-unit-projector';
import { buildVirtualLayout, computeVirtualRange } from '../../src/ui/chat/message-stream/virtual-window';
import type { Message } from '../../src/ui/chat/message-stream/types';

describe('聊天虚拟窗口性能合同', () => {
	it('100 条混合消息 - 600px 视口只挂载有限 RenderUnit', () => {
		const messages: Message[] = Array.from({ length: 100 }, (_, i) => ({
			id: `m${i}`,
			role: i % 2 === 0 ? 'user' : 'assistant',
			segments: [{ type: 'text', text: `消息 ${i}\n\n${'x'.repeat(200)}` }],
		}));
		const units = new RenderUnitProjector().project(messages, false);
		const layout = buildVirtualLayout(units, new Map(), () => 100);
		const range = computeVirtualRange(layout, 4000, 600, 900, new Set());
		expect(range.end - range.start).toBeLessThanOrEqual(26);
		expect(units.length).toBeGreaterThan(100);
	});

	it('单条 16K 多段助手消息 - 拆成多个虚拟块而非一个巨型单元', () => {
		const text = Array.from({ length: 200 }, (_, i) => `段落 ${i} ${'x'.repeat(68)}`).join('\n\n');
		const msg: Message = { id: 'long', role: 'assistant', segments: [{ type: 'text', text }] };
		const units = new RenderUnitProjector().project([msg], false);
		expect(text.length).toBeGreaterThanOrEqual(15_000);
		expect(units.length).toBeGreaterThan(100);
	});
});
