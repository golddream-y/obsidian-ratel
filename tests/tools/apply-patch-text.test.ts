import { describe, it, expect } from 'vitest';
import { applyUpdateHunks, parseUpdatePatch, peekUpdateFilePath } from '../../src/tools/apply-patch-text';

const FILE = '甲\n乙\n丙\n丁\n';

function patch(body: string): string {
	return `*** Begin Patch\n*** Update File: 章/第004章.md\n${body}\n*** End Patch\n`;
}

describe('apply-patch-text', () => {
	it('peekUpdateFilePath - 恰好一个 Update File - 返回路径', () => {
		expect(peekUpdateFilePath(patch('@@\n 乙\n-丙\n+丙二'))).toBe('章/第004章.md');
	});

	it('parseUpdatePatch - 两处增删 - 解析出两个 hunk', () => {
		const parsed = parseUpdatePatch(patch('@@ 标题不参与匹配\n 甲\n-乙\n+乙二\n@@\n 丁\n+戊'));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.hunks).toHaveLength(2);
		expect(parsed.hunks[0]!.ops.map((op) => op.kind)).toEqual(['context', 'delete', 'insert']);
	});

	it('applyUpdateHunks - 两处按顺序套用 - 得到新全文', () => {
		const parsed = parseUpdatePatch(patch('@@\n 甲\n-乙\n+乙二\n@@\n 丁\n+戊'));
		if (!parsed.ok) throw new Error('parse');
		const applied = applyUpdateHunks(FILE, parsed.hunks);
		expect(applied).toEqual({ ok: true, content: '甲\n乙二\n丙\n丁\n戊\n' });
	});

	it('applyUpdateHunks - 上下文对不上 - mismatch 且不返回新正文', () => {
		const parsed = parseUpdatePatch(patch('@@\n 不存在\n-乙\n+乙二'));
		if (!parsed.ok) throw new Error('parse');
		expect(applyUpdateHunks(FILE, parsed.hunks)).toEqual({ ok: false, reason: 'mismatch' });
	});

	it('applyUpdateHunks - 上下文出现两次 - ambiguous', () => {
		const parsed = parseUpdatePatch(patch('@@\n 甲\n+插'));
		if (!parsed.ok) throw new Error('parse');
		expect(applyUpdateHunks('甲\n乙\n甲\n', parsed.hunks).ok).toBe(false);
		const again = applyUpdateHunks('甲\n乙\n甲\n', parsed.hunks);
		expect(again).toEqual({ ok: false, reason: 'ambiguous' });
	});

	it('parseUpdatePatch - 只有上下文没有增删 - empty', () => {
		expect(parseUpdatePatch(patch('@@\n 甲')).ok).toBe(false);
		const parsed = parseUpdatePatch(patch('@@\n 甲'));
		expect(parsed).toEqual({ ok: false, reason: 'empty' });
	});

	it('parseUpdatePatch - Add File - add', () => {
		const text = '*** Begin Patch\n*** Add File: a.md\n+hello\n*** End Patch\n';
		expect(parseUpdatePatch(text)).toEqual({ ok: false, reason: 'add' });
	});

	it('parseUpdatePatch - Delete File - delete', () => {
		const text = '*** Begin Patch\n*** Delete File: a.md\n*** End Patch\n';
		expect(parseUpdatePatch(text)).toEqual({ ok: false, reason: 'delete' });
	});

	it('parseUpdatePatch - Move to - move', () => {
		const text = '*** Begin Patch\n*** Update File: a.md\n*** Move to: b.md\n@@\n 甲\n+乙\n*** End Patch\n';
		expect(parseUpdatePatch(text)).toEqual({ ok: false, reason: 'move' });
	});

	it('parseUpdatePatch - 两个 Update File - multi', () => {
		const text = '*** Begin Patch\n*** Update File: a.md\n@@\n 甲\n+乙\n*** Update File: b.md\n@@\n 甲\n+乙\n*** End Patch\n';
		expect(parseUpdatePatch(text)).toEqual({ ok: false, reason: 'multi' });
	});

	it('applyUpdateHunks - End of File 不在末尾 - eof', () => {
		const parsed = parseUpdatePatch(patch('@@\n 甲\n+插\n*** End of File'));
		if (!parsed.ok) throw new Error('parse');
		expect(applyUpdateHunks(FILE, parsed.hunks)).toEqual({ ok: false, reason: 'eof' });
	});

	it('applyUpdateHunks - End of File 在末尾 - 插入成功', () => {
		const parsed = parseUpdatePatch(patch('@@\n 丁\n+戊\n*** End of File'));
		if (!parsed.ok) throw new Error('parse');
		expect(applyUpdateHunks(FILE, parsed.hunks)).toEqual({ ok: true, content: '甲\n乙\n丙\n丁\n戊\n' });
	});

	it('applyUpdateHunks - 只有插入没有上下文 - mismatch', () => {
		const parsed = parseUpdatePatch(patch('@@\n+插'));
		if (!parsed.ok) throw new Error('parse');
		expect(applyUpdateHunks(FILE, parsed.hunks)).toEqual({ ok: false, reason: 'mismatch' });
	});

	it('parseUpdatePatch - 缺少 End Patch - parse', () => {
		expect(parseUpdatePatch('*** Begin Patch\n*** Update File: a.md\n@@\n 甲\n+乙\n')).toEqual({
			ok: false,
			reason: 'parse',
		});
	});
});
