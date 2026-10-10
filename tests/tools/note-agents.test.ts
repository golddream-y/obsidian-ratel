import { describe, expect, it } from 'vitest';
import {
	agentsChainDirs,
	joinAgentsBlock,
	nestedDirs,
	staleAgentsDirs,
	touchedNotePaths,
	truncateUtf8,
} from '../../src/tools/note-agents';

describe('agentsChainDirs', () => {
	it('agentsChainDirs - 嵌套笔记 - 根在前近的在后', () => {
		expect(agentsChainDirs('Work/Diary/note.md')).toEqual(['', 'Work', 'Work/Diary']);
	});
	it('agentsChainDirs - 目标就是 AGENTS.md - 包含其所在目录', () => {
		expect(agentsChainDirs('Work/AGENTS.md')).toEqual(['', 'Work']);
	});
	it('agentsChainDirs - 库根笔记 - 只有根', () => {
		expect(agentsChainDirs('note.md')).toEqual(['']);
	});
});

describe('truncateUtf8', () => {
	it('truncateUtf8 - 未超限 - 不截断', () => {
		expect(truncateUtf8('你好', 80)).toEqual({ text: '你好', truncated: false });
	});
});

describe('touchedNotePaths', () => {
	it('touchedNotePaths - read_note - 取 path', () => {
		expect(touchedNotePaths({ id: '1', name: 'read_note', args: { path: 'Work/a.md' } })).toEqual(['Work/a.md']);
	});
	it('touchedNotePaths - move_note - from 在 to 前', () => {
		expect(touchedNotePaths({
			id: '1', name: 'move_note', args: { from: 'A/x.md', to: 'B/y.md' },
		})).toEqual(['A/x.md', 'B/y.md']);
	});
	it('touchedNotePaths - copy_note - 只有 to', () => {
		expect(touchedNotePaths({
			id: '1', name: 'copy_note', args: { from: 'A/x.md', to: 'B/y.md' },
		})).toEqual(['B/y.md']);
	});
	it('touchedNotePaths - apply_patch - 取 Update File', () => {
		expect(touchedNotePaths({
			id: '1',
			name: 'apply_patch',
			args: { patch: '*** Begin Patch\n*** Update File: Work/a.md\n@@\n-a\n+b\n*** End Patch' },
		})).toEqual(['Work/a.md']);
	});
	it('touchedNotePaths - grep - 空', () => {
		expect(touchedNotePaths({ id: '1', name: 'grep', args: { path: 'Work/a.md' } })).toEqual([]);
	});
	it('touchedNotePaths - 路径含 .. - 丢弃', () => {
		expect(touchedNotePaths({ id: '1', name: 'read_note', args: { path: '../x.md' } })).toEqual([]);
	});
});

describe('staleAgentsDirs', () => {
	it('staleAgentsDirs - 子目录文件 - 只有所在目录', () => {
		expect(staleAgentsDirs(['A/B/AGENTS.md'])).toEqual(['A/B']);
	});
	it('staleAgentsDirs - 库根 - 空', () => {
		expect(staleAgentsDirs(['AGENTS.md'])).toEqual([]);
	});
	it('staleAgentsDirs - 移动到另一个 AGENTS.md - 源和目标都过期', () => {
		expect(staleAgentsDirs(['A/AGENTS.md', 'B/AGENTS.md'])).toEqual(['A', 'B']);
	});
	it('staleAgentsDirs - 普通笔记 - 空', () => {
		expect(staleAgentsDirs(['Work/a.md'])).toEqual([]);
	});
});

describe('joinAgentsBlock', () => {
	it('joinAgentsBlock - 两层 - 浅的在前且含优先句', () => {
		const block = joinAgentsBlock([
			{ dir: 'Work', text: '工作规则' },
			{ dir: 'Work/Diary', text: '日记规则' },
		]);
		expect(block!.dirs).toEqual(['Work', 'Work/Diary']);
		expect(block!.text.indexOf('工作规则')).toBeLessThan(block!.text.indexOf('日记规则'));
		expect(block!.text).toContain('离笔记更近的优先');
		expect(block!.text.startsWith('[目录约束 AGENTS.md]')).toBe(true);
	});
	it('joinAgentsBlock - 三层各 7KB - 丢掉最浅且不进 dirs', () => {
		const block = joinAgentsBlock([
			{ dir: 'A', text: '甲'.repeat(7000) },
			{ dir: 'A/B', text: '乙'.repeat(7000) },
			{ dir: 'A/B/C', text: '丙'.repeat(7000) },
		]);
		expect(block!.dirs).not.toContain('A');
		expect(block!.text).toContain('已截断');
	});
	it('joinAgentsBlock - 单层远超 16KB - 先截 8KB 仍进 dirs', () => {
		const raw = '甲'.repeat(20000);
		const block = joinAgentsBlock([{ dir: 'Work', text: raw }]);
		expect(block!.dirs).toEqual(['Work']);
		expect(block!.text).toContain('已截断');
		expect(block!.text).not.toContain(raw);
	});
});
