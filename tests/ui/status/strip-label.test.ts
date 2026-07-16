/**
 * @file tests/ui/status/strip-label.test.ts
 * @description StatusStrip 文案合成与上下文 % 色阶
 * @module tests/ui/status/strip-label
 */
import { describe, it, expect } from 'vitest';
import { clampContextPct, composeStripLabel, contextPctTextColor } from '../../../src/ui/status/strip-label';

describe('composeStripLabel', () => {
	it('busyOverride 优先 - 有 override - 返回 override', () => {
		expect(
			composeStripLabel({
				busyOverride: '索引中...',
				toneLabel: '就绪',
				chatBusy: false,
				tone: 'ready',
			}),
		).toBe('索引中...');
	});

	it('无 override - 透传 toneLabel', () => {
		expect(
			composeStripLabel({
				busyOverride: null,
				toneLabel: '思考中',
				chatBusy: false,
				tone: 'thinking',
			}),
		).toBe('思考中');
	});

	it('无 override - chatBusy 场景 - 透传调用方已压制后的 toneLabel', () => {
		expect(
			composeStripLabel({
				busyOverride: null,
				toneLabel: '就绪',
				chatBusy: true,
				tone: 'ready',
			}),
		).toBe('就绪');
	});
});

describe('clampContextPct', () => {
	it('钳制 - 正常范围 - 原样返回', () => {
		expect(clampContextPct(12)).toBe(12);
		expect(clampContextPct(100)).toBe(100);
	});

	it('钳制 - 越界 - 限制在 0..100', () => {
		expect(clampContextPct(-5)).toBe(0);
		expect(clampContextPct(140)).toBe(100);
	});
});

describe('contextPctTextColor', () => {
	it('色阶 - <80 - success', () => {
		expect(contextPctTextColor(12)).toBe('var(--text-success)');
		expect(contextPctTextColor(79)).toBe('var(--text-success)');
	});

	it('色阶 - ≥80 且 <95 - warning', () => {
		expect(contextPctTextColor(80)).toBe('var(--text-warning)');
		expect(contextPctTextColor(94)).toBe('var(--text-warning)');
	});

	it('色阶 - ≥95 - error', () => {
		expect(contextPctTextColor(95)).toBe('var(--text-error)');
		expect(contextPctTextColor(100)).toBe('var(--text-error)');
	});
});
