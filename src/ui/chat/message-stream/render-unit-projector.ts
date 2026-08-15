/**
 * @file src/ui/chat/message-stream/render-unit-projector.ts
 * @description 把完整消息流投影为可虚拟化的稳定渲染单元
 * @module ui/chat/message-stream/render-unit-projector
 * @depends ./types, ../stable-markdown-projection, ../../../utils/markdown-renderer
 */
import { splitStableMarkdownBlocks } from '../../../utils/markdown-renderer';
import {
	StableMarkdownProjection,
	type MarkdownSplitter,
} from '../stable-markdown-projection';
import type { Message, MessageSegment } from './types';

/** 逻辑消息内的单元位置 — 决定附件、footer 与进场动画归属 */
export type MessageUnitPosition = 'only' | 'first' | 'middle' | 'last';

/** 普通消息渲染单元 — 逻辑消息的一个分片(稳定块/活动尾部/工具组) */
export interface MessageRenderUnit {
	kind: 'message';
	id: string;
	messageId: string;
	messageIndex: number;
	msg: Message;
	segments: MessageSegment[];
	position: MessageUnitPosition;
	anchor: boolean;
	showAttachments: boolean;
	showFooter: boolean;
	streaming: boolean;
}

/** compact 压缩分隔行渲染单元 */
export interface CompactRenderUnit {
	kind: 'compact';
	id: string;
	messageId: string;
	messageIndex: number;
	phase: Message['compactPhase'];
}

/** 虚拟跳转请求 — token 递增去重,同 token 不重复处理 */
export interface VirtualJumpRequest {
	messageId: string;
	token: number;
}

/** 虚拟化渲染单元判别联合 */
export type RenderUnit = MessageRenderUnit | CompactRenderUnit;

interface MessageUnitDraft {
	id: string;
	segments: MessageSegment[];
	streaming: boolean;
}

interface StaticTextCache {
	text: string;
	blocks: Array<{ id: string; source: string }>;
}

/**
 * 维护活动 text segment 的稳定块缓存,并为静态消息执行一次块投影。
 *
 * 设计要点:
 * - 活动文本复用增量投影,历史静态文本按内容缓存拆分结果。
 * - 投影异常时回退为一条消息一个单元,优先保证内容可见。
 *
 * @example
 *   const projector = new RenderUnitProjector();
 *   const units = projector.project(messages, true);
 */
export class RenderUnitProjector {
	private active = new Map<string, StableMarkdownProjection>();
	private staticText = new Map<string, StaticTextCache>();

	constructor(private readonly splitStatic: MarkdownSplitter = splitStableMarkdownBlocks) {}

	/**
	 * 投影完整消息数组;失败时回退为一条消息一个单元。
	 *
	 * @param messages - UI 消息事实源
	 * @param isRunning - Agent Loop 是否运行中
	 * @returns 稳定 id 的渲染单元
	 * @example
	 *   projector.project(messages, false);
	 */
	project(messages: Message[], isRunning: boolean): RenderUnit[] {
		try {
			return this.projectUnsafe(messages, isRunning);
		} catch {
			// 修复:投影异常时清缓存整体降级 — 保证任何输入下内容可见
			this.active.clear();
			this.staticText.clear();
			return messages.map((msg, messageIndex): RenderUnit => msg.role === 'compact'
				? { kind: 'compact', id: `compact:${msg.id}`, messageId: msg.id, messageIndex, phase: msg.compactPhase }
				: {
					kind: 'message', id: `message:${msg.id}`, messageId: msg.id, messageIndex,
					msg, segments: msg.segments, position: 'only', anchor: true,
					showAttachments: true, showFooter: true, streaming: false,
				});
		}
	}

	private projectUnsafe(messages: Message[], isRunning: boolean): RenderUnit[] {
		const units: RenderUnit[] = [];
		const liveKeys = new Set<string>();
		const seenTextKeys = new Set<string>();
		for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
			const msg = messages[messageIndex]!;
			if (msg.role === 'compact') {
				units.push({ kind: 'compact', id: `compact:${msg.id}`, messageId: msg.id, messageIndex, phase: msg.compactPhase });
				continue;
			}
			if (msg.role === 'user') {
				units.push(this.toUnit(msg, messageIndex, {
					id: `message:${msg.id}`, segments: msg.segments, streaming: false,
				}, 0, 1));
				continue;
			}

			const drafts: MessageUnitDraft[] = [];
			let trace: MessageSegment[] = [];
			const flushTrace = () => {
				if (trace.length === 0) return;
				const start = drafts.length;
				drafts.push({ id: `${msg.id}:trace:${start}`, segments: trace, streaming: false });
				trace = [];
			};

			for (let segmentIndex = 0; segmentIndex < msg.segments.length; segmentIndex++) {
				const seg = msg.segments[segmentIndex]!;
				if (seg.type === 'tool' || seg.type === 'think') {
					trace.push(seg);
					continue;
				}
				flushTrace();
				if (seg.type !== 'text') {
					drafts.push({ id: `${msg.id}:seg:${segmentIndex}`, segments: [seg], streaming: false });
					continue;
				}

				// 关键路径:只有运行中最后一条消息的最后一段才算活动尾部;
				// 文本后出现工具时,前一文本立即走静态路径冻结。
				const isActive = isRunning &&
					messageIndex === messages.length - 1 &&
					segmentIndex === msg.segments.length - 1;
				const key = `${msg.id}:${segmentIndex}`;
				seenTextKeys.add(key);
				if (isActive) {
					liveKeys.add(key);
					this.staticText.delete(key);
					const projection = this.active.get(key) ?? new StableMarkdownProjection(this.splitStatic);
					this.active.set(key, projection);
					const snapshot = projection.update(seg.text);
					for (const block of snapshot.blocks) {
						drafts.push({ id: `${key}:${block.id}`, segments: [{ type: 'text', text: block.source }], streaming: false });
					}
					if (snapshot.tail) {
						drafts.push({ id: `${key}:tail`, segments: [{ type: 'text', text: snapshot.tail }], streaming: true });
					}
					continue;
				}

				const cachedActive = this.active.get(key);
				let cachedStatic = this.staticText.get(key);
				if (!cachedStatic || cachedStatic.text !== seg.text) {
					const blocks = cachedActive
						? cachedActive.finish(seg.text).blocks.map((block) => ({ id: `${key}:${block.id}`, source: block.source }))
						: this.splitStatic(seg.text, true).stableBlocks.map((source, index) => ({ id: `${key}:static:${index}`, source }));
					cachedStatic = { text: seg.text, blocks };
					this.staticText.set(key, cachedStatic);
				}
				this.active.delete(key);
				for (const block of cachedStatic.blocks) {
					drafts.push({ id: block.id, segments: [{ type: 'text', text: block.source }], streaming: false });
				}
			}
			flushTrace();
			if (drafts.length === 0) {
				drafts.push({ id: `${msg.id}:empty`, segments: [], streaming: false });
			}
			for (let i = 0; i < drafts.length; i++) units.push(this.toUnit(msg, messageIndex, drafts[i]!, i, drafts.length));
		}
		// 关键路径:清理不再存活的消息级缓存,防止长会话泄漏
		for (const key of this.active.keys()) if (!liveKeys.has(key)) this.active.delete(key);
		for (const key of this.staticText.keys()) if (!seenTextKeys.has(key)) this.staticText.delete(key);
		return units;
	}

	private toUnit(
		msg: Message,
		messageIndex: number,
		draft: MessageUnitDraft,
		index: number,
		total: number,
	): MessageRenderUnit {
		const position: MessageUnitPosition = total === 1 ? 'only' : index === 0 ? 'first' : index === total - 1 ? 'last' : 'middle';
		return {
			kind: 'message', id: draft.id, messageId: msg.id, messageIndex, msg,
			segments: draft.segments, position, anchor: index === 0,
			showAttachments: index === 0, showFooter: index === total - 1,
			streaming: draft.streaming,
		};
	}
}
