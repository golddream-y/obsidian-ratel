// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { extractMermaidBlocks } from '../../src/utils/mermaid-renderer';

describe('extractMermaidBlocks', () => {
	it('无 mermaid 块 - 返回空数组', () => {
		const html = '<p>普通内容</p><pre><code class="language-js">var x = 1;</code></pre>';
		expect(extractMermaidBlocks(html)).toEqual([]);
	});

	it('单个 mermaid 块 - 返回代码内容', () => {
		const html = '<pre><code class="language-mermaid">graph TD\n  A--&gt;B</code></pre>';
		const blocks = extractMermaidBlocks(html);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toContain('graph TD');
		expect(blocks[0]).toContain('A-->B');
	});

	it('多个 mermaid 块 - 全部提取', () => {
		const html = `
			<pre><code class="language-mermaid">graph TD\n  A--&gt;B</code></pre>
			<p>中间文本</p>
			<pre><code class="language-mermaid">sequenceDiagram\n  A-&gt;&gt;B: Hi</code></pre>
		`;
		const blocks = extractMermaidBlocks(html);
		expect(blocks).toHaveLength(2);
	});

	it('mermaid 块与普通代码块混合 - 只提取 mermaid', () => {
		const html = `
			<pre><code class="language-js">var x = 1;</code></pre>
			<pre><code class="language-mermaid">graph TD\n  A--&gt;B</code></pre>
		`;
		const blocks = extractMermaidBlocks(html);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toContain('graph TD');
	});

	it('hljs class 前缀的 mermaid 块 - 正确提取', () => {
		const html = '<pre><code class="hljs language-mermaid">graph TD\n  A--&gt;B</code></pre>';
		const blocks = extractMermaidBlocks(html);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toContain('graph TD');
	});
});
