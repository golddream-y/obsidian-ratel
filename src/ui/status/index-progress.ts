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
	return {
		total,
		completed,
		pending: count(snap.indexPendingFiles),
		failed: count(snap.indexFailedFiles),
		percentage: total > 0 ? Math.floor(completed / total * 1000) / 10 : null,
	};
}
