/**
 * @file tests/worker/worker-bridge.test.ts
 * @description WorkerManager 单元测试 — Node Worker Threads 事件封装
 * @module tests/worker/worker-bridge
 * @depends worker/manager
 */

import { describe, it, expect, vi } from 'vitest';
import { tNow } from '../../src/i18n';
import { WorkerManager, type WorkerLike, type WorkerManagerClock } from '../../src/worker/manager';
import {
	canMarkReady,
	IndexStallWatchdog,
	IndexTaskCoordinator,
} from '../../src/core/index-task-coordinator';
import { getWriteOwnerCoordinator } from '../../src/core/index-write-owner';
import { createEmbedAbortError } from '../../src/ports/embedding';

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

		await expect(responsePromise).rejects.toMatchObject({ code: 'request-timeout' });
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

		await expect(responsePromise).rejects.toMatchObject({ code: 'request-timeout' });
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
   const rejected = expect(first).rejects.toMatchObject({ code: 'index-stalled' });
   const id = worker.postMessage.mock.calls[0]![0]._requestId;
   await vi.advanceTimersByTimeAsync(110);
   await rejected;
   const drop = vi.fn(async () => undefined);
   await expect(manager.runExclusive(drop)).rejects.toThrow(tNow('notice.indexStillRunning'));
   // 关键路径(T5):只读请求走独立车道 —— 停滞的是推理阶段时不再被写通道拒绝,
   // 但仍受自身有界超时约束(见「普通查询 - 超过上限仍无响应」用例)。
   const readDuringStall = manager.request({ type: 'index.status', payload: {} });
   const readId = worker.postMessage.mock.calls[1]![0]._requestId;
   // 只读请求在停滞期间照常被派发并结算,不受写通道停滞影响。
   expect(worker.postMessage).toHaveBeenCalledTimes(2);
   worker._emit('message', { type: 'index.status.result', payload: { totalDocs: 1, lastIndexTime: 1 }, _requestId: readId });
   expect((await readDuringStall).type).toBe('index.status.result');
   await vi.advanceTimersByTimeAsync(500);
   expect(drop).not.toHaveBeenCalled();
   expect(worker.postMessage).toHaveBeenCalledTimes(2);
   worker._emit('message', { type: 'index.progress', payload: { done: 1, total: 1 }, _requestId: id });
   expect(progress).not.toHaveBeenCalled();
   worker._emit('message', { type: 'index.done', payload: { indexed: 1, errors: 0 }, _requestId: id });
   await manager.runExclusive(drop);
   expect(drop).toHaveBeenCalled();
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
   // 关键路径(T5):只读请求已走独立车道,这里用写请求验证「排队时间不计入执行超时」。
   const second = manager.request({ type: 'index.delete', payload: { filePath: 'a.md' } });
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
   worker._emit('message', { type: 'vector.delete.done', payload: { count: 1 }, _requestId: next });
   await second;
  } finally { manager.destroy(); vi.useRealTimers(); }
 });
 it('活动超时 - 重复或非法进度 - 不续期且不回退展示', async () => {
  vi.useFakeTimers();
  const worker = createMockWorker(); const progress = vi.fn();
  const manager = new WorkerManager(worker as unknown as WorkerLike, { timeoutMs: 100, onProgress: progress });
  try {
   const first = manager.request({ type: 'index.full', payload: { files: [] } });
   const rejected = expect(first).rejects.toMatchObject({ code: 'index-stalled' });
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
  const second = manager.request({ type: 'index.delete', payload: { filePath: 'a.md' } });
  const dropped = manager.runExclusive(async () => undefined);
  const errors = [expect(first).rejects.toThrow(/destroyed/), expect(second).rejects.toThrow(/destroyed/), expect(dropped).rejects.toThrow(/destroyed/)];
  manager.destroy(); await Promise.all(errors);
  expect(vi.getTimerCount()).toBe(0);
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
 });
});

// ==================== T5:活动、停滞、取消与车道分离 ====================

/**
 * 可控时钟 — 手动推进,不用真实定时器赛跑。
 *
 * 关键路径:停滞阈值、只读排队上限等时间行为全部由它驱动。
 */
function createTestClock() {
	const timers = new Map<number, { handler: () => void; at: number }>();
	let nextId = 1;
	let now = 0;
	const clock: WorkerManagerClock = {
		setTimeout: (handler, timeoutMs) => {
			const id = nextId++;
			timers.set(id, { handler, at: now + timeoutMs });
			return id;
		},
		clearTimeout: (handle) => {
			timers.delete(handle as number);
		},
	};
	return {
		clock,
		/** 推进时间并触发到期的定时器(新武装的定时器留到下一次推进)。 */
		advance(ms: number): void {
			now += ms;
			for (const [id, timer] of [...timers]) {
				if (timer.at > now) continue;
				timers.delete(id);
				timer.handler();
			}
		},
		pendingCount(): number {
			return timers.size;
		},
	};
}

/**
 * 可数的取消信号替身 — 让「调用方 signal 上残留 abort 监听」可被直接观测。
 *
 * 关键路径(I1):真实 `AbortSignal` 不暴露监听器数量,因此用一个只实现
 * `addEventListener` / `removeEventListener` / `aborted` 的替身替代。
 */
function createCountingSignal() {
	const listeners = new Set<() => void>();
	let aborted = false;
	const signal = {
		get aborted(): boolean {
			return aborted;
		},
		addEventListener: (_type: string, listener: () => void): void => {
			listeners.add(listener);
		},
		removeEventListener: (_type: string, listener: () => void): void => {
			listeners.delete(listener);
		},
	};
	return {
		signal: signal as unknown as AbortSignal,
		/** 触发取消:与真实 `{ once: true }` 一致,先摘除再通知。 */
		abort(): void {
			aborted = true;
			const pending = [...listeners];
			listeners.clear();
			for (const listener of pending) listener();
		},
		listenerCount(): number {
			return listeners.size;
		},
	};
}

/** 合法活动包的构造器 — 序号、阶段与数量都由用例显式给出。 */
function activity(input: {
	taskId?: string;
	requestId: string;
	epoch?: number;
	sequence: number;
	stage?: 'chunk' | 'embed' | 'persist';
	completedUnits?: number;
}): Record<string, unknown> {
	return {
		taskId: input.taskId ?? 'task-x',
		requestId: input.requestId,
		epoch: input.epoch ?? 0,
		sequence: input.sequence,
		stage: input.stage ?? 'embed',
		completedUnits: input.completedUnits ?? 1,
	};
}

describe('停滞恢复与迟到终态(T5)', () => {
	it('停滞 - 无有效活动达到阈值 - 结束等待但保留写保护，迟到成功仍走提交路径', async () => {
		const testClock = createTestClock();
		const worker = createMockWorker();
		const lateTerminal: unknown[] = [];
		const resumed: unknown[] = [];
		const manager = new WorkerManager(worker as unknown as WorkerLike, {
			timeoutMs: 1000,
			clock: testClock.clock,
			onResume: info => resumed.push(info),
		});
		const task = manager.request(
			{ type: 'index.full', payload: { files: [] } },
			{ taskId: 'task-stall', epoch: 5, onLateTerminal: response => lateTerminal.push(response) },
		);
		const rejected = expect(task).rejects.toMatchObject({ code: 'index-stalled' });
		const sent = worker.postMessage.mock.calls[0]![0] as { _requestId: string; payload: { taskId?: string; epoch?: number } };
		// 关键路径:任务身份随请求下发,Worker 侧据此给活动盖章。
		expect(sent.payload.taskId).toBe('task-stall');
		expect(sent.payload.epoch).toBe(5);

		testClock.advance(1000);
		await rejected;
		expect(manager.isStalled()).toBe(true);
		expect(manager.stallInfo()?.taskId).toBe('task-stall');
		// 停滞:写通道继续拒绝新写调用,已提交保护不释放。
		await expect(manager.runExclusive(async () => undefined)).rejects.toThrow(tNow('notice.indexStillRunning'));
		expect(lateTerminal).toHaveLength(0);

		// 迟到有效活动 → 回到处理中。
		worker._emit('message', { type: 'index.activity', payload: activity({ taskId: 'task-stall', requestId: sent._requestId, epoch: 5, sequence: 1, stage: 'embed', completedUnits: 4 }) });
		expect(manager.isStalled()).toBe(false);
		expect(resumed).toHaveLength(1);

		// 迟到成功仍交付提交路径,并在真实终态释放写保护。
		worker._emit('message', { type: 'index.done', payload: { indexed: 3, errors: 0 }, _requestId: sent._requestId });
		expect(lateTerminal).toEqual([{ type: 'index.done', payload: { indexed: 3, errors: 0 } }]);
		await expect(manager.runExclusive(async () => 'released')).resolves.toBe('released');
		manager.destroy();
	});

	it('旧行为对照 - 未登记迟到终态 - 写保护保留但终态结果没有接收方', async () => {
		const testClock = createTestClock();
		const worker = createMockWorker();
		const manager = new WorkerManager(worker as unknown as WorkerLike, { timeoutMs: 1000, clock: testClock.clock });
		// 事实更正(规范审查者已核对 HEAD 的 manager):
		// 旧代码在超时后设 `pending.timedOut = true`,但**保留 pending 与 busy**;真实终态到达时执行
		// `pending.delete` + `stalled = false; release()`,只是终态结果经 `resolve` 交付 ——
		// 等待早已结束的调用方拿不到它。即旧代码丢的是「终态结果向调用方的投递」,**没有**丢掉写保护。
		// 旧实现没有 `onLateTerminal`,因此「无接收方」这一段是人工核对 HEAD 源码得到的对照,
		// **不是自动化红证**;这里能自动化证明的是:未登记回调时 pending 与写保护确实保留到真实终态。
		const task = manager.request({ type: 'index.full', payload: { files: [] } });
		const rejected = expect(task).rejects.toMatchObject({ code: 'index-stalled' });
		const sent = worker.postMessage.mock.calls[0]![0] as { _requestId: string };
		testClock.advance(1000);
		await rejected;
		// 等待结束但 pending 未丢弃 —— 这正是「写保护保留」与只读超时的区别。
		expect(manager.isStalled()).toBe(true);
		expect(manager.stallInfo()?.requestId).toBe(sent._requestId);
		worker._emit('message', { type: 'index.done', payload: { indexed: 4, errors: 0 }, _requestId: sent._requestId });
		expect(manager.isStalled()).toBe(false);
		expect(manager.stallInfo()).toBeNull();
		await expect(manager.runExclusive(async () => 'released')).resolves.toBe('released');
		manager.destroy();
	});

	it('迟到终态 - 只投递给登记回调且 requestId 匹配的在途请求', async () => {
		const testClock = createTestClock();
		const worker = createMockWorker();
		const lateTerminal = vi.fn();
		const manager = new WorkerManager(worker as unknown as WorkerLike, { timeoutMs: 1000, clock: testClock.clock });
		const task = manager.request(
			{ type: 'index.full', payload: { files: [] } },
			{ taskId: 'task-late', onLateTerminal: response => lateTerminal(response) },
		);
		const rejected = expect(task).rejects.toMatchObject({ code: 'index-stalled' });
		const sent = worker.postMessage.mock.calls[0]![0] as { _requestId: string };
		testClock.advance(1000);
		await rejected;
		// 关键路径:未匹配的 requestId 不得投递,也不得释放写保护 —— 投递是选择性的,不是广播。
		worker._emit('message', { type: 'index.done', payload: { indexed: 9, errors: 0 }, _requestId: 'req-unmatched' });
		expect(lateTerminal).not.toHaveBeenCalled();
		expect(manager.isStalled()).toBe(true);
		await expect(manager.runExclusive(async () => undefined)).rejects.toThrow(tNow('notice.indexStillRunning'));
		// 匹配的迟到终态:投递一次并释放写保护。
		worker._emit('message', { type: 'index.done', payload: { indexed: 3, errors: 0 }, _requestId: sent._requestId });
		expect(lateTerminal).toHaveBeenCalledTimes(1);
		expect(lateTerminal).toHaveBeenCalledWith({ type: 'index.done', payload: { indexed: 3, errors: 0 } });
		await expect(manager.runExclusive(async () => 'released')).resolves.toBe('released');
		manager.destroy();
	});

	it('活动 - 非单调、非法或旧 epoch - 不算进展也不恢复停滞', async () => {
		const testClock = createTestClock();
		const worker = createMockWorker();
		const resumed = vi.fn();
		const manager = new WorkerManager(worker as unknown as WorkerLike, {
			timeoutMs: 1000,
			clock: testClock.clock,
			onResume: resumed,
		});
		const task = manager.request({ type: 'index.full', payload: { files: [] } }, { taskId: 'task-a', epoch: 2 });
		const rejected = expect(task).rejects.toMatchObject({ code: 'index-stalled' });
		const id = (worker.postMessage.mock.calls[0]![0] as { _requestId: string })._requestId;
		testClock.advance(1000);
		await rejected;

		const invalidPayloads: unknown[] = [
			activity({ taskId: 'task-a', requestId: id, epoch: 2, sequence: 0 }),
			activity({ taskId: 'task-a', requestId: id, epoch: 2, sequence: 1, stage: 'bogus' as 'embed' }),
			{ taskId: 'task-a', requestId: id, epoch: 2, sequence: 1, stage: 'embed', completedUnits: -1 },
			activity({ taskId: 'task-a', requestId: id, epoch: 1, sequence: 1 }),
			activity({ taskId: 'other-task', requestId: 'unknown-request', epoch: 2, sequence: 1 }),
		];
		for (const payload of invalidPayloads) {
			worker._emit('message', { type: 'index.activity', payload });
		}
		expect(manager.isStalled()).toBe(true);
		expect(resumed).not.toHaveBeenCalled();

		// 合法且序号更大、epoch 相同的活动才恢复。
		worker._emit('message', { type: 'index.activity', payload: activity({ taskId: 'task-a', requestId: id, epoch: 2, sequence: 1, stage: 'chunk', completedUnits: 6 }) });
		expect(manager.isStalled()).toBe(false);
		expect(resumed).toHaveBeenCalledTimes(1);
		// 同一序号重复到达不再续期(非单调)。
		worker._emit('message', { type: 'index.activity', payload: activity({ taskId: 'task-a', requestId: id, epoch: 2, sequence: 1 }) });
		expect(resumed).toHaveBeenCalledTimes(1);
		manager.destroy();
	});

	it('活动 - taskId 命中但 requestId 不匹配 - 不算进展也不恢复停滞(建议3)', async () => {
		const testClock = createTestClock();
		const worker = createMockWorker();
		const resumed = vi.fn();
		const manager = new WorkerManager(worker as unknown as WorkerLike, {
			timeoutMs: 1000,
			clock: testClock.clock,
			onResume: resumed,
		});
		const task = manager.request({ type: 'index.full', payload: { files: [] } }, { taskId: 'task-a', epoch: 2 });
		const rejected = expect(task).rejects.toMatchObject({ code: 'index-stalled' });
		const id = (worker.postMessage.mock.calls[0]![0] as { _requestId: string })._requestId;
		testClock.advance(1000);
		await rejected;
		// 关键路径(建议3):任务身份命中不等于请求身份命中 —— 冒名 requestId 的活动不得续期。
		worker._emit('message', { type: 'index.activity', payload: activity({ taskId: 'task-a', requestId: 'req-impostor', epoch: 2, sequence: 1 }) });
		expect(manager.isStalled()).toBe(true);
		expect(resumed).not.toHaveBeenCalled();
		// 正向对照:真实 requestId 的活动仍然恢复。
		worker._emit('message', { type: 'index.activity', payload: activity({ taskId: 'task-a', requestId: id, epoch: 2, sequence: 1 }) });
		expect(manager.isStalled()).toBe(false);
		expect(resumed).toHaveBeenCalledTimes(1);
		manager.destroy();
	});

	it('活动 - 超大序号 - 不永久屏蔽该任务后续合法活动(建议3)', async () => {
		const testClock = createTestClock();
		const worker = createMockWorker();
		const resumed = vi.fn();
		const manager = new WorkerManager(worker as unknown as WorkerLike, {
			timeoutMs: 1000,
			clock: testClock.clock,
			onResume: resumed,
		});
		const task = manager.request({ type: 'index.full', payload: { files: [] } }, { taskId: 'task-b', epoch: 0 });
		const rejected = expect(task).rejects.toMatchObject({ code: 'index-stalled' });
		const id = (worker.postMessage.mock.calls[0]![0] as { _requestId: string })._requestId;
		testClock.advance(1000);
		await rejected;
		// 关键路径(建议3):一条畸形的大序号不得把 watermark 推高到后续真实活动全被丢弃。
		worker._emit('message', { type: 'index.activity', payload: activity({ taskId: 'task-b', requestId: id, sequence: Number.MAX_SAFE_INTEGER, stage: 'embed', completedUnits: 1 }) });
		expect(manager.isStalled()).toBe(true);
		expect(resumed).not.toHaveBeenCalled();
		worker._emit('message', { type: 'index.activity', payload: activity({ taskId: 'task-b', requestId: id, sequence: 1, stage: 'embed', completedUnits: 2 }) });
		expect(manager.isStalled()).toBe(false);
		expect(resumed).toHaveBeenCalledTimes(1);
		manager.destroy();
	});
});

describe('取消与运行时重置(T5)', () => {
	it('取消 - 单项任务取消 - 不终止共享 Worker，写保护保留到真实终态', async () => {
		const testClock = createTestClock();
		const worker = createMockWorker();
		const lateTerminal: unknown[] = [];
		const manager = new WorkerManager(worker as unknown as WorkerLike, { timeoutMs: 1000, clock: testClock.clock });
		const task = manager.request(
			{ type: 'index.full', payload: { files: [] } },
			{ taskId: 'task-cancel', epoch: 7, onLateTerminal: response => lateTerminal.push(response) },
		);
		const rejected = expect(task).rejects.toMatchObject({ code: 'index-cancelled' });
		const id = (worker.postMessage.mock.calls[0]![0] as { _requestId: string })._requestId;

		expect(manager.cancelIndex({ taskId: 'task-cancel' })).toBe(true);
		await rejected;
		// 迁移语义:取消经消息表达,不传 AbortSignal,也不终止共享 Worker。
		expect(worker.postMessage).toHaveBeenCalledWith({
			type: 'index.cancel',
			payload: { requestId: id, taskId: 'task-cancel', epoch: 7 },
		});
		expect(worker.terminate).not.toHaveBeenCalled();

		// 执行中的写占用继续保留:独占操作必须排队而不是并行进入。
		const drop = vi.fn(async () => 'dropped');
		const queuedDrop = manager.runExclusive(drop);
		await Promise.resolve();
		expect(drop).not.toHaveBeenCalled();

		// 真实终态到达后交付并释放写保护。
		worker._emit('message', { type: 'index.done', payload: { indexed: 0, errors: 1 }, _requestId: id });
		expect(lateTerminal).toHaveLength(1);
		await expect(queuedDrop).resolves.toBe('dropped');
		expect(drop).toHaveBeenCalledTimes(1);

		// 其他查询继续可用(共享 Worker 不为单项取消而终止)。
		const status = manager.request({ type: 'index.status', payload: {} });
		const statusId = (worker.postMessage.mock.calls.at(-1)![0] as { _requestId: string })._requestId;
		worker._emit('message', { type: 'index.status.result', payload: { totalDocs: 1, lastIndexTime: 2 }, _requestId: statusId });
		await expect(status).resolves.toEqual({ type: 'index.status.result', payload: { totalDocs: 1, lastIndexTime: 2 } });
		manager.destroy();
	});

	it('取消 - 目标不匹配 - 不影响在途任务', async () => {
		const testClock = createTestClock();
		const worker = createMockWorker();
		const manager = new WorkerManager(worker as unknown as WorkerLike, { timeoutMs: 1000, clock: testClock.clock });
		const task = manager.request({ type: 'index.full', payload: { files: [] } }, { taskId: 'task-keep' });
		const id = (worker.postMessage.mock.calls[0]![0] as { _requestId: string })._requestId;
		expect(manager.cancelIndex({ taskId: 'task-other' })).toBe(false);
		expect(manager.cancelIndex({})).toBe(false);
		worker._emit('message', { type: 'index.done', payload: { indexed: 1, errors: 0 }, _requestId: id });
		await expect(task).resolves.toEqual({ type: 'index.done', payload: { indexed: 1, errors: 0 } });
		manager.destroy();
	});

	it('取消 - 排队中的只读请求 - 立即失败且不会在窗口关闭后被派发', async () => {
		const testClock = createTestClock();
		const worker = createMockWorker();
		const manager = new WorkerManager(worker as unknown as WorkerLike, { timeoutMs: 1000, clock: testClock.clock });
		const indexTask = manager.request({ type: 'index.full', payload: { files: [] } }, { taskId: 'task-queued-read' });
		const indexId = (worker.postMessage.mock.calls[0]![0] as { _requestId: string })._requestId;
		// 提交窗口打开 → 查询只能排队等待。
		worker._emit('message', { type: 'index.activity', payload: activity({ taskId: 'task-queued-read', requestId: indexId, sequence: 1, stage: 'persist', completedUnits: 0 }) });
		const controller = new AbortController();
		const search = manager.request(
			{ type: 'vector.search', payload: { queryVector: [1, 0], topK: 1 } },
			{ signal: controller.signal },
		);
		const rejected = expect(search).rejects.toMatchObject({ code: 'index-cancelled' });
		expect(worker.postMessage).toHaveBeenCalledTimes(1);
		controller.abort();
		await rejected;
		// 关键路径:窗口关闭后已取消的查询不得被悄悄派发。
		worker._emit('message', { type: 'index.done', payload: { indexed: 1, errors: 0 }, _requestId: indexId });
		await expect(indexTask).resolves.toEqual({ type: 'index.done', payload: { indexed: 1, errors: 0 } });
		expect(worker.postMessage).toHaveBeenCalledTimes(1);
		expect(testClock.pendingCount()).toBe(0);
		manager.destroy();
	});

	it('运行时重置 - 永久挂起 - 全部调用按真实失败结束且没有遗留定时器', async () => {
		const testClock = createTestClock();
		const worker = createMockWorker();
		const manager = new WorkerManager(worker as unknown as WorkerLike, { timeoutMs: 1000, clock: testClock.clock });
		const indexTask = manager.request({ type: 'index.full', payload: { files: [] } });
		const indexRejected = expect(indexTask).rejects.toMatchObject({ code: 'runtime-reset' });
		const search = manager.request({ type: 'vector.search', payload: { queryVector: [1, 0], topK: 1 } });
		const searchRejected = expect(search).rejects.toMatchObject({ code: 'runtime-reset' });
		// 写通道被占用 → 独占操作只能排队,同样必须被重置结束。
		const drop = vi.fn(async () => 'dropped');
		const dropped = manager.runExclusive(drop);
		const droppedRejected = expect(dropped).rejects.toMatchObject({ code: 'runtime-reset' });

		manager.resetRuntime('索引运行时已重置');
		await Promise.all([indexRejected, searchRejected, droppedRejected]);
		expect(drop).not.toHaveBeenCalled();
		expect(testClock.pendingCount()).toBe(0);

		// 重置后写通道可用(不是死锁状态)。
		await expect(manager.runExclusive(async () => 'ok')).resolves.toBe('ok');
		manager.destroy();
	});
it('取消 - 已派发的只读请求被撤销 - 同步释放只读通道且后续查询可派发(建议1)', async () => {
		const testClock = createTestClock();
		const worker = createMockWorker();
		const manager = new WorkerManager(worker as unknown as WorkerLike, { timeoutMs: 1000, clock: testClock.clock });
		const controller = new AbortController();
		const first = manager.request(
			{ type: 'vector.search', payload: { queryVector: [1, 0], topK: 1 } },
			{ signal: controller.signal },
		);
		const firstRejected = expect(first).rejects.toMatchObject({ code: 'index-cancelled' });
		const firstId = (worker.postMessage.mock.calls[0]![0] as { _requestId: string })._requestId;
		controller.abort();
		await firstRejected;
		// 关键路径:只读取消必须同步释放只读通道,否则 worker 永久挂起时后续查询只能各自超时。
		const second = manager.request({ type: 'index.status', payload: {} });
		expect(worker.postMessage).toHaveBeenCalledTimes(2);
		const secondId = (worker.postMessage.mock.calls[1]![0] as { _requestId: string })._requestId;
		// 已取消请求的迟到终态不得再触碰任何状态。
		worker._emit('message', { type: 'vector.search.result', payload: [], _requestId: firstId });
		expect(testClock.pendingCount()).toBe(1);
		worker._emit('message', { type: 'index.status.result', payload: { totalDocs: 1, lastIndexTime: 1 }, _requestId: secondId });
		await expect(second).resolves.toEqual({ type: 'index.status.result', payload: { totalDocs: 1, lastIndexTime: 1 } });
		expect(testClock.pendingCount()).toBe(0);
		manager.destroy();
	});

	it('运行时重置 - 已启动的独占操作 - 调用方按真实失败结束，写通道保留到它真实结束(B2)', async () => {
		const testClock = createTestClock();
		const worker = createMockWorker();
		const manager = new WorkerManager(worker as unknown as WorkerLike, { timeoutMs: 1000, clock: testClock.clock });
		let releaseDrop!: () => void;
		let dropStarted = false;
		const drop = manager.runExclusive(async () => {
			dropStarted = true;
			await new Promise<void>(resolve => { releaseDrop = resolve; });
			return 'dropped';
		});
		// 关键路径:独占操作已**启动**(不是仅排队)。
		expect(dropStarted).toBe(true);
		let outcome = 'pending';
		void drop.then(
			() => { outcome = 'resolved'; },
			(error: unknown) => { outcome = (error as { code?: string }).code ?? 'unknown'; },
		);
		// 独占期间发起的只读请求同样按真实失败结束。
		const search = manager.request({ type: 'vector.search', payload: { queryVector: [1, 0], topK: 1 } });
		const searchRejected = expect(search).rejects.toMatchObject({ code: 'runtime-reset' });
		expect(dropStarted).toBe(true);
		manager.resetRuntime('索引运行时已重置');
		await searchRejected;
		await new Promise(resolve => setTimeout(resolve, 0));
		// 关键路径:已启动的独占操作必须让调用方的等待按真实失败结束,而不是永久 pending。
		expect(outcome).toBe('runtime-reset');
		expect(testClock.pendingCount()).toBe(0);
		// 关键路径:未结束的 dropIndex 仍持有写通道与独占门 —— 新写请求不得与它并行进入。
		const queuedWrite = manager.request({ type: 'index.delete', payload: { filePath: 'a.md' } });
		expect(worker.postMessage).not.toHaveBeenCalled();
		releaseDrop();
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(worker.postMessage).toHaveBeenCalledTimes(1);
		const writeId = (worker.postMessage.mock.calls[0]![0] as { _requestId: string })._requestId;
		worker._emit('message', { type: 'vector.delete.done', payload: { count: 1 }, _requestId: writeId });
		await expect(queuedWrite).resolves.toEqual({ type: 'vector.delete.done', payload: { count: 1 } });
		expect(outcome).toBe('runtime-reset');
		manager.destroy();
	});
});

describe('只读车道与提交窗口(T5)', () => {
	it('只读请求 - 长推理进行中 - 立即派发，不排在索引终态后面', async () => {
		const testClock = createTestClock();
		const worker = createMockWorker();
		const manager = new WorkerManager(worker as unknown as WorkerLike, { timeoutMs: 1000, clock: testClock.clock });
		const indexTask = manager.request({ type: 'index.full', payload: { files: [{ path: 'a.md', content: 'x' }] } });
		const search = manager.request({ type: 'vector.search', payload: { queryVector: [1, 0], topK: 2 } });
		// 关键路径:查询与索引同时派发(两条消息),不再等索引整轮结束。
		expect(worker.postMessage).toHaveBeenCalledTimes(2);
		const indexId = (worker.postMessage.mock.calls[0]![0] as { _requestId: string })._requestId;
		const searchId = (worker.postMessage.mock.calls[1]![0] as { _requestId: string })._requestId;
		worker._emit('message', { type: 'vector.search.result', payload: [], _requestId: searchId });
		await expect(search).resolves.toEqual({ type: 'vector.search.result', payload: [] });
		// 索引仍未结算。
		worker._emit('message', { type: 'index.done', payload: { indexed: 1, errors: 0 }, _requestId: indexId });
		await expect(indexTask).resolves.toEqual({ type: 'index.done', payload: { indexed: 1, errors: 0 } });
		manager.destroy();
	});

	it('只读请求 - 提交窗口内 - 提交完成本身关闭窗口，下一次提交开始再打开(建议2)', async () => {
		const testClock = createTestClock();
		const worker = createMockWorker();
		const manager = new WorkerManager(worker as unknown as WorkerLike, { timeoutMs: 1000, clock: testClock.clock });
		const indexTask = manager.request({ type: 'index.full', payload: { files: [] } }, { taskId: 'task-persist' });
		const indexId = (worker.postMessage.mock.calls[0]![0] as { _requestId: string })._requestId;
		// 提交开始(已完成 0 次)→ 窗口打开。
		worker._emit('message', { type: 'index.activity', payload: activity({ taskId: 'task-persist', requestId: indexId, sequence: 1, stage: 'persist', completedUnits: 0 }) });
		const search = manager.request({ type: 'vector.search', payload: { queryVector: [1, 0], topK: 1 } });
		expect(worker.postMessage).toHaveBeenCalledTimes(1);
		// 关键路径(建议2):提交完成(已完成 1 次)本身关窗 —— 不再依赖「下一条非 persist 活动」。
		worker._emit('message', { type: 'index.activity', payload: activity({ taskId: 'task-persist', requestId: indexId, sequence: 2, stage: 'persist', completedUnits: 1 }) });
		expect(worker.postMessage).toHaveBeenCalledTimes(2);
		const searchId = (worker.postMessage.mock.calls[1]![0] as { _requestId: string })._requestId;
		worker._emit('message', { type: 'vector.search.result', payload: [], _requestId: searchId });
		await expect(search).resolves.toEqual({ type: 'vector.search.result', payload: [] });
		// 下一次提交开始(完成数未增长)→ 窗口重新打开,查询再次排队。
		worker._emit('message', { type: 'index.activity', payload: activity({ taskId: 'task-persist', requestId: indexId, sequence: 3, stage: 'persist', completedUnits: 1 }) });
		const search2 = manager.request({ type: 'vector.search', payload: { queryVector: [1, 0], topK: 1 } });
		expect(worker.postMessage).toHaveBeenCalledTimes(2);
		worker._emit('message', { type: 'index.activity', payload: activity({ taskId: 'task-persist', requestId: indexId, sequence: 4, stage: 'persist', completedUnits: 2 }) });
		expect(worker.postMessage).toHaveBeenCalledTimes(3);
		const search2Id = (worker.postMessage.mock.calls[2]![0] as { _requestId: string })._requestId;
		worker._emit('message', { type: 'vector.search.result', payload: [], _requestId: search2Id });
		await expect(search2).resolves.toEqual({ type: 'vector.search.result', payload: [] });
		worker._emit('message', { type: 'index.done', payload: { indexed: 1, errors: 0 }, _requestId: indexId });
		await indexTask;
		manager.destroy();
	});

	it('只读请求 - 直接存储写事务在途 - 提交窗口打开，结算后关闭(B1)', async () => {
		const testClock = createTestClock();
		const worker = createMockWorker();
		const manager = new WorkerManager(worker as unknown as WorkerLike, { timeoutMs: 1000, clock: testClock.clock });
		// 关键路径(B1):`index.delete` 走多步写事务(不是 replaceFile),同样必须挡住只读车道。
		const deletion = manager.request({ type: 'index.delete', payload: { filePath: 'a.md' } });
		const deleteId = (worker.postMessage.mock.calls[0]![0] as { _requestId: string })._requestId;
		const search = manager.request({ type: 'vector.search', payload: { queryVector: [1, 0], topK: 1 } });
		expect(worker.postMessage).toHaveBeenCalledTimes(1);
		worker._emit('message', { type: 'vector.delete.done', payload: { count: 1 }, _requestId: deleteId });
		await expect(deletion).resolves.toEqual({ type: 'vector.delete.done', payload: { count: 1 } });
		// 窗口关闭 → 查询立即派发。
		expect(worker.postMessage).toHaveBeenCalledTimes(2);
		const searchId = (worker.postMessage.mock.calls[1]![0] as { _requestId: string })._requestId;
		worker._emit('message', { type: 'vector.search.result', payload: [], _requestId: searchId });
		await expect(search).resolves.toEqual({ type: 'vector.search.result', payload: [] });
		manager.destroy();
	});

	it('只读请求 - 调用方 signal 上不残留 abort 监听(I1)', async () => {
		const testClock = createTestClock();
		const worker = createMockWorker();
		const manager = new WorkerManager(worker as unknown as WorkerLike, { timeoutMs: 1000, clock: testClock.clock });
		const probe = createCountingSignal();
		const search = manager.request(
			{ type: 'vector.search', payload: { queryVector: [1, 0], topK: 1 } },
			{ signal: probe.signal },
		);
		// 派发那一刻:排队期的监听已摘除,只剩 pending 自己的一个。
		expect(probe.listenerCount()).toBe(1);
		const searchId = (worker.postMessage.mock.calls[0]![0] as { _requestId: string })._requestId;
		worker._emit('message', { type: 'vector.search.result', payload: [], _requestId: searchId });
		await expect(search).resolves.toEqual({ type: 'vector.search.result', payload: [] });
		expect(probe.listenerCount()).toBe(0);

		// 排队期取消同样不残留监听。
		const queuedProbe = createCountingSignal();
		const indexTask = manager.request({ type: 'index.full', payload: { files: [] } }, { taskId: 'task-queued-signal' });
		const indexId = (worker.postMessage.mock.calls[1]![0] as { _requestId: string })._requestId;
		worker._emit('message', { type: 'index.activity', payload: activity({ taskId: 'task-queued-signal', requestId: indexId, sequence: 1, stage: 'persist', completedUnits: 0 }) });
		const queued = manager.request(
			{ type: 'vector.search', payload: { queryVector: [1, 0], topK: 1 } },
			{ signal: queuedProbe.signal },
		);
		const queuedRejected = expect(queued).rejects.toMatchObject({ code: 'index-cancelled' });
		expect(queuedProbe.listenerCount()).toBe(1);
		queuedProbe.abort();
		await queuedRejected;
		expect(queuedProbe.listenerCount()).toBe(0);
		worker._emit('message', { type: 'index.done', payload: { indexed: 1, errors: 0 }, _requestId: indexId });
		await indexTask;
		manager.destroy();
	});

	it('普通查询 - 超过上限仍无响应 - 按超时 reject 且不设置停滞', async () => {
		const testClock = createTestClock();
		const worker = createMockWorker();
		const manager = new WorkerManager(worker as unknown as WorkerLike, { timeoutMs: 1000, clock: testClock.clock });
		const search = manager.request({ type: 'vector.search', payload: { queryVector: [1, 0], topK: 1 } });
		const rejected = expect(search).rejects.toMatchObject({ code: 'request-timeout' });
		testClock.advance(1000);
		await rejected;
		// 关键路径:新设计不得把所有请求都改成无限等待,也不把查询超时当成索引停滞。
		expect(manager.isStalled()).toBe(false);
		await expect(manager.runExclusive(async () => 'ok')).resolves.toBe('ok');
		expect(testClock.pendingCount()).toBe(0);
		manager.destroy();
	});

	it('只读请求 - 提交窗口内长时间排队 - 排队等待同样有界', async () => {
		const testClock = createTestClock();
		const worker = createMockWorker();
		const manager = new WorkerManager(worker as unknown as WorkerLike, { timeoutMs: 1000, clock: testClock.clock });
		const indexTask = manager.request({ type: 'index.full', payload: { files: [] } }, { taskId: 'task-blocked' });
		// 关键路径:索引任务自身也会因无进展被判定停滞,其失败同样要被观察。
		const indexRejected = expect(indexTask).rejects.toMatchObject({ code: 'index-stalled' });
		const indexId = (worker.postMessage.mock.calls[0]![0] as { _requestId: string })._requestId;
		worker._emit('message', { type: 'index.activity', payload: activity({ taskId: 'task-blocked', requestId: indexId, sequence: 1, stage: 'persist', completedUnits: 0 }) });
		const search = manager.request({ type: 'vector.search', payload: { queryVector: [1, 0], topK: 1 } });
		const rejected = expect(search).rejects.toMatchObject({ code: 'request-timeout' });
		testClock.advance(1000);
		await Promise.all([rejected, indexRejected]);
		expect(worker.postMessage).toHaveBeenCalledTimes(1);
		manager.destroy();
	});
});

describe('卸载与实例接管(T5)', () => {
	it('卸载期间推理迟到 + 磁盘仍在提交 + 新实例立即启动 - 旧回调失效且提交不重叠', async () => {
		const testClock = createTestClock();
		const root = `/tmp/ratel-t5-handoff-${Date.now()}`;
		const coordinator = getWriteOwnerCoordinator(root);
		const oldLease = await coordinator.acquire({ instanceToken: 'old-instance', clock: testClock.clock });
		// 旧实例:磁盘提交仍在进行(在途提交已登记)。
		const commitTicket = oldLease.beginCommit();
		const oldWorker = createMockWorker();
		const oldProgress = vi.fn();
		const oldActivity = vi.fn();
		const oldStall = vi.fn();
		const oldResume = vi.fn();
		const lateTerminal: unknown[] = [];
		const oldManager = new WorkerManager(oldWorker as unknown as WorkerLike, {
			timeoutMs: 1000,
			clock: testClock.clock,
			onProgress: oldProgress,
			onActivity: oldActivity,
			onStall: oldStall,
			onResume: oldResume,
		});
		const oldTask = oldManager.request(
			{ type: 'index.full', payload: { files: [] } },
			{ taskId: 'old-task', epoch: oldLease.epoch, onLateTerminal: response => lateTerminal.push(response) },
		);
		const oldRejected = expect(oldTask).rejects.toMatchObject({ code: 'index-stalled' });
		const oldRequestId = (oldWorker.postMessage.mock.calls[0]![0] as { _requestId: string })._requestId;
		testClock.advance(1000);
		await oldRejected;
		expect(oldStall).toHaveBeenCalledTimes(1);

		// 卸载旧实例:销毁写通道,旧 epoch 立即撤销。
		oldManager.destroy();
		await expect(oldManager.request({ type: 'index.status', payload: {} })).rejects.toThrow('destroyed');
		await oldLease.release();
		const stallCallsAtUnload = oldStall.mock.calls.length;

		// 磁盘仍在提交 → 新实例立即启动只报占用,不与旧提交重叠。
		const takeover = coordinator.acquire({ instanceToken: 'new-instance', clock: testClock.clock, closeTimeoutMs: 1000 });
		const takeoverRejected = expect(takeover).rejects.toMatchObject({ code: 'predecessor-not-closed' });
		testClock.advance(1000);
		await takeoverRejected;

		// 旧实例事件(迟到活动、进度、终态)不得更新任何状态或回调。
		oldWorker._emit('message', { type: 'index.activity', payload: activity({ taskId: 'old-task', requestId: oldRequestId, epoch: oldLease.epoch, sequence: 1, stage: 'persist', completedUnits: 1 }) });
		oldWorker._emit('message', { type: 'index.progress', payload: { done: 1, total: 1 }, _requestId: oldRequestId });
		oldWorker._emit('message', { type: 'index.done', payload: { indexed: 9, errors: 0 }, _requestId: oldRequestId });
		expect(oldProgress).not.toHaveBeenCalled();
		expect(oldActivity).not.toHaveBeenCalled();
		expect(oldResume).not.toHaveBeenCalled();
		expect(oldStall.mock.calls.length).toBe(stallCallsAtUnload);
		expect(lateTerminal).toHaveLength(0);

		// 旧提交结算后才放行新实例;新 epoch 严格更大,旧租约已不可写。
		commitTicket.settle();
		const newLease = await coordinator.acquire({ instanceToken: 'new-instance', clock: testClock.clock, closeTimeoutMs: 1000 });
		expect(newLease.epoch).toBeGreaterThan(oldLease.epoch);
		expect(oldLease.isActive()).toBe(false);
		expect(() => oldLease.assertWritable()).toThrow();
		await newLease.release();
	});
});

describe('协调器停滞看护(T5)', () => {
	it('协调器 - 事件持续到达但无真实完成 - 判定停滞并在有效活动后恢复处理中', () => {
		const coordinator = new IndexTaskCoordinator({
			vault: {
				listMarkdownFiles: () => ['a.md'],
				readFile: async () => 'body',
				stat: () => ({ mtime: 1, size: 4 }),
			},
			journal: {
				prepare: async () => ({ transactionId: 'tx-1' }),
				commit: async () => ({ commit: { revision: 1, inputHash: null, chunkCount: 0 }, superseded: false }),
				cleanup: async () => undefined,
				readReceipt: async () => null,
			},
			processor: { prepareBlocks: async (input) => [{ id: `${input.path}#chunk-0`, vector: [1, 0], metadata: { path: input.path } }] },
			getConfigFingerprint: () => 'c'.repeat(64),
			autoDrain: false,
		});
		// 关键路径:事件持续到达(序号单调增长)但不消费、也无真实完成 → 进展代数不动。
		for (let i = 0; i < 50; i += 1) coordinator.notify('a.md', 'upsert');
		expect(coordinator.progressMark()).toBe(0);

		const testClock = createTestClock();
		const stalls: unknown[] = [];
		const resumes: unknown[] = [];
		const watchdog = new IndexStallWatchdog({
			source: coordinator,
			stallAfterMs: 500,
			clock: testClock.clock,
			onStall: info => stalls.push(info),
			onResume: info => resumes.push(info),
		});
		watchdog.start();
		testClock.advance(500);
		expect(watchdog.isStalled()).toBe(true);
		expect(coordinator.isStalled()).toBe(true);
		expect(coordinator.counters().phase).toBe('stalled');
		// 任务与队列继续被持有,终态判据仍是 canMarkReady(未变)。
		expect(coordinator.counters().queued).toBeGreaterThan(0);
		expect(canMarkReady(coordinator.counters())).toBe(false);
		expect(stalls).toHaveLength(1);

		// 更多事件不恢复停滞。
		for (let i = 0; i < 10; i += 1) coordinator.notify('a.md', 'upsert');
		testClock.advance(500);
		expect(coordinator.isStalled()).toBe(true);

		// 迟到有效活动 → 恢复处理中。
		expect(coordinator.observeActivity({ taskId: 'task-1', requestId: 'req-1', epoch: 0, sequence: 1, stage: 'embed', completedUnits: 4 })).toBe(true);
		testClock.advance(500);
		expect(coordinator.isStalled()).toBe(false);
		expect(coordinator.progressMark()).toBeGreaterThan(0);
		expect(resumes).toHaveLength(1);
		expect(coordinator.lastActivity()?.stage).toBe('embed');
		watchdog.stop();
		expect(testClock.pendingCount()).toBe(0);
	});

	it('协调器 - 过期重排后真实提交 - 有效进展推进且终态可达', async () => {
		let reads = 0;
		const commits: number[] = [];
		let committedReceipt: {
			schemaVersion: 2;
			generationId: string;
			path: string;
			configFingerprint: string;
			commitId: string;
			revision: number;
			chunkCount: number;
			blockSetHash: string;
			state: 'present';
			inputHash: string;
		} | null = null;
		const coordinator = new IndexTaskCoordinator({
			vault: {
				listMarkdownFiles: () => ['a.md'],
				// 前三次读取内容都不同(推理后核对必然过期),之后稳定 → 真实提交。
				readFile: async () => {
					reads += 1;
					return reads <= 3 ? `body-${reads}` : 'body-final';
				},
				stat: () => ({ mtime: 1, size: 4 }),
			},
			journal: {
				prepare: async () => ({ transactionId: `tx-${commits.length + 1}` }),
				commit: async () => {
					commits.push(1);
					committedReceipt = {
						schemaVersion: 2,
						generationId: 'gen-t5',
						path: 'a.md',
						configFingerprint: 'c'.repeat(64),
						commitId: 'commit-1',
						revision: 1,
						chunkCount: 1,
						blockSetHash: 'b'.repeat(64),
						state: 'present',
						inputHash: 'f'.repeat(64),
					};
					return { commit: { revision: 1, inputHash: 'f'.repeat(64), chunkCount: 1 }, superseded: false };
				},
				cleanup: async () => undefined,
				readReceipt: async () => committedReceipt,
			},
			processor: { prepareBlocks: async (input) => [{ id: `${input.path}#chunk-0`, vector: [1, 0], metadata: { path: input.path } }] },
			getConfigFingerprint: () => 'c'.repeat(64),
		});
		const counters = await coordinator.start();
		// 关键路径:过期重排不消耗重试预算、不推进有效进展;真实提交后才推进并收敛。
		expect(coordinator.expiredRequeues()).toBeGreaterThan(0);
		expect(coordinator.progressMark()).toBeGreaterThan(0);
		expect(counters.phase).toBe('ready');
		expect(canMarkReady(counters)).toBe(true);
		expect(coordinator.isStalled()).toBe(false);
	});

	it('协调器取消 - 先撤销在途可取消调用、再停止调度新文件(I6)', async () => {
		const order: string[] = [];
		let prepareCalls = 0;
		let coordinator!: IndexTaskCoordinator;
		coordinator = new IndexTaskCoordinator({
			vault: {
				listMarkdownFiles: () => ['a.md', 'b.md'],
				readFile: async () => 'body',
				stat: () => ({ mtime: 1, size: 4 }),
			},
			journal: {
				prepare: async () => ({ transactionId: 'tx-cancel' }),
				commit: async () => ({ commit: { revision: 1, inputHash: 'f'.repeat(64), chunkCount: 1 }, superseded: false }),
				cleanup: async () => undefined,
				readReceipt: async () => null,
			},
			processor: {
				prepareBlocks: async (input, options) => {
					prepareCalls += 1;
					order.push(`prepare:${input.path}`);
					if (prepareCalls === 1) {
						// 首次准备故意挂起,只接受取消信号 —— 用它观察「撤销」与「停止调度」的先后。
						await new Promise<never>((_resolve, reject) => {
							options?.signal?.addEventListener('abort', () => {
								// 关键路径(I6):撤销这一刻必须还没进入「停止调度新文件」状态。
								order.push(`abort:first:paused=${String(coordinator.isPaused())}`);
								reject(createEmbedAbortError());
							});
						});
					}
					return [{ id: `${input.path}#chunk-0`, vector: [1, 0], metadata: { path: input.path } }];
				},
			},
			getConfigFingerprint: () => 'c'.repeat(64),
			autoDrain: false,
		});
		const start = coordinator.start();
		await vi.waitFor(() => expect(order).toContain('prepare:a.md'));
		coordinator.abortActive('用例取消');
		// 关键路径(I6):撤销在途可取消调用发生在 `abortActive` 返回之前,且此刻尚未停止调度。
		expect(order).toEqual(['prepare:a.md', 'abort:first:paused=false']);
		expect(coordinator.isPaused()).toBe(true);
		expect(coordinator.counters().phase).toBe('stopping');
		await start;
		// 「再停止调度新文件」:取消后没有任何新文件进入准备阶段。
		expect(order.filter(entry => entry.startsWith('prepare:'))).toEqual(['prepare:a.md']);
		// 正向对照:恢复后 b.md 才会被调度 —— 证明「未调度」不是因为没有待处理项。
		coordinator.resume();
		await coordinator.drain();
		expect(order).toContain('prepare:b.md');
		coordinator.destroy();
	});
});
