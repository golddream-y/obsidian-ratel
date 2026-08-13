/**
 * @file tests/core/should-auto-compact-wiring.test.ts
 * @description 自动压缩决策纯函数 — ChatView 发送前/轮后接线
 * @module tests/core/should-auto-compact-wiring
 */
import { describe, expect, it } from 'vitest';
import { decidePostTurnCompact, decidePreSendCompact } from '../../src/ui/chat/compact-auto';

describe('decidePreSendCompact', () => {
	it('decidePreSendCompact - 生成中 - false', () => {
		expect(
			decidePreSendCompact({
				enabled: true,
				percentage: 90,
				circuitOpen: false,
				isRunning: true,
				isCompacting: false,
			}),
		).toBe(false);
	});

	it('decidePreSendCompact - 超阈值空闲 - true', () => {
		expect(
			decidePreSendCompact({
				enabled: true,
				percentage: 85,
				circuitOpen: false,
				isRunning: false,
				isCompacting: false,
			}),
		).toBe(true);
	});

	it('decidePreSendCompact - 压缩中 - false', () => {
		expect(
			decidePreSendCompact({
				enabled: true,
				percentage: 90,
				circuitOpen: false,
				isRunning: false,
				isCompacting: true,
			}),
		).toBe(false);
	});
});

describe('decidePostTurnCompact', () => {
	it('decidePostTurnCompact - 达阈值且启用 - true', () => {
		expect(
			decidePostTurnCompact({
				enabled: true,
				percentage: 85,
				circuitOpen: false,
			}),
		).toBe(true);
	});

	it('decidePostTurnCompact - 断路已开 - false', () => {
		expect(
			decidePostTurnCompact({
				enabled: true,
				percentage: 90,
				circuitOpen: true,
			}),
		).toBe(false);
	});
});
