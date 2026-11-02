/**
 * @file src/core/index-thread-visibility-gate.ts
 * @description 线程版检索可见性门 — 用线程内完成记录判定候选是否可检索
 * @module src/core/index-thread-visibility-gate
 *
 * 关键路径:
 * - 门必须在融合与精排之前给出判定,否则被拒内容会先进入模型再被丢弃。
 * - 记录取不到时返回 `unjudgeable`,而不是「全部拒绝」——两者对用户含义完全不同:
 *   前者是「不知道」,后者是「确实没有可检索内容」。
 * - 线程不可用时同样如实降级,不把「读不到记录」伪装成「没有命中」。
 */

import type { SearchCandidateGate, SearchCandidateVerdict } from './multi-query-searcher';

/** 线程侧最小记录能力。 */
export interface ThreadRecordClient {
	listCommitted(): Promise<Array<{
		path: string;
		state: 'present' | 'deleted';
		revision: number;
		inputHash: string | null;
		chunkCount: number;
	}>>;
}

/** 门内部缓存。 */
interface GateState {
	records: Map<string, { state: 'present' | 'deleted'; revision: number }>;
	kind: 'known' | 'unjudgeable';
}

/**
 * 构造线程版可见性门。
 * @param client 已打开的索引线程客户端
 */
export function createThreadVisibilityGate(client: ThreadRecordClient): SearchCandidateGate {
	const state: GateState = { records: new Map(), kind: 'unjudgeable' };

	return {
		async refresh(): Promise<unknown> {
			try {
				const records = await client.listCommitted();
				state.records = new Map(records.map((record) => [record.path, { state: record.state, revision: record.revision }]));
				state.kind = 'known';
			} catch {
				// 关键路径:读不到记录 ≠ 没有内容;保留 unjudgeable 让上层如实呈现。
				state.records = new Map();
				state.kind = 'unjudgeable';
			}
			return state.kind;
		},

		async decide(path: string): Promise<SearchCandidateVerdict> {
			if (state.kind !== 'known') {
				return { visible: false, path, freshness: 'unknown', reason: 'records-unjudgeable' };
			}
			const record = state.records.get(path);
			if (record === undefined) {
				return { visible: false, path, freshness: 'unknown', reason: 'no-committed-record' };
			}
			if (record.state !== 'present') {
				return { visible: false, path, freshness: 'known-stale', reason: 'deleted' };
			}
			// 关键路径:已提交且仍是 present 才算本轮核对通过,可以承诺精确块定位。
			return { visible: true, path, freshness: 'verified' };
		},

		recordsKind(): 'known' | 'unjudgeable' {
			return state.kind;
		},
	};
}
