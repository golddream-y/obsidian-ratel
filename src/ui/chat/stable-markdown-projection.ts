/**
 * @file src/ui/chat/stable-markdown-projection.ts
 * @description 管理流式 Markdown 的稳定块、活动尾部与源码偏移 id
 * @module ui/chat/stable-markdown-projection
 * @depends ../../utils/markdown-renderer
 */
import {
	splitStableMarkdownBlocks,
	type StableMarkdownSplit,
} from '../../utils/markdown-renderer';

/** 已冻结的稳定块 — id 由源码偏移生成,供 Svelte keyed each 复用 DOM */
export interface StableMarkdownBlock {
	id: string;
	start: number;
	end: number;
	source: string;
}

/** 投影快照 — 稳定块数组与活动尾部,每次 update/finish 返回新副本 */
export interface StableMarkdownSnapshot {
	blocks: StableMarkdownBlock[];
	tail: string;
}

/** 尾部拆分函数签名 — 供测试注入 mock,默认为 splitStableMarkdownBlocks */
export type MarkdownSplitter = (text: string, finalize: boolean) => StableMarkdownSplit;

/**
 * 增量维护稳定 Markdown 块;已生成块永不因后续正常 delta 改写。
 *
 * 设计要点:
 * - 仅分析尚未冻结的尾部,避免每次 delta 重做全量 lexer。
 * - 使用源码偏移生成稳定 id,保证 keyed DOM 节点能够复用。
 *
 * @example
 *   const projection = new StableMarkdownProjection();
 *   projection.update('第一段。\n\n第二');
 */
export class StableMarkdownProjection {
	private fullText = '';
	private tail = '';
	private consumed = 0;
	private blocks: StableMarkdownBlock[] = [];

	constructor(private readonly split: MarkdownSplitter = splitStableMarkdownBlocks) {}

	/**
	 * 接收最新完整文本,只在新增换行或围栏候选时分析尾部。
	 *
	 * @param nextText - 当前 text segment 的最新完整文本
	 * @returns 稳定块与活动尾部快照
	 * @example
	 *   projection.update('第一段。\n\n第二');
	 */
	update(nextText: string): StableMarkdownSnapshot {
		// 关键路径:CRLF 归一化 — 与 splitStableMarkdownBlocks 保持文本一致,
		// 保证 fullText/tail/块偏移全部基于归一化坐标,id 不因 \r 漂移。
		const normalized = nextText.replace(/\r\n?/g, '\n');
		if (!normalized.startsWith(this.fullText)) this.reset();
		const delta = normalized.slice(this.fullText.length);
		this.fullText = normalized;
		this.tail += delta;
		if (!/[\n`~]/.test(delta)) return this.snapshot();
		this.promote(this.split(this.tail, false));
		return this.snapshot();
	}

	/**
	 * 完成本段,只切剩余尾部,不重新处理已冻结块。
	 *
	 * @param nextText - text segment 的最终完整文本
	 * @returns 尾部完成后的稳定块快照
	 * @example
	 *   projection.finish('第一段。\n\n第二段。');
	 */
	finish(nextText: string): StableMarkdownSnapshot {
		this.update(nextText);
		this.promote(this.split(this.tail, true));
		return this.snapshot();
	}

	/**
	 * 返回不可变快照,供 Svelte keyed each 使用。
	 *
	 * @returns 当前稳定块数组副本与活动尾部
	 * @example
	 *   const snapshot = projection.snapshot();
	 */
	snapshot(): StableMarkdownSnapshot {
		return { blocks: this.blocks.slice(), tail: this.tail };
	}

	/**
	 * 清理会话切换或非前缀改写产生的旧投影。
	 *
	 * @returns 无返回值
	 * @example
	 *   projection.reset();
	 */
	reset(): void {
		this.fullText = '';
		this.tail = '';
		this.consumed = 0;
		this.blocks = [];
	}

	private promote(result: StableMarkdownSplit): void {
		for (const source of result.stableBlocks) {
			const start = this.consumed;
			const end = start + source.length;
			// 关键路径:冻结块对象 — 已晋升块对外只读,防止快照消费方篡改内部状态
			this.blocks.push(Object.freeze({ id: `md:${start}:${end}`, start, end, source }));
			this.consumed = end;
		}
		this.tail = result.tail;
	}
}
