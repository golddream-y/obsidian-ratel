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
    const _k2: StringKey = 'settings.chatProfiles.heading';
    // 关键路径:P-MEMORY-UI 重构后用 'memory.settings.heading'(原 memory.tool.saveMemory 已删)
    const _k3: StringKey = 'memory.settings.heading';
    expect(_k1).toBe('common.ok');
    expect(_k2).toBe('settings.chatProfiles.heading');
    expect(_k3).toBe('memory.settings.heading');
  });
});

describe('索引可靠性文案语义', () => {
  it('drop-index 文案与真实语义一致:只清理非活动代际', () => {
    expect(zh['cmd.dropIndex']).toContain('非活动');
    expect(en['cmd.dropIndex']).toMatch(/inactive/i);
    expect(zh['modal.dropIndex.confirmDesc']).toContain('非活动');
    expect(en['modal.dropIndex.confirmDesc']).toMatch(/inactive/i);
    // 关键路径:清理不承诺清空活动索引,避免用户以为检索会失效。
    expect(zh['modal.dropIndex.confirmDesc']).toContain('活动索引');
  });

  it('重建当前索引文案说明「会重新核对、不会先清空」', () => {
    expect(zh['cmd.rebuildIndex']).toContain('核对');
    expect(en['cmd.rebuildIndex']).toMatch(/verif/i);
    expect(zh['modal.rebuildIndex.confirmDesc']).toContain('不会先清空');
    expect(en['modal.rebuildIndex.confirmDesc']).toMatch(/not (clear|wipe|erase)/i);
  });

  it('新增阶段/须知文案 zh 与 en 成对存在且非空', () => {
    const keys: StringKey[] = [
      'status.phase.stalled',
      'status.phase.stopping',
      'status.phase.migrating',
      'status.detail.stalled',
      'status.detail.resumed',
      'status.detail.partial',
      'status.detail.stopping',
      'status.detail.migrating',
      'status.detail.diskFailure',
      'status.detail.epochMissing',
      'status.detail.recordsUnknown',
      'status.detail.configMismatch',
      'status.detail.reverifying',
    ];
    for (const key of keys) {
      expect(zh[key], `zh.${key}`).toBeTruthy();
      expect(en[key], `en.${key}`).toBeTruthy();
    }
  });
});
