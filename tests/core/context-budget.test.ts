import { describe, it, expect } from 'vitest';
import { outputReserve, prefixSlack, tailBudget } from '../../src/core/context-budget';
import { presetToTokens } from '../../src/ui/tokens/context-length-presets';

describe('context-budget', () => {
	it('outputReserve - 大窗按 10% 封顶 32k(不再夹 8k 下限)', () => {
		// 256k: 256000 * 0.10 = 25600
		expect(outputReserve(256_000)).toBe(25_600);
		// 1M(1048576): 10% = 104857 → 夹到 32000
		expect(outputReserve(1_048_576)).toBe(32_000);
		// 64k: 6400 — 10% 不再夹 8k 下限(修复 32k 分界悬崖)
		expect(outputReserve(64_000)).toBe(6_400);
	});

	it('outputReserve - 小窗(<32k)改按 15% 且下限 512', () => {
		expect(outputReserve(4_096)).toBe(614); // max(512, floor(4096*0.15))
		expect(outputReserve(1_024)).toBe(512);
	});

	it('prefixSlack - 大窗 min(24000, 20%) 随窗口缩放,小窗 20% 且下限 512', () => {
		expect(prefixSlack(256_000)).toBe(24_000);
		expect(prefixSlack(4_096)).toBe(819); // max(512, floor(4096*0.20))
		expect(prefixSlack(1_024)).toBe(512);
	});

	it('tailBudget - 各预设远大于写死的 8000', () => {
		expect(tailBudget(presetToTokens('128k'))).toBe(91_200); // 128000-12800-24000
		expect(tailBudget(presetToTokens('200k'))).toBe(156_000); // 200000-20000-24000
		expect(tailBudget(presetToTokens('256k'))).toBe(206_400); // 256000-25600-24000
		expect(tailBudget(presetToTokens('1M'))).toBe(992_576); // 1048576-32000-24000
	});

	it('tailBudget - 32k 分界无悬崖 - 预算单调不减', () => {
		// 31999(小窗分支): 31999 - 4799(15%) - 6399(20%) = 20801
		expect(tailBudget(31_999)).toBe(20_801);
		// 32000(大窗分支): 32000 - 3200(10%) - 6400(20%) = 22400 > 20801,窗口 +1 预算不暴跌
		expect(tailBudget(32_000)).toBe(22_400);
	});

	it('tailBudget - custom 小窗有 1024 下限', () => {
		// 4096 - 614 - 819 = 2663
		expect(tailBudget(4_096)).toBe(2_663);
		// 极端小窗触发下限
		expect(tailBudget(1_024)).toBe(1_024);
	});
});
