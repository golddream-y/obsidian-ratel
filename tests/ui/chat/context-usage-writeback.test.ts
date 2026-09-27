/**
 * @file tests/ui/chat/context-usage-writeback.test.ts
 * @description message.end 真值写回 — 窗口占用看最后一步
 * @module tests/ui/chat/context-usage-writeback
 */
import { describe, it, expect } from 'vitest';
import { resolveApiUsedTokens } from '../../../src/ui/chat/context-usage-writeback';

describe('resolveApiUsedTokens', () => {
	it('resolveApiUsedTokens - 多步合计远大于最后一步 - 用最后一步输入加输出', () => {
		expect(
			resolveApiUsedTokens({
				tokens: 0,
				promptTokens: 9000,
				completionTokens: 100,
				stepPromptTokens: 30000,
				stepCompletionTokens: 400,
			}),
		).toBe(9100);
	});

	it('resolveApiUsedTokens - 只有单步 - 用该步输入加输出', () => {
		expect(
			resolveApiUsedTokens({ tokens: 0, promptTokens: 1200, completionTokens: 80 }),
		).toBe(1280);
	});

	it('resolveApiUsedTokens - 无最后一步只有各步合计 - 退回合计', () => {
		expect(
			resolveApiUsedTokens({
				tokens: 0,
				stepPromptTokens: 30000,
				stepCompletionTokens: 400,
			}),
		).toBe(30400);
	});

	it('resolveApiUsedTokens - 无任何 usage - 返回 undefined', () => {
		expect(resolveApiUsedTokens({ tokens: 0 })).toBeUndefined();
	});
});
