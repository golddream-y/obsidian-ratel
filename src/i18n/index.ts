/**
 * @file src/i18n/index.ts
 * @description i18n store + 翻译函数 + 语言检测
 * @module i18n
 *
 * 设计要点:
 * - `langStore` 是当前语言的 svelte writable store,默认 'zh'
 * - `t` 是 derived store,Svelte 组件用 `$t('key')` 自动订阅
 * - `tNow` 同步读,TS 文件无 store 订阅时使用
 * - `detectLang` 根据 navigator.language 检测;'zh' 开头返回 zh,其余返回 en
 * - `applyLangPreference` 把 'auto' 解析后写入 langStore
 */

import { writable, derived, get } from 'svelte/store';
import type { Lang, LangPreference, StringKey, Strings } from './types';
import { zh } from './zh';
import { en } from './en';

// 关键路径:re-export 类型,让消费者 `import { tNow, LangPreference } from '../i18n'` 一站式可用
export type { Lang, LangPreference, StringKey, Strings };

const TABLES: Record<Lang, Strings> = { zh, en };

export const langStore = writable<Lang>('zh');

/**
 * 翻译函数(订阅 store)— Svelte 组件用 $t('key') 自动重求值
 */
export const t = derived<typeof langStore, (key: StringKey, params?: Record<string, string | number>) => string>(
  langStore,
  // 关键路径:显式标注内层函数参数类型,避免 TS 推断为 any(no-unsafe-argument)
  ($lang) => (key: StringKey, params?: Record<string, string | number>): string => translate($lang, key, params)
);

/**
 * 翻译函数(同步读)— TS 文件用 tNow('key')
 *
 * @param key - 翻译表 key,如 'common.ok'
 * @param params - 可选的 {placeholder} 替换参数
 * @returns 当前 langStore 对应的翻译文本;若 key 缺失则 fallback 到 zh,再 fallback 到 key 本身
 */
export function tNow(key: StringKey, params?: Record<string, string | number>): string {
  return translate(get(langStore), key, params);
}

/**
 * 内部翻译函数 — 取表 + 占位符替换
 *
 * 关键路径:
 * - 当前 lang 表里查不到时 fallback 到 zh,再 fallback 到 key 本身,避免 UI 显示 undefined
 * - 占位符用简单 {key} 替换,多余/缺失的 params key 不抛错
 */
function translate(lang: Lang, key: StringKey, params?: Record<string, string | number>): string {
  const table = TABLES[lang];
  let value = table[key];
  if (value === undefined) {
    // 关键路径:fallback 到 zh,再 fallback 到 key 本身,避免 UI 显示 undefined
    value = zh[key] ?? key;
  }
  if (params) {
    // 简单 {key} 替换,多余/缺失的 params key 不抛错
    for (const [k, v] of Object.entries(params)) {
      value = value.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return value;
}

/**
 * 检测浏览器语言 — 'zh' 开头返回 zh,其余返回 en
 *
 * 关键路径:navigator 在某些环境(如 SSR / 测试隔离)不可访问,用 try/catch 兜底返回 en
 *
 * @returns 'zh' 或 'en'
 */
export function detectLang(): Lang {
  try {
    const navLang = (typeof navigator !== 'undefined' ? navigator.language : 'en') || 'en';
    return navLang.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  } catch {
    // navigator 不可用时兜底 en
    return 'en';
  }
}

/**
 * 把 'auto' 解析后写入 langStore,显式 'zh'/'en' 直接写入
 *
 * @param pref - 'auto' 走 detectLang;'zh'/'en' 忽略 navigator 直接写入
 * @returns 解析后的 Lang(用于调用方确认实际生效语言)
 */
export function applyLangPreference(pref: LangPreference): Lang {
  const lang = pref === 'auto' ? detectLang() : pref;
  langStore.set(lang);
  return lang;
}

/**
 * 直接设置当前语言 — 用于运行时切换(如 Settings 面板下拉)
 */
export function setLang(lang: Lang): void {
  langStore.set(lang);
}
