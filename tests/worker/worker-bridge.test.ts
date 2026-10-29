/**
 * @file tests/worker/worker-bridge.test.ts
 * @description WorkerManager 单元测试 — Node Worker Threads 事件封装
 * @module tests/worker/worker-bridge
 * @depends worker/manager
 */

import { describe, it, expect, vi } from 'vitest';
import { tNow } from '../../src/i18n';
import { WorkerManager, type WorkerLike } from '../../src/worker/manager';

function createMockWorker() {
	const listeners: Record<string, ((...args: unknown[]) => void) | undefined> = {};
	return {
		postMessage: vi.fn(),
		on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
			listeners[event] = listener;
			return createMockWorker();
		}),
		terminate: vi.fn(),
		_emit(event: string, ...args: unknown[]) {
			listeners[event]?.(...args);
		},
	};
}

describe('WorkerManager', () => {
	it('sends index.status request and receives response', async () => {
		const mockWorker = createMockWorker();

		const manager = new WorkerManager(mockWorker as unknown as WorkerLike);

		const responsePromise = manager.request({
			type: 'index.status',
			payload: {},
		});

		expect(mockWorker.postMessage).toHaveBeenCalledWith({
			type: 'index.status',
			payload: {},
			_requestId: expect.any(String),
		});

		const sentMessage = mockWorker.postMessage.mock.calls[0]![0] as Record<string, unknown>;
		const requestId = sentMessage._requestId as string;

		mockWorker._emit('message', {
			type: 'index.status.result',
			payload: { totalDocs: 42, lastIndexTime: 1000 },
			_requestId: requestId,
		});

		const response = await responsePromise;
		expect(response).toEqual({
			type: 'index.status.result',
			payload: { totalDocs: 42, lastIndexTime: 1000 },
		});
	});

	it('handles worker errors', async () => {
		const mockWorker = createMockWorker();

		const manager = new WorkerManager(mockWorker as unknown as WorkerLike);

		const responsePromise = manager.request({
			type: 'index.full',
			payload: { files: [{ path: '/test.md', content: 'x' }] },
		});

		mockWorker._emit('error', new Error('Worker crashed'));

		await expect(responsePromise).rejects.toThrow('Worker error: Worker crashed');
	});

	it('terminates worker on destroy', () => {
		const mockWorker = createMockWorker();

		const manager = new WorkerManager(mockWorker as unknown as WorkerLike);
		manager.destroy();
		expect(mockWorker.terminate).toHaveBeenCalled();
	});

	it('Worker 在指定 timeoutMs 内不响应则 reject', async () => {
		// 关键路径:用真实 50ms timeout 短时间等待,避免 fakeTimers + microtask 死锁
		const mockWorker = createMockWorker();

		const manager = new WorkerManager(mockWorker as unknown as WorkerLike, {
			timeoutMs: 50,
		});

		const responsePromise = manager.request({
			type: 'index.status',
			payload: {},
		});

		await expect(responsePromise).rejects.toThrow(/timeout/i);
		manager.destroy();
	});

	it('超时后 reject 但不 terminate Worker(InlineWorker 主线程不可中断)', async () => {
		const mockWorker = createMockWorker();

		const manager = new WorkerManager(mockWorker as unknown as WorkerLike, {
			timeoutMs: 50,
		});

		const responsePromise = manager.request({
			type: 'index.status',
			payload: {},
		});

		await expect(responsePromise).rejects.toThrow(/timeout/i);
		// 关键路径:超时不 terminate Worker,因为 InlineWorker 在主线程执行 ONNX 推理无法中断,
		// terminate 会清空监听器导致后续所有请求永久失败。
		expect(mockWorker.terminate).not.toHaveBeenCalled();
		manager.destroy();
	});
});


describe('索引请求生命周期', () => {
 it('活动超时 - 持续进度跨过总时限 - 仅发送一次且等待终态', async () => {
  vi.useFakeTimers();
  const worker = createMockWorker();
  const progress = vi.fn();
  const manager = new WorkerManager(worker as unknown as WorkerLike, { timeoutMs: 100, onProgress: progress });
  try {
   const result = manager.request({ type: 'index.full', payload: { files: [] } });
   const settled = vi.fn();
   void result.then(settled, settled);
   const id = worker.postMessage.mock.calls[0]![0]._requestId;
   for (let i = 1; i <= 3; i++) {
    await vi.advanceTimersByTimeAsync(80);
    worker._emit('message', { type: 'index.progress', payload: { done: i, total: 4 }, _requestId: id });
   }
   expect(settled).not.toHaveBeenCalled();
   expect(progress).toHaveBeenCalledTimes(3);
   worker._emit('message', { type: 'index.done', payload: { indexed: 4, errors: 0 }, _requestId: id });
   expect((await result).type).toBe('index.done');
   expect(worker.postMessage).toHaveBeenCalledTimes(1);
  } finally { manager.destroy(); vi.useRealTimers(); }
 });

 it('无进展超时 - 迟到终态前 - 保留写保护且排队不计时', async () => {
  vi.useFakeTimers();
  const worker = createMockWorker();
  const progress = vi.fn();
  const manager = new WorkerManager(worker as unknown as WorkerLike, { timeoutMs: 100, onProgress: progress });
  try {
   const first = manager.request({ type: 'index.full', payload: { files: [] } });
   const rejected = expect(first).rejects.toThrow(/timeout/);
   const id = worker.postMessage.mock.calls[0]![0]._requestId;
   await vi.advanceTimersByTimeAsync(110);
   await rejected;
   const drop = vi.fn(async () => undefined);
   await expect(manager.runExclusive(drop)).rejects.toThrow(tNow('notice.indexStillRunning'));
   await expect(manager.request({ type: 'index.status', payload: {} })).rejects.toThrow(tNow('notice.indexStillRunning'));
   await vi.advanceTimersByTimeAsync(500);
   expect(drop).not.toHaveBeenCalled();
   expect(worker.postMessage).toHaveBeenCalledTimes(1);
   worker._emit('message', { type: 'index.progress', payload: { done: 1, total: 1 }, _requestId: id });
   expect(progress).not.toHaveBeenCalled();
   worker._emit('message', { type: 'index.done', payload: { indexed: 1, errors: 0 }, _requestId: id });
   await manager.runExclusive(drop);
   const next = manager.request({ type: 'index.status', payload: {} });
   const nextId = worker.postMessage.mock.calls[1]![0]._requestId;
   worker._emit('message', { type: 'index.progress', payload: { done: 1, total: 1 }, _requestId: id });
   worker._emit('message', { type: 'index.status.result', payload: { totalDocs: 1, lastIndexTime: 1 }, _requestId: nextId });
   expect((await next).type).toBe('index.status.result');
   expect(progress).not.toHaveBeenCalled();
  } finally { manager.destroy(); vi.useRealTimers(); }
 });
});


describe('请求清理与进度校验', () => {
 it('排队请求 - 前序耗时且正常完成 - 从实际发送开始计时', async () => {
  vi.useFakeTimers();
  const worker = createMockWorker();
  const manager = new WorkerManager(worker as unknown as WorkerLike, { timeoutMs: 100 });
  try {
   const first = manager.request({ type: 'index.full', payload: { files: [] } });
   const second = manager.request({ type: 'index.status', payload: {} });
   const settled = vi.fn(); void second.then(settled, settled);
   const id = worker.postMessage.mock.calls[0]![0]._requestId;
   await vi.advanceTimersByTimeAsync(80);
   worker._emit('message', { type: 'index.progress', payload: { done: 1, total: 2 }, _requestId: id });
   await vi.advanceTimersByTimeAsync(80);
   expect(worker.postMessage).toHaveBeenCalledTimes(1);
   worker._emit('message', { type: 'index.done', payload: { indexed: 2, errors: 0 }, _requestId: id });
   await first;
   expect(settled).not.toHaveBeenCalled();
   const next = worker.postMessage.mock.calls[1]![0]._requestId;
   worker._emit('message', { type: 'index.status.result', payload: { totalDocs: 2, lastIndexTime: 1 }, _requestId: next });
   await second;
  } finally { manager.destroy(); vi.useRealTimers(); }
 });
 it('活动超时 - 重复或非法进度 - 不续期且不回退展示', async () => {
  vi.useFakeTimers();
  const worker = createMockWorker(); const progress = vi.fn();
  const manager = new WorkerManager(worker as unknown as WorkerLike, { timeoutMs: 100, onProgress: progress });
  try {
   const first = manager.request({ type: 'index.full', payload: { files: [] } });
   const rejected = expect(first).rejects.toThrow(/timeout/);
   const id = worker.postMessage.mock.calls[0]![0]._requestId;
   worker._emit('message', { type: 'index.progress', payload: { done: 1, total: 4 }, _requestId: id });
   await vi.advanceTimersByTimeAsync(80);
   for (const done of [1, 0, 5, NaN]) worker._emit('message', { type: 'index.progress', payload: { done, total: 4 }, _requestId: id });
   await vi.advanceTimersByTimeAsync(30); await rejected;
   expect(progress).toHaveBeenCalledTimes(1);
  } finally { manager.destroy(); vi.useRealTimers(); }
 });
 it('销毁 - 有执行和排队请求 - 全部拒绝且没有遗留定时器', async () => {
  vi.useFakeTimers();
  const worker = createMockWorker(); const manager = new WorkerManager(worker as unknown as WorkerLike);
  const first = manager.request({ type: 'index.full', payload: { files: [] } });
  const second = manager.request({ type: 'index.status', payload: {} });
  const dropped = manager.runExclusive(async () => undefined);
  const errors = [expect(first).rejects.toThrow(/destroyed/), expect(second).rejects.toThrow(/destroyed/), expect(dropped).rejects.toThrow(/destroyed/)];
  manager.destroy(); await Promise.all(errors);
  expect(vi.getTimerCount()).toBe(0);
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
 });
});
