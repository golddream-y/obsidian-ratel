/**
 * @file tests/ui/chat/context-usage-writeback.test.ts
 * @description message.end 真值写回 — step 合计优先于单步
 * @module tests/ui/chat/context-usage-writeback
 */
import { describe, it, expect } from 'vitest';
import { resolveApiUsedTokens } from '../../../src/ui/chat/context-usage-writeback';

describe('resolveApiUsedTokens', () => {
	it('有 step 合计 - 用各步输入输出合计', () => {
		expect(
			resolveApiUsedTokens({
				tokens: 0,
				promptTokens: 9000,
				completionTokens: 100,
				stepPromptTokens: 30000,
				stepCompletionTokens: 400,
			}),
		).toBe(30400);
	});

	it('无 step 合计 - 回退单步 prompt+completion', () => {
		expect(
			resolveApiUsedTokens({ tokens: 0, promptTokens: 1200, completionTokens: 80 }),
		).toBe(1280);
	});

	it('无任何 usage - 返回 undefined 保留估算', () => {
		expect(resolveApiUsedTokens({ tokens: 0 })).toBeUndefined();
	});
});
