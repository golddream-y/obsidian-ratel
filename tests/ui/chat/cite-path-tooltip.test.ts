/**
 * @file tests/ui/chat/cite-path-tooltip.test.ts
 * @description 引用悬停路径 tip
 * @module tests/ui/chat/cite-path-tooltip
 */
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { bindCitePathTooltip } from '../../../src/ui/chat/cite-path-tooltip';

describe('bindCitePathTooltip', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('bindCitePathTooltip - pointerenter - 显示路径 tip', () => {
		const btn = document.createElement('button');
		document.body.appendChild(btn);
		const cleanup = bindCitePathTooltip(btn, 'folder/note.md');
		btn.dispatchEvent(new Event('pointerenter'));
		const tip = document.querySelector('.ratel-cite-tip');
		expect(tip).toBeTruthy();
		expect(tip!.textContent).toBe('folder/note.md');
		btn.dispatchEvent(new Event('pointerleave'));
		expect(document.querySelector('.ratel-cite-tip')).toBeNull();
		cleanup();
	});
});
