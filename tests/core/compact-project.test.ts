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
	FOLDABLE_TOOL_NAMES,
	extractRestoredNotePaths,
	isPromptTooLong,
	microcompactMessages,
	offloadStalePayload,
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
	it('FOLDABLE_TOOL_NAMES - 发现类可折,read_note 与图切片不可折', () => {
		expect([...FOLDABLE_TOOL_NAMES].sort()).toEqual(
			['glob', 'grep', 'list_files', 'search_memory', 'search_vault'].sort(),
		);
		expect(FOLDABLE_TOOL_NAMES.has('read_note')).toBe(false);
		expect(FOLDABLE_TOOL_NAMES.has('get_links')).toBe(false);
		expect(FOLDABLE_TOOL_NAMES.has('search_by_tag')).toBe(false);
		expect(FOLDABLE_TOOL_NAMES.has('search_by_property')).toBe(false);
		expect(FOLDABLE_TOOL_NAMES.has('get_vault_structure')).toBe(false);
	});

	it('microcompactMessages - 旧 grep 超保留条数 - 正文变占位且保留 toolCallId', () => {
		const msgs: ChatMessage[] = [];
		for (let i = 0; i < 6; i++) {
			msgs.push(asstTool(`t${i}`, 'grep', { pattern: `p${i}` }));
			msgs.push(tool(`t${i}`, 'FULL'.repeat(20)));
		}
		const out = microcompactMessages(msgs, 5);
		const tools = out.filter((m) => m.role === 'tool');
		expect(tools[0]!.content.startsWith('[compacted] grep')).toBe(true);
		expect(tools[5]!.content.startsWith('FULL')).toBe(true);
		expect(tools[0]!.toolCallId).toBe('t0');
	});

	it('microcompactMessages - 6 条 read_note keepRecent=5 - 全部仍是全文', () => {
		const msgs: ChatMessage[] = [];
		for (let i = 0; i < 6; i++) {
			msgs.push(asstTool(`t${i}`, 'read_note', { path: `n${i}.md` }));
			msgs.push(tool(`t${i}`, `BODY${i}`.repeat(10)));
		}
		const out = microcompactMessages(msgs, 5);
		const tools = out.filter((m) => m.role === 'tool');
		expect(tools).toHaveLength(6);
		for (const t of tools) {
			expect(t.content.startsWith('[compacted]')).toBe(false);
			expect(t.content.startsWith('BODY')).toBe(true);
		}
	});

	it('microcompactMessages - 6 条 get_links keepRecent=5 - 切片全部保留', () => {
		const msgs: ChatMessage[] = [];
		for (let i = 0; i < 6; i++) {
			msgs.push(asstTool(`t${i}`, 'get_links', { path: `n${i}.md` }));
			msgs.push(tool(`t${i}`, JSON.stringify({ path: `n${i}.md`, outgoing: [`x${i}.md`] })));
		}
		const out = microcompactMessages(msgs, 5);
		const tools = out.filter((m) => m.role === 'tool');
		expect(tools).toHaveLength(6);
		for (const t of tools) {
			expect(t.content.startsWith('[compacted]')).toBe(false);
			expect(t.content).toContain('outgoing');
		}
	});

	it('microcompactMessages - 先 6 条 grep 再 1 条 get_links - grep 可折 links 仍在', () => {
		const msgs: ChatMessage[] = [];
		for (let i = 0; i < 6; i++) {
			msgs.push(asstTool(`g${i}`, 'grep', { pattern: 'q' }));
			msgs.push(tool(`g${i}`, 'GREP'.repeat(20)));
		}
		msgs.push(asstTool('L', 'get_links', { path: 'hub.md' }));
		msgs.push(tool('L', '{"path":"hub.md","outgoing":["a.md"]}'));
		const out = microcompactMessages(msgs, 5);
		const tools = out.filter((m) => m.role === 'tool');
		expect(tools[0]!.content.startsWith('[compacted] grep')).toBe(true);
		expect(tools[6]!.content).toContain('hub.md');
		expect(tools[6]!.content.startsWith('[compacted]')).toBe(false);
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

describe('offloadStalePayload', () => {
	it('offloadStalePayload - 上轮思考过程 - 不再回传，本轮保留', () => {
		const first = { role: 'user' as const, content: '先写' };
		const out = offloadStalePayload([
			first,
			{
				role: 'assistant',
				content: '',
				reasoning: '旧思考',
				toolCallId: 'a',
				toolName: 'read_note',
				toolArgs: { path: 'a.md' },
			},
			{ role: 'tool', content: '全文', toolCallId: 'a' },
			{ role: 'user', content: '继续' },
			{
				role: 'assistant',
				content: '',
				reasoning: '本轮思考',
				toolCallId: 'b',
				toolName: 'read_note',
				toolArgs: { path: 'b.md' },
			},
		]);
		expect(out[0]).toBe(first);
		expect(out[1]!.reasoning).toBeUndefined();
		expect(out[4]!.reasoning).toBe('本轮思考');
	});

	it('offloadStalePayload - 两轮各写一次 - 上一轮参数变占位，本轮正文保留', () => {
		const chapter = '第一章正文';
		const out = offloadStalePayload([
			{ role: 'user', content: '写' },
			asstTool('w1', 'write_note', { path: '第001章.md', content: chapter }),
			tool('w1', 'ok'),
			{ role: 'user', content: '继续' },
			asstTool('w2', 'write_note', { path: '第002章.md', content: '第二章' }),
			tool('w2', 'ok'),
		]);
		expect(out[1]!.toolArgs).toEqual({ path: '第001章.md' });
		expect(out[2]!.content).toContain('read_note');
		expect(out[2]!.content).not.toContain(chapter);
		expect(out[4]!.toolArgs).toEqual({ path: '第002章.md', content: '第二章' });
	});

	it('offloadStalePayload - 同一轮连写两次 - 只保留最后一次正文', () => {
		const out = offloadStalePayload([
			{ role: 'user', content: '继续' },
			asstTool('w1', 'write_note', { path: '第001章.md', content: '旧章' }),
			tool('w1', 'ok'),
			asstTool('w2', 'write_note', { path: '第002章.md', content: '新章' }),
			tool('w2', 'ok'),
		]);
		expect(out[1]!.toolArgs).toEqual({ path: '第001章.md' });
		expect(out[1]!.toolArgs).not.toHaveProperty('content');
		expect(out[3]!.toolArgs!.content).toBe('新章');
	});

	it('offloadStalePayload - 写入结果是 Error - 参数保留', () => {
		const out = offloadStalePayload([
			{ role: 'user', content: '写' },
			asstTool('w1', 'write_note', { path: '第001章.md', content: '没写上' }),
			tool('w1', 'Error: 拒绝'),
			{ role: 'user', content: '继续' },
		]);
		expect(out[1]!.toolArgs!.content).toBe('没写上');
	});

	it('offloadStalePayload - edit_note 的 old_string 与 new_string - 都换成占位', () => {
		const out = offloadStalePayload([
			{ role: 'user', content: '改' },
			asstTool('e1', 'edit_note', { path: 'a.md', old_string: '旧句', new_string: '新句' }),
			tool('e1', 'ok'),
			{ role: 'user', content: '下一轮' },
		]);
		expect(out[1]!.toolArgs).toEqual({ path: 'a.md' });
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
		expect(p.head.some((m) => m.content.includes('没有该篇'))).toBe(true);
		expect(p.head.some((m) => m.content.includes('按需 read_note'))).toBe(false);
		expect(p.tail).toHaveLength(1);
		expect(p.tail[0]!.content).toBe('新');
	});

	it('projectView - 无标记且含上轮写入 - tail 中上轮正文已是占位', () => {
		const messages: ChatMessage[] = [
			{ role: 'user', content: '写' },
			asstTool('w1', 'write_note', { path: 'a.md', content: '正文' }),
			tool('w1', 'ok'),
			{ role: 'user', content: '继续' },
		];
		const { tail } = projectView(messages, undefined);
		const write = tail.find((m) => m.toolName === 'write_note');
		expect(write?.toolArgs).toEqual({ path: 'a.md' });
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
