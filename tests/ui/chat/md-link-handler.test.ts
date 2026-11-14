// @vitest-environment jsdom
/**
 * @file tests/ui/chat/md-link-handler.test.ts
 * @description 正文链接点击代理 — 内部路径 / 外链 / 页内锚点 / 解绑
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/utils/open-external-url', () => ({
	openExternalUrl: vi.fn(async () => undefined),
}));

import { openExternalUrl } from '../../../src/utils/open-external-url';
import {
	bindMarkdownLinkClick,
	hrefToVaultPath,
	isExternalHref,
} from '../../../src/ui/chat/md-link-handler';

function clickAnchor(anchor: Element): MouseEvent {
	const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
	anchor.dispatchEvent(event);
	return event;
}

describe('md-link-handler', () => {
	beforeEach(() => {
		vi.mocked(openExternalUrl).mockClear();
		document.body.innerHTML = '';
	});

	it('内部链接解码后交给 onOpenPath,并阻止默认导航', () => {
		const container = document.createElement('div');
		container.innerHTML = '<a href="Personal/%E8%B4%B9%E7%94%A8/%E7%AE%97%E5%8A%9B%E5%9E%AB%E4%BB%98.md">算力垫付.md</a>';
		document.body.append(container);
		const onOpenPath = vi.fn();
		bindMarkdownLinkClick(container, { onOpenPath });

		const anchor = container.querySelector('a')!;
		const event = clickAnchor(anchor);

		expect(onOpenPath).toHaveBeenCalledWith('Personal/费用/算力垫付.md');
		expect(event.defaultPrevented).toBe(true);
		expect(openExternalUrl).not.toHaveBeenCalled();
	});

	it('外链走系统浏览器', () => {
		const container = document.createElement('div');
		container.innerHTML = '<a href="https://example.com/x">外链</a>';
		document.body.append(container);
		bindMarkdownLinkClick(container, { onOpenPath: vi.fn() });

		clickAnchor(container.querySelector('a')!);

		expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/x');
	});

	it('页内锚点只阻止默认导航,不打开任何文档', () => {
		const container = document.createElement('div');
		container.innerHTML = '<a href="#报销进度">锚点</a>';
		document.body.append(container);
		const onOpenPath = vi.fn();
		bindMarkdownLinkClick(container, { onOpenPath });

		const event = clickAnchor(container.querySelector('a')!);

		expect(event.defaultPrevented).toBe(true);
		expect(onOpenPath).not.toHaveBeenCalled();
		expect(openExternalUrl).not.toHaveBeenCalled();
	});

	it('解绑后不再响应点击', () => {
		const container = document.createElement('div');
		container.innerHTML = '<a href="A.md">A</a>';
		document.body.append(container);
		const onOpenPath = vi.fn();
		const unbind = bindMarkdownLinkClick(container, { onOpenPath });
		unbind();

		clickAnchor(container.querySelector('a')!);

		expect(onOpenPath).not.toHaveBeenCalled();
	});

	it('href 归一化与外部链接判定', () => {
		expect(hrefToVaultPath('./A%20B.md')).toBe('A B.md');
		expect(hrefToVaultPath('/A.md')).toBe('A.md');
		expect(isExternalHref('https://a.com')).toBe(true);
		expect(isExternalHref('mailto:a@b.c')).toBe(true);
		expect(isExternalHref('Personal/A.md')).toBe(false);
	});
});
