/**
 * @file tests/ui/status/tone.test.ts
 * @description tone 计算逻辑单元测试 — 验证 5 种 tone 优先级
 * @module tests/ui/status/tone
 * @depends src/ui/status/tone, src/user-feedback/user-status
 */
import { describe, it, expect } from 'vitest';
import { deriveTone, type Tone } from '../../../src/ui/status/tone';
import type { UserStatusSnapshot } from '../../../src/user-feedback/user-status';

// 关键路径:构造最小 snapshot,只填必要字段
function snap(partial: Partial<UserStatusSnapshot>): UserStatusSnapshot {
	return {
		model: 'idle',
		index: 'idle',
		embedding: 'ready',
		worker: 'inline',
		...partial,
	};
}

describe('deriveTone', () => {
	it('索引中 - 优先级最高 - 覆盖思考中', () => {
		// 关键路径:indexing 优先于 thinking,即使 model 不是 ready
		const s = snap({ index: 'processing', model: 'checking' });
		expect(deriveTone(s)).toEqual({ tone: 'indexing' as Tone });
	});

	it('索引中 - scanning 状态 - 返回 indexing', () => {
		expect(deriveTone(snap({ index: 'scanning' }))).toEqual({ tone: 'indexing' });
	});

	it('索引中 - queueing 状态 - 返回 indexing', () => {
		expect(deriveTone(snap({ index: 'queueing' }))).toEqual({ tone: 'indexing' });
	});

	it('索引中 - diffing 状态 - 返回 indexing(smartReindex hash 比对阶段)', () => {
		// 关键路径:diffing 是 smartReindex 的 hash 比对阶段,用户感知也是"索引中"
		expect(deriveTone(snap({ index: 'diffing' }))).toEqual({ tone: 'indexing' });
	});

	it('错误 - model failed - 返回 error', () => {
		expect(deriveTone(snap({ model: 'failed' }))).toEqual({ tone: 'error' });
	});

	it('错误 - index failed - 返回 error', () => {
		expect(deriveTone(snap({ index: 'failed' }))).toEqual({ tone: 'error' });
	});

	it('未配置 - model idle 且 embedding unavailable - 返回 unconfigured', () => {
		expect(deriveTone(snap({ model: 'idle', embedding: 'unavailable' }))).toEqual({ tone: 'unconfigured' });
	});

	it('思考中 - model 非 ready 且非 idle - 返回 thinking', () => {
		expect(deriveTone(snap({ model: 'checking' }))).toEqual({ tone: 'thinking' });
		expect(deriveTone(snap({ model: 'downloading' }))).toEqual({ tone: 'thinking' });
		expect(deriveTone(snap({ model: 'initializing' }))).toEqual({ tone: 'thinking' });
	});

	it('就绪 - model ready 且 index 非 failed - 返回 ready', () => {
		expect(deriveTone(snap({ model: 'ready', index: 'ready' }))).toEqual({ tone: 'ready' });
	});

	it('就绪 - model ready 且 index idle - 返回 ready', () => {
		expect(deriveTone(snap({ model: 'ready', index: 'idle' }))).toEqual({ tone: 'ready' });
	});
});
