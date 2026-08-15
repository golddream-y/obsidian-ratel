// @vitest-environment jsdom
/**
 * @file tests/ui/chat/streaming-markdown-state.test.ts
 * @description 流式 Markdown 轻渲染状态机与文本节点增量补丁
 * @module tests/ui/chat/streaming-markdown-state
 */
import { describe, expect, it } from 'vitest';
import {
	applyLightTextAction,
	StreamingMarkdownState,
	type MarkdownRenderAction,
} from '../../../src/ui/chat/streaming-markdown-state';

describe('StreamingMarkdownState', () => {
	it('next - 200 个流式增量后结束 - 只产生一次富渲染动作', () => {
		const state = new StreamingMarkdownState();
		let content = '';
		let richCount = 0;
		for (let i = 0; i < 200; i++) {
			content += 'x'.repeat(80);
			const action = state.next({ content, streaming: true, citeKey: '' });
			if (action.kind === 'render-rich') richCount++;
		}
		const final = state.next({ content, streaming: false, citeKey: '' });
		if (final.kind === 'render-rich') richCount++;
		expect(content).toHaveLength(16_000);
		expect(richCount).toBe(1);
		expect(final).toEqual({ kind: 'render-rich', text: content, force: true });
	});

	it('next - 内容保持前缀增长 - 首次替换后只追加新增后缀', () => {
		const state = new StreamingMarkdownState();
		expect(state.next({ content: 'ab', streaming: true, citeKey: '' })).toEqual({
			kind: 'replace-light', text: 'ab',
		});
		expect(state.next({ content: 'abcd', streaming: true, citeKey: '' })).toEqual({
			kind: 'append-light', text: 'cd',
		});
		expect(state.next({ content: 'abcd', streaming: true, citeKey: '' })).toEqual({ kind: 'none' });
	});

	it('next - 内容不再以前值开头 - 回退为轻量整段替换', () => {
		const state = new StreamingMarkdownState();
		state.next({ content: '旧内容', streaming: true, citeKey: '' });
		expect(state.next({ content: '新内容', streaming: true, citeKey: '' })).toEqual({
			kind: 'replace-light', text: '新内容',
		});
	});

	it('next - 静态内容与 citeKey 未变化 - 不重复富渲染', () => {
		const state = new StreamingMarkdownState();
		expect(state.next({ content: '# 标题', streaming: false, citeKey: '1:a.md' }).kind).toBe('render-rich');
		expect(state.next({ content: '# 标题', streaming: false, citeKey: '1:a.md' })).toEqual({ kind: 'none' });
		expect(state.next({ content: '# 标题', streaming: false, citeKey: '1:b.md' }).kind).toBe('render-rich');
	});

	it('reset - 组件上下文切换 - 下一份文本从轻量替换开始', () => {
		const state = new StreamingMarkdownState();
		state.next({ content: '旧会话', streaming: true, citeKey: '' });
		state.reset();
		expect(state.next({ content: '新会话', streaming: true, citeKey: '' })).toEqual({
			kind: 'replace-light', text: '新会话',
		});
	});

	it('reset - 复用后内容与旧内容相同 - 重新渲染而非返回 none', () => {
		const state = new StreamingMarkdownState();
		state.next({ content: '# 标题', streaming: false, citeKey: '' });
		state.reset();
		// 关键路径:不 reset 时同内容会误判为 none,导致组件复用时白屏
		expect(state.next({ content: '# 标题', streaming: false, citeKey: '' })).toEqual({
			kind: 'render-rich', text: '# 标题', force: true,
		});
	});

	it('next - 空文本流式帧 - 不创建无意义节点', () => {
		const state = new StreamingMarkdownState();
		expect(state.next({ content: '', streaming: true, citeKey: '' })).toEqual({ kind: 'none' });
	});
});

describe('applyLightTextAction', () => {
	it('append-light - 连续追加 - 复用同一个 Text 节点', () => {
		const host = document.createElement('div');
		let node: Text | null = null;
		node = applyLightTextAction(host, node, { kind: 'replace-light', text: 'ab' });
		const first = node;
		node = applyLightTextAction(host, node, { kind: 'append-light', text: 'cd' });
		expect(node).toBe(first);
		expect(host.textContent).toBe('abcd');
	});

	it('replace-light - 节点已脱离容器 - 安全重建文本节点', () => {
		const host = document.createElement('div');
		const stale = document.createTextNode('stale');
		const action: MarkdownRenderAction = { kind: 'append-light', text: 'fresh' };
		const node = applyLightTextAction(host, stale, action);
		expect(node.parentNode).toBe(host);
		expect(host.textContent).toBe('fresh');
	});
});
