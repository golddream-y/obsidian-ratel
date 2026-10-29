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
	it('异步消息 - 全量未结束时收到下一条 - 单次写入且进度关联原请求', async () => {
		let release!: () => void;
		let writes = 0;
		let maxWrites = 0;
		const order: string[] = [];
		const processor = new IndexProcessor({
			deleteByPath: async () => 0,
			beginFileUpdate: async () => { writes++; maxWrites = Math.max(maxWrites, writes); },
			upsertItem: async () => undefined,
			endFileUpdate: async () => { writes--; },
		} as unknown as VectraStore, {
			modelId: 'test', dimensions: 3,
			embed: async (texts) => { order.push(texts[0]!); if (order.length === 1)
				await new Promise<void>(r => { release = r; }); return texts.map(() => [1, 0, 0]); },
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
			release();
			await vi.waitFor(() => expect(messages.filter(message => message.type === 'index.done')).toHaveLength(2));
			expect(maxWrites).toBe(1);
			expect(messages.filter(message => message.type === 'index.progress').map(message => message._requestId)).toEqual(['first', 'second']);
		}
		finally {
			worker.terminate();
		}
	});
});
