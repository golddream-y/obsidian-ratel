/**
 * @file tests/adapters/obsidian-workspace.test.ts
 * @description ObsidianWorkspace openNote / openPluginSettings 适配层单测
 * @module tests/adapters/obsidian-workspace
 */

import { describe, it, expect, vi } from 'vitest';
import { ObsidianWorkspace } from '../../src/adapters/obsidian-workspace';
import type { App } from 'obsidian';
import type { RatelVaultSettingTab } from '../../src/settings';

/**
 * 构造最小 App mock — 本测试只需可控的 openLinkText / setting.open / setting.openTabById,
 * 其余 workspace 方法返回 null 即可(adapter 既有方法不在本测试路径上)。
 */
function makeApp(opts: { openLinkText?: unknown } = {}): App {
	return {
		workspace: {
			openLinkText: opts.openLinkText ?? vi.fn().mockResolvedValue({}),
			getActiveFile: () => null,
			getActiveViewOfType: () => null,
		},
		setting: {
			open: vi.fn(),
			openTabById: vi.fn(),
		},
	} as unknown as App;
}

describe('ObsidianWorkspace.openNote', () => {
	it('openNote - 正常 linktext - 调 openLinkText 并返回 true', async () => {
		// 真实签名 Promise<void>:成功 resolve undefined,不抛错即成功
		const openLinkText = vi.fn().mockResolvedValue(undefined);
		const ws = new ObsidianWorkspace(makeApp({ openLinkText }), () => null);
		const ok = await ws.openNote('notes/foo.md#标题');
		expect(openLinkText).toHaveBeenCalledWith('notes/foo.md#标题', '', false);
		expect(ok).toBe(true);
	});

	it('openNote - openLinkText 抛错 - 返回 false', async () => {
		const openLinkText = vi.fn().mockRejectedValue(new Error('workspace API error'));
		const ws = new ObsidianWorkspace(makeApp({ openLinkText }), () => null);
		const ok = await ws.openNote('不存在.md');
		expect(ok).toBe(false);
	});
});

describe('ObsidianWorkspace.openPluginSettings', () => {
	it('openPluginSettings - SettingTab 实例存在 - 打开设置并定位 tab,返回 focusTab 结果', async () => {
		const app = makeApp();
		const focusTab = vi.fn().mockReturnValue(true);
		const ws = new ObsidianWorkspace(app, () => ({ focusTab }) as unknown as RatelVaultSettingTab);
		const ok = await ws.openPluginSettings('index');
		expect(
			(app as unknown as { setting: { open: ReturnType<typeof vi.fn> } }).setting.open,
		).toHaveBeenCalledTimes(1);
		expect(
			(app as unknown as { setting: { openTabById: ReturnType<typeof vi.fn> } }).setting.openTabById,
		).toHaveBeenCalledWith('ratel-vault');
		expect(focusTab).toHaveBeenCalledWith('index');
		expect(ok).toBe(true);
	});

	it('openPluginSettings - SettingTab 实例为 null - 返回 false', async () => {
		const app = makeApp();
		const ws = new ObsidianWorkspace(app, () => null);
		const ok = await ws.openPluginSettings('chat');
		expect(ok).toBe(false);
	});
});
