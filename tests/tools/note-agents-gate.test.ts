/**
 * @file tests/tools/note-agents-gate.test.ts
 * @description applyNoteAgentsGate — 读附约束、写前闸门
 */

import { describe, expect, it, vi } from 'vitest';
import {
	AgentsChainSeen,
	applyNoteAgentsGate,
	collectUnseenAgentsChain,
} from '../../src/tools/note-agents';
import { ContextManager } from '../../src/core/context-manager';
import type { Persistence, Session } from '../../src/ports/persistence';

function makeReadAgentsFile(map: Map<string, string>) {
	return async (dir: string) => map.get(dir) ?? null;
}

describe('applyNoteAgentsGate', () => {
	it('applyNoteAgentsGate - 读嵌套笔记 - 附 Work 约束且不含库根正文', async () => {
		const files = new Map<string, string>([
			['', '库根全文不应出现'],
			['Work', '工作区写作规则'],
		]);
		const seen = new AgentsChainSeen();
		const gate = await applyNoteAgentsGate({
			op: 'read',
			notePath: 'Work/a.md',
			seen,
			readAgentsFile: makeReadAgentsFile(files),
		});
		expect(gate.proceed).toBe(true);
		expect(gate.attachment).toContain('工作区写作规则');
		expect(gate.attachment).toContain('离笔记更近的优先');
		expect(gate.attachment).not.toContain('库根全文不应出现');
	});

	it('collectUnseenAgentsChain - 同一目录链 - 只返回一次且不含库根', async () => {
		const files = new Map<string, string>([
			['', '库根全文不应出现'],
			['卷一/第一幕', '第一幕规则'],
			['卷一/第二幕', '第二幕规则'],
		]);
		const seen = new AgentsChainSeen();
		const read = makeReadAgentsFile(files);
		const first = await collectUnseenAgentsChain('卷一/第一幕/a.md', seen, read);
		expect(first).toContain('第一幕规则');
		expect(first).not.toContain('库根全文不应出现');
		const second = await collectUnseenAgentsChain('卷一/第一幕/b.md', seen, read);
		expect(second).toBe('');
		const other = await collectUnseenAgentsChain('卷一/第二幕/c.md', seen, read);
		expect(other).toContain('第二幕规则');
	});

	it('applyNoteAgentsGate - 写嵌套笔记 - 第一次也继续且不返回未改动文件', async () => {
		const files = new Map<string, string>([['Work', '先读我再写']]);
		const seen = new AgentsChainSeen();
		const gate = await applyNoteAgentsGate({
			op: 'write',
			notePath: 'Work/a.md',
			seen,
			readAgentsFile: makeReadAgentsFile(files),
		});
		expect(gate.proceed).toBe(true);
		expect(gate.attachment).not.toContain('未改动文件');
	});

	it('applyNoteAgentsGate - 写库根笔记 - 首次即可继续', async () => {
		const files = new Map<string, string>([['', '库根规则']]);
		const seen = new AgentsChainSeen();
		const gate = await applyNoteAgentsGate({
			op: 'write',
			notePath: 'a.md',
			seen,
			readAgentsFile: makeReadAgentsFile(files),
		});
		expect(gate.proceed).toBe(true);
	});

	it('applyNoteAgentsGate - 目录仅有 CLAUDE.md - 链中无其正文', async () => {
		const readAgentsFile = vi.fn(async (dir: string) => {
			if (dir === 'Work') return null;
			return null;
		});
		const seen = new AgentsChainSeen();
		const gate = await applyNoteAgentsGate({
			op: 'read',
			notePath: 'Work/a.md',
			seen,
			readAgentsFile,
		});
		expect(gate.attachment).toBe('');
		expect(readAgentsFile).toHaveBeenCalledWith('Work');
	});
});

describe('appendNoteAgentsChain', () => {
	it('appendNoteAgentsChain - 库根之后追加子目录规则 - 两段都在且顺序正确', async () => {
		const ctx = new ContextManager(emptyPersistence(), undefined, 8000);
		ctx.setNoteAgentsRoot('库根规则');
		ctx.appendNoteAgentsChain('第一幕规则');
		const text = ctx.toMessages().map((m) => m.content).join('\n');
		expect(text.indexOf('库根规则')).toBeGreaterThanOrEqual(0);
		expect(text.indexOf('库根规则')).toBeLessThan(text.indexOf('第一幕规则'));
	});
});

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
		listSessionIndex: async () => [],
	};
}
