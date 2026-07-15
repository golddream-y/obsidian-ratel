/**
 * @file tests/core/tool-message-align.test.ts
 * @description 工具消息对齐 — 孤立 tool / compact slice 窗口
 * @module tests/core/tool-message-align
 */

import { describe, it, expect } from 'vitest';
import {
	alignPreservedToolMessages,
	sanitizeToolMessageOrder,
} from '../../src/core/tool-message-align';
import type { ChatMessage } from '../../src/ports/llm';

function asstTool(id: string, name = 'read_note'): ChatMessage {
	return {
		role: 'assistant',
		content: '',
		toolCallId: id,
		toolName: name,
		toolArgs: { path: 'a.md' },
	};
}

function toolResult(id: string, content = 'ok'): ChatMessage {
	return { role: 'tool', content, toolCallId: id };
}

describe('alignPreservedToolMessages', () => {
	it('alignPreservedToolMessages - slice(-3) 落在半截工具对 - 无孤立 tool A', () => {
		const full: ChatMessage[] = [
			asstTool('A'),
			toolResult('A', 'ra'),
			asstTool('B'),
			toolResult('B', 'rb'),
		];
		const sliced = full.slice(-3); // [tool A, asst B, tool B]
		expect(sliced[0]!.role).toBe('tool');
		expect(sliced[0]!.toolCallId).toBe('A');

		const aligned = alignPreservedToolMessages(sliced);
		expect(aligned.every((m) => m.role !== 'tool' || hasPair(aligned, m))).toBe(true);
		expect(aligned.map((m) => m.toolCallId ?? m.role)).toEqual(['B', 'B']);
		expect(aligned.some((m) => m.toolCallId === 'A')).toBe(false);
	});

	it('alignPreservedToolMessages - 完整工具对窗口 - 原样保留', () => {
		const msgs: ChatMessage[] = [
			{ role: 'user', content: 'q' },
			asstTool('A'),
			toolResult('A'),
		];
		expect(alignPreservedToolMessages(msgs)).toEqual(msgs);
	});

	it('alignPreservedToolMessages - 无 tool 普通对话 - 不变', () => {
		const msgs: ChatMessage[] = [
			{ role: 'user', content: 'u1' },
			{ role: 'assistant', content: 'a1' },
			{ role: 'user', content: 'u2' },
		];
		expect(alignPreservedToolMessages(msgs)).toEqual(msgs);
	});
});

describe('sanitizeToolMessageOrder', () => {
	it('sanitizeToolMessageOrder - 孤立 tool 在中间 - 丢弃', () => {
		const msgs: ChatMessage[] = [
			{ role: 'user', content: 'q' },
			toolResult('orphan'),
			{ role: 'assistant', content: 'hi' },
		];
		const out = sanitizeToolMessageOrder(msgs);
		expect(out).toEqual([
			{ role: 'user', content: 'q' },
			{ role: 'assistant', content: 'hi' },
		]);
	});

	it('sanitizeToolMessageOrder - 配对正确 - 全保留', () => {
		const msgs: ChatMessage[] = [asstTool('c1'), toolResult('c1', 'body')];
		expect(sanitizeToolMessageOrder(msgs)).toEqual(msgs);
	});
});

/** 测试辅助:tool 前是否有匹配 assistant */
function hasPair(msgs: ChatMessage[], tool: ChatMessage): boolean {
	const id = tool.toolCallId;
	const idx = msgs.indexOf(tool);
	for (let i = idx - 1; i >= 0; i--) {
		const p = msgs[i]!;
		if (p.role === 'tool') continue;
		return p.role === 'assistant' && p.toolCallId === id;
	}
	return false;
}
