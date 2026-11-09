/**
 * @file tests/core/gpu-probe.test.ts
 * @description GPU 探测判定 — 预热失败必须判不可用
 * @module tests/core/gpu-probe
 */

import { describe, expect, it } from 'vitest';
import { judgeGpuProbeMessage } from '../../src/core/gpu-probe';

describe('GPU 探测判定', () => {
	it('ready - 还不能下结论，必须等预热给出实测结果', () => {
		// 装载成功不等于能推理；提前判成功会在预热失败时留下坏执行器。
		expect(judgeGpuProbeMessage({ type: 'ready' })).toEqual({ decided: false, usable: false });
	});

	it('warmup:done - 判可用', () => {
		const verdict = judgeGpuProbeMessage({ type: 'warmup:done' });
		expect(verdict.decided).toBe(true);
		expect(verdict.usable).toBe(true);
	});

	it('warmup:error - 必须判不可用并回退（本次缺陷的源头）', () => {
		// 现场:Failed to wait for the operation:3 —— WebGPU 等待操作失败。
		// 旧实现把这条也 settle(true)，于是坏掉的 GPU 实例被投入使用，
		// 之后每次索引都失败或挂起，表现为 120 秒超时后反复重建。
		const verdict = judgeGpuProbeMessage({
			type: 'warmup:error',
			error: 'failed to call OrtRun(). ERROR_MESSAGE: Failed to wait for the operation:3',
		});
		expect(verdict.decided).toBe(true);
		expect(verdict.usable).toBe(false);
		expect(verdict.reason).toContain('预热失败');
	});

	it('error - 初始化失败判不可用', () => {
		const verdict = judgeGpuProbeMessage({ type: 'error', error: 'webgpuInit is not a function' });
		expect(verdict.usable).toBe(false);
		expect(verdict.reason).toContain('初始化失败');
	});

	it('未知消息 - 不下结论，避免误判', () => {
		expect(judgeGpuProbeMessage({ type: 'embed:progress' })).toEqual({ decided: false, usable: false });
		expect(judgeGpuProbeMessage({ type: '' })).toEqual({ decided: false, usable: false });
	});
});
