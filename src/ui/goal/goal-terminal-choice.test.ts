/**
 * @file src/ui/goal/goal-terminal-choice.test.ts
 * @description 终态弹窗关窗语义 — 未落盘关窗中止,已终态关窗视为留列表
 * @module ui/goal/goal-terminal-choice.test
 */

import { describe, it, expect } from 'vitest';
import { choiceFromModalClose } from './GoalTerminalChoiceModal';

describe('choiceFromModalClose', () => {
	it('点了留在列表 - 无论是否已终态 - 返回 keep', () => {
		const keep = { choice: 'keep' as const, showCompletedNotice: true };
		expect(choiceFromModalClose(keep, false)).toEqual(keep);
		expect(choiceFromModalClose(keep, true)).toEqual(keep);
	});

	it('未点按钮关窗 - 尚未落盘 - 中止不关目标', () => {
		expect(choiceFromModalClose(null, false)).toBeNull();
	});

	it('未点按钮关窗 - 已是终态 - 视为留在列表', () => {
		expect(choiceFromModalClose(null, true)).toEqual({
			choice: 'keep',
			showCompletedNotice: false,
		});
	});
});
