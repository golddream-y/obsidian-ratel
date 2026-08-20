/**
 * @file src/ui/chat/tool-detail-model.ts
 * @description 工具旁注中间层 — 封闭形态判别联合(编码稳定性来源)
 * @module ui/chat/tool-detail-model
 */

/** 列表预览条数上限(normalize/render 共用) */
export const TOOL_DETAIL_LIST_PREVIEW = 12;

/**
 * 工具展开旁注的稳定形态 — 种类封闭,新增须改 S-CHAT-TRACE。
 */
export type ToolDetailModel =
	| { kind: 'busy'; label?: string }
	| { kind: 'error'; message: string }
	| {
			kind: 'listing';
			path: string;
			files: string[];
			folders: string[];
	  }
	| {
			kind: 'links';
			path?: string;
			outgoing: number;
			backlinks: number;
			unresolved: number;
	  }
	| {
			kind: 'hits';
			items: string[];
			hint?: 'reranked' | 'grep' | 'generic';
			/** 检索/过滤条件 — 各字段互斥使用,避免 pattern 兼作 tag */
			query?: string;
			pattern?: string;
			tag?: string;
			property?: string;
			path?: string;
	  }
	| { kind: 'snippet'; path?: string; chars: number }
	| { kind: 'kv'; entries: Array<{ key: string; value: string }> }
	| { kind: 'empty' };
