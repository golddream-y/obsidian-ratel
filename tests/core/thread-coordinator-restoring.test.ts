/**
 * @file tests/core/thread-coordinator-restoring.test.ts
 * @description 恢复阶段判定 — 内容变更的记录也要让恢复态结束
 * @module tests/core/thread-coordinator-restoring
 */

import { describe, expect, it } from 'vitest';
import { IndexThreadCoordinator, type ThreadIndexClient, type ThreadIndexVault } from '../../src/core/index-thread-coordinator';

/** 构造最小协调器：记录 3 条，其中 1 条内容已变（重做）、2 条跳过。 */
function makeCoordinator(): { coordinator: IndexThreadCoordinator; outcomes: string[] } {
	const outcomes: string[] = [];
	const client: ThreadIndexClient = {
		start: async () => undefined,
		indexFile: async (filePath) => {
			// a、b 内容未变 → 跳过；c 内容变了 → 重做（返回非 skipped）
			if (filePath === 'c.md') {
				outcomes.push(`write:${filePath}`);
				return { chunkCount: 2 };
			}
			outcomes.push(`skip:${filePath}`);
			return { chunkCount: 1, skipped: true };
		},
		deleteFile: async () => ({ removed: 0 }),
		recover: async () => ({ pending: 0, decisions: 0, failures: 0 }),
		close: async () => undefined,
		listCommitted: async () => [
			{ path: 'a.md', state: 'present' as const },
			{ path: 'b.md', state: 'present' as const },
			{ path: 'c.md', state: 'present' as const },
		],
	};
	const vault: ThreadIndexVault = {
		listMarkdownFiles: () => ['a.md', 'b.md', 'c.md'],
		readFile: async () => 'content',
	};
	const coordinator = new IndexThreadCoordinator({
		client,
		vault,
		start: { root: '/tmp/restoring-test', generationId: 'gen-x', configFingerprint: 'f'.repeat(64) },
	});
	return { coordinator, outcomes };
}

describe('恢复阶段判定', () => {
	it('内容变更的记录重做后 - 恢复态必须结束', async () => {
		const { coordinator, outcomes } = makeCoordinator();
		const counters = await coordinator.start();
		// 三篇都有完成记录：两篇跳过、一篇重做，核对数应为 3 而不是 2。
		expect(outcomes).toContain('write:c.md');
		expect(counters.restoredTotal).toBe(3);
		expect(counters.restoredFiles).toBe(3);
		expect(counters.restoring).toBe(false);
	});
});
