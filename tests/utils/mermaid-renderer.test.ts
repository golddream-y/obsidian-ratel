// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('mermaid', () => ({
	default: {
		initialize: vi.fn(),
		render: vi.fn(async (id: string) => ({
			svg: `<svg xmlns="http://www.w3.org/2000/svg" data-id="${id}"></svg>`,
		})),
	},
}));

import { extractMermaidBlocks, renderMermaidBlocks } from '../../src/utils/mermaid-renderer';

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

describe('renderMermaidBlocks', () => {
	afterEach(() => {
		document.body.className = '';
		document.body.replaceChildren();
	});

	it('renderMermaidBlocks - 已有 md-block 壳 - 只换 body 保留 data-ratel-src', async () => {
		const root = document.createElement('div');
		root.innerHTML = `<div class="ratel-md-block" data-ratel-fence="mermaid" data-ratel-src="graph TD; A-->B"><div class="ratel-md-block-bar"><span class="ratel-md-block-label">mermaid</span><div class="ratel-md-block-actions"></div></div><div class="ratel-md-block-body"><pre><code class="hljs language-mermaid">graph TD; A--&gt;B</code></pre></div></div>`;
		document.body.appendChild(root);
		await renderMermaidBlocks(root);
		const block = root.querySelector('.ratel-md-block')!;
		expect(block.getAttribute('data-ratel-src')).toBe('graph TD; A-->B');
		expect(block.querySelector('.ratel-md-block-bar')).toBeTruthy();
		expect(block.querySelector('.ratel-mermaid svg')).toBeTruthy();
		expect(block.querySelector('pre')).toBeNull();
	});

	it('renderMermaidBlocks - initialize 关闭 htmlLabels - 避免 DOMPurify 剥掉节点文字', async () => {
		const mermaidMod = await import('mermaid');
		const root = document.createElement('div');
		root.innerHTML = `<div class="ratel-md-block" data-ratel-fence="mermaid" data-ratel-src="x"><div class="ratel-md-block-body"><pre><code class="language-mermaid">graph TD; A</code></pre></div></div>`;
		document.body.appendChild(root);
		await renderMermaidBlocks(root);
		expect(mermaidMod.default.initialize).toHaveBeenLastCalledWith(
			expect.objectContaining({ htmlLabels: false }),
		);
	});

	it('renderMermaidBlocks - SVG text 节点标签 - sanitize 后仍保留文字', async () => {
		const mermaidMod = await import('mermaid');
		vi.mocked(mermaidMod.default.render).mockResolvedValueOnce({
			svg: '<svg xmlns="http://www.w3.org/2000/svg"><g><rect/><text>Client</text></g></svg>',
			bindFunctions: undefined,
		});
		const root = document.createElement('div');
		root.innerHTML = `<div class="ratel-md-block" data-ratel-fence="mermaid" data-ratel-src="x"><div class="ratel-md-block-body"><pre><code class="language-mermaid">graph TD; A[Client]</code></pre></div></div>`;
		document.body.appendChild(root);
		await renderMermaidBlocks(root);
		expect(root.querySelector('.ratel-mermaid')?.textContent).toContain('Client');
	});

	it('renderMermaidBlocks - body.theme-light - initialize 用 default 主题', async () => {
		document.body.className = 'theme-light';
		const mermaidMod = await import('mermaid');
		const root = document.createElement('div');
		root.innerHTML = `<div class="ratel-md-block" data-ratel-fence="mermaid" data-ratel-src="x"><div class="ratel-md-block-body"><pre><code class="language-mermaid">graph TD; A</code></pre></div></div>`;
		document.body.appendChild(root);
		await renderMermaidBlocks(root);
		expect(mermaidMod.default.initialize).toHaveBeenLastCalledWith(
			expect.objectContaining({ theme: 'default', startOnLoad: false, securityLevel: 'strict' }),
		);
	});

	it('renderMermaidBlocks - body.theme-dark - initialize 用 dark 主题', async () => {
		document.body.className = 'theme-dark';
		const mermaidMod = await import('mermaid');
		const root = document.createElement('div');
		root.innerHTML = `<div class="ratel-md-block" data-ratel-fence="mermaid" data-ratel-src="x"><div class="ratel-md-block-body"><pre><code class="language-mermaid">graph TD; A</code></pre></div></div>`;
		document.body.appendChild(root);
		await renderMermaidBlocks(root);
		expect(mermaidMod.default.initialize).toHaveBeenLastCalledWith(
			expect.objectContaining({ theme: 'dark' }),
		);
	});

	it('renderMermaidBlocks - render 抛错 - body 错误条且外壳仍在', async () => {
		const mermaid = await import('mermaid');
		vi.mocked(mermaid.default.render).mockRejectedValueOnce(new Error('bad'));
		const root = document.createElement('div');
		root.innerHTML = `<div class="ratel-md-block" data-ratel-fence="mermaid" data-ratel-src="x"><div class="ratel-md-block-body"><pre><code class="language-mermaid">x</code></pre></div></div>`;
		await renderMermaidBlocks(root, { failed: (d) => `失败:${d}` });
		expect(root.querySelector('.ratel-md-block')).toBeTruthy();
		expect(root.querySelector('.ratel-md-block-error')?.textContent).toContain('失败:');
	});
});
