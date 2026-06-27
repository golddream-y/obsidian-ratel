// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderMarkdownToHtml, areAllCodeBlocksClosed } from '../../src/utils/markdown-renderer';

describe('renderMarkdownToHtml', () => {
	it('标题 - h1/h2 生成对应标签', () => {
		const html = renderMarkdownToHtml('# 标题一\n## 标题二');
		expect(html).toContain('<h1>标题一</h1>');
		expect(html).toContain('<h2>标题二</h2>');
	});

	it('粗体/斜体 - 生成 strong/em 标签', () => {
		const html = renderMarkdownToHtml('**粗体** 和 *斜体*');
		expect(html).toContain('<strong>粗体</strong>');
		expect(html).toContain('<em>斜体</em>');
	});

	it('代码块 - 生成 pre code 标签', () => {
		const html = renderMarkdownToHtml('```javascript\nconst x = 1;\n```');
		expect(html).toContain('<pre>');
		expect(html).toContain('<code');
		expect(html).toContain('language-javascript');
	});

	it('行内代码 - 生成 code 标签', () => {
		const html = renderMarkdownToHtml('这是 `inline code` 文本');
		expect(html).toContain('<code>inline code</code>');
	});

	it('表格 - 生成 table 标签', () => {
		const md = '| A | B |\n|---|---|\n| 1 | 2 |';
		const html = renderMarkdownToHtml(md);
		expect(html).toContain('<table>');
		expect(html).toContain('<th>A</th>');
		expect(html).toContain('<td>1</td>');
	});

	it('引用块 - 生成 blockquote 标签', () => {
		const html = renderMarkdownToHtml('> 引用文本');
		expect(html).toContain('<blockquote>');
		expect(html).toContain('引用文本');
	});

	it('无序列表 - 生成 ul/li 标签', () => {
		const html = renderMarkdownToHtml('- 项 A\n- 项 B');
		expect(html).toContain('<ul>');
		expect(html).toContain('<li>项 A</li>');
	});

	it('XSS - script 标签被过滤', () => {
		const html = renderMarkdownToHtml('<script>alert(1)</script>正常文本');
		expect(html).not.toContain('<script>');
		expect(html).toContain('正常文本');
	});

	it('XSS - onerror 属性被过滤', () => {
		const html = renderMarkdownToHtml('<img src="x" onerror="alert(1)">');
		expect(html).not.toContain('onerror');
	});

	it('XSS - javascript: 协议被过滤', () => {
		const html = renderMarkdownToHtml('[点击](javascript:alert(1))');
		expect(html).not.toContain('javascript:');
	});
});

describe('areAllCodeBlocksClosed', () => {
	it('无代码块 - 返回 true', () => {
		expect(areAllCodeBlocksClosed('普通文本')).toBe(true);
	});

	it('已闭合代码块 - 返回 true', () => {
		const text = '前文\n```js\nconst x = 1;\n```\n后文';
		expect(areAllCodeBlocksClosed(text)).toBe(true);
	});

	it('未闭合代码块 - 返回 false', () => {
		const text = '前文\n```js\nconst x = 1;\n';
		expect(areAllCodeBlocksClosed(text)).toBe(false);
	});

	it('多个代码块全部闭合 - 返回 true', () => {
		const text = '```js\na\n```\n中间\n```py\nb\n```';
		expect(areAllCodeBlocksClosed(text)).toBe(true);
	});

	it('多个代码块最后一个未闭合 - 返回 false', () => {
		const text = '```js\na\n```\n中间\n```py\nb\n';
		expect(areAllCodeBlocksClosed(text)).toBe(false);
	});
});
