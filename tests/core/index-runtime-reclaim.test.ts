/**
 * @file tests/core/index-runtime-reclaim.test.ts
 * @description 启动恢复必须先回收孤立隔离事务,且回收失败不得阻断恢复
 * @module tests/core/index-runtime-reclaim
 */

import { describe, expect, it, vi } from 'vitest';
import { recoverIndexJournal } from '../../src/core/index-runtime-assembly';
import type { IndexFileJournal } from '../../src/core/index-file-journal';

/** 只暴露本用例关心的两个方法的假日志。 */
function makeJournal(overrides: Partial<Record<'reclaim', 'pending' | 'recover'>> = {}): {
	journal: IndexFileJournal;
	calls: string[];
} {
	const calls: string[] = [];
	const journal = {
		async reclaimOrphanQuarantinedTransactions() {
			calls.push('reclaim');
			if (overrides.reclaim === 'reclaim') throw new Error('reclaim failed');
			return { reclaimed: ['t-1'], retained: [] };
		},
		async listPendingPaths() {
			calls.push('pending');
			if (overrides.pending === 'pending') throw new Error('list failed');
			return [];
		},
		async recover() {
			calls.push('recover');
			if (overrides.recover === 'recover') throw new Error('recover failed');
			return { decisions: [], failures: [] };
		},
	} as unknown as IndexFileJournal;
	return { journal, calls };
}

const vault = { listMarkdownFiles: () => [], readFile: async () => '', stat: async () => ({ mtime: 0, size: 0 }) };

describe('启动恢复中的隔离事务回收', () => {
	it('没有未决事务时也回收 - 不读全库正文', async () => {
		const { journal, calls } = makeJournal();
		await recoverIndexJournal({ journal, vault: vault as never });
		expect(calls).toEqual(['reclaim', 'pending']);
	});

	it('回收失败 - 记录后继续恢复判定 - 不中断启动', async () => {
		const { journal, calls } = makeJournal({ reclaim: 'reclaim' });
		await recoverIndexJournal({ journal, vault: vault as never });
		expect(calls).toEqual(['reclaim', 'pending']);
	});

	it('未装配日志 - 直接返回 - 不触碰 Vault', async () => {
		const readFile = vi.fn();
		await recoverIndexJournal({ journal: undefined, vault: { listMarkdownFiles: () => [], readFile, stat: async () => ({ mtime: 0, size: 0 }) } as never });
		expect(readFile).not.toHaveBeenCalled();
	});
});
