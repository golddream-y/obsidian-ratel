/**
 * @file src/ui/status/index-progress.ts
 * @description 索引展示的数值归一化；不从文案解析进度，不参与完成判定。
 */
import type { UserStatusSnapshot } from '../../user-feedback/user-status';

/** 只在总量已知时显示百分比；防止未知总量、非有限值与过期计数产生 NaN 或越界进度。 */
export function indexProgressView(snap: UserStatusSnapshot) {
	const count = (n: number | undefined): number => Number.isFinite(n) ? Math.max(0, Math.floor(n!)) : 0;
	const total = count(snap.indexTotalFiles ?? (snap.index === 'ready' ? snap.indexDocCount : undefined));
	const completed = Math.min(total, count(snap.indexCommittedFiles ?? (snap.index === 'ready' ? snap.indexDocCount : undefined)));
	const blocksTotal = count(snap.indexTotalBlocks);
	const blocksCommitted = Math.min(blocksTotal, count(snap.indexCommittedBlocks));
	return {
		total,
		completed,
		pending: count(snap.indexPendingFiles),
		failed: count(snap.indexFailedFiles),
		percentage: total > 0 ? Math.floor(completed / total * 1000) / 10 : null,
		/**
		 * 块级进度 — 与文件进度分开汇报。
		 *
		 * 关键路径：块是唯一吞吐单位；`total` 可能仍含未分块文件的预估，界面必须
		 * 通过 `estimated` 标明「预估」还是「实际」，不能让用户把预估当精确值。
		 */
		blocks: blocksTotal > 0
			? {
				total: blocksTotal,
				committed: blocksCommitted,
				stored: count(snap.indexStoredBlocks),
				reused: count(snap.indexReusedBlocks),
				estimated: snap.indexBlocksEstimated === true,
				percentage: Math.floor(blocksCommitted / blocksTotal * 1000) / 10,
			}
			: null,
		/** 发现阶段结论（按篇） — 只报数量，不参与速率。 */
		discovery: {
			unchanged: count(snap.indexSkippedFiles),
			added: count(snap.indexAddedFiles),
			changed: count(snap.indexChangedFiles),
			removed: count(snap.indexRemovedFiles),
		},
	};
}
