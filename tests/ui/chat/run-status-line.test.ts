/**
 * @file tests/ui/chat/run-status-line.test.ts
 * @description 消息球状态行的优先级与轮换
 * @module tests/ui/chat/run-status-line
 */

import { describe, expect, it } from 'vitest';
import { composeRunStatusLine, pickRotatingIndex, type RunStatusPhrases } from '../../../src/ui/chat/run-status-line';

const phrases: RunStatusPhrases = {
	composing: '撰写中',
	wait: ['正在想下一步', '还在看刚才的结果', '马上继续'],
	flavor: ['🌙 月还没升到中天', '星子一颗一颗亮起来', '❄️ 雪还在下'],
	step: (step) => `第 ${step} 步`,
};

const base = {
	retryText: null,
	toolText: null,
	streaming: false,
	step: 1,
	tick: 0,
};

describe('composeRunStatusLine', () => {
	it('composeRunStatusLine - 重试中 - 只显示重试句', () => {
		expect(composeRunStatusLine({
			...base,
			retryText: '网络不稳，2 秒后重试',
			toolText: '查看 a.md',
			streaming: true,
			step: 3,
		}, phrases)).toBe('网络不稳，2 秒后重试');
	});

	it('composeRunStatusLine - 工具调用中 - 用工具名不加撰写中', () => {
		expect(composeRunStatusLine({ ...base, toolText: '查看 a.md', streaming: true }, phrases)).toBe('查看 a.md');
	});

	it('composeRunStatusLine - 已出字 - 撰写中加随机句', () => {
		const line = composeRunStatusLine({ ...base, streaming: true, tick: 0 }, phrases);
		expect(line.startsWith('撰写中 · ')).toBe(true);
		expect(phrases.flavor.some((f) => line === `撰写中 · ${f}`)).toBe(true);
	});

	it('composeRunStatusLine - 连续两拍 - 随机句不重复', () => {
		const a = composeRunStatusLine({ ...base, streaming: true, tick: 0 }, phrases);
		const b = composeRunStatusLine({ ...base, streaming: true, tick: 1 }, phrases);
		expect(a).not.toBe(b);
	});

	it('composeRunStatusLine - 还没出字 - 等待句不是撰写中', () => {
		const line = composeRunStatusLine({ ...base, tick: 0 }, phrases);
		expect(phrases.wait).toContain(line);
	});

	it('composeRunStatusLine - 第 2 步 - 末尾只有步数', () => {
		expect(composeRunStatusLine({ ...base, step: 2 }, phrases)).toMatch(/ · 第 2 步$/);
	});

	it('composeRunStatusLine - 第 1 步 - 不加步数', () => {
		expect(composeRunStatusLine({ ...base, step: 1 }, phrases)).not.toContain('第');
	});
});

describe('pickRotatingIndex', () => {
	it('pickRotatingIndex - 相邻拍 - 下标不同', () => {
		for (let tick = 1; tick < 40; tick++) {
			expect(pickRotatingIndex(tick, 30)).not.toBe(pickRotatingIndex(tick - 1, 30));
		}
	});
});
