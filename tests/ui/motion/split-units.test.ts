/**
 * @file tests/ui/motion/split-units.test.ts
 * @description WelcomeBlurText 分词单测
 * @module tests/ui/motion/split-units
 */

import { describe, expect, it } from 'vitest';
import { splitBlurUnits, shouldGapBlurWords } from '../../../src/ui/motion/empty/blur-split';

describe('splitBlurUnits', () => {
	it('splitBlurUnits - 英文词 - 按空格', () => {
		expect(splitBlurUnits('Hello vault', 'words')).toEqual(['Hello', 'vault']);
	});

	it('splitBlurUnits - 中文无空格 - 按字', () => {
		expect(splitBlurUnits('有什么想挖的', 'words')).toEqual([
			'有',
			'什',
			'么',
			'想',
			'挖',
			'的',
		]);
	});

	it('splitBlurUnits - letters 模式 - 按字符', () => {
		expect(splitBlurUnits('Hi', 'letters')).toEqual(['H', 'i']);
	});

	it('splitBlurUnits - 空串 - 空数组', () => {
		expect(splitBlurUnits('', 'words')).toEqual([]);
		expect(splitBlurUnits('   ', 'words')).toEqual([]);
	});

	it('splitBlurUnits - 英文无空格 - 整段一词', () => {
		expect(splitBlurUnits('Hello', 'words')).toEqual(['Hello']);
	});

	it('shouldGapBlurWords - 英文欢迎句 - 需要词间距', () => {
		expect(shouldGapBlurWords('What would you like to look up in your vault?')).toBe(true);
		expect(splitBlurUnits('What would you like to look up in your vault?', 'words').join(' ')).toBe(
			'What would you like to look up in your vault?',
		);
	});

	it('shouldGapBlurWords - 中文欢迎句 - 不要字间空格', () => {
		expect(shouldGapBlurWords('想从库里查找什么？')).toBe(false);
	});
});
