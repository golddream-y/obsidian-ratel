// @vitest-environment jsdom
/**
 * @file tests/perf/chat-stable-block-policy.test.ts
 * @description 稳定块渲染次数只随块数量增长,不随 delta 数量增长
 * @module tests/perf/chat-stable-block-policy
 */
import { describe, expect, it } from 'vitest';
import { StableMarkdownProjection } from '../../src/ui/chat/stable-markdown-projection';
import { renderMarkdownToHtml } from '../../src/utils/markdown-renderer';

describe('稳定 Markdown 块性能合同', () => {
	it('16K / 200 delta - 富渲染次数不超过最终块数', () => {
		const projection = new StableMarkdownProjection();
		let content = '';
		let renderedBlocks = 0;
		let seenBlocks = 0;

		for (let i = 0; i < 200; i++) {
			content += 'x'.repeat(78);
			if ((i + 1) % 10 === 0) content += '\n\n';
			const snapshot = projection.update(content);
			for (const block of snapshot.blocks.slice(seenBlocks)) {
				renderMarkdownToHtml(block.source);
				renderedBlocks++;
			}
			seenBlocks = snapshot.blocks.length;
		}

		const final = projection.finish(content);
		for (const block of final.blocks.slice(seenBlocks)) {
			renderMarkdownToHtml(block.source);
			renderedBlocks++;
		}

		expect(content.length).toBeGreaterThanOrEqual(15_000);
		expect(final.tail).toBe('');
		// 每个块生命周期内只富渲染一次:总渲染次数 === 最终块数
		expect(renderedBlocks).toBe(final.blocks.length);
		expect(renderedBlocks).toBeLessThanOrEqual(20);
	});
});
