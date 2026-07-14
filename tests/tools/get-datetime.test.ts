/**
 * @file tests/tools/get-datetime.test.ts
 * @description get_datetime 工具单测
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createGetDatetimeTool } from '../../src/tools/get-datetime';
import { makeToolDef } from '../helpers/make-tool-def';

describe('get_datetime', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('offsetDays=1 - 日期进一天', async () => {
		vi.useFakeTimers();
		// 关键路径:用本地构造避免 ISO+offset 在非 +08 CI 上落到前一天
		vi.setSystemTime(new Date(2026, 6, 14, 12, 0, 0));
		const tool = createGetDatetimeTool(makeToolDef('get_datetime'));
		const result = (await tool.execute({ offsetDays: 1, format: 'local' })) as {
			local: string;
		};
		expect(result.local.startsWith('2026-07-15')).toBe(true);
	});

	it('format=full - 返回完整字段', async () => {
		const tool = createGetDatetimeTool(makeToolDef('get_datetime'));
		const result = (await tool.execute({})) as Record<string, unknown>;
		expect(result).toHaveProperty('iso');
		expect(result).toHaveProperty('local');
		expect(result).toHaveProperty('timezone');
		expect(result).toHaveProperty('weekday');
		expect(result).toHaveProperty('epochMs');
	});
});
