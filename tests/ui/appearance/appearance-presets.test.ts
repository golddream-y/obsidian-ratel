/**
 * @file tests/ui/appearance/appearance-presets.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
	APPEARANCE_PRESETS,
	hexForAccent,
	isUiAccentId,
	isUiColorScheme,
} from '../../../src/ui/appearance/appearance-presets';

describe('appearance-presets', () => {
	it('APPEARANCE_PRESETS - 含铜调 + 8 个 Material 500 - 与表一致', () => {
		expect(APPEARANCE_PRESETS).toHaveLength(9);
		expect(hexForAccent('copper')).toBe('#c9956c');
		expect(hexForAccent('teal')).toBe('#009688');
		expect(hexForAccent('red')).toBe('#F44336');
		expect(hexForAccent('follow')).toBeNull();
	});

	it('isUiAccentId - 非法值 - false', () => {
		expect(isUiAccentId('copper')).toBe(true);
		expect(isUiAccentId('teal')).toBe(true);
		expect(isUiAccentId('follow')).toBe(true);
		expect(isUiAccentId('magenta')).toBe(false);
	});

	it('isUiColorScheme - auto/light/dark - 仅合法', () => {
		expect(isUiColorScheme('auto')).toBe(true);
		expect(isUiColorScheme('system')).toBe(false);
	});
});
