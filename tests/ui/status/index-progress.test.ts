/** 索引进度来自结构化计数，不能由状态文案或上下文占用推断。 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_STATUS } from '../../../src/user-feedback/user-status';
import { indexProgressView } from '../../../src/ui/status/index-progress';

describe('索引详情进度', () => {
	it('处理 172/2803 篇 - 文案没有比例 - 仍显示 6.1% 文件进度', () => {
		expect(indexProgressView({ ...DEFAULT_USER_STATUS, index: 'processing', indexDetail: '重新核对中', indexTotalFiles: 2803, indexCommittedFiles: 172, indexPendingFiles: 2631, indexFailedFiles: 0 }))
			.toMatchObject({ completed: 172, total: 2803, pending: 2631, percentage: 6.1 });
	});
	it('总量未知 - 0/0 - 不产生 NaN 或假装已完成', () => {
		expect(indexProgressView({ ...DEFAULT_USER_STATUS, index: 'scanning', indexTotalFiles: 0, indexCommittedFiles: 0 }).percentage).toBeNull();
	});
	it('过期计数超过总量 - 展示限制在百分之百 - 不改变真实状态', () => {
		expect(indexProgressView({ ...DEFAULT_USER_STATUS, index: 'processing', indexTotalFiles: 2, indexCommittedFiles: 3 })).toMatchObject({ completed: 2, percentage: 100 });
	});
	it('旧后端仅提供就绪文件数 - 兼容展示 - 进度完整', () => {
		expect(indexProgressView({ ...DEFAULT_USER_STATUS, index: 'ready', indexDocCount: 12 })).toMatchObject({ total: 12, completed: 12, percentage: 100 });
	});
	it('非有限计数 - 安全显示未知总量 - 不渲染非法进度值', () => {
		expect(indexProgressView({ ...DEFAULT_USER_STATUS, indexTotalFiles: Number.NaN, indexCommittedFiles: Number.POSITIVE_INFINITY }).percentage).toBeNull();
	});
	it('块阶段 - 已写/共 M 块按块计 - 仍含预估时标记出来', () => {
		expect(indexProgressView({
			...DEFAULT_USER_STATUS,
			index: 'processing',
			indexTotalBlocks: 40,
			indexCommittedBlocks: 12,
			indexStoredBlocks: 16,
			indexReusedBlocks: 90,
			indexBlocksEstimated: true,
		}).blocks).toEqual({ total: 40, committed: 12, stored: 16, reused: 90, estimated: true, percentage: 30 });
	});
	it('没有块计数 - 不伪造块进度', () => {
		expect(indexProgressView({ ...DEFAULT_USER_STATUS, index: 'scanning' }).blocks).toBeNull();
	});
	it('发现阶段 - 未变/新增/变更/失效按篇透传', () => {
		expect(indexProgressView({
			...DEFAULT_USER_STATUS,
			indexSkippedFiles: 7,
			indexAddedFiles: 2,
			indexChangedFiles: 3,
			indexRemovedFiles: 1,
		}).discovery).toEqual({ unchanged: 7, added: 2, changed: 3, removed: 1 });
	});
});
