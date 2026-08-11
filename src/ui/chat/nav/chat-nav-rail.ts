/**
 * @file src/ui/chat/nav/chat-nav-rail.ts
 * @description 对话进度轨纯函数 — 锚点、抽稀、拇指比例
 * @module ui/chat/nav/chat-nav-rail
 */

export interface ChatNavAnchor {
	id: string;
	summary: string;
	/** 在 messages 数组中的下标 */
	index: number;
}

export const CHAT_NAV_TICK_CAP = 12;

type Seg = { type: string; text?: string };
type MsgLike = { id: string; role: string; segments: Seg[] };

/**
 * 从消息 segments 拼出纯文本（仅 text 段）。
 */
export function textFromMessage(msg: { segments: Seg[] }): string {
	return msg.segments
		.filter((s) => s.type === 'text' && typeof s.text === 'string')
		.map((s) => s.text!.trim())
		.filter(Boolean)
		.join(' ');
}

/**
 * 刻度悬停摘要 — 压空白并截断。
 */
export function summarizeNavText(text: string, maxChars = 24): string {
	const t = text.replace(/\s+/g, ' ').trim();
	if (t.length <= maxChars) return t;
	return t.slice(0, Math.max(0, maxChars - 1)) + '…';
}

/**
 * 提取 user 轮次锚点（按 messages 顺序）。
 */
export function extractUserAnchors(messages: MsgLike[]): ChatNavAnchor[] {
	const out: ChatNavAnchor[] = [];
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i]!;
		if (m.role !== 'user') continue;
		out.push({
			id: m.id,
			summary: summarizeNavText(textFromMessage(m), 36),
			index: i,
		});
	}
	return out;
}

/**
 * 刻度过多时抽稀：必留首、尾；若有 visibleId 则留它及其邻域；其余均匀取样至 cap。
 *
 * keep 可能因首尾+visible 邻域超过 cap；不得用 slice(0, cap) 丢掉末项。
 */
export function thinAnchors(
	anchors: ChatNavAnchor[],
	visibleId: string | null,
	cap: number = CHAT_NAV_TICK_CAP,
): ChatNavAnchor[] {
	if (anchors.length <= cap) return anchors.slice();
	if (cap <= 0) return [];
	const firstId = anchors[0]!.id;
	const lastId = anchors[anchors.length - 1]!.id;
	const byId = new Map(anchors.map((a) => [a.id, a]));
	const keep = new Set<string>();
	keep.add(firstId);
	keep.add(lastId);
	const preferred = new Set<string>();
	if (visibleId && byId.has(visibleId)) {
		const vi = anchors.findIndex((a) => a.id === visibleId);
		for (let d = -1; d <= 1; d++) {
			const a = anchors[vi + d];
			if (a) {
				keep.add(a.id);
				preferred.add(a.id);
			}
		}
	}
	// 均匀填满剩余名额
	const step = (anchors.length - 1) / Math.max(1, cap - 1);
	for (let i = 0; i < cap && keep.size < cap; i++) {
		const idx = Math.round(i * step);
		keep.add(anchors[Math.min(anchors.length - 1, idx)]!.id);
	}
	const ordered = anchors.filter((a) => keep.has(a.id));
	if (ordered.length <= cap) return ordered;

	// keep 超额：强制保留首尾，再优先 visible 邻域，其余按序填满
	const selected = new Set<string>([firstId]);
	if (cap >= 2) selected.add(lastId);
	for (const id of preferred) {
		if (selected.size >= cap) break;
		selected.add(id);
	}
	for (const a of ordered) {
		if (selected.size >= cap) break;
		selected.add(a.id);
	}
	// 关键路径：再滤一遍，保证顺序且末项仍是会话最后锚点
	return ordered.filter((a) => selected.has(a.id));
}

/**
 * 内容高度不足以滚动时不显示轨。
 */
export function needsRail(scrollHeight: number, clientHeight: number, epsilon = 8): boolean {
	return scrollHeight > clientHeight + epsilon;
}

/**
 * 拇指比例 [0,1]；不可滚动时为 0。
 */
export function thumbRatio(scrollTop: number, scrollHeight: number, clientHeight: number): number {
	const max = scrollHeight - clientHeight;
	if (max <= 0) return 0;
	const r = scrollTop / max;
	return Math.min(1, Math.max(0, r));
}
