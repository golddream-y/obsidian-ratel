import { describe, expect, it } from 'vitest';
import { shouldCarryShortOutline, CARRY_SYSTEM } from '../../src/core/turn-carry';

describe('shouldCarryShortOutline', () => {
	it('shouldCarryShortOutline - 只有标题且思考更长 - true', () => {
		expect(shouldCarryShortOutline({
			visibleChars: 36,
			reasoningChars: 1200,
			wroteNote: false,
			alreadyCarried: false,
		})).toBe(true);
		expect(CARRY_SYSTEM).toContain('不要再重列提纲');
	});

	it('shouldCarryShortOutline - 短回答且思考更长、用户不是继续 - true', () => {
		expect(shouldCarryShortOutline({
			visibleChars: 20,
			reasoningChars: 400,
			wroteNote: false,
			alreadyCarried: false,
		})).toBe(true);
	});

	it('shouldCarryShortOutline - 可见正文为空 - false', () => {
		expect(shouldCarryShortOutline({
			visibleChars: 0,
			reasoningChars: 500,
			wroteNote: false,
			alreadyCarried: false,
		})).toBe(false);
	});

	it('shouldCarryShortOutline - 已写笔记 - false', () => {
		expect(shouldCarryShortOutline({
			visibleChars: 10,
			reasoningChars: 500,
			wroteNote: true,
			alreadyCarried: false,
		})).toBe(false);
	});

	it('shouldCarryShortOutline - 正文已有 200 字 - false', () => {
		expect(shouldCarryShortOutline({
			visibleChars: 200,
			reasoningChars: 800,
			wroteNote: false,
			alreadyCarried: false,
		})).toBe(false);
	});

	it('shouldCarryShortOutline - 思考为空且只有一句标题 - true', () => {
		expect(shouldCarryShortOutline({
			visibleChars: 35,
			reasoningChars: 0,
			wroteNote: false,
			alreadyCarried: false,
		})).toBe(true);
	});

	it('shouldCarryShortOutline - 已经续过 - false', () => {
		expect(shouldCarryShortOutline({
			visibleChars: 10,
			reasoningChars: 500,
			wroteNote: false,
			alreadyCarried: true,
		})).toBe(false);
	});
});
