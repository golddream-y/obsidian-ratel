/**
 * @file src/ui/chat/streaming-markdown-state.ts
 * @description 决定流式 Markdown 使用轻量追加、轻量替换或最终富渲染
 * @module ui/chat/streaming-markdown-state
 */

export type MarkdownRenderAction =
	| { kind: 'none' }
	| { kind: 'append-light'; text: string }
	| { kind: 'replace-light'; text: string }
	| { kind: 'render-rich'; text: string; force: boolean };

export interface MarkdownRenderInput {
	content: string;
	streaming: boolean;
	citeKey: string;
}

/**
 * 保存已经交给 DOM 的文本和模式,确保流式阶段只返回新增后缀。
 *
 * 设计要点:
 * - 只记录渲染决策所需的最小状态,不持有 DOM 引用。
 * - 非前缀改写降级为整段轻量替换,结束时只触发一次富渲染。
 *
 * @example
 *   const state = new StreamingMarkdownState();
 *   state.next({ content: '回答', streaming: true, citeKey: '' });
 */
export class StreamingMarkdownState {
	private appliedContent = '';
	private appliedCiteKey = '';
	private mode: 'empty' | 'light' | 'rich' = 'empty';

	/**
	 * 根据下一份完整内容返回唯一需要执行的 DOM 动作。
	 *
	 * @param input - 最新完整文本、流式状态与引用键
	 * @returns 本帧应执行的渲染动作
	 * @example
	 *   state.next({ content: '回答继续', streaming: true, citeKey: '' });
	 */
	next(input: MarkdownRenderInput): MarkdownRenderAction {
		const { content, streaming, citeKey } = input;
		if (streaming) {
			// 关键路径:空文本首帧无需创建任何节点,先进入轻量模式等待首个增量
			if (content === '' && this.appliedContent === '') {
				this.mode = 'light';
				this.appliedCiteKey = citeKey;
				return { kind: 'none' };
			}
			if (this.mode === 'light' && content === this.appliedContent) return { kind: 'none' };
			const action: MarkdownRenderAction =
				this.mode === 'light' && content.startsWith(this.appliedContent)
					? { kind: 'append-light', text: content.slice(this.appliedContent.length) }
					: { kind: 'replace-light', text: content };
			this.appliedContent = content;
			this.appliedCiteKey = citeKey;
			this.mode = 'light';
			return action;
		}

		if (
			this.mode === 'rich' &&
			content === this.appliedContent &&
			citeKey === this.appliedCiteKey
		) return { kind: 'none' };

		this.appliedContent = content;
		this.appliedCiteKey = citeKey;
		this.mode = 'rich';
		return { kind: 'render-rich', text: content, force: true };
	}

	/**
	 * 清空组件复用前的渲染状态。
	 *
	 * @returns 无返回值
	 * @example
	 *   state.reset();
	 */
	reset(): void {
		this.appliedContent = '';
		this.appliedCiteKey = '';
		this.mode = 'empty';
	}
}

/**
 * 把轻量动作应用到单一 Text 节点;append 路径不替换已有节点。
 *
 * @param host - Markdown 根容器
 * @param current - 当前活动 Text 节点
 * @param action - 轻量追加或替换动作
 * @returns 仍应持有的 Text 节点
 * @example
 *   applyLightTextAction(host, null, { kind: 'replace-light', text: '回答' });
 */
export function applyLightTextAction(
	host: HTMLElement,
	current: Text | null,
	action: Extract<MarkdownRenderAction, { kind: 'append-light' | 'replace-light' }>,
): Text {
	if (action.kind === 'append-light' && current?.parentNode === host) {
		current.appendData(action.text);
		return current;
	}
	const node = host.ownerDocument.createTextNode(action.text);
	host.replaceChildren(node);
	return node;
}
