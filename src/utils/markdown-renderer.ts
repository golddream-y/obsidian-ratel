/**
 * @file src/utils/markdown-renderer.ts
 * @description Markdown → HTML 渲染纯函数层(marked + marked-highlight + DOMPurify + highlight.js)
 * @module utils/markdown-renderer
 * @depends marked, marked-highlight, dompurify, highlight.js
 */

import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import markdown from 'highlight.js/lib/languages/markdown';

// 按需注册 7 种常用语言,控制体积
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('json', json);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('markdown', markdown);

/**
 * DOMPurify 白名单配置 — 允许 mermaid 生成的 SVG 标签和属性通过 sanitize。
 *
 * 关键路径:mermaid.render() 输出 SVG 字符串,包含 <svg>/<path>/<g>/<rect> 等标签
 * 和 viewBox/d/fill/stroke 等属性。默认 DOMPurify 配置会移除这些,导致 mermaid 图表空白。
 */
const SANITIZE_CONFIG = {
	ADD_TAGS: [
		'svg', 'path', 'g', 'rect', 'circle', 'line', 'text',
		'polyline', 'polygon', 'defs', 'marker', 'foreignObject', 'span',
	],
	ADD_ATTR: [
		'viewBox', 'd', 'fill', 'stroke', 'stroke-width', 'x', 'y',
		'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
		'width', 'height', 'transform', 'class', 'id',
		'marker-end', 'marker-start', 'href', 'target',
	],
};

/**
 * 配置 marked 实例 — 启用 GFM + 代码高亮。
 *
 * 关键路径:marked v15 移除了内置 highlight 选项,必须通过 marked-highlight 扩展实现。
 * langPrefix 设为 'hljs language-' 使输出 class 同时包含 hljs(供 CSS 令牌色)和 language-xxx(供 mermaid 检测)。
 */
const markedInstance = new Marked(
	markedHighlight({
		langPrefix: 'hljs language-',
		highlight(code: string, lang: string): string {
			if (lang && hljs.getLanguage(lang)) {
				try {
					return hljs.highlight(code, { language: lang }).value;
				} catch {
					// 语言注册但高亮失败,回退纯文本
					return code;
				}
			}
			// 未注册语言,不高亮
			return code;
		},
	}),
);

markedInstance.setOptions({
	gfm: true,
	breaks: false,
});

/**
 * 将 Markdown 文本渲染为已 sanitize 的 HTML 字符串。
 *
 * 管线:marked.parse → DOMPurify.sanitize → 返回安全 HTML。
 * 异常时回退为转义纯文本(<pre> 包裹),保证不白屏。
 *
 * @param text - Markdown 源文本
 * @returns 已 sanitize 的 HTML 字符串,可直接用于 innerHTML
 */
export function renderMarkdownToHtml(text: string): string {
	if (!text) return '';

	try {
		const rawHtml = markedInstance.parse(text) as string;
		return DOMPurify.sanitize(rawHtml, SANITIZE_CONFIG);
	} catch {
		// 修复:marked 解析异常时回退为转义纯文本,避免白屏
		const escaped = text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
		return `<pre>${escaped}</pre>`;
	}
}

/**
 * 检测文本中是否所有代码块(用 ``` 分隔)都已闭合。
 *
 * 关键路径:流式渲染时,模型可能正在输出代码块内容,此时 ``` 数量为奇数(未闭合)。
 * 未闭合时不渲染 mermaid(避免半截代码触发 mermaid.parse 错误)。
 *
 * @param text - 待检测的文本
 * @returns true = 所有代码块已闭合(或无代码块)
 */
export function areAllCodeBlocksClosed(text: string): boolean {
	const fenceCount = (text.match(/```/g) ?? []).length;
	return fenceCount % 2 === 0;
}
