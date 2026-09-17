/**
 * @file src/utils/chat-time.ts
 * @description 跨日续聊 — 本地日历日、分割线文案、会话列表、env 间隔（S-CHAT-TIME）
 * @module utils/chat-time
 * @depends utils/local-datetime, i18n/types
 */
import type { StringKey } from '../i18n/types';
import { formatEnvContextLine, formatLocalDateTime } from './local-datetime';

/** 同日连续对答不注入间隔行的空闲阈值（4 小时） */
export const ENV_GAP_IDLE_MS = 4 * 60 * 60 * 1000;

/** 本地日历日（年月日，与 formatLocalDateTime 同一套本地墙钟） */
export type Ymd = { y: number; m: number; d: number };

/** i18n 标签：key + 可选插值参数 */
export type ChatTimeLabel = { key: StringKey; params?: Record<string, string | number> };

/**
 * 将 epoch ms 转为本地日历日。
 *
 * @param ts - Unix epoch 毫秒
 * @returns 本地年月日
 */
export function localYmd(ts: number): Ymd {
	const d = new Date(ts);
	return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
}

/** 比较两个本地日历日是否相同 */
function ymdEq(a: Ymd, b: Ymd): boolean {
	return a.y === b.y && a.m === b.m && a.d === b.d;
}

/**
 * 取某时刻所在本地日的 00:00:00.000 epoch ms。
 *
 * @param ts - Unix epoch 毫秒
 * @returns 本地日零点时刻
 */
function startOfLocalDay(ts: number): number {
	const d = new Date(ts);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

/**
 * 判断两条消息之间是否应插入日分割线。
 *
 * 规则：curr 缺省不插；prev 缺省且 curr 有值则插；本地日不同则插。
 *
 * @param prev - 前一条气泡的 createdAt（可缺省）
 * @param curr - 当前气泡的 createdAt（可缺省）
 * @returns 是否插入分割线
 */
export function shouldShowDayDivider(prev: number | undefined, curr: number | undefined): boolean {
	if (curr === undefined) return false;
	if (prev === undefined) return true;
	return !ymdEq(localYmd(prev), localYmd(curr));
}

/**
 * 生成日分割线 i18n 标签（今天 / 昨天 / M月D日 / YYYY年M月D日）。
 *
 * @param ts - 目标气泡的 createdAt
 * @param now - 参照时刻（通常为当前时间）
 * @returns i18n key 与插值参数
 */
export function formatDayDividerLabel(ts: number, now: Date): ChatTimeLabel {
	const nowTs = now.getTime();
	const curr = localYmd(ts);
	const today = localYmd(nowTs);
	if (ymdEq(curr, today)) return { key: 'chat.day.today' };
	const yStart = startOfLocalDay(nowTs);
	const yest = localYmd(yStart - 1);
	if (ymdEq(curr, yest)) return { key: 'chat.day.yesterday' };
	if (curr.y === today.y) {
		return { key: 'chat.day.monthDay', params: { month: curr.m, day: curr.d } };
	}
	return { key: 'chat.day.yearMonthDay', params: { year: curr.y, month: curr.m, day: curr.d } };
}

/**
 * 生成会话列表相对/日历时间 i18n 标签。
 *
 * 与 now 同一本地日：相对（· / Nm / Nh）；否则复用 formatDayDividerLabel。
 *
 * @param updatedAt - 会话最后活动时间
 * @param nowMs - 参照时刻 epoch ms，默认 Date.now()
 * @returns i18n key 与插值参数
 */
export function formatSessionWhen(updatedAt: number, nowMs: number = Date.now()): ChatTimeLabel {
	const diff = nowMs - updatedAt;
	if (ymdEq(localYmd(updatedAt), localYmd(nowMs))) {
		if (diff < 60_000) return { key: 'chat.session.whenNow' };
		if (diff < 3600_000) {
			return { key: 'chat.session.whenMinutes', params: { n: Math.floor(diff / 60_000) } };
		}
		return { key: 'chat.session.whenHours', params: { n: Math.floor(diff / 3600_000) } };
	}
	return formatDayDividerLabel(updatedAt, new Date(nowMs));
}

/**
 * 从消息列表末尾向前找最近一条 user 的 createdAt。
 *
 * @param messages - 含 role 与可选 createdAt 的消息数组
 * @returns 最近 user 的 createdAt，或 undefined
 */
export function lastUserCreatedAt(
	messages: Array<{ role: string; createdAt?: number }>,
): number | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role === 'user' && typeof m.createdAt === 'number') return m.createdAt;
	}
	return undefined;
}

/**
 * 判断是否应向模型 env 段注入「距上一轮」间隔行。
 *
 * 跨本地日必出；同日仅当间隔 ≥ ENV_GAP_IDLE_MS 时出。
 *
 * @param lastUserAt - 最近一条 user 的 createdAt
 * @param now - 当前时刻
 * @returns 是否展示间隔行
 */
export function shouldShowEnvGap(lastUserAt: number, now: Date): boolean {
	if (!ymdEq(localYmd(lastUserAt), localYmd(now.getTime()))) return true;
	return now.getTime() - lastUserAt >= ENV_GAP_IDLE_MS;
}

/**
 * 生成 env 间隔行中文文本（模型可见，不进 i18n）。
 *
 * 间隔满小时向下取整；不足 1 小时写「不足 1 小时」。
 *
 * @param lastUserAt - 最近一条 user 的 createdAt
 * @param now - 当前时刻
 * @returns 单行间隔描述
 */
export function formatEnvGapLine(lastUserAt: number, now: Date): string {
	const delta = Math.max(0, now.getTime() - lastUserAt);
	const hours = Math.floor(delta / 3600_000);
	const span = hours < 1 ? '不足 1 小时' : `${hours} 小时`;
	const prev = formatLocalDateTime(new Date(lastUserAt)).local.slice(0, 16);
	return `距上一轮用户消息: ${span}（上次 ${prev}）`;
}

/**
 * 拼装完整 env 上下文（当前时间行 + 可选间隔行）。
 *
 * @param now - 当前时刻
 * @param lastUserAt - 最近一条 user 的 createdAt，可缺省
 * @returns 1 或 2 行 env 文本
 */
export function composeEnvContext(now: Date, lastUserAt?: number): string {
	const line1 = formatEnvContextLine(now);
	if (lastUserAt === undefined || !shouldShowEnvGap(lastUserAt, now)) return line1;
	return `${line1}\n${formatEnvGapLine(lastUserAt, now)}`;
}
