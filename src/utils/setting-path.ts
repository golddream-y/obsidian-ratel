/**
 * @file src/utils/setting-path.ts
 * @description data.json 点号路径叶子写入 — configure_plugin 唯一写法
 * @module utils/setting-path
 */
import { tNow } from '../i18n';

export const FORBID_KEY_RE = /token|secret|password|apiKey|webhook|cookie/i;
export const MAX_PATCH_KEYS = 20;
export const MAX_DOT_SEGMENTS = 6;

/**
 * 将点号路径拆成段;非法路径抛用户可见 i18n 错误。
 *
 * @param key - 如 `cal.weekStart`
 * @returns 非空段数组
 * @throws 空段、数组下标、越界段数等
 */
/** 路径里不允许分隔符、空白和控制字符。 */
function hasSeparatorOrControl(key: string): boolean {
	for (const ch of key) {
		const code = ch.codePointAt(0) ?? 0;
		if (ch === '/' || ch === '\\' || code <= 0x1f || ch.trim() === '') return true;
	}
	return false;
}

export function parseSettingKey(key: string): string[] {
	if (typeof key !== 'string' || !key || key.startsWith('.') || key.endsWith('.') || key.includes('..')) {
		throw new Error(tNow('error.ecosystem.badKey', { key: String(key) }));
	}
	if (hasSeparatorOrControl(key)) {
		throw new Error(tNow('error.ecosystem.badKey', { key }));
	}
	const segs = key.split('.');
	if (segs.length > MAX_DOT_SEGMENTS || segs.some((s) => s === '' || /^\d+$/.test(s))) {
		throw new Error(tNow('error.ecosystem.badKey', { key }));
	}
	return segs;
}

function cloneJson<T>(v: T): T {
	return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * 对 data.json 根对象做点号路径叶子 patch,不整枝覆盖。
 *
 * @param root - 当前 settings 对象
 * @param patch - 最多 {@link MAX_PATCH_KEYS} 个 key
 * @returns 深拷贝后的新根对象
 */
export function applyLeafPatch(
	root: Record<string, unknown>,
	patch: Record<string, unknown>,
): Record<string, unknown> {
	const keys = Object.keys(patch);
	if (keys.length === 0 || keys.length > MAX_PATCH_KEYS) {
		throw new Error(tNow('error.ecosystem.patchSize', { n: String(keys.length) }));
	}
	const next = cloneJson(root);
	for (const key of keys) {
		if (patch[key] === undefined) throw new Error(tNow('error.ecosystem.badKey', { key }));
		JSON.stringify(patch[key]);
		const segs = parseSettingKey(key);
		let cur: Record<string, unknown> = next;
		for (let i = 0; i < segs.length - 1; i++) {
			const s = segs[i]!;
			const child = cur[s];
			if (child === undefined || child === null || Array.isArray(child) || typeof child !== 'object') {
				cur[s] = {};
			}
			cur = cur[s] as Record<string, unknown>;
		}
		cur[segs[segs.length - 1]!] = cloneJson(patch[key]);
	}
	return next;
}
