/**
 * @file src/settings/chat-headers.ts
 * @description 对话请求的自定义请求头 — 文本编辑与结构互转
 * @module settings/chat-headers
 */

/** 合法的 HTTP 头名(RFC 7230 token)。 */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** 解析结果。 */
export interface ParsedChatHeaders {
	/** 解析成功的请求头;键按首次出现的原名保留。 */
	headers: Record<string, string>;
	/** 无法解析的行(原样保留,供界面提示)。 */
	invalidLines: string[];
}

/**
 * 把「每行一个 `名称: 值`」的文本解析成请求头。
 *
 * 设计要点:
 * - 空行与 `#` 开头的注释行忽略,便于用户在设置里留说明。
 * - 名称大小写不敏感去重,后出现的行覆盖先出现的值。
 * - 名称不合法或缺少冒号的行不静默丢弃,交给界面提示,避免「填了没生效」。
 *
 * @param raw - 用户输入的文本
 * @returns 请求头与非法行清单
 */
export function parseChatHeaders(raw: string): ParsedChatHeaders {
	const headers: Record<string, string> = {};
	const seen = new Map<string, string>();
	const invalidLines: string[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const colon = trimmed.indexOf(':');
		if (colon <= 0) {
			invalidLines.push(trimmed);
			continue;
		}
		const name = trimmed.slice(0, colon).trim();
		const value = trimmed.slice(colon + 1).trim();
		if (!HEADER_NAME.test(name) || value.length === 0) {
			invalidLines.push(trimmed);
			continue;
		}
		const lower = name.toLowerCase();
		const previous = seen.get(lower);
		if (previous !== undefined) delete headers[previous];
		seen.set(lower, name);
		headers[name] = value;
	}
	return { headers, invalidLines };
}

/**
 * 把请求头格式化成可编辑文本。
 *
 * @param headers - 请求头;空对象返回空串
 * @returns 每行一个 `名称: 值`
 */
export function formatChatHeaders(headers: Record<string, string> | undefined): string {
	if (!headers) return '';
	return Object.entries(headers)
		.map(([name, value]) => `${name}: ${value}`)
		.join('\n');
}
