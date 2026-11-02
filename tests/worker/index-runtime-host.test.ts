/**
 * @file tests/worker/index-runtime-host.test.ts
 * @description 索引运行时宿主 — 生命周期、请求结算、超时取消与退出收敛
 * @module tests/worker/index-runtime-host
 *
 * 关键路径:
 * - 用假 Worker 精确控制消息时序,断言的是**结算次数与配额归还**,不是「看起来没报错」。
 * - 超时/取消只结束调用方等待,配额必须等 cancel-ack 或真实终态;无终态才计数强制回收。
 * - Worker 退出后 pending 必须全部失败且只失败一次,旧 epoch 的迟到响应不得污染新运行时。
 */

import { describe, expect, it, vi } from 'vitest';
import { IndexRuntimeHost, IndexRuntimeHostError, type RuntimeWorkerLike } from '../../src/worker/index-runtime-host';
import { INDEX_RUNTIME_PROTOCOL_VERSION } from '../../src/worker/index-runtime-protocol';

/** 可注入的假 Worker。 */
class FakeWorker implements RuntimeWorkerLike {
	posted: unknown[] = [];
	terminated = false;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: ((event: { message?: string }) => void) | null = null;

	postMessage(message: unknown): void {
		this.posted.push(message);
	}

	terminate(): Promise<void> {
		this.terminated = true;
		return Promise.resolve();
	}

	/** 模拟 Worker 回报响应。 */
	reply(requestId: string, ok: boolean, result?: unknown, epoch = 1): void {
		this.onmessage?.({
			data: {
				kind: 'response',
				protocolVersion: INDEX_RUNTIME_PROTOCOL_VERSION,
				runtimeId: 'rt-test',
				epoch,
				requestId,
				ok,
				result,
			},
		});
	}

	/** 模拟 Worker 崩溃。 */
	crash(message = 'boom'): void {
		this.onerror?.({ message });
	}
}

/** 建一个使用假 Worker 的宿主。 */
function makeHost(options: { timeoutMs?: number; maxInflight?: number; maxBytes?: number } = {}): {
	host: IndexRuntimeHost;
	worker: FakeWorker;
} {
	const worker = new FakeWorker();
	const host = new IndexRuntimeHost({
		createWorker: () => worker,
		runtimeId: 'rt-test',
		requestTimeoutMs: options.timeoutMs ?? 1000,
		maxInflight: options.maxInflight,
		maxInflightBytes: options.maxBytes,
	});
	return { host, worker };
}

/** 取最后一条请求的 requestId。 */
function lastRequestId(worker: FakeWorker): string {
	const messages = worker.posted.filter((m) => (m as { kind?: string }).kind === 'request');
	const last = messages[messages.length - 1] as { requestId?: string } | undefined;
	return last?.requestId ?? '';
}

describe('索引运行时宿主', () => {
	it('未启动 - 请求直接拒绝 - 不产生悬挂 Promise', async () => {
		const { host } = makeHost();
		await expect(host.request('ping')).rejects.toMatchObject({ code: 'not-started' });
	});

	it('启动 - epoch 从 1 开始 - 重复启动不重置', () => {
		const { host } = makeHost();
		expect(host.start()).toBe(1);
		expect(host.start()).toBe(1);
		expect(host.running).toBe(true);
	});

	it('请求/响应 - 正常结算 - 在途配额归还', async () => {
		const { host, worker } = makeHost();
		host.start();
		const pending = host.request<{ value: number }>('read', { path: 'a.md' });
		expect(host.inflight).toBe(1);
		worker.reply(lastRequestId(worker), true, { value: 42 });
		await expect(pending).resolves.toEqual({ value: 42 });
		expect(host.inflight).toBe(0);
		expect(host.inflightPayloadBytes).toBe(0);
	});

	it('重复响应 - 只结算一次 - 不重复归还配额', async () => {
		const { host, worker } = makeHost();
		host.start();
		const pending = host.request('read');
		const id = lastRequestId(worker);
		worker.reply(id, true, 1);
		worker.reply(id, true, 2);
		await expect(pending).resolves.toBe(1);
		expect(host.inflight).toBe(0);
		expect(host.inflightPayloadBytes).toBe(0);
	});

	it('未知请求或旧 epoch 响应 - 忽略 - 不异常', async () => {
		const { host, worker } = makeHost();
		host.start();
		const pending = host.request('read');
		worker.reply('req-unknown', true, 1);
		worker.reply(lastRequestId(worker), true, 3, 99);
		expect(host.inflight).toBe(1);
		worker.reply(lastRequestId(worker), true, 4);
		await expect(pending).resolves.toBe(4);
	});

	it('超时 - 拒绝并发出取消 - 迟到响应不二次结算', async () => {
		vi.useFakeTimers();
		try {
			const { host, worker } = makeHost({ timeoutMs: 100 });
			host.start();
			const pending = host.request('read');
			const id = lastRequestId(worker);
			vi.advanceTimersByTime(100);
			await expect(pending).rejects.toMatchObject({ code: 'timeout' });
			const controls = worker.posted.filter((m) => (m as { kind?: string }).kind === 'control');
			expect(controls).toHaveLength(1);
			expect((controls[0] as { control: string }).control).toBe('cancel');
			// 迟到响应:调用方已结算,不抛异常,配额在终态后归还。
			worker.reply(id, true, 1);
			expect(host.inflight).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('取消 - 立即拒绝 - 收到 cancel-ack 后归还配额', async () => {
		const { host, worker } = makeHost();
		host.start();
		const controller = new AbortController();
		const pending = host.request('read', undefined, controller.signal);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: 'aborted' });
		// 关键路径:取消不提前归还配额,避免取消风暴扩大在途。
		expect(host.inflight).toBe(1);
		worker.onmessage?.({
			data: {
				kind: 'control',
				protocolVersion: INDEX_RUNTIME_PROTOCOL_VERSION,
				runtimeId: 'rt-test',
				epoch: 1,
				control: 'cancel-ack',
				requestId: lastRequestId(worker),
			},
		});
		expect(host.inflight).toBe(0);
	});

	it('Worker 崩溃 - 在途全部失败一次 - 不自动重启', async () => {
		const { host, worker } = makeHost();
		host.start();
		const first = host.request('read');
		const second = host.request('read');
		worker.crash('v8 oom');
		await expect(first).rejects.toBeInstanceOf(IndexRuntimeHostError);
		await expect(second).rejects.toBeInstanceOf(IndexRuntimeHostError);
		expect(host.inflight).toBe(0);
		expect(host.running).toBe(false);
	});

	it('退出后重启 - epoch 递增 - 旧 epoch 响应被忽略', async () => {
		const workers: FakeWorker[] = [];
		const host = new IndexRuntimeHost({
			createWorker: () => {
				const worker = new FakeWorker();
				workers.push(worker);
				return worker;
			},
			runtimeId: 'rt-test',
			requestTimeoutMs: 1000,
		});
		host.start();
		workers[0]!.crash();
		expect(host.start()).toBe(2);
		const pending = host.request('read');
		workers[1]!.reply(lastRequestId(workers[1]!), true, 'new', 1);
		expect(host.inflight).toBe(1);
		workers[1]!.reply(lastRequestId(workers[1]!), true, 'ok', 2);
		await expect(pending).resolves.toBe('ok');
	});

	it('在途上限 - 超出即拒绝 - 不排队占内存', async () => {
		const { host } = makeHost({ maxInflight: 1 });
		host.start();
		void host.request('read');
		await expect(host.request('read')).rejects.toMatchObject({ code: 'over-budget' });
	});

	it('载荷预算 - 超预算请求在发送前拒绝', async () => {
		const { host, worker } = makeHost({ maxBytes: 100 });
		host.start();
		await expect(host.request('write', { text: 'x'.repeat(1000) })).rejects.toMatchObject({ code: 'over-budget' });
		expect(worker.posted).toHaveLength(0);
	});

	it('停止 - 先撤销再终止 - 在途以 stopped 失败', async () => {
		const { host, worker } = makeHost();
		host.start();
		const pending = host.request('read');
		await host.stop('user');
		await expect(pending).rejects.toMatchObject({ code: 'stopped' });
		expect(worker.terminated).toBe(true);
		const controls = worker.posted.filter((m) => (m as { kind?: string }).kind === 'control');
		expect((controls[0] as { control: string }).control).toBe('revoke');
		expect(host.running).toBe(false);
	});
});

describe('宿主应答反向调用', () => {
	it('Worker 请求嵌入 - 宿主处理并回结果 - 失败如实回错误', async () => {
		const worker = new FakeWorker();
		const host = new IndexRuntimeHost({
			createWorker: () => worker,
			runtimeId: 'rt-test',
			requestTimeoutMs: 1000,
			onCall: async (method, payload) => {
				if (method === 'embed') return [[0.1], [0.2]];
				throw new Error(`未知宿主方法 ${method}`);
			},
		});
		host.start();
		worker.onmessage?.({
			data: {
				kind: 'call',
				protocolVersion: INDEX_RUNTIME_PROTOCOL_VERSION,
				runtimeId: 'rt-test',
				epoch: 1,
				callId: 'c1',
				method: 'embed',
				payload: { texts: ['a', 'b'] },
			},
		});
		await vi.waitFor(() => expect(worker.posted.some((m) => (m as { kind?: string }).kind === 'call-result')).toBe(true));
		const okResult = worker.posted.find((m) => (m as { callId?: string }).callId === 'c1') as { ok: boolean; result: unknown };
		expect(okResult).toMatchObject({ ok: true, result: [[0.1], [0.2]] });

		worker.onmessage?.({
			data: {
				kind: 'call',
				protocolVersion: INDEX_RUNTIME_PROTOCOL_VERSION,
				runtimeId: 'rt-test',
				epoch: 1,
				callId: 'c2',
				method: 'unknown',
			},
		});
		await vi.waitFor(() => expect(worker.posted.some((m) => (m as { callId?: string }).callId === 'c2')).toBe(true));
		expect(worker.posted.find((m) => (m as { callId?: string }).callId === 'c2')).toMatchObject({ ok: false });
	});
});
