/**
 * @file tests/utils/chat-time.test.ts
 * @description 跨日分割线 / 会话列表 / env 间隔纯函数
 * @module utils/chat-time.test
 */
import { describe, it, expect } from 'vitest';
import {
	composeEnvContext,
	formatDayDividerLabel,
	formatEnvGapLine,
	formatSessionWhen,
	lastUserCreatedAt,
	localYmd,
	shouldShowDayDivider,
	shouldShowEnvGap,
} from '../../src/utils/chat-time';

const local = (y: number, m: number, d: number, h = 12, min = 0) =>
	new Date(y, m - 1, d, h, min, 0, 0).getTime();

describe('localYmd / shouldShowDayDivider', () => {
	it('shouldShowDayDivider - curr 缺省 - 不插', () => {
		expect(shouldShowDayDivider(local(2026, 9, 16), undefined)).toBe(false);
	});

	it('shouldShowDayDivider - prev 缺省且 curr 有值 - 插', () => {
		expect(shouldShowDayDivider(undefined, local(2026, 9, 16))).toBe(true);
	});

	it('shouldShowDayDivider - 同一本地日 - 不插', () => {
		expect(shouldShowDayDivider(local(2026, 9, 16, 1), local(2026, 9, 16, 23))).toBe(false);
	});

	it('shouldShowDayDivider - 跨本地日 - 插', () => {
		expect(shouldShowDayDivider(local(2026, 9, 16, 23), local(2026, 9, 17, 0, 30))).toBe(true);
	});

	it('localYmd - 同一本地日早晚 - 年月日相同', () => {
		expect(localYmd(local(2026, 9, 16, 0, 30))).toEqual(localYmd(local(2026, 9, 16, 23, 30)));
	});
});

describe('formatDayDividerLabel', () => {
	const now = new Date(2026, 8, 17, 12, 0, 0, 0);

	it('formatDayDividerLabel - 当天 - 今天', () => {
		expect(formatDayDividerLabel(local(2026, 9, 17), now)).toEqual({ key: 'chat.day.today' });
	});

	it('formatDayDividerLabel - 昨天 - 昨天', () => {
		expect(formatDayDividerLabel(local(2026, 9, 16), now)).toEqual({ key: 'chat.day.yesterday' });
	});

	it('formatDayDividerLabel - 同年更早 - monthDay', () => {
		expect(formatDayDividerLabel(local(2026, 3, 5), now)).toEqual({
			key: 'chat.day.monthDay',
			params: { month: 3, day: 5 },
		});
	});

	it('formatDayDividerLabel - 跨年 - yearMonthDay', () => {
		expect(formatDayDividerLabel(local(2025, 12, 31), now)).toEqual({
			key: 'chat.day.yearMonthDay',
			params: { year: 2025, month: 12, day: 31 },
		});
	});
});

describe('formatSessionWhen', () => {
	const now = new Date(2026, 8, 17, 12, 0, 0, 0).getTime();

	it('formatSessionWhen - 当天 3 小时前 - hours', () => {
		expect(formatSessionWhen(now - 3 * 3600_000, now)).toEqual({
			key: 'chat.session.whenHours',
			params: { n: 3 },
		});
	});

	it('formatSessionWhen - 昨天 - yesterday', () => {
		expect(formatSessionWhen(local(2026, 9, 16, 18), now)).toEqual({ key: 'chat.day.yesterday' });
	});

	it('formatSessionWhen - 跨年 - yearMonthDay', () => {
		expect(formatSessionWhen(local(2025, 12, 1), now)).toEqual({
			key: 'chat.day.yearMonthDay',
			params: { year: 2025, month: 12, day: 1 },
		});
	});
});

describe('env gap', () => {
	const now = new Date(2026, 8, 17, 12, 0, 0, 0);

	it('composeEnvContext - 无上一轮时间戳 - 只有当前时间行', () => {
		const text = composeEnvContext(now, undefined);
		expect(text.startsWith('当前本地时间:')).toBe(true);
		expect(text.includes('距上一轮')).toBe(false);
	});

	it('shouldShowEnvGap - 同日 3 小时 - 否', () => {
		expect(shouldShowEnvGap(local(2026, 9, 17, 9), now)).toBe(false);
	});

	it('shouldShowEnvGap - 同日 5 小时 - 是', () => {
		expect(shouldShowEnvGap(local(2026, 9, 17, 7), now)).toBe(true);
	});

	it('formatEnvGapLine - 跨日 30 分钟 - 不足 1 小时', () => {
		const last = local(2026, 9, 16, 23, 30);
		const n = new Date(2026, 8, 17, 0, 0, 0, 0);
		expect(shouldShowEnvGap(last, n)).toBe(true);
		expect(formatEnvGapLine(last, n)).toContain('不足 1 小时');
		expect(formatEnvGapLine(last, n)).toContain('上次 2026-09-16 23:30');
	});

	it('formatEnvGapLine - 26 小时 50 分 - 26 小时', () => {
		const n = new Date(2026, 8, 17, 12, 0, 0, 0);
		const last = n.getTime() - (26 * 3600_000 + 50 * 60_000);
		expect(formatEnvGapLine(last, n)).toContain('26 小时');
	});

	it('lastUserCreatedAt - 从后往前找 user', () => {
		expect(
			lastUserCreatedAt([
				{ role: 'user', createdAt: 1 },
				{ role: 'assistant', createdAt: 2 },
				{ role: 'user', createdAt: 3 },
				{ role: 'assistant', createdAt: 4 },
			]),
		).toBe(3);
	});
});
