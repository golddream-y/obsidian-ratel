/**
 * @file src/utils/local-datetime.ts
 * @description 本地时间格式化 — 供 system 环境注入与 get_datetime 工具共用
 * @module utils/local-datetime
 */

/** 本地时间结构化结果 */
export interface LocalDateTimeInfo {
	/** UTC ISO 8601 */
	iso: string;
	/** 本地可读串 `YYYY-MM-DD HH:mm:ss` */
	local: string;
	/** IANA 时区名(如 Asia/Shanghai) */
	timezone: string;
	/** 中文星期(星期日…星期六) */
	weekday: string;
	/** Unix epoch 毫秒 */
	epochMs: number;
}

const WEEKDAYS_ZH = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'] as const;

/**
 * 格式化本地时间为结构化字段。
 *
 * 关键路径:时区取 `Intl.DateTimeFormat().resolvedOptions().timeZone`,
 * 与 Obsidian 运行环境一致,不硬编码 UTC+8。
 *
 * @param date - 目标时刻,默认 now
 * @returns iso / local / timezone / weekday / epochMs
 */
export function formatLocalDateTime(date: Date = new Date()): LocalDateTimeInfo {
	const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, '0');
	const d = String(date.getDate()).padStart(2, '0');
	const hh = String(date.getHours()).padStart(2, '0');
	const mm = String(date.getMinutes()).padStart(2, '0');
	const ss = String(date.getSeconds()).padStart(2, '0');
	return {
		iso: date.toISOString(),
		local: `${y}-${m}-${d} ${hh}:${mm}:${ss}`,
		timezone,
		weekday: WEEKDAYS_ZH[date.getDay()]!,
		epochMs: date.getTime(),
	};
}

/**
 * 生成注入到 system 旁路的单行环境时间。
 *
 * 形态:`当前本地时间: 2026-07-14 20:25 (Asia/Shanghai, 星期二)`
 *
 * @param date - 目标时刻,默认 now
 * @returns 单行中文环境上下文
 */
export function formatEnvContextLine(date: Date = new Date()): string {
	const info = formatLocalDateTime(date);
	// 注入行省略秒,足够「今天几号 / 星期几」场景,省 token
	const shortLocal = info.local.slice(0, 16);
	return `当前本地时间: ${shortLocal} (${info.timezone}, ${info.weekday})`;
}

/**
 * 按日记命名格式拼文件名(不含扩展名)。
 *
 * 仅支持 `YYYY` / `MM` / `DD` 占位符简单替换,不引入 moment 依赖。
 *
 * @param date - 目标日期(用本地年月日)
 * @param format - 如 `YYYY-MM-DD`
 * @returns 替换后的文件名主体
 */
export function formatDailyNoteStem(date: Date, format: string): string {
	const y = String(date.getFullYear());
	const m = String(date.getMonth() + 1).padStart(2, '0');
	const d = String(date.getDate()).padStart(2, '0');
	return format.replace(/YYYY/g, y).replace(/MM/g, m).replace(/DD/g, d);
}

/**
 * 解析 `YYYY-MM-DD` 为本地正午 Date;非法则返回 null。
 *
 * @param dateStr - 日期字符串
 * @returns 本地 Date 或 null
 */
export function parseLocalDateOnly(dateStr: string): Date | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
	if (!m) return null;
	const y = Number(m[1]);
	const mo = Number(m[2]);
	const d = Number(m[3]);
	if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
	// 关键路径:用本地正午避免 DST 边界把「日历日」拨到前一天
	const date = new Date(y, mo - 1, d, 12, 0, 0, 0);
	if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) {
		return null;
	}
	return date;
}
