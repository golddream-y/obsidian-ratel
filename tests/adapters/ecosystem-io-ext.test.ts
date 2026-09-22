/**
 * @file tests/adapters/ecosystem-io-ext.test.ts
 * @description MemoryEcosystemIo 扩展方法 — listPluginIds 不校验 plugins 根
 * @module adapters/ecosystem-io-ext.test
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { setConfigDir } from '../../src/utils/path-safety';
import { MemoryEcosystemIo } from '../../src/adapters/ecosystem-vault';

describe('MemoryEcosystemIo.listPluginIds', () => {
	beforeEach(() => {
		setConfigDir('.obsidian');
	});

	it('listPluginIds - 已装 calendar 与 ratel-vault - 只返回 calendar', async () => {
		const ctx = () => ({
			catalogIds: new Set(['calendar', 'ratel-vault']),
			installedIds: new Set(['calendar', 'ratel-vault']),
		});
		const io = new MemoryEcosystemIo(ctx);
		await io.writeText('.obsidian/plugins/calendar/manifest.json', '{"id":"calendar"}');
		// 通道 B writeText 会拒 ratel-vault;直接写入内存盘键模拟 vault 上已存在
		io.files.set('.obsidian/plugins/ratel-vault/manifest.json', '{"id":"ratel-vault"}');
		await expect(io.listPluginIds('.obsidian')).resolves.toEqual(['calendar']);
	});
});
