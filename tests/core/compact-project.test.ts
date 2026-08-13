/**
 * @file tests/core/compact-project.test.ts
 * @description 上下文投影 / microcompact / PTL / 断路器
 * @module tests/core/compact-project
 */
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../src/ports/llm';
import type { CompactMarker } from '../../src/ports/persistence';
import {
	AUTO_COMPACT_THRESHOLD_PCT,
	CompactCircuitBreaker,
	extractRestoredNotePaths,
	isPromptTooLong,
	microcompactMessages,
	projectView,
	shouldAutoCompact,
} from '../../src/core/compact-project';

function asstTool(id: string, name: string, args: Record<string, unknown>): ChatMessage {
	return { role: 'assistant', content: '', toolCallId: id, toolName: name, toolArgs: args };
}
function tool(id: string, content: string): ChatMessage {
	return { role: 'tool', content, toolCallId: id };
}

describe('microcompactMessages', () => {
	it('microcompactMessages - 旧 read_note 超保留条数 - 正文变占位且保留 toolCallId', () => {
		const msgs: ChatMessage[] = [];
		for (let i = 0; i < 6; i++) {
			msgs.push(asstTool(`t${i}`, 'read_note', { path: `n${i}.md` }));
			msgs.push(tool(`t${i}`, 'FULL'.repeat(20)));
		}
		const out = microcompactMessages(msgs, 5);
		const tools = out.filter((m) => m.role === 'tool');
		expect(tools[0]!.content.startsWith('[compacted] read_note')).toBe(true);
		expect(tools[0]!.content).toContain('path=n0.md');
		expect(tools[5]!.content.startsWith('FULL')).toBe(true);
		expect(tools[0]!.toolCallId).toBe('t0');
	});

	it('microcompactMessages - Error: 开头 - 不折叠', () => {
		const msgs = [
			asstTool('a', 'read_note', { path: 'x.md' }),
			tool('a', 'Error: 不存在'),
		];
		expect(microcompactMessages(msgs, 0)[1]!.content).toBe('Error: 不存在');
	});

	it('microcompactMessages - remember - 不折叠', () => {
		const msgs = [
			asstTool('a', 'remember', { type: 'global' }),
			tool('a', 'saved'),
		];
		expect(microcompactMessages(msgs, 0)[1]!.content).toBe('saved');
	});
});

describe('projectView', () => {
	it('projectView - 无标记 - tail 为全文 head 为空', () => {
		const messages: ChatMessage[] = [
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content: 'yo' },
		];
		const p = projectView(messages, undefined);
		expect(p.head).toEqual([]);
		expect(p.tail.map((m) => m.content)).toEqual(['hi', 'yo']);
	});

	it('projectView - 有标记 - head 含摘要 tail 从 afterIndex+1 起', () => {
		const messages: ChatMessage[] = [
			{ role: 'user', content: '旧' },
			{ role: 'assistant', content: '旧答' },
			{ role: 'user', content: '新' },
		];
		const markers: CompactMarker[] = [
			{ afterIndex: 1, summary: '要点A', restoredNotePaths: ['a.md'], at: 1 },
		];
		const p = projectView(messages, markers);
		expect(p.head[0]!.role).toBe('system');
		expect(p.head[0]!.content).toContain('[compact 摘要]');
		expect(p.head[0]!.content).toContain('要点A');
		expect(p.head.some((m) => m.content.includes('a.md'))).toBe(true);
		expect(p.tail).toHaveLength(1);
		expect(p.tail[0]!.content).toBe('新');
	});
});

describe('extractRestoredNotePaths', () => {
	it('extractRestoredNotePaths - 区间内多篇 - 近者优先去重最多 5', () => {
		const messages: ChatMessage[] = [];
		for (let i = 0; i < 7; i++) {
			messages.push(asstTool(`t${i}`, 'read_note', { path: `p${i}.md` }));
			messages.push(tool(`t${i}`, 'x'));
		}
		const paths = extractRestoredNotePaths(messages, 0, messages.length - 1);
		expect(paths).toEqual(['p6.md', 'p5.md', 'p4.md', 'p3.md', 'p2.md']);
	});
});

describe('isPromptTooLong', () => {
	it('isPromptTooLong - prompt too long / 413 / 中文过长 - true', () => {
		expect(isPromptTooLong(new Error('prompt too long'))).toBe(true);
		expect(isPromptTooLong({ status: 413 })).toBe(true);
		expect(isPromptTooLong(new Error('上下文过长'))).toBe(true);
		expect(isPromptTooLong(new Error('network'))).toBe(false);
	});
});

describe('shouldAutoCompact', () => {
	it('shouldAutoCompact - 启用且达阈值且断路未开 - true', () => {
		expect(shouldAutoCompact(85, true, false)).toBe(true);
		expect(shouldAutoCompact(84, true, false)).toBe(false);
		expect(shouldAutoCompact(90, false, false)).toBe(false);
		expect(shouldAutoCompact(90, true, true)).toBe(false);
	});
});

describe('CompactCircuitBreaker', () => {
	it('CompactCircuitBreaker - 连续失败 3 次 - isOpen', () => {
		const b = new CompactCircuitBreaker();
		b.fail('s1');
		b.fail('s1');
		expect(b.isOpen('s1')).toBe(false);
		b.fail('s1');
		expect(b.isOpen('s1')).toBe(true);
		b.succeed('s1');
		expect(b.isOpen('s1')).toBe(false);
	});
});

void AUTO_COMPACT_THRESHOLD_PCT;
