/**
 * @file tests/helpers/global-polyfill.ts
 * @description vitest 全局 polyfill — Node 环境下补齐 window / activeDocument / 等 Obsidian 渲染进程全局
 * @module tests/helpers/global-polyfill
 *
 * 关键路径:
 * - 源码遵循 Obsidian linter 规则,统一用 `window.setTimeout` / `activeDocument.createElement`
 *   以兼容 popout 窗口。
 * - 但 vitest `environment: 'node'` 下无 `window` / `activeDocument`,
 *   会导致源码导入即崩。本文件在 setupFiles 阶段把这些全局指向 globalThis,
 *   让源码在测试环境正常工作。
 */

// 关键路径:Node 环境 `globalThis.window` 不存在;源码用 `window.setTimeout` 时会抛 ReferenceError。
// 把 window 指向 globalThis,让 setTimeout/clearTimeout/requestAnimationFrame 走 Node 实现。
if (typeof (globalThis as Record<string, unknown>).window === 'undefined') {
	(globalThis as Record<string, unknown>).window = globalThis;
}

// 关键路径:Obsidian 的 activeDocument 在测试环境不存在,指向 globalThis.document(node 内置,可能为 undefined)。
// 仅在 document 已存在时绑定,避免 jsdom 缺失环境报错。
if (typeof (globalThis as Record<string, unknown>).activeDocument === 'undefined') {
	(globalThis as Record<string, unknown>).activeDocument =
		(globalThis as Record<string, unknown>).document ?? globalThis;
}

// 关键路径:requestAnimationFrame / cancelAnimationFrame 在 Node 不存在,提供 noop 占位。
if (typeof (globalThis as Record<string, unknown>).requestAnimationFrame === 'undefined') {
	(globalThis as Record<string, unknown>).requestAnimationFrame = (cb: FrameRequestCallback) => {
		return setTimeout(() => cb(0), 0);
	};
}
if (typeof (globalThis as Record<string, unknown>).cancelAnimationFrame === 'undefined') {
	(globalThis as Record<string, unknown>).cancelAnimationFrame = (id: number) => {
		clearTimeout(id);
	};
}

// 关键路径:DOMParser 在 Node 不存在,提供最小桩 — mermaid-renderer 等用 DOMParser 解析 SVG 字符串。
// 测试不依赖实际解析结果,只要返回一个带 documentElement 的对象即可。
if (typeof (globalThis as Record<string, unknown>).DOMParser === 'undefined') {
	(globalThis as Record<string, unknown>).DOMParser = class {
		parseFromString(_source: string, _mimeType: string) {
			return {
				documentElement: {} as Element,
			};
		}
	};
}

// 关键路径:jsdom 无 Obsidian HTMLElement 助手；商店 prefer-create-el 要求源码走 createDiv/createEl/setCssProps
if (typeof HTMLElement !== 'undefined') {
	const proto = HTMLElement.prototype as HTMLElement & {
		createEl?: (tag: string, o?: { cls?: string; text?: string; attr?: Record<string, string> } | string) => HTMLElement;
		createDiv?: (o?: { cls?: string; text?: string; attr?: Record<string, string> } | string) => HTMLDivElement;
		setText?: (t: string) => void;
		setCssProps?: (props: Record<string, string>) => void;
	};
	const apply = (el: HTMLElement, o?: { cls?: string; text?: string; attr?: Record<string, string> } | string) => {
		const opts = typeof o === 'string' ? { cls: o } : o;
		if (opts?.cls) el.className = opts.cls;
		if (opts?.text) el.textContent = opts.text;
		if (opts?.attr) {
			for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
		}
	};
	if (!proto.createEl) {
		proto.createEl = function (this: HTMLElement, tag, o) {
			const el = document.createElement(tag);
			apply(el, o);
			this.appendChild(el);
			return el;
		};
	}
	if (!proto.createDiv) {
		proto.createDiv = function (this: HTMLElement, o) {
			return this.createEl!('div', o) as HTMLDivElement;
		};
	}
	if (!proto.setText) {
		proto.setText = function (this: HTMLElement, t: string) {
			this.textContent = t;
		};
	}
	if (!proto.setCssProps) {
		proto.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
			for (const [k, v] of Object.entries(props)) {
				this.style.setProperty(k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), v);
			}
		};
	}
}
