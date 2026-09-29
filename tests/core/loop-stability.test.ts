/**
 * @file tests/core/loop-stability.test.ts
 * @description 收束、空步与工具截止
 * @module tests/core/loop-stability
 */
import { describe, expect, it } from 'vitest';
import {
	shouldAppendWrapUp,
	shouldContinueEmptyStep,
	withToolDeadline,
} from '../../src/core/loop-stability';

describe('shouldAppendWrapUp', () => {
	it('shouldAppendWrapUp - 还剩 6 步 - 不收束', () => {
		expect(shouldAppendWrapUp(44, 50)).toBe(false);
	});

	it('shouldAppendWrapUp - 还剩 5 步 - 收束', () => {
		expect(shouldAppendWrapUp(45, 50)).toBe(true);
	});

	it('shouldAppendWrapUp - 已到顶 - 不再追加', () => {
		expect(shouldAppendWrapUp(50, 50)).toBe(false);
	});
});

describe('shouldContinueEmptyStep', () => {
	it('shouldContinueEmptyStep - 第一步就空 - 不续', () => {
		expect(shouldContinueEmptyStep({
			step: 0,
			sawTool: false,
			alreadyContinued: false,
			text: '',
			reasoning: '',
			toolCallCount: 0,
		})).toBe(false);
	});

	it('shouldContinueEmptyStep - 第二步空且还没续 - 续一次', () => {
		expect(shouldContinueEmptyStep({
			step: 1,
			sawTool: true,
			alreadyContinued: false,
			text: '  ',
			reasoning: '',
			toolCallCount: 0,
		})).toBe(true);
	});

	it('shouldContinueEmptyStep - 已经续过 - 不再续', () => {
		expect(shouldContinueEmptyStep({
			step: 2,
			sawTool: true,
			alreadyContinued: true,
			text: '',
			reasoning: '',
			toolCallCount: 0,
		})).toBe(false);
	});

	it('shouldContinueEmptyStep - 有正文 - 不续', () => {
		expect(shouldContinueEmptyStep({
			step: 1,
			sawTool: true,
			alreadyContinued: false,
			text: '好',
			reasoning: '',
			toolCallCount: 0,
		})).toBe(false);
	});
});

describe('withToolDeadline', () => {
	it('withToolDeadline - 等待中取消 - 立刻拒绝且 code 为 CANCELLED', async () => {
		const signal = new AbortController();
		const pending = withToolDeadline(new Promise(() => {}), 60_000, signal.signal, '超时');
		signal.abort();
		await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
	});

	it('withToolDeadline - 超过截止 - code 为 TOOL_TIMEOUT', async () => {
		await expect(withToolDeadline(new Promise(() => {}), 15, undefined, '超时了')).rejects.toMatchObject({
			code: 'TOOL_TIMEOUT',
			message: '超时了',
		});
	});
});
