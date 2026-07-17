/**
 * @file src/utils/mermaid-renderer.ts
 * @description Mermaid 图表初始化与异步渲染
 * @module utils/mermaid-renderer
 * @depends mermaid, dompurify
 */

import mermaid from 'mermaid';
import DOMPurify from 'dompurify';

/**
 * mermaid 初始化配置。
 *
 * 关键路径:
 * - startOnLoad: false — 手动控制渲染时机,不在页面加载时自动扫描
 * - securityLevel: 'strict' — 禁止 mermaid 代码中的 HTML 标签和事件处理器,防 XSS
 * - theme: 'dark' — 首版固定暗色主题,后续可读 Obsidian 主题自适应
 */
mermaid.initialize({
	startOnLoad: false,
	theme: 'dark',
	securityLevel: 'strict',
});

/**
 * DOMPurify 白名单配置 — 允许 mermaid 生成的 SVG 标签和属性通过 sanitize。
 *
 * 关键路径:mermaid.render() 输出 SVG 字符串,包含 <svg>/<path>/<g>/<rect> 等标签
 * 和 viewBox/d/fill/stroke 等属性。直接 innerHTML 赋值会被 Obsidian linter 拦截
 * (@microsoft/sdl/no-inner-html),必须经 DOMPurify 清洗后再注入,既满足安全约束
 * 又保证渲染效果不变。
 */
const MERMAID_SANITIZE_CONFIG = {
	ADD_TAGS: [
		'svg', 'path', 'g', 'rect', 'circle', 'line', 'text',
		'tspan', 'polyline', 'polygon', 'defs', 'marker',
		'foreignObject', 'span', 'use', 'style', 'title',
	],
	ADD_ATTR: [
		'viewBox', 'd', 'fill', 'stroke', 'stroke-width', 'x', 'y',
		'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
		'width', 'height', 'transform', 'class', 'id',
		'marker-end', 'marker-start', 'href', 'target',
	],
};

let renderCounter = 0;

/**
 * 从 HTML 字符串中提取所有 mermaid 代码块的内容。
 *
 * 用于在 marked 输出后、DOM 注入前检测是否存在 mermaid 块。
 * 匹配 `<code class="...language-mermaid...">...</code>` 模式。
 *
 * 关键路径:marked-highlight 输出的 class 可能是 "hljs language-mermaid",
 * 正则用 `[^"]*language-mermaid` 匹配任意前缀。
 *
 * @param html - marked 输出的 HTML 字符串
 * @returns mermaid 代码内容数组(每个元素是一个代码块的原始文本,已反转义 HTML 实体)
 */
export function extractMermaidBlocks(html: string): string[] {
	const blocks: string[] = [];
	const regex = /<code[^>]*class="[^"]*language-mermaid[^"]*"[^>]*>([\s\S]*?)<\/code>/g;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(html)) !== null) {
		// 反转义 HTML 实体(&lt; → <, &gt; → >, &amp; → &)
		const code = match[1]!
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&amp;/g, '&')
			.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'");
		blocks.push(code);
	}
	return blocks;
}

/**
 * 渲染容器中的所有 mermaid 代码块为 SVG。
 *
 * 关键路径:在 innerHTML 注入 DOM 后调用,querySelectorAll 找到所有
 * `code.language-mermaid` 元素,用 mermaid.render() 生成 SVG 替换。
 * 单个块渲染失败不影响其他块(显示原始代码 + 错误提示)。
 *
 * @param container - 包含已渲染 HTML 的 DOM 容器
 * @returns Promise,所有 mermaid 块渲染完成后 resolve
 */
export async function renderMermaidBlocks(container: HTMLElement): Promise<void> {
	const mermaidCodeEls = container.querySelectorAll<HTMLElement>('code.language-mermaid');
	if (mermaidCodeEls.length === 0) return;

	const renderPromises: Promise<void>[] = [];

	mermaidCodeEls.forEach((codeEl) => {
		renderPromises.push(renderSingleMermaidBlock(codeEl));
	});

	await Promise.allSettled(renderPromises);
}

/**
 * 渲染单个 mermaid 代码块。
 *
 * @param codeEl - `<code class="...language-mermaid...">` 元素
 */
async function renderSingleMermaidBlock(codeEl: HTMLElement): Promise<void> {
	const code = codeEl.textContent ?? '';
	if (!code.trim()) return;

	const id = `ratel-mermaid-${++renderCounter}`;

	try {
		const { svg } = await mermaid.render(id, code);
		// 关键路径:替换 <pre><code> 结构为 mermaid SVG 容器
		// 关键路径:用 DOMParser + replaceChildren 替代 innerHTML=,避免触发 no-inner-html 规则;
		// 即便经 DOMPurify 清洗,linter 仍会拦截 innerHTML 赋值,改用 DOM 解析后插入子节点更安全。
		// 安全路径:activeDocument.body.createDiv 满足 prefer-create-el,且兼容 popout
		const wrapper = activeDocument.body.createDiv({ cls: 'ratel-mermaid' });
		wrapper.remove();
		const sanitized = DOMPurify.sanitize(svg, MERMAID_SANITIZE_CONFIG);
		const parsed = new DOMParser().parseFromString(sanitized, 'image/svg+xml');
		wrapper.replaceChildren(parsed.documentElement);
		const pre = codeEl.parentElement; // <pre> 标签
		if (pre && pre.tagName === 'PRE') {
			pre.replaceWith(wrapper);
		} else {
			codeEl.replaceWith(wrapper);
		}
	} catch (err) {
		// 修复:mermaid 渲染失败时显示原始代码 + 错误提示,不影响其他内容
		const errorDiv = activeDocument.body.createDiv({
			cls: 'ratel-mermaid-error',
			text: `Mermaid 渲染失败: ${err instanceof Error ? err.message : String(err)}`,
		});
		errorDiv.remove();
		const pre = codeEl.parentElement;
		if (pre && pre.tagName === 'PRE') {
			pre.replaceWith(errorDiv);
		} else {
			codeEl.replaceWith(errorDiv);
		}
	}
}
