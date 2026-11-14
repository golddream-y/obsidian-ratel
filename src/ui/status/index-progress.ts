/**
 * @file src/ui/status/index-progress.ts
 * @description 索引展示的数值归一化；不从文案解析进度，不参与完成判定。
 * @module ui/status/index-progress
 */
import type { UserStatusSnapshot } from '../../user-feedback/user-status';

/** 归一化展示计数、阶段与色调；预估总量不参与精确百分比或吞吐展示。 */
export function indexProgressView(snap: UserStatusSnapshot) {
	const count = (n: number | undefined): number => Number.isFinite(n) ? Math.max(0, Math.floor(n!)) : 0;
	const indexing = ['scanning', 'processing', 'queueing', 'diffing', 'init'].includes(snap.index);
	const blocksTotal = count(snap.indexTotalBlocks);
	const estimated = snap.indexBlocksEstimated === true;
	// 修复:暂估总量可能小于真实完成量，不能截断已经完成的块数。
	const blocksCommitted = estimated ? count(snap.indexCommittedBlocks) : Math.min(blocksTotal, count(snap.indexCommittedBlocks));
	const blocks = blocksTotal > 0 || estimated
		? {
			total: blocksTotal,
			committed: blocksCommitted,
			stored: count(snap.indexStoredBlocks),
			reused: count(snap.indexReusedBlocks),
			estimated,
			percentage: estimated ? null : Math.floor(blocksCommitted / blocksTotal * 1000) / 10,
		}
		: null;
	// 关键路径:恢复标志可能覆盖整轮；真实写入开始后切换到块口径。
	const blockPhase = indexing && blocks !== null && (
		blocks.committed > 0 || blocks.stored > 0 || (snap.index === 'processing' && snap.indexRestoring !== true)
	);
	const verifying = indexing && snap.indexRestoring === true && !blockPhase;
	const total = count(verifying ? snap.indexRestoredTotal : snap.indexTotalFiles ?? (snap.index === 'ready' ? snap.indexDocCount : undefined));
	const completed = Math.min(total, count(verifying ? snap.indexRestoredFiles : snap.indexCommittedFiles ?? (snap.index === 'ready' ? snap.indexDocCount : undefined)));
	const percentage = total > 0 ? Math.floor(completed / total * 1000) / 10 : null;
	const failed = count(snap.indexFailedFiles);
	const tone = snap.index === 'failed' ? 'error'
		: failed > 0 || indexing || snap.indexPhase === 'stalled' || snap.indexPhase === 'stopping' ? 'warning'
			: snap.index === 'ready' ? 'success' : 'muted';
	return {
		total,
		completed,
		// 就绪时保留全库已索引篇数，不把本轮提交数描述成本轮更新篇数。
		indexed: count(snap.indexDocCount ?? completed),
		pending: count(snap.indexPendingFiles),
		failed,
		// 正常就绪后收起工程入口；失败和异常提示仍须保留排查入口。
		showDiagnostics: snap.index !== 'ready' || failed > 0 || snap.indexNotice !== undefined
			|| snap.indexPhase === 'stalled' || snap.indexPhase === 'stopping' || snap.indexPhase === 'partial-failure',
		percentage,
		blocks,
		blockPhase,
		barPercentage: blockPhase ? blocks.percentage : percentage,
		blocksPerSecond: blockPhase && !estimated ? snap.indexBlocksPerSecond : undefined,
		tone,
		/** 发现阶段结论（按篇），只供折叠诊断使用。 */
		discovery: {
			unchanged: count(snap.indexSkippedFiles),
			added: count(snap.indexAddedFiles),
			changed: count(snap.indexChangedFiles),
			removed: count(snap.indexRemovedFiles),
		},
	};
}
