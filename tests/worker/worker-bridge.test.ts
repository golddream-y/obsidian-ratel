import { describe, it, expect, vi } from 'vitest';
import { WorkerManager } from '../../src/worker/manager';

describe('WorkerManager', () => {
	it('sends index.status request and receives response', async () => {
		const mockWorker = {
			postMessage: vi.fn(),
			onmessage: null as ((e: MessageEvent) => void) | null,
			terminate: vi.fn(),
		};

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

		mockWorker.onmessage!({
			data: {
				type: 'index.status.result',
				payload: { totalDocs: 42, lastIndexTime: 1000 },
				_requestId: requestId,
			},
		} as MessageEvent);

		const response = await responsePromise;
		expect(response).toEqual({
			type: 'index.status.result',
			payload: { totalDocs: 42, lastIndexTime: 1000 },
		});
	});

	it('handles worker errors', async () => {
		const mockWorker = {
			postMessage: vi.fn(),
			onmessage: null as ((e: MessageEvent) => void) | null,
			onerror: null as ((e: ErrorEvent) => void) | null,
			terminate: vi.fn(),
		};

		const manager = new WorkerManager(mockWorker as unknown as Worker);

		const responsePromise = manager.request({
			type: 'index.full',
			payload: { vaultPath: '/test' },
		});

		mockWorker.onerror!({ message: 'Worker crashed' } as ErrorEvent);

		await expect(responsePromise).rejects.toThrow('Worker error: Worker crashed');
	});

	it('terminates worker on destroy', () => {
		const mockWorker = {
			postMessage: vi.fn(),
			onmessage: null as ((e: MessageEvent) => void) | null,
			terminate: vi.fn(),
		};

		const manager = new WorkerManager(mockWorker as unknown as Worker);
		manager.destroy();
		expect(mockWorker.terminate).toHaveBeenCalled();
	});

	it('Worker 在指定 timeoutMs 内不响应则 reject', async () => {
		// 关键路径:用真实 50ms timeout 短时间等待,避免 fakeTimers + microtask 死锁
		const mockWorker = {
			postMessage: vi.fn(),
			onmessage: null as ((e: MessageEvent) => void) | null,
			onerror: null as ((e: ErrorEvent) => void) | null,
			terminate: vi.fn(),
		};

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

	it('超时后调用 terminate 释放 Worker', async () => {
		const mockWorker = {
			postMessage: vi.fn(),
			onmessage: null as ((e: MessageEvent) => void) | null,
			onerror: null as ((e: ErrorEvent) => void) | null,
			terminate: vi.fn(),
		};

		const manager = new WorkerManager(mockWorker as unknown as Worker, {
			timeoutMs: 50,
		});

		const responsePromise = manager.request({
			type: 'index.status',
			payload: {},
		});

		await expect(responsePromise).rejects.toThrow();
		expect(mockWorker.terminate).toHaveBeenCalled();
	});
});
