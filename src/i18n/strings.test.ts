/**
 * @file src/i18n/strings.test.ts
 * @description 翻译表完整性测试
 * @module i18n/strings.test
 */

import { describe, it, expect } from 'vitest';
import { zh } from './zh';
import { en } from './en';
import type { Strings, StringKey } from './types';

describe('i18n 翻译表完整性', () => {
  it('zh 与 en key 集合完全一致', () => {
    const zhKeys = Object.keys(zh).sort();
    const enKeys = Object.keys(en).sort();
    expect(enKeys).toEqual(zhKeys);
  });

  it('zh 所有翻译值都是非空字符串', () => {
    for (const [key, value] of Object.entries(zh)) {
      expect(value, `zh.${key} 不应为空`).toBeTruthy();
      expect(typeof value, `zh.${key} 应为字符串`).toBe('string');
    }
  });

  it('en 所有翻译值都是非空字符串', () => {
    for (const [key, value] of Object.entries(en)) {
      expect(value, `en.${key} 不应为空`).toBeTruthy();
      expect(typeof value, `en.${key} 应为字符串`).toBe('string');
    }
  });

  it('编译期断言:zh 满足 Strings 形状', () => {
    const _zh: Strings = zh;
    expect(_zh).toBeDefined();
  });

  it('编译期断言:en 满足 Strings 形状', () => {
    const _en: Strings = en;
    expect(_en).toBeDefined();
  });

  it('StringKey 类型可枚举常见 key', () => {
    // 编译期断言:StringKey 接受 'common.ok',不接受未知 key
    const _k1: StringKey = 'common.ok';
    const _k2: StringKey = 'settings.chatModel.heading';
    // 关键路径:P-MEMORY-UI 重构后用 'memory.settings.heading'(原 memory.tool.saveMemory 已删)
    const _k3: StringKey = 'memory.settings.heading';
    expect(_k1).toBe('common.ok');
    expect(_k2).toBe('settings.chatModel.heading');
    expect(_k3).toBe('memory.settings.heading');
  });
});
