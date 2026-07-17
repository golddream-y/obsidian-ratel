/**
 * @file tests/ui/appearance/normalize-appearance-settings.test.ts
 * @description normalizeAppearanceSettings 归一化行为测试
 * @module tests/ui/appearance/normalize-appearance-settings
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, type RatelVaultSettings } from '../../../src/settings';
import { normalizeAppearanceSettings } from '../../../src/ui/appearance/normalize-appearance-settings';

describe('normalizeAppearanceSettings', () => {
	it('normalize - 缺字段或非法 - 回落 auto/follow', () => {
		const s = { ...DEFAULT_SETTINGS } as RatelVaultSettings;
		delete (s as Partial<RatelVaultSettings>).uiAccent;
		delete (s as Partial<RatelVaultSettings>).uiColorScheme;
		(s as { uiAccent?: string }).uiAccent = 'nope';
		(s as { uiColorScheme?: string }).uiColorScheme = 'system';
		normalizeAppearanceSettings(s);
		expect(s.uiAccent).toBe('follow');
		expect(s.uiColorScheme).toBe('auto');
	});
});
