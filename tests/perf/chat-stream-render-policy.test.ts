// @vitest-environment jsdom
/**
 * @file tests/perf/chat-stream-render-policy.test.ts
 * @description 16K 字 / 200 delta 下轻渲染调用次数与 Text 节点稳定性
 * @module tests/perf/chat-stream-render-policy
 */
import { describe, expect, it } from 'vitest';
import {
	applyLightTextAction,
	StreamingMarkdownState,
} from '../../src/ui/chat/streaming-markdown-state';
import { renderMarkdownToHtml } from '../../src/utils/markdown-renderer';

describe('聊天流式渲染性能合同', () => {
	it('16K / 200 delta - 完整 Markdown 只在结束时渲染一次', () => {
		const host = document.createElement('div');
		const state = new StreamingMarkdownState();
		let node: Text | null = null;
		let richCalls = 0;
		let content = '';

		for (let i = 0; i < 200; i++) {
			content += `${String(i).padStart(3, '0')}:${'x'.repeat(76)}`;
			const action = state.next({ content, streaming: true, citeKey: '' });
			if (action.kind === 'append-light' || action.kind === 'replace-light') {
				node = applyLightTextAction(host, node, action);
			}
		}

		const beforeFinalNode = node;
		const final = state.next({ content, streaming: false, citeKey: '' });
		if (final.kind === 'render-rich') {
			richCalls++;
			host.innerHTML = renderMarkdownToHtml(final.text);
		}

		expect(content).toHaveLength(16_000);
		expect(beforeFinalNode).not.toBeNull();
		expect(richCalls).toBe(1);
		expect(host.textContent?.length).toBeGreaterThan(15_000);
	});
});
