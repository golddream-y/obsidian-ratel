/**
 * @file tests/tools/get-daily-note.test.ts
 * @description get_daily_note 工具单测
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createGetDailyNoteTool } from '../../src/tools/get-daily-note';
import { createMockVaultPort } from '../helpers/mock-vault-port';
import { makeToolDef } from '../helpers/make-tool-def';

describe('get_daily_note', () => {
	afterEach(() => vi.useRealTimers());

	it('存在日记 - exists=true', async () => {
		vi.useFakeTimers();
		// 关键路径:本地构造日期,避免跨时区断言失败
		vi.setSystemTime(new Date(2026, 6, 14, 12, 0, 0));
		const vault = createMockVaultPort({ files: { 'daily/2026-07-14.md': '# today' } });
		const tool = createGetDailyNoteTool(
			vault,
			() => ({ folder: 'daily', format: 'YYYY-MM-DD' }),
			makeToolDef('get_daily_note'),
		);
		const result = (await tool.execute({})) as { path: string; exists: boolean; date: string };
		expect(result.path).toBe('daily/2026-07-14.md');
		expect(result.exists).toBe(true);
		expect(result.date).toBe('2026-07-14');
	});

	it('不存在 - exists=false 且不创建', async () => {
		const vault = createMockVaultPort({ files: {} });
		const tool = createGetDailyNoteTool(
			vault,
			() => ({ folder: '', format: 'YYYY-MM-DD' }),
			makeToolDef('get_daily_note'),
		);
		const result = (await tool.execute({ date: '2026-01-01' })) as {
			path: string;
			exists: boolean;
		};
		expect(result.path).toBe('2026-01-01.md');
		expect(result.exists).toBe(false);
		expect(await vault.fileExists('2026-01-01.md')).toBe(false);
	});

	it('非法日期 - 返回 path=null 与 message 不抛错', async () => {
		const vault = createMockVaultPort({ files: {} });
		const tool = createGetDailyNoteTool(
			vault,
			() => ({ folder: 'daily', format: 'YYYY-MM-DD' }),
			makeToolDef('get_daily_note'),
		);
		const result = (await tool.execute({ date: 'not-a-date' })) as {
			path: null;
			exists: boolean;
			message: string;
		};
		expect(result.path).toBeNull();
		expect(result.exists).toBe(false);
		expect(result.message).toContain('日期格式无效');
	});
});
