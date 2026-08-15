/**
 * @file tests/ui/chat/frame-coalescer.test.ts
 * @description requestAnimationFrame 合帧器的请求、取消与重复调度
 * @module tests/ui/chat/frame-coalescer
 */
import { describe, expect, it, vi } from 'vitest';
import { FrameCoalescer } from '../../../src/ui/chat/frame-coalescer';

describe('FrameCoalescer', () => {
	it('request - 同一帧请求三次 - 任务只执行一次', () => {
		const callbacks: FrameRequestCallback[] = [];
		const request = vi.fn((cb: FrameRequestCallback) => {
			callbacks.push(cb);
			return 7;
		});
		const task = vi.fn();
		const scheduler = new FrameCoalescer(task, request, vi.fn());
		scheduler.request();
		scheduler.request();
		scheduler.request();
		expect(request).toHaveBeenCalledTimes(1);
		callbacks[0]!(0);
		expect(task).toHaveBeenCalledTimes(1);
	});

	it('cancel - 已排队 - 取消且不执行任务', () => {
		const cancel = vi.fn();
		const scheduler = new FrameCoalescer(vi.fn(), () => 9, cancel);
		scheduler.request();
		scheduler.cancel();
		expect(cancel).toHaveBeenCalledWith(9);
	});

	it('request - 上一帧执行后再次请求 - 可排下一帧', () => {
		const callbacks: FrameRequestCallback[] = [];
		const task = vi.fn();
		const scheduler = new FrameCoalescer(task, (cb) => {
			callbacks.push(cb);
			return callbacks.length;
		}, vi.fn());
		scheduler.request();
		callbacks[0]!(0);
		scheduler.request();
		callbacks[1]!(16);
		expect(task).toHaveBeenCalledTimes(2);
	});

	it('cancel - 取消后再次 request - 可重新排队执行', () => {
		const callbacks: FrameRequestCallback[] = [];
		const task = vi.fn();
		const cancel = vi.fn();
		const scheduler = new FrameCoalescer(task, (cb) => {
			callbacks.push(cb);
			return callbacks.length;
		}, cancel);
		scheduler.request();
		scheduler.cancel();
		scheduler.request();
		callbacks[1]!(0);
		expect(task).toHaveBeenCalledTimes(1);
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it('request - task 抛异常 - frameId 已复位可再排下一帧', () => {
		const callbacks: FrameRequestCallback[] = [];
		let shouldThrow = true;
		const calls: number[] = [];
		const scheduler = new FrameCoalescer(() => {
			if (shouldThrow) throw new Error('布局失败');
			calls.push(1);
		}, (cb) => {
			callbacks.push(cb);
			return callbacks.length;
		}, vi.fn());
		scheduler.request();
		// 关键路径:回调先清 frameId 再执行 task,异常不会让后续 request 被去重吞掉
		expect(() => callbacks[0]!(0)).toThrow('布局失败');
		shouldThrow = false;
		scheduler.request();
		callbacks[1]!(16);
		expect(calls).toHaveLength(1);
	});

	it('默认调度 - 未注入帧函数 - 真实 rAF 执行任务且可取消', async () => {
		const task = vi.fn();
		// 修复回归:默认参数曾直接提取原生 rAF,receiver 丢失在 Chromium 抛 Illegal invocation
		const scheduler = new FrameCoalescer(task);
		scheduler.request();
		expect(task).not.toHaveBeenCalled();
		await new Promise((r) => setTimeout(r, 32));
		expect(task).toHaveBeenCalledTimes(1);
		scheduler.request();
		scheduler.cancel();
		await new Promise((r) => setTimeout(r, 32));
		expect(task).toHaveBeenCalledTimes(1);
	});
});
