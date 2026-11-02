/**
 * @file tests/core/index-thread-visibility-gate.test.ts
 * @description 线程可见性门 — 有记录放行、无记录拒绝、读取失败如实降级
 * @module tests/core/index-thread-visibility-gate
 */

import { describe, expect, it } from 'vitest';
import { createThreadVisibilityGate } from '../../src/core/index-thread-visibility-gate';

/** 记录集工厂。 */
function records(list: Array<{ path: string; state: 'present' | 'deleted' }>) {
	return list.map((item, index) => ({ ...item, revision: index + 1, inputHash: 'a'.repeat(64), chunkCount: 1 }));
}

describe('线程可见性门', () => {
	it('已提交路径 - 放行且标记 verified - 可承诺块定位', async () => {
		const gate = createThreadVisibilityGate({ listCommitted: async () => records([{ path: 'a.md', state: 'present' }]) });
		await gate.refresh?.();
		await expect(gate.decide('a.md')).resolves.toMatchObject({ visible: true, freshness: 'verified' });
	});

	it('没有完成记录的路径 - 拒绝 - 原因稳定', async () => {
		const gate = createThreadVisibilityGate({ listCommitted: async () => records([{ path: 'a.md', state: 'present' }]) });
		await gate.refresh?.();
		await expect(gate.decide('b.md')).resolves.toMatchObject({ visible: false, reason: 'no-committed-record' });
	});

	it('已删除记录 - 拒绝 - 新鲜度为 stale', async () => {
		const gate = createThreadVisibilityGate({ listCommitted: async () => records([{ path: 'a.md', state: 'deleted' }]) });
		await gate.refresh?.();
		await expect(gate.decide('a.md')).resolves.toMatchObject({ visible: false, freshness: 'known-stale' });
	});

	it('记录读取失败 - 降级为不可判定 - 不伪装成空库', async () => {
		const gate = createThreadVisibilityGate({ listCommitted: async () => { throw new Error('线程停止'); } });
		await gate.refresh?.();
		expect(gate.recordsKind?.()).toBe('unjudgeable');
		await expect(gate.decide('a.md')).resolves.toMatchObject({ visible: false, reason: 'records-unjudgeable' });
	});
});
