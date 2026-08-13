/**
 * @file tests/ui/motion/split-units.test.ts
 * @description WelcomeBlurText 分词单测
 * @module tests/ui/motion/split-units
 */

import { describe, expect, it } from 'vitest';
import { splitBlurUnits } from '../../../src/ui/motion/empty/blur-split';

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
});
