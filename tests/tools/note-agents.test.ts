import { describe, expect, it } from 'vitest';
import {
	agentsChainDirs,
	joinAgentsChain,
	nestedDirs,
	AgentsChainSeen,
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

describe('joinAgentsChain', () => {
	it('joinAgentsChain - 两层 - 根在前且含优先句', () => {
		const joined = joinAgentsChain([
			{ dir: '', text: '根规则' },
			{ dir: 'Work', text: '工作规则' },
		]);
		expect(joined.truncated).toBe(false);
		expect(joined.text.indexOf('根规则')).toBeLessThan(joined.text.indexOf('工作规则'));
		expect(joined.text).toContain('离笔记更近的优先');
	});
	it('joinAgentsChain - 合计超限 - 从最远截断', () => {
		const far = '远'.repeat(6000);
		const near = '近'.repeat(100);
		const joined = joinAgentsChain([
			{ dir: '', text: far },
			{ dir: 'Work', text: near },
		]);
		expect(joined.truncated).toBe(true);
		expect(joined.text).toContain('近');
		expect(joined.text).toContain('已截断');
	});
});

describe('truncateUtf8', () => {
	it('truncateUtf8 - 未超限 - 不截断', () => {
		expect(truncateUtf8('你好', 80)).toEqual({ text: '你好', truncated: false });
	});
});

describe('AgentsChainSeen', () => {
	it('AgentsChainSeen - 只有库根 - 视为已见', () => {
		const seen = new AgentsChainSeen();
		expect(seen.has('note.md')).toBe(true);
	});
	it('AgentsChainSeen - 有更近目录且未 mark - 未见', () => {
		const seen = new AgentsChainSeen();
		expect(seen.has('Work/note.md')).toBe(false);
		expect(nestedDirs('Work/note.md')).toEqual(['Work']);
	});
	it('AgentsChainSeen - mark 之后 - 已见', () => {
		const seen = new AgentsChainSeen();
		seen.mark('Work/note.md');
		expect(seen.has('Work/note.md')).toBe(true);
	});
});
