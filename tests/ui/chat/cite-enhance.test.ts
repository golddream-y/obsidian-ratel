/**
 * @file tests/ui/chat/cite-enhance.test.ts
 * @description 正文 `[n]` 提升为可点 cite
 * @module tests/ui/chat/cite-enhance
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { enhanceCiteLinks } from '../../../src/ui/chat/cite-enhance';

type DomElementInfo = {
	cls?: string | string[];
	text?: string | DocumentFragment;
	attr?: Record<string, string | number | boolean | null>;
};

/** jsdom 无 Obsidian DOM 助手 — 测试前补齐 createFragment / createEl / appendText */
beforeAll(() => {
	const g = globalThis as typeof globalThis & {
		createFragment?: () => DocumentFragment;
		createEl?: (tag: string, o?: DomElementInfo | string) => HTMLElement;
	};
	if (!g.createFragment) {
		g.createFragment = () => {
			const frag = document.createDocumentFragment();
			(frag as DocumentFragment & { appendText: (val: string) => void }).appendText = (val) => {
				frag.appendChild(document.createTextNode(val));
			};
			return frag;
		};
	}
	if (!g.createEl) {
		g.createEl = (tag, o) => {
			const el = document.createElement(tag);
			if (typeof o === 'string') {
				el.className = o;
				return el;
			}
			if (o?.cls) {
				el.className = Array.isArray(o.cls) ? o.cls.join(' ') : o.cls;
			}
			if (o?.text != null) {
				el.textContent = String(o.text);
			}
			if (o?.attr) {
				for (const [k, v] of Object.entries(o.attr)) {
					if (v != null) el.setAttribute(k, String(v));
				}
			}
			return el;
		};
	}
});

describe('enhanceCiteLinks', () => {
	it('增强 - 匹配编号 - 替换为按钮并可点击', () => {
		const root = document.createElement('div');
		root.innerHTML = '<p>见 [1] 与 [[2]]</p>';
		const onCite = vi.fn();
		const cleanup = enhanceCiteLinks(root, new Set([1, 2]), onCite);

		const buttons = root.querySelectorAll('button.ratel-cite');
		expect(buttons).toHaveLength(2);
		expect(buttons[0]!.textContent).toBe('[1]');
		expect(buttons[1]!.textContent).toBe('[2]');

		(buttons[0] as HTMLButtonElement).click();
		expect(onCite).toHaveBeenCalledWith(1);

		cleanup();
		expect(root.querySelectorAll('button.ratel-cite')).toHaveLength(0);
		expect(root.textContent).toContain('[1]');
	});

	it('增强 - 无匹配编号 - 保持纯文本', () => {
		const root = document.createElement('div');
		root.innerHTML = '<p>见 [9]</p>';
		enhanceCiteLinks(root, new Set([1]), vi.fn());
		expect(root.querySelectorAll('button.ratel-cite')).toHaveLength(0);
		expect(root.textContent).toContain('[9]');
	});

	it('增强 - code 块内 - 不替换', () => {
		const root = document.createElement('div');
		root.innerHTML = '<pre><code>[1]</code></pre><p>[1]</p>';
		enhanceCiteLinks(root, new Set([1]), vi.fn());
		expect(root.querySelectorAll('button.ratel-cite')).toHaveLength(1);
		expect(root.querySelector('code')!.textContent).toBe('[1]');
	});
});
