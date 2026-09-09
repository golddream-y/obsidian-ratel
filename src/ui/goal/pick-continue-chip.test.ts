/**
 * @file src/ui/goal/pick-continue-chip.test.ts
 * @description 继续 chip 规则单元测试 — spec 4.11 面 3
 * @module ui/goal/pick-continue-chip.test
 */

import { describe, it, expect } from 'vitest';
import { pickContinueChip, shouldShowContinueChip } from './pick-continue-chip';
import type { AgentGoal } from '../../core/goal-store';

const SESSION = 's-main';
const OTHER = 's-other';

function makeGoal(partial: Partial<AgentGoal> & Pick<AgentGoal, 'id' | 'status' | 'objective'>): AgentGoal {
	return {
		version: 1,
		completionCriteria: { text: '标准' },
		progressNote: '',
		roundsDone: 0,
		maxRounds: 10,
		usage: { inputTokens: 0, outputTokens: 0 },
		grant: null,
		birthSessionId: SESSION,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...partial,
	};
}

describe('pickContinueChip', () => {
	it('输入非空 - 隐藏 chip', () => {
		const r = pickContinueChip({
			sessionId: SESSION,
			goals: [makeGoal({ id: 'g1', status: 'active', objective: 'A', activeSessionId: SESSION })],
			inputNonempty: true,
			isRunning: false,
		});
		expect(r.kind).toBe('hidden');
	});

	it('运行中 - 隐藏 chip', () => {
		const r = pickContinueChip({
			sessionId: SESSION,
			goals: [makeGoal({ id: 'g1', status: 'active', objective: 'A', activeSessionId: SESSION })],
			inputNonempty: false,
			isRunning: true,
		});
		expect(r.kind).toBe('hidden');
	});

	it('本会话 active 闲等 - 不叠继续 chip(Strip 已显示)', () => {
		const r = pickContinueChip({
			sessionId: SESSION,
			goals: [makeGoal({ id: 'g1', status: 'active', objective: '整理笔记', activeSessionId: SESSION })],
			inputNonempty: false,
			isRunning: false,
		});
		expect(r.kind).toBe('hidden');
	});

	it('active 绑在其他会话 - 接管', () => {
		const r = pickContinueChip({
			sessionId: SESSION,
			goals: [makeGoal({ id: 'g1', status: 'active', objective: 'X', activeSessionId: OTHER })],
			inputNonempty: false,
			isRunning: false,
		});
		expect(r.kind).toBe('takeover');
	});

	it('无 active 仅 1 pending - 排队目标', () => {
		const r = pickContinueChip({
			sessionId: SESSION,
			goals: [makeGoal({ id: 'g2', status: 'pending', objective: '排队' })],
			inputNonempty: false,
			isRunning: false,
		});
		expect(r.kind).toBe('single-pending');
		expect(r.goalId).toBe('g2');
	});

	it('pending 两条 - 打开设置', () => {
		const r = pickContinueChip({
			sessionId: SESSION,
			goals: [
				makeGoal({ id: 'g1', status: 'pending', objective: 'A' }),
				makeGoal({ id: 'g2', status: 'pending', objective: 'B' }),
			],
			inputNonempty: false,
			isRunning: false,
		});
		expect(r.kind).toBe('multi-pending');
		expect(r.pendingCount).toBe(2);
	});

	it('仅 paused - 不显示', () => {
		const r = pickContinueChip({
			sessionId: SESSION,
			goals: [makeGoal({ id: 'g1', status: 'paused', objective: 'P' })],
			inputNonempty: false,
			isRunning: false,
		});
		expect(r.kind).toBe('hidden');
	});

	it('shouldShowContinueChip - 条已在展示 pending - 不叠 chip', () => {
		const chip = pickContinueChip({
			sessionId: SESSION,
			goals: [makeGoal({ id: 'g2', status: 'pending', objective: '排队' })],
			inputNonempty: false,
			isRunning: false,
		});
		expect(shouldShowContinueChip(chip, 'pending')).toBe(false);
	});

	it('shouldShowContinueChip - 接管 - 条在别处仍显示 chip', () => {
		const chip = pickContinueChip({
			sessionId: SESSION,
			goals: [makeGoal({ id: 'g1', status: 'active', objective: 'X', activeSessionId: OTHER })],
			inputNonempty: false,
			isRunning: false,
		});
		expect(shouldShowContinueChip(chip, 'active-elsewhere')).toBe(true);
	});

	it('shouldShowContinueChip - hidden chip - 不显示', () => {
		expect(shouldShowContinueChip({ kind: 'hidden' }, 'hidden')).toBe(false);
	});
});
