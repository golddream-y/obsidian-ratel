/**
 * @file tests/ui/chat/md-block-enhance.test.ts
 * @description 统一富块复制按钮
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enhanceMdBlocks } from '../../../src/ui/chat/md-block-enhance';

const LABELS = { copy: '复制', copied: '已复制', expand: '放大' };

function mountBlock(html: string): HTMLDivElement {
	const root = document.createElement('div');
	root.innerHTML = html;
	document.body.appendChild(root);
	return root;
}

describe('enhanceMdBlocks', () => {
	beforeEach(() => {
		document.body.replaceChildren();
	});

	it('enhanceMdBlocks - 代码块 - 复制 textContent 且无放大钮', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.assign(navigator, { clipboard: { writeText } });
		const root = mountBlock(
			`<div class="ratel-md-block" data-ratel-fence="code"><div class="ratel-md-block-bar"><span class="ratel-md-block-label">json</span><div class="ratel-md-block-actions"></div></div><div class="ratel-md-block-body"><pre><code>{ "a": 1 }</code></pre></div></div>`,
		);
		enhanceMdBlocks(root, { labels: LABELS });
		expect(root.querySelector('.ratel-md-expand')).toBeNull();
		root.querySelector<HTMLButtonElement>('.ratel-md-copy')!.click();
		await vi.waitFor(() => {
			expect(writeText).toHaveBeenCalledWith('{ "a": 1 }');
		});
	});

	it('enhanceMdBlocks - mermaid - 复制 data-ratel-src 不是 SVG', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.assign(navigator, { clipboard: { writeText } });
		const root = mountBlock(
			`<div class="ratel-md-block" data-ratel-fence="mermaid" data-ratel-src="${encodeURIComponent('graph TD; A-->B')}"><div class="ratel-md-block-bar"><span class="ratel-md-block-label">mermaid</span><div class="ratel-md-block-actions"></div></div><div class="ratel-md-block-body"><div class="ratel-mermaid"><svg></svg></div></div></div>`,
		);
		enhanceMdBlocks(root, { labels: LABELS });
		root.querySelector<HTMLButtonElement>('.ratel-md-copy')!.click();
		await vi.waitFor(() => {
			expect(writeText).toHaveBeenCalledWith('graph TD; A-->B');
		});
	});

	it('enhanceMdBlocks - mermaid - 复制保留字面量 &lt;tag&gt;', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.assign(navigator, { clipboard: { writeText } });
		const source = 'graph TD\nA[&lt;tag&gt;]';
		const root = mountBlock(
			`<div class="ratel-md-block" data-ratel-fence="mermaid" data-ratel-src="${encodeURIComponent(source)}"><div class="ratel-md-block-bar"><span class="ratel-md-block-label">mermaid</span><div class="ratel-md-block-actions"></div></div><div class="ratel-md-block-body"><div class="ratel-mermaid"><svg></svg></div></div></div>`,
		);
		enhanceMdBlocks(root, { labels: LABELS });
		root.querySelector<HTMLButtonElement>('.ratel-md-copy')!.click();
		await vi.waitFor(() => {
			expect(writeText).toHaveBeenCalledWith(source);
		});
	});

	it('enhanceMdBlocks - 无 onExpand - 即使有 svg 也不画放大', () => {
		const root = mountBlock(
			`<div class="ratel-md-block" data-ratel-fence="mermaid" data-ratel-src="x"><div class="ratel-md-block-bar"><div class="ratel-md-block-actions"></div></div><div class="ratel-md-block-body"><svg></svg></div></div>`,
		);
		enhanceMdBlocks(root, { labels: LABELS });
		expect(root.querySelector('.ratel-md-expand')).toBeNull();
	});

	it('enhanceMdBlocks - 有 onExpand 且有 svg - 画放大钮', () => {
		const onExpand = vi.fn();
		const root = mountBlock(
			`<div class="ratel-md-block" data-ratel-fence="mermaid" data-ratel-src="x"><div class="ratel-md-block-bar"><div class="ratel-md-block-actions"></div></div><div class="ratel-md-block-body"><svg></svg></div></div>`,
		);
		enhanceMdBlocks(root, { labels: LABELS, onExpand });
		root.querySelector<HTMLButtonElement>('.ratel-md-expand')!.click();
		expect(onExpand).toHaveBeenCalledTimes(1);
	});
});
