/**
 * @file src/ui/status/tone.ts
 * @description 共享 tone 计算逻辑 — Header badge 与 StatusLine 共用,避免逻辑重复
 * @module ui/status/tone
 * @depends user-feedback/user-status
 */

import type { UserStatusSnapshot } from '../../user-feedback/user-status';

/** 状态色调,5 种视觉区分 */
export type Tone = 'ready' | 'thinking' | 'error' | 'unconfigured' | 'indexing';

/**
 * 从 UserStatusSnapshot 派生 tone — 优先级:索引中 > 错误 > 未配置 > 思考中 > 就绪。
 *
 * 关键路径:Header model-badge 与 StatusLine.dot 必须用同一份 tone 逻辑,
 * 否则两者颜色不同步会让用户困惑。index 字段的 processing/scanning/queueing/diffing
 * 四种状态都归为 indexing tone(diffing 是 smartReindex 的 hash 比对阶段,用户感知也是"索引中")。
 *
 * @param snap - 使用者状态快照
 * @returns `{ tone }` — 调用方根据 tone 自行决定 label 和样式
 */
export function deriveTone(snap: UserStatusSnapshot): { tone: Tone } {
	// 关键路径:索引中优先于思考中(用户更关心索引进度)
	// 关键路径:diffing 是 smartReindex 的 hash 比对阶段,归为 indexing tone
	if (snap.index === 'processing' || snap.index === 'scanning' || snap.index === 'queueing' || snap.index === 'diffing') {
		return { tone: 'indexing' };
	}
	if (snap.model === 'failed' || snap.index === 'failed') {
		return { tone: 'error' };
	}
	if (snap.model === 'idle' && snap.embedding === 'unavailable') {
		return { tone: 'unconfigured' };
	}
	if (snap.model !== 'ready' && snap.model !== 'idle') {
		return { tone: 'thinking' };
	}
	return { tone: 'ready' };
}
