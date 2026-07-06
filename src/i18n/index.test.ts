/**
 * @file src/i18n/index.test.ts
 * @description i18n 运行时行为测试
 * @module i18n/index.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { langStore, t, tNow, detectLang, applyLangPreference, setLang } from './index';
import { get } from 'svelte/store';

describe('i18n 运行时', () => {
  beforeEach(() => {
    setLang('zh');
  });

  describe('detectLang', () => {
    it('zh / zh-CN / zh-TW / zh-Hans 返回 zh', () => {
      // 关键路径:Node 测试环境用 globalThis 而非 global(避免 obsidianmd/no-global-this 警告)
      const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
      for (const lang of ['zh', 'zh-CN', 'zh-TW', 'zh-Hans']) {
        Object.defineProperty(globalThis, 'navigator', { value: { language: lang }, configurable: true });
        expect(detectLang()).toBe('zh');
      }
      if (original) Object.defineProperty(globalThis, 'navigator', original);
    });

    it('en / en-US / ja / fr / "" 返回 en', () => {
      const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
      for (const lang of ['en', 'en-US', 'ja', 'fr', '']) {
        Object.defineProperty(globalThis, 'navigator', { value: { language: lang }, configurable: true });
        expect(detectLang()).toBe('en');
      }
      if (original) Object.defineProperty(globalThis, 'navigator', original);
    });
  });

  describe('applyLangPreference', () => {
    it("'auto' 走 detectLang()", () => {
      const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
      Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true });
      const result = applyLangPreference('auto');
      expect(result).toBe('zh');
      expect(get(langStore)).toBe('zh');
      if (original) Object.defineProperty(globalThis, 'navigator', original);
    });

    it("显式 'zh' / 'en' 忽略 navigator", () => {
      applyLangPreference('en');
      expect(get(langStore)).toBe('en');
      applyLangPreference('zh');
      expect(get(langStore)).toBe('zh');
    });
  });

  describe('tNow', () => {
    it('不同 currentLang 下返回对应翻译', () => {
      setLang('zh');
      expect(tNow('common.ok')).toBe('确定');
      setLang('en');
      expect(tNow('common.ok')).toBe('OK');
    });

    it('替换 {key} 占位', () => {
      setLang('zh');
      const result = tNow('chat.tool.found', { count: 5 });
      expect(result).toBe('找到 5 项');
    });

    it('多余 / 缺失的 params key 不抛错', () => {
      setLang('zh');
      expect(() => tNow('common.ok', { unused: 'x' })).not.toThrow();
      expect(() => tNow('chat.tool.found')).not.toThrow();
    });
  });

  describe('t (derived store)', () => {
    it('setLang 后重新发射,新函数读新 lang', () => {
      setLang('zh');
      const fn1 = get(t);
      expect(fn1('common.ok')).toBe('确定');
      setLang('en');
      const fn2 = get(t);
      expect(fn2('common.ok')).toBe('OK');
    });
  });
});
