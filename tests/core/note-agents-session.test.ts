/**
 * @file tests/core/note-agents-session.test.ts
 * @description ContextManager — 子目录 AGENTS.md 挂在 tool 消息上并按历史去重
 * @module tests/core/note-agents-session
 */

import { describe, expect, it } from 'vitest';
import { ContextManager } from '../../src/core/context-manager';
import { microcompactMessages } from '../../src/core/compact-project';
import type { Persistence, Session } from '../../src/ports/persistence';

function emptyPersistence(): Persistence {
	const sessions = new Map<string, Session>();
	return {
		sessions: {
			get: async (id) => sessions.get(id) ?? null,
			upsert: async (session) => { sessions.set(session.id, session); },
			list: async () => [],
			delete: async () => {},
		},
		notes: { get: async () => null, upsert: async () => {}, listByPath: async () => [], delete: async () => {} },
		hooks: { append: async () => {}, list: async () => [] },
		getLastSessionId: async () => null,
		setLastSessionId: async () => {},
	};
}

async function boot(ctx: ContextManager) {
	await ctx.load('s1');
	ctx.addUserMessage('hi');
}

describe('note-agents session', () => {
	it('toMessages - 只有过期标记 - 适配器看不到 noteAgentsStale', async () => {
		const ctx = new ContextManager(emptyPersistence(), undefined, 8000);
		await boot(ctx);
		ctx.addAssistantToolCall({ id: 'c1', name: 'edit_note', args: { path: 'Work/AGENTS.md' } }, '');
		ctx.addToolResult('c1', 'ok', { noteAgentsStale: ['Work'] });
		const outbound = ctx.toMessages().find((m) => m.role === 'tool')!;
		expect(outbound.noteAgents).toBeUndefined();
		expect(outbound.noteAgentsStale).toBeUndefined();
		expect(outbound.content).toBe('ok');
		expect(ctx.getTranscript().find((m) => m.role === 'tool')?.noteAgentsStale).toEqual(['Work']);
	});

	it('loadNoteAgents - 未登记 reader - 返回 undefined', async () => {
		const ctx = new ContextManager(emptyPersistence(), undefined, 8000);
		await boot(ctx);
		expect(await ctx.loadNoteAgents(['Work/a.md'])).toBeUndefined();
	});

	it('addToolResult - 首次加载 Work - 字段在消息上且系统段不含子目录', async () => {
		const ctx = new ContextManager(emptyPersistence(), undefined, 8000);
		await boot(ctx);
		ctx.setNoteAgentsRoot('库根规则');
		ctx.setNoteAgentsReader(async (dir) => (dir === 'Work' ? '工作规则' : null));
		const block = await ctx.loadNoteAgents(['Work/a.md']);
		ctx.addAssistantToolCall({ id: 'c1', name: 'read_note', args: { path: 'Work/a.md' } }, '');
		ctx.addToolResult('c1', '{"content":"正文"}', { noteAgents: block });
		const stored = ctx.getTranscript().find((m) => m.role === 'tool')!;
		expect(stored.noteAgents?.dirs).toEqual(['Work']);
		expect(stored.content).not.toContain('工作规则');
		const outbound = ctx.toMessages().find((m) => m.role === 'tool')!;
		expect(outbound.content.startsWith('{"content":"正文"}')).toBe(true);
		expect(outbound.content).toContain('工作规则');
		expect(outbound.noteAgents).toBeUndefined();
		expect(ctx.toMessages().filter((m) => m.role === 'system').map((m) => m.content).join('\n')).toContain('库根规则');
		expect(ctx.toMessages().filter((m) => m.role === 'system').map((m) => m.content).join('\n')).not.toContain('工作规则');
	});

	it('loadNoteAgents - 同目录已在历史里 - 不再加载', async () => {
		const ctx = new ContextManager(emptyPersistence(), undefined, 8000);
		await boot(ctx);
		ctx.setNoteAgentsReader(async (dir) => (dir === 'Work' ? '工作规则' : null));
		const first = await ctx.loadNoteAgents(['Work/a.md']);
		ctx.addAssistantToolCall({ id: 'c1', name: 'read_note', args: { path: 'Work/a.md' } }, '');
		ctx.addToolResult('c1', 'ok', { noteAgents: first });
		expect(await ctx.loadNoteAgents(['Work/b.md'])).toBeUndefined();
	});

	it('loadNoteAgents - 已有 Work 再碰 Diary - 只返回 Diary', async () => {
		const ctx = new ContextManager(emptyPersistence(), undefined, 8000);
		await boot(ctx);
		ctx.setNoteAgentsReader(async (dir) => (dir === 'Work' ? '工作' : dir === 'Work/Diary' ? '日记' : null));
		const first = await ctx.loadNoteAgents(['Work/a.md']);
		ctx.addAssistantToolCall({ id: 'c1', name: 'read_note', args: { path: 'Work/a.md' } }, '');
		ctx.addToolResult('c1', 'ok', { noteAgents: first });
		const second = await ctx.loadNoteAgents(['Work/Diary/c.md']);
		expect(second!.dirs).toEqual(['Work/Diary']);
	});

	it('loadNoteAgents - stale 之后 - 重新加载', async () => {
		const ctx = new ContextManager(emptyPersistence(), undefined, 8000);
		await boot(ctx);
		let text = '旧规则';
		ctx.setNoteAgentsReader(async (dir) => (dir === 'Work' ? text : null));
		const first = await ctx.loadNoteAgents(['Work/a.md']);
		ctx.addAssistantToolCall({ id: 'c1', name: 'read_note', args: { path: 'Work/a.md' } }, '');
		ctx.addToolResult('c1', 'ok', { noteAgents: first });
		text = '新规则';
		ctx.addAssistantToolCall({ id: 'c2', name: 'edit_note', args: { path: 'Work/AGENTS.md' } }, '');
		ctx.addToolResult('c2', 'ok', { noteAgentsStale: ['Work'] });
		const again = await ctx.loadNoteAgents(['Work/b.md']);
		expect(again!.text).toContain('新规则');
	});

	it('toMessages - 保存再 load - 仍视为已加载', async () => {
		const persistence = emptyPersistence();
		const ctx = new ContextManager(persistence, undefined, 8000);
		await boot(ctx);
		ctx.setNoteAgentsReader(async () => '工作规则');
		const block = await ctx.loadNoteAgents(['Work/a.md']);
		ctx.addAssistantToolCall({ id: 'c1', name: 'read_note', args: { path: 'Work/a.md' } }, '');
		ctx.addToolResult('c1', 'ok', { noteAgents: block });
		await ctx.save();
		const ctx2 = new ContextManager(persistence, undefined, 8000);
		await ctx2.load('s1');
		ctx2.setNoteAgentsReader(async () => '工作规则');
		expect(await ctx2.loadNoteAgents(['Work/b.md'])).toBeUndefined();
	});

	it('loadNoteAgents - 压缩标记覆盖带块的消息 - 重新加载', async () => {
		const ctx = new ContextManager(emptyPersistence(), undefined, 8000);
		await boot(ctx);
		ctx.setNoteAgentsReader(async (dir) => (dir === 'Work' ? '工作规则' : null));
		const block = await ctx.loadNoteAgents(['Work/a.md']);
		ctx.addAssistantToolCall({ id: 'c1', name: 'read_note', args: { path: 'Work/a.md' } }, '');
		ctx.addToolResult('c1', 'ok', { noteAgents: block });
		const afterIndex = ctx.getTranscript().length - 1;
		await ctx.appendCompactMarker({
			afterIndex,
			summary: '已读 Work',
			restoredNotePaths: [],
			at: Date.now(),
		});
		const again = await ctx.loadNoteAgents(['Work/a.md']);
		expect(again!.dirs).toEqual(['Work']);
	});

	it('microcompactMessages - 折叠正文 - 保留 noteAgents', () => {
		const folded = microcompactMessages([
			{ role: 'tool', content: '旧', toolCallId: 'a', noteAgents: { dirs: ['Work'], text: '工作规则' } },
			{ role: 'tool', content: '1', toolCallId: 'b' },
			{ role: 'tool', content: '2', toolCallId: 'c' },
			{ role: 'tool', content: '3', toolCallId: 'd' },
			{ role: 'tool', content: '4', toolCallId: 'e' },
			{ role: 'tool', content: '5', toolCallId: 'f' },
			{ role: 'tool', content: '6', toolCallId: 'g' },
		], 5);
		expect(folded[0]!.noteAgents?.dirs).toEqual(['Work']);
	});
});
