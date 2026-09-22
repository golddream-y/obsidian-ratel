/**
 * @file tests/adapters/ecosystem-io-ext.test.ts
 * @description EcosystemIo 扩展 — Memory/Adapter listPluginIds 与 copyTree
 * @module adapters/ecosystem-io-ext.test
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DataAdapter } from 'obsidian';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setConfigDir } from '../../src/utils/path-safety';
import { AdapterEcosystemIo, MemoryEcosystemIo } from '../../src/adapters/ecosystem-vault';

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

/** 模拟 Obsidian list 返回 vault 相对全路径 */
class FullPathListAdapter implements Pick<DataAdapter, 'list' | 'read'> {
	readonly readCalls: string[] = [];
	private readonly listings: Record<string, { files: string[]; folders: string[] }>;
	private readonly contents: Record<string, string>;

	constructor(
		listings: Record<string, { files: string[]; folders: string[] }>,
		contents: Record<string, string>,
	) {
		this.listings = listings;
		this.contents = contents;
	}

	async list(dir: string): Promise<{ files: string[]; folders: string[] }> {
		return this.listings[dir] ?? { files: [], folders: [] };
	}

	async read(file: string): Promise<string> {
		this.readCalls.push(file);
		return this.contents[file] ?? '';
	}
}

describe('AdapterEcosystemIo', () => {
	beforeEach(() => {
		setConfigDir('.obsidian');
	});

	it('listPluginIds - list 返回全路径 - 只取 id 且排除 ratel-vault', async () => {
		const adapter = new FullPathListAdapter(
			{
				'.obsidian/plugins': {
					folders: ['.obsidian/plugins/calendar', '.obsidian/plugins/ratel-vault'],
					files: [],
				},
			},
			{},
		);
		const io = new AdapterEcosystemIo(adapter as DataAdapter, () => ({
			catalogIds: new Set(['calendar']),
			installedIds: new Set(['calendar']),
		}));
		await expect(io.listPluginIds('.obsidian')).resolves.toEqual(['calendar']);
	});

	it('copyTree - list 全路径 - read 一次且 dst 下为 basename', async () => {
		const mainRel = '.obsidian/plugins/calendar/main.js';
		const adapter = new FullPathListAdapter(
			{
				'.obsidian/plugins/calendar': { files: [mainRel], folders: [] },
			},
			{ [mainRel]: 'module.exports={};' },
		);
		const io = new AdapterEcosystemIo(adapter as DataAdapter, () => ({
			catalogIds: new Set(['calendar']),
			installedIds: new Set(['calendar']),
		}));
		const dst = mkdtempSync(path.join(tmpdir(), 'ratel-eco-copy-'));
		try {
			await io.copyTree('.obsidian/plugins/calendar', dst);
			expect(adapter.readCalls).toEqual([mainRel]);
			expect(readFileSync(path.join(dst, 'main.js'), 'utf-8')).toBe('module.exports={};');
			expect(() =>
				readFileSync(path.join(dst, '.obsidian', 'plugins', 'calendar', 'main.js'), 'utf-8'),
			).toThrow();
		} finally {
			rmSync(dst, { recursive: true, force: true });
		}
	});
});
