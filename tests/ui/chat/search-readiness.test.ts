/**
 * @file tests/ui/chat/search-readiness.test.ts
 * @description 检索就绪判定 — 索引未收敛但已有可检索版本时仍允许检索
 * @module tests/ui/chat/search-readiness
 */

import { describe, expect, it } from 'vitest';
import { isSearchReady } from '../../../src/ui/chat/chat-send-gate';
import type { UserStatusSnapshot } from '../../../src/user-feedback/user-status';

/** 构造最小快照。 */
function snapshot(patch: Partial<UserStatusSnapshot>): UserStatusSnapshot {
	return {
		model: 'ready',
		index: 'ready',
		embedding: 'ready',
		worker: 'thread',
		...patch,
	};
}

describe('isSearchReady', () => {
	it('索引已就绪 - 可检索', () => {
		expect(isSearchReady(snapshot({}))).toBe(true);
	});

	// 关键路径(2026-11-07 线上):索引中一律拒绝检索，与「已完成的笔记可用于搜索」自相矛盾。
	it('索引进行中但已有提交文件 - 仍可检索', () => {
		expect(isSearchReady(snapshot({ index: 'processing', indexCommittedFiles: 120 }))).toBe(true);
	});

	it('索引进行中且没有任何提交文件 - 不可检索', () => {
		expect(isSearchReady(snapshot({ index: 'processing', indexCommittedFiles: 0 }))).toBe(false);
	});

	it('嵌入未就绪 - 一律不可检索', () => {
		expect(isSearchReady(snapshot({ embedding: 'loading', indexCommittedFiles: 120 }))).toBe(false);
	});
});
