/**
 * @file tests/adapters/worker-lifecycle-reason.test.ts
 * @description Worker 生命周期 — crash 必须携带可区分的原因
 * @module tests/adapters/worker-lifecycle-reason
 */

import { describe, expect, it, vi } from 'vitest';
import { EmbeddingWorkerProxy } from '../../src/adapters/embedding-worker-proxy';

/** 造一个收下消息但永不回应的 Worker 替身。 */
function makeSilentWorker(): Worker {
	return {
		postMessage: vi.fn(),
		terminate: vi.fn(),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	} as unknown as Worker;
}

describe('Worker 生命周期原因', () => {
	it('请求超时被重建 - crash 回调携带可区分的原因而不是只有一个枚举', async () => {
		// 关键路径:三种故障都叫 crash（请求超时 / worker 抛错 / init 失败）。
		// 只记枚举时现场日志只有 worker.crash 四个字，无法定位；
		// 这里用极短超时走真实分支，锁住「原因必须透传」这条契约。
		const lifecycle: Array<{ kind: string; reason?: string }> = [];
		const proxy = new EmbeddingWorkerProxy(
			'blob:test',
			{
				vocabContent: 'a\n',
				modelBuffer: new ArrayBuffer(8),
				wasmBinary: new ArrayBuffer(8),
				modelId: 'local:test',
			},
			2,
			8,
			(kind, reason) => lifecycle.push({ kind, reason }),
			'classic',
			makeSilentWorker(),
			20,
		);
		await expect(proxy.embed(['工程化'])).rejects.toThrow(/超时/);
		const crash = lifecycle.find((item) => item.kind === 'crash');
		expect(crash).toBeDefined();
		expect(crash?.reason).toContain('超时');
		// 诊断字段必须含批量信息，否则「批量过大」与「GPU 卡死」区分不开。
		expect(crash?.reason).toContain('批量=1');
	});
});

describe('GPU 设备丢失', () => {
	it('收到 gpu:lost - 立即按 crash 重建并带出设备原因', async () => {
		// 关键路径:设备丢失后推理不会抛错、只是永不返回；
		// 若不做这条通道，用户要等到 120 秒超时才看到失败。
		const lifecycle: Array<{ kind: string; reason?: string }> = [];
		const listeners: Array<(event: MessageEvent) => void> = [];
		const worker = {
			postMessage: vi.fn(),
			terminate: vi.fn(),
			addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
				if (type === 'message') listeners.push(listener);
			},
			removeEventListener: vi.fn(),
		} as unknown as Worker;
		const proxy = new EmbeddingWorkerProxy(
			'blob:test',
			{
				vocabContent: 'a\n',
				modelBuffer: new ArrayBuffer(8),
				wasmBinary: new ArrayBuffer(8),
				modelId: 'local:test',
			},
			2,
			8,
			(kind, reason) => lifecycle.push({ kind, reason }),
			'classic',
			worker,
		);
		// 预热实例在首次使用时才挂监听，先发一次请求触发 attach。
		const pending = proxy.embed(['工程化']).then(
			() => new Error('应当被拒绝'),
			(error: Error) => error,
		);
		await new Promise((resolve) => setTimeout(resolve, 5));
		for (const listener of listeners) {
			listener({ data: { type: 'gpu:lost', reason: 'destroyed:device removed' } } as MessageEvent);
		}
		const settled = await pending;
		expect(settled.message).toContain('GPU 设备丢失');
		const crash = lifecycle.find((item) => item.kind === 'crash');
		expect(crash?.reason).toContain('GPU 设备丢失');
		expect(crash?.reason).toContain('device removed');
	});
});
