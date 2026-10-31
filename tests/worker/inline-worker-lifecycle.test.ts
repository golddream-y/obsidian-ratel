/**
 * @file tests/worker/inline-worker-lifecycle.test.ts
 * @description 直接消息入口串行化与异常恢复
 * @module tests/worker/inline-worker-lifecycle
 * @depends worker/inline-worker, worker/handler
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { WorkerResponse } from '../../src/types';
import { InlineWorker } from '../../src/worker/inline-worker';
import { IndexProcessor } from '../../src/worker/index-processor';
import { setProcessorForTest } from '../../src/worker/handler';
import type { VectraStore } from '../../src/adapters/vector-vectra';
describe('InlineWorker 串行入口', () => {
	afterEach(() => setProcessorForTest(null));
	it('异步消息 - 全量未结束时收到下一条 - 每文件单次事务写入且进度关联原请求', async () => {
		let releaseEmbed!: () => void;
		let releaseWrite!: () => void;
		// 关键路径(新存储契约):`reembedFile` 走 `replaceFile` 一个事务完成删除 + 插入,
		// 因此「写入」的观测点从旧的 beginFileUpdate/endFileUpdate 挪到 replaceFile。
		let writesInFlight = 0;
		let maxWritesInFlight = 0;
		const replaceCalls: string[] = [];
		const order: string[] = [];
		const processor = new IndexProcessor({
			replaceFile: async (input: { path: string }) => {
				replaceCalls.push(input.path);
				writesInFlight++;
				maxWritesInFlight = Math.max(maxWritesInFlight, writesInFlight);
				// 关键路径:首个文件的提交故意挂起,若入口未串行,第二条消息的提交会并发进入。
				if (replaceCalls.length === 1) await new Promise<void>(resolve => { releaseWrite = resolve; });
				writesInFlight--;
			},
			isReloadRequired: () => false,
			reload: async () => undefined,
		} as unknown as VectraStore, {
			modelId: 'test', dimensions: 3,
			embed: async (texts) => { order.push(texts[0]!); if (order.length === 1)
				await new Promise<void>(r => { releaseEmbed = r; }); return texts.map(() => [1, 0, 0]); },
		}, { maxTokens: 100, overlapTokens: 0, count: text => text.length });
		setProcessorForTest(processor);
		const worker = new InlineWorker();
		const messages: Array<{
			type: string;
			_requestId?: string;
		}> = [];
		worker.on('message', (message: WorkerResponse & {
			_requestId?: string;
		}) => messages.push(message));
		try {
			worker.postMessage({ type: 'index.full', payload: { files: [{ path: 'a.md', content: 'first' }] }, _requestId: 'first' });
			worker.postMessage({ type: 'index.full', payload: { files: [{ path: 'b.md', content: 'second' }] }, _requestId: 'second' });
			await vi.waitFor(() => expect(order).toHaveLength(1));
			releaseEmbed();
			await vi.waitFor(() => expect(replaceCalls).toHaveLength(1));
			// 关键路径:第一个文件的提交仍挂起时,第二条消息不得并发进入写入路径。
			expect(maxWritesInFlight).toBe(1);
			releaseWrite();
			await vi.waitFor(() => expect(messages.filter(message => message.type === 'index.done')).toHaveLength(2));
			// 关键路径:每个文件恰好一次事务写入,顺序与请求顺序一致。
			expect(replaceCalls).toEqual(['a.md', 'b.md']);
			expect(maxWritesInFlight).toBe(1);
			expect(messages.filter(message => message.type === 'index.progress').map(message => message._requestId)).toEqual(['first', 'second']);
		}
		finally {
			worker.terminate();
		}
	});
});
