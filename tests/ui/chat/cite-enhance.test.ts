/**
 * @file tests/ui/chat/cite-enhance.test.ts
 * @description 正文 `[n]` 提升为可点 cite
 * @module tests/ui/chat/cite-enhance
 */
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { enhanceCiteLinks } from '../../../src/ui/chat/cite-enhance';

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
