/**
 * @file tests/adapters/data-json-merge.test.ts
 * @description data.json merge — settings 与 sessionIndex 互不覆盖
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mergePluginData } from '../../src/adapters/data-json-merge';
import { PersistenceJson } from '../../src/adapters/persistence-json';

describe('mergePluginData / settings↔persistence', () => {
	it('mergePluginData - patch 覆盖同名键 - 保留其它键', () => {
		const next = mergePluginData(
			{ sessionIndex: [{ id: 's1' }], chatModel: 'old' },
			{ chatModel: 'new' },
		);
		expect(next.chatModel).toBe('new');
		expect(next.sessionIndex).toEqual([{ id: 's1' }]);
	});

	describe('Persistence upsert 后再 merge settings', () => {
		let pluginDir: string;
		let disk: Record<string, unknown>;

		beforeEach(() => {
			pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-merge-'));
			disk = { chatModel: 'deepseek-chat' };
		});
		afterEach(() => {
			fs.rmSync(pluginDir, { recursive: true, force: true });
		});

		it('upsert session 后 saveSettings 风格 merge - sessionIndex 仍在', async () => {
			const p = new PersistenceJson(
				async () => disk,
				async (d) => {
					disk = d as Record<string, unknown>;
				},
				pluginDir,
			);
			await p.sessions.upsert({
				id: 's1',
				title: 't',
				messages: [{ role: 'user', content: 'hi' }],
				createdAt: 1,
				updatedAt: 2,
			});
			expect(Array.isArray(disk.sessionIndex)).toBe(true);
			disk = mergePluginData(disk, { chatModel: 'other-model' });
			expect(disk.chatModel).toBe('other-model');
			expect(Array.isArray(disk.sessionIndex)).toBe(true);
			expect((disk.sessionIndex as unknown[]).length).toBe(1);
		});
	});
});
