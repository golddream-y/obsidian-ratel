/**
 * @file tests/core/ecosystem-change-log.test.ts
 * @description jsonl 新在前、按 pluginId 过滤
 * @module core/ecosystem-change-log.test
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendEcosystemChange, listEcosystemChanges } from '../../src/core/ecosystem-change-log';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'ratel-elog-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('ecosystem-change-log', () => {
	it('appendEcosystemChange - 两条后 list limit 1 - 只要最新', async () => {
		const a = await appendEcosystemChange(dir, { action: 'install', pluginId: 'calendar', summary: 'a' });
		const b = await appendEcosystemChange(dir, { action: 'configure', pluginId: 'calendar', summary: 'b' });
		expect(a.id).toBe('ch_000001');
		expect(b.id).toBe('ch_000002');
		const rows = await listEcosystemChanges(dir, { limit: 1 });
		expect(rows).toHaveLength(1);
		expect(rows[0]!.id).toBe('ch_000002');
	});
	it('listEcosystemChanges - pluginId 过滤', async () => {
		await appendEcosystemChange(dir, { action: 'install', pluginId: 'calendar', summary: 'a' });
		await appendEcosystemChange(dir, { action: 'install', pluginId: 'dataview', summary: 'b' });
		const rows = await listEcosystemChanges(dir, { pluginId: 'dataview' });
		expect(rows).toHaveLength(1);
		expect(rows[0]!.pluginId).toBe('dataview');
	});
});
