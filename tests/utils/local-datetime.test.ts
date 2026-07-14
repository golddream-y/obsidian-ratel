/**
 * @file tests/utils/local-datetime.test.ts
 * @description local-datetime 格式化单测
 * @module tests/utils/local-datetime
 */

import { describe, it, expect } from 'vitest';
import {
	formatLocalDateTime,
	formatEnvContextLine,
	formatDailyNoteStem,
	parseLocalDateOnly,
} from '../../src/utils/local-datetime';

describe('local-datetime', () => {
	// 固定 +08:00 正午,避免 CI 时区漂移导致 weekday/local 不稳定
	const fixed = new Date('2026-07-14T12:00:00+08:00');

	it('formatLocalDateTime - 固定时刻 - 含 iso/时区/中文星期', () => {
		const info = formatLocalDateTime(fixed);
		expect(info.iso).toBe(fixed.toISOString());
		expect(info.epochMs).toBe(fixed.getTime());
		expect(info.timezone.length).toBeGreaterThan(0);
		expect(info.weekday).toMatch(/^星期/);
		expect(info.local).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
	});

	it('formatEnvContextLine - 固定时刻 - 单行含时间与星期', () => {
		const line = formatEnvContextLine(fixed);
		expect(line.startsWith('当前本地时间:')).toBe(true);
		expect(line).toContain(formatLocalDateTime(fixed).timezone);
		expect(line).toMatch(/星期/);
	});

	it('formatDailyNoteStem - YYYY-MM-DD - 替换年月日', () => {
		expect(formatDailyNoteStem(fixed, 'YYYY-MM-DD')).toBe('2026-07-14');
		expect(formatDailyNoteStem(fixed, 'YYYY/MM/DD')).toBe('2026/07/14');
	});

	it('parseLocalDateOnly - 合法日期 - 返回本地 Date', () => {
		const d = parseLocalDateOnly('2026-07-14');
		expect(d).not.toBeNull();
		expect(d!.getFullYear()).toBe(2026);
		expect(d!.getMonth()).toBe(6);
		expect(d!.getDate()).toBe(14);
	});

	it('parseLocalDateOnly - 非法串 - 返回 null', () => {
		expect(parseLocalDateOnly('2026-13-01')).toBeNull();
		expect(parseLocalDateOnly('not-a-date')).toBeNull();
	});
});
