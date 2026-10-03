import { describe, it, expect } from 'vitest';
import { measureNoteText } from '../../src/tools/note-text-stats';

describe('measureNoteText', () => {
	it('measureNoteText - 汉字与拉丁词混排 - 划分之和等于码点', () => {
		const stats = measureNoteText('你好 hello world。');
		expect(stats.length.han).toBe(2);
		expect(stats.length.latinLetters).toBe(10);
		expect(stats.words.latin).toBe(2);
		expect(stats.length.han + stats.length.latinLetters + stats.length.other).toBe(stats.length.codePoints);
		expect(stats.length.chars).toBe(stats.length.codePoints);
	});

	it('measureNoteText - 汉语拼音 - 记入拉丁词', () => {
		const stats = measureNoteText('ni hao');
		expect(stats.length.han).toBe(0);
		expect(stats.words.latin).toBe(2);
		expect(stats.length.latinLetters).toBe(5);
	});

	it('measureNoteText - 撇号 - 断开成两个拉丁词', () => {
		expect(measureNoteText("don't").words.latin).toBe(2);
	});

	it('measureNoteText - 增补平面字符 - chars 大于 codePoints', () => {
		const rare = String.fromCodePoint(0x20000);
		const stats = measureNoteText(rare);
		expect(stats.length.han).toBe(1);
		expect(stats.length.codePoints).toBe(1);
		expect(stats.length.chars).toBe(2);
		expect(stats.length.other).toBe(0);
	});
});
