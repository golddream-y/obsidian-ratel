// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
	renderMarkdownToHtml,
	areAllCodeBlocksClosed,
	decodeFenceSrcAttr,
	splitStableMarkdownBlocks,
} from '../../src/utils/markdown-renderer';

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

	it('围栏代码 - 包成 ratel-md-block 并带语言标签', () => {
		const html = renderMarkdownToHtml('```json\n{"a":1}\n```');
		expect(html).toContain('class="ratel-md-block"');
		expect(html).toContain('data-ratel-fence="code"');
		expect(html).toContain('class="ratel-md-block-label">json<');
		expect(html).toContain('class="ratel-md-block-body"');
		expect(html).not.toContain('ratel-code-block');
	});

	it('mermaid 围栏 - 同样包壳并带 data-ratel-src', () => {
		const html = renderMarkdownToHtml('```mermaid\ngraph TD; A-->B\n```');
		expect(html).toContain('data-ratel-fence="mermaid"');
		expect(html).toContain('data-ratel-src="');
		expect(html).toContain('graph TD');
		expect(html).toContain('language-mermaid');
		expect(html).toContain('class="ratel-md-block-label">mermaid<');
	});

	it('mermaid data-ratel-src - decodeFenceSrcAttr round-trip 还原箭头', () => {
		const html = renderMarkdownToHtml('```mermaid\ngraph TD; A-->B\n```');
		const doc = new DOMParser().parseFromString(html, 'text/html');
		const src = doc.querySelector('.ratel-md-block')?.getAttribute('data-ratel-src') ?? '';
		expect(decodeFenceSrcAttr(src)).toBe('graph TD; A-->B');
	});

	it('mermaid data-ratel-src - 字面量 &lt;tag&gt; 不二次解码', () => {
		const html = renderMarkdownToHtml('```mermaid\ngraph TD\nA[&lt;tag&gt;]\n```');
		const doc = new DOMParser().parseFromString(html, 'text/html');
		const src = doc.querySelector('.ratel-md-block')?.getAttribute('data-ratel-src') ?? '';
		expect(decodeFenceSrcAttr(src)).toBe('graph TD\nA[&lt;tag&gt;]');
	});

	it('行内代码 - 不包成代码卡片', () => {
		const html = renderMarkdownToHtml('这是 `inline` 文本');
		expect(html).not.toContain('ratel-md-block');
		expect(html).toContain('<code>inline</code>');
	});

	it('行内代码 - 生成 code 标签', () => {
		const html = renderMarkdownToHtml('这是 `inline code` 文本');
		expect(html).toContain('<code>inline code</code>');
	});

	it('表格 - 外包横滚壳', () => {
		const md = '| A | B |\n|---|---|\n| 1 | 2 |';
		const html = renderMarkdownToHtml(md);
		expect(html).toContain('class="ratel-md-table-wrap"');
		expect(html).toContain('<table>');
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

describe('splitStableMarkdownBlocks', () => {
	it('拆分 - 两个段落 - 冻结第一段并保留最后一段', () => {
		const input = '第一段。\n\n第二段正在写';
		const result = splitStableMarkdownBlocks(input, false);
		expect(result.stableBlocks.join('') + result.tail).toBe(input);
		expect(result.stableBlocks).toEqual(['第一段。\n\n']);
		expect(result.tail).toBe('第二段正在写');
	});

	it('拆分 - 未闭合围栏 - 不提前冻结围栏内容', () => {
		const input = '```ts\nconst x = 1;\n';
		expect(splitStableMarkdownBlocks(input, false)).toEqual({
			stableBlocks: [], tail: input, hasCrossBlockDependency: false,
		});
	});

	it('拆分 - 闭合围栏后出现新段落 - 围栏成为稳定块', () => {
		const input = '```ts\nconst x = 1;\n```\n\n后文';
		const result = splitStableMarkdownBlocks(input, false);
		expect(result.stableBlocks).toHaveLength(1);
		expect(result.stableBlocks[0]).toContain('```ts');
		expect(result.tail).toBe('后文');
	});

	it('拆分 - GFM 表格后出现段落 - 表格整体冻结', () => {
		const input = '| A | B |\n|---|---|\n| 1 | 2 |\n\n后文';
		const result = splitStableMarkdownBlocks(input, false);
		expect(result.stableBlocks).toHaveLength(1);
		expect(result.stableBlocks[0]).toContain('|---|---|');
		expect(result.tail).toBe('后文');
	});

	it('拆分 - 宽松列表继续 - 不把同一 list token 拆开', () => {
		const input = '- A\n\n- B\n\n后文';
		const result = splitStableMarkdownBlocks(input, false);
		expect(result.stableBlocks).toHaveLength(1);
		expect(result.stableBlocks[0]).toContain('- A');
		expect(result.stableBlocks[0]).toContain('- B');
	});

	it('拆分 - Markdown 引用定义 - 流式不拆且结束时只生成一个块', () => {
		const input = '参考 [文档][ref]。\n\n[ref]: https://example.com';
		expect(splitStableMarkdownBlocks(input, false)).toEqual({
			stableBlocks: [], tail: input, hasCrossBlockDependency: true,
		});
		expect(splitStableMarkdownBlocks(input, true)).toEqual({
			stableBlocks: [input], tail: '', hasCrossBlockDependency: true,
		});
	});

	it('拆分 - 未解析引用使用但定义尚未到达 - 也不提前冻结', () => {
		const input = '参考 [文档][ref]。\n\n下一段正在写';
		expect(splitStableMarkdownBlocks(input, false)).toEqual({
			stableBlocks: [], tail: input, hasCrossBlockDependency: true,
		});
	});

	it('拆分 - finalize 普通文本 - 返回所有 token 且源码可重建', () => {
		const input = '# 标题\n\n正文\n\n- A\n- B';
		const result = splitStableMarkdownBlocks(input, true);
		expect(result.stableBlocks.join('') + result.tail).toBe(input);
		expect(result.tail).toBe('');
		expect(result.stableBlocks.length).toBeGreaterThan(1);
	});

	it('拆分 - CRLF 输入 - 归一化后仍可冻结且无跨块依赖', () => {
		const input = '第一段。\r\n\r\n第二段正在写';
		const result = splitStableMarkdownBlocks(input, false);
		// 归一化后 raw 拼接可无损还原,稳定块机制不因 CRLF 静默失效
		expect(result.stableBlocks).toEqual(['第一段。\n\n']);
		expect(result.tail).toBe('第二段正在写');
		expect(result.hasCrossBlockDependency).toBe(false);
	});

	it('拆分 - GFM 任务列表 - 不触发引用依赖误判', () => {
		const input = '- [ ] 待办 A\n- [x] 已办 B\n\n后文';
		const result = splitStableMarkdownBlocks(input, false);
		expect(result.hasCrossBlockDependency).toBe(false);
		expect(result.stableBlocks.join('')).toContain('[ ] 待办 A');
	});

	it('拆分 - 普通块分别渲染 - 可见文本顺序与整段一致', () => {
		const input = '# 标题\n\n正文。\n\n- A\n- B';
		const split = splitStableMarkdownBlocks(input, true);
		const fullDoc = new DOMParser().parseFromString(renderMarkdownToHtml(input), 'text/html');
		const blockDoc = new DOMParser().parseFromString(
			split.stableBlocks.map(renderMarkdownToHtml).join(''),
			'text/html',
		);
		expect(blockDoc.body.textContent).toBe(fullDoc.body.textContent);
	});
});
