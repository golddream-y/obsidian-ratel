/**
 * @file tests/tools/note-agents-gate.test.ts
 * @description applyNoteAgentsGate — 读附约束、写前闸门
 */

import { describe, expect, it, vi } from 'vitest';
import {
	AgentsChainSeen,
	applyNoteAgentsGate,
} from '../../src/tools/note-agents';

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

	it('applyNoteAgentsGate - 写嵌套笔记未见约束 - 不继续且含 Work 约束', async () => {
		const files = new Map<string, string>([['Work', '先读我再写']]);
		const seen = new AgentsChainSeen();
		const gate = await applyNoteAgentsGate({
			op: 'write',
			notePath: 'Work/a.md',
			seen,
			readAgentsFile: makeReadAgentsFile(files),
		});
		expect(gate.proceed).toBe(false);
		expect(gate.attachment).toContain('先读我再写');
	});

	it('applyNoteAgentsGate - 写嵌套笔记已 mark - 可继续', async () => {
		const files = new Map<string, string>([['Work', '先读我再写']]);
		const seen = new AgentsChainSeen();
		await applyNoteAgentsGate({
			op: 'write',
			notePath: 'Work/a.md',
			seen,
			readAgentsFile: makeReadAgentsFile(files),
		});
		const second = await applyNoteAgentsGate({
			op: 'write',
			notePath: 'Work/a.md',
			seen,
			readAgentsFile: makeReadAgentsFile(files),
		});
		expect(second.proceed).toBe(true);
		expect(second.attachment).toBe('');
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
