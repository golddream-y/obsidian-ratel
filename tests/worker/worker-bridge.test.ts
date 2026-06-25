/**
 * @file tests/worker/worker-bridge.test.ts
 * @description WorkerManager 单元测试 — Node Worker Threads 事件封装
 * @module tests/worker/worker-bridge
 * @depends worker/manager
 */

import { describe, it, expect, vi } from 'vitest';
import { WorkerManager } from '../../src/worker/manager';

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

		const manager = new WorkerManager(mockWorker as unknown as Worker);

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

		const manager = new WorkerManager(mockWorker as unknown as Worker);

		const responsePromise = manager.request({
			type: 'index.full',
			payload: { vaultPath: '/test' },
		});

		mockWorker._emit('error', new Error('Worker crashed'));

		await expect(responsePromise).rejects.toThrow('Worker error: Worker crashed');
	});

	it('terminates worker on destroy', () => {
		const mockWorker = createMockWorker();

		const manager = new WorkerManager(mockWorker as unknown as Worker);
		manager.destroy();
		expect(mockWorker.terminate).toHaveBeenCalled();
	});

	it('Worker 在指定 timeoutMs 内不响应则 reject', async () => {
		// 关键路径:用真实 50ms timeout 短时间等待,避免 fakeTimers + microtask 死锁
		const mockWorker = createMockWorker();

		const manager = new WorkerManager(mockWorker as unknown as Worker, {
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

		const manager = new WorkerManager(mockWorker as unknown as Worker, {
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
