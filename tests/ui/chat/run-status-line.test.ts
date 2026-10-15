/**
 * @file tests/ui/chat/run-status-line.test.ts
 * @description 消息球状态行的阶段取句、优先级与轮换
 * @module tests/ui/chat/run-status-line
 */

import { describe, expect, it } from 'vitest';
import {
	composeRunStatusLine,
	pickRotatingIndex,
	type RunStatusInput,
	type RunStatusPhrases,
} from '../../../src/ui/chat/run-status-line';

const phrases: RunStatusPhrases = {
	composing: '撰写中',
	prepare: ['新墨研开了…', '翻几页旧册…', '温壶烫盏…'],
	awaiting: ['目送归雁过山…', '等第一声远钟…', '闲敲棋子落灯花…'],
	flavor: ['🌙 月还没升到中天', '星子一颗一颗亮起来', '❄️ 雪还在下'],
	step: (step) => `第 ${step} 步`,
};

const base: RunStatusInput = {
	retryText: null,
	toolText: null,
	phase: 'preparing',
	step: 1,
	tick: 0,
	seed: 0,
};

describe('composeRunStatusLine', () => {
	it('composeRunStatusLine - 重试中 - 只显示重试句', () => {
		expect(composeRunStatusLine({
			...base,
			retryText: '网络不稳，2 秒后重试',
			toolText: '查看 a.md',
			phase: 'composing',
			step: 3,
		}, phrases)).toBe('网络不稳，2 秒后重试');
	});

	it('composeRunStatusLine - 工具调用中 - 用工具名不加撰写中', () => {
		expect(composeRunStatusLine({ ...base, toolText: '查看 a.md', phase: 'composing' }, phrases))
			.toBe('查看 a.md');
	});

	it('composeRunStatusLine - 撰写阶段 - 撰写中加随机句', () => {
		const line = composeRunStatusLine({ ...base, phase: 'composing', tick: 0 }, phrases);
		expect(line.startsWith('撰写中 · ')).toBe(true);
		expect(phrases.flavor.some((f) => line === `撰写中 · ${f}`)).toBe(true);
	});

	it('composeRunStatusLine - 本地准备阶段 - 取 prepare 池且不带撰写中', () => {
		const line = composeRunStatusLine({ ...base, phase: 'preparing', tick: 0 }, phrases);
		expect(phrases.prepare).toContain(line);
		expect(line.startsWith('撰写中')).toBe(false);
	});

	it('composeRunStatusLine - 在途阶段 - 取 awaiting 池且不带撰写中', () => {
		const line = composeRunStatusLine({ ...base, phase: 'awaiting', tick: 0 }, phrases);
		expect(phrases.awaiting).toContain(line);
		expect(line.startsWith('撰写中')).toBe(false);
	});

	it('composeRunStatusLine - 撰写阶段连续两拍 - 随机句不重复', () => {
		const a = composeRunStatusLine({ ...base, phase: 'composing', tick: 0 }, phrases);
		const b = composeRunStatusLine({ ...base, phase: 'composing', tick: 1 }, phrases);
		expect(a).not.toBe(b);
	});

	it('composeRunStatusLine - 在途阶段连续两拍 - 随机句不重复', () => {
		const a = composeRunStatusLine({ ...base, phase: 'awaiting', tick: 0 }, phrases);
		const b = composeRunStatusLine({ ...base, phase: 'awaiting', tick: 1 }, phrases);
		expect(a).not.toBe(b);
	});

	it('composeRunStatusLine - 换随机起点 - 开门句不同', () => {
		const a = composeRunStatusLine({ ...base, phase: 'preparing', tick: 0, seed: 0 }, phrases);
		const b = composeRunStatusLine({ ...base, phase: 'preparing', tick: 0, seed: 1 }, phrases);
		expect(a).not.toBe(b);
	});

	it('composeRunStatusLine - 第 2 步 - 末尾加步数', () => {
		expect(composeRunStatusLine({ ...base, step: 2 }, phrases)).toMatch(/ · 第 2 步$/);
	});

	it('composeRunStatusLine - 第 1 步 - 不加步数', () => {
		expect(composeRunStatusLine({ ...base, step: 1 }, phrases)).not.toContain('第');
	});

	it('composeRunStatusLine - 重试中第 2 步 - 不加步数', () => {
		expect(composeRunStatusLine({ ...base, retryText: '重试中', step: 2 }, phrases)).toBe('重试中');
	});
});

describe('pickRotatingIndex', () => {
	it('pickRotatingIndex - 相邻拍 - 下标不同', () => {
		for (let tick = 1; tick < 40; tick++) {
			expect(pickRotatingIndex(tick, 30)).not.toBe(pickRotatingIndex(tick - 1, 30));
		}
	});

	it('pickRotatingIndex - 不同随机起点 - 首拍下标不同', () => {
		expect(pickRotatingIndex(0, 30, 0)).not.toBe(pickRotatingIndex(0, 30, 1));
	});

	it('pickRotatingIndex - 单元素池 - 恒为 0', () => {
		expect(pickRotatingIndex(5, 1, 999)).toBe(0);
	});
});
