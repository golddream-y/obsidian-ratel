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
		'data-ratel-src', 'data-ratel-fence',
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

const CODE_CLASS_RE = /\bclass="([^"]*)"/i;
const CODE_LANG_RE = /\blanguage-([a-z0-9_+-]+)/i;

/**
 * 反转义 HTML 实体文本（用于从 code 内层还原 mermaid 源码）。
 *
 * @param text - 含 HTML 实体的文本
 * @returns 解码后的纯文本
 */
export function unescapeHtmlText(text: string): string {
	return text
		.replace(/&quot;/g, '"')
		.replace(/&gt;/g, '>')
		.replace(/&lt;/g, '<')
		.replace(/&amp;/g, '&');
}

/**
 * 解码 data-ratel-src 属性值（encodeURIComponent 编码；旧 fixture 回退 unescapeHtmlText）。
 *
 * @param attr - data-ratel-src 属性原始值
 * @returns 围栏源码纯文本
 */
export function decodeFenceSrcAttr(attr: string): string {
	try {
		return decodeURIComponent(attr);
	} catch {
		return unescapeHtmlText(attr);
	}
}

/**
 * 从 code 元素 HTML 提取围栏源码（去标签 + 反转义）。
 *
 * @param body - code 元素 innerHTML
 * @returns 围栏原始源码文本
 */
function fenceSourceFromCodeHtml(body: string): string {
	return unescapeHtmlText(body.replace(/<[^>]+>/g, ''));
}

/**
 * 把围栏 `<pre><code>` 包成统一 ratel-md-block 外壳（顶栏 + 语言名 + 操作区占位）。
 *
 * mermaid 与代码围栏共用壳，mermaid 额外带 data-ratel-src 供后续渲染读取源码。
 *
 * @param html - marked 输出的 HTML
 * @returns 已包外壳的 HTML
 */
function wrapFencedCodeHtml(html: string): string {
	const fencedPreRe = /<pre>\s*<code([^>]*)>([\s\S]*?)<\/code>\s*<\/pre>/gi;
	return html.replace(fencedPreRe, (_full, attrs: string, body: string) => {
		const cls = CODE_CLASS_RE.exec(attrs)?.[1] ?? '';
		const isMermaid = /\blanguage-mermaid\b/i.test(cls);
		const lang = isMermaid ? 'mermaid' : fencedLangFromClass(cls);
		const fence = isMermaid ? 'mermaid' : 'code';
		const srcAttr = isMermaid
			? ` data-ratel-src="${encodeURIComponent(fenceSourceFromCodeHtml(body).trimEnd())}"`
			: '';
		const langHtml = lang
			? `<span class="ratel-md-block-label">${escapeHtmlText(lang)}</span>`
			: '<span class="ratel-md-block-label"></span>';
		return `<div class="ratel-md-block" data-ratel-fence="${fence}"${srcAttr}><div class="ratel-md-block-bar">${langHtml}<div class="ratel-md-block-actions"></div></div><div class="ratel-md-block-body"><pre><code${attrs}>${body}</code></pre></div></div>`;
	});
}

/**
 * 为表格外包横滚容器，避免宽表撑破聊天气泡。
 *
 * @param html - 含 table 的 HTML
 * @returns 已包横滚壳的 HTML
 */
function wrapTablesHtml(html: string): string {
	return html.replace(/<table\b[\s\S]*?<\/table>/gi, (table) => {
		if (table.includes('ratel-md-table-wrap')) return table;
		return `<div class="ratel-md-table-wrap">${table}</div>`;
	});
}

/**
 * 从 hljs class 抽出语言 id。
 *
 * @param className - code 元素 class
 * @returns 小写语言 id，或空串
 */
function fencedLangFromClass(className: string): string {
	const raw = CODE_LANG_RE.exec(className)?.[1]?.toLowerCase() ?? '';
	if (!raw || raw === 'plaintext' || raw === 'text') return '';
	return raw;
}

/**
 * 转义语言标签文本（class 理论上已是安全 token，仍防注入）。
 *
 * @param text - 原始文本
 * @returns HTML 安全文本
 */
function escapeHtmlText(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * 将 Markdown 文本渲染为已 sanitize 的 HTML 字符串。
 *
 * 管线:marked.parse → 包围栏代码卡片 → 表格横滚壳 → DOMPurify.sanitize。
 * 异常时回退为转义纯文本(<pre> 包裹),保证不白屏。
 *
 * @param text - Markdown 源文本
 * @returns 已 sanitize 的 HTML 字符串,可直接用于 innerHTML
 */
export function renderMarkdownToHtml(text: string): string {
	if (!text) return '';

	try {
		const rawHtml = markedInstance.parse(text) as string;
		return DOMPurify.sanitize(wrapTablesHtml(wrapFencedCodeHtml(rawHtml)), SANITIZE_CONFIG);
	} catch {
		// 修复:marked 解析异常时回退为转义纯文本,避免白屏
		const escaped = text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
		return `<pre>${escaped}</pre>`;
	}
}

/** 稳定块拆分结果 — stableBlocks 可冻结富渲染,tail 留作活动轻量尾部 */
export interface StableMarkdownSplit {
	stableBlocks: string[];
	tail: string;
	hasCrossBlockDependency: boolean;
}

/**
 * 引用链接使用检测正则 — 命中时前文不允许冻结。
 *
 * 子模式拆解:
 * - `(^|[^!])` 起始或非 `!` 前缀 — 排除图片 `![alt](...)`
 * - `\[(?![ xX]\])(?!\d+\])` — 排除 GFM 任务列表 `[ ]`/`[x]` 与数字脚注 `[1]`
 * - `([^\]\n]+)\]` — 链接文本(不含换行,排除跨行误配)
 * - `(?!\s*\()` — 排除 inline 链接 `[text](url)`(无跨块依赖)
 */
const REFERENCE_USE_RE = /(^|[^!])\[(?![ xX]\])(?!\d+\])([^\]\n]+)\](?!\s*\()/m;

/**
 * 按 marked lexer 的顶层 token 切出稳定前缀,最后一个语义 token 永远留作活动尾部。
 *
 * 关键路径:引用定义会改变前文链接解析,检测到 def token 时整段不拆。
 * 关键路径:入口先做 CRLF 归一化 — marked 会吃掉 \r 导致 raw 与源码不一致,
 * startsWith 校验恒失败,稳定块机制在 CRLF 输入下 100% 静默失效(退化为纯 tail)。
 *
 * @param text - 尚未冻结的 Markdown 尾部
 * @param finalize - 是否结束流式并完成全部尾部
 * @returns 稳定块、活动尾部和跨块依赖标记;hasCrossBlockDependency 为诊断标记,投影层不依赖
 * @example
 *   splitStableMarkdownBlocks('第一段\n\n第二段', false);
 */
export function splitStableMarkdownBlocks(
	text: string,
	finalize: boolean,
): StableMarkdownSplit {
	if (!text) return { stableBlocks: [], tail: '', hasCrossBlockDependency: false };

	// 修复:CRLF 归一化 — 保证 raw 拼接可无损还原源码(归一后文本)
	const normalized = text.replace(/\r\n?/g, '\n');
	text = normalized;

	const tokens = markedInstance.lexer(text);
	// 关键路径:定义可能尚未流到;非数字 shortcut/reference link 也必须阻止前文冻结。
	const hasReferenceUse = REFERENCE_USE_RE.test(text);
	const hasCrossBlockDependency =
		hasReferenceUse || tokens.some((token) => token.type === 'def');
	if (hasCrossBlockDependency) {
		return finalize
			? { stableBlocks: [text], tail: '', hasCrossBlockDependency: true }
			: { stableBlocks: [], tail: text, hasCrossBlockDependency: true };
	}

	const semanticIndexes = tokens
		.map((token, index) => token.type === 'space' ? -1 : index)
		.filter((index) => index >= 0);
	if (!finalize && semanticIndexes.length < 2) {
		return { stableBlocks: [], tail: text, hasCrossBlockDependency: false };
	}

	const cut = finalize ? tokens.length : semanticIndexes[semanticIndexes.length - 1]!;
	const stableTokens = tokens.slice(0, cut);
	const stableBlocks: string[] = [];
	let leadingSpace = '';
	for (const token of stableTokens) {
		if (token.type === 'space') {
			if (stableBlocks.length > 0) {
				stableBlocks[stableBlocks.length - 1] += token.raw;
			} else {
				leadingSpace += token.raw;
			}
			continue;
		}
		stableBlocks.push(leadingSpace + token.raw);
		leadingSpace = '';
	}
	if (leadingSpace && stableBlocks.length > 0) {
		stableBlocks[stableBlocks.length - 1] += leadingSpace;
	}
	if (finalize && stableBlocks.length === 0) {
		return { stableBlocks: [text], tail: '', hasCrossBlockDependency: false };
	}

	const stableText = stableBlocks.join('');
	// 修复:lexer raw 无法无损覆盖源码时保持轻量尾部,禁止错误截断。
	if (!text.startsWith(stableText)) {
		return { stableBlocks: [], tail: text, hasCrossBlockDependency: false };
	}
	return {
		stableBlocks,
		tail: text.slice(stableText.length),
		hasCrossBlockDependency: false,
	};
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
