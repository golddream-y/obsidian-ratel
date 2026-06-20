/**
 * @file tests/worker/inline-worker.test.ts
 * @description InlineWorker 单元测试 — 未初始化守卫、消息转发、错误回调
 * @module tests/worker/inline-worker
 * @depends worker/inline-worker, adapters/vector-vectra
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InlineWorker } from '../../src/worker/inline-worker';
import { VectraStore } from '../../src/adapters/vector-vectra';
import type { EmbeddingsModel, EmbeddingsResponse } from 'vectra';
import path from 'path';
import fs from 'fs';

const TMP_DIR = path.join(__dirname, '../tmp/inline-worker-test');

const stubEmbedder: EmbeddingsModel = {
	maxTokens: 8192,
	async createEmbeddings(inputs: string | string[]): Promise<EmbeddingsResponse> {
		const arr = Array.isArray(inputs) ? inputs : [inputs];
		return {
			status: 'success',
			output: arr.map(() => Array(512).fill(0).map(() => Math.random())),
		};
	},
};

describe('InlineWorker', () => {
	beforeEach(() => {
		if (fs.existsSync(TMP_DIR)) fs.rmSync(TMP_DIR, { recursive: true });
		fs.mkdirSync(TMP_DIR, { recursive: true });
	});

	afterEach(async () => {
		// 关键路径:vectra 内部 catalog.json 写入是异步的,等写入完成再删目录,
		// 否则会出现 ENOENT unhandled rejection。
		await new Promise((resolve) => setTimeout(resolve, 200));
		if (fs.existsSync(TMP_DIR)) fs.rmSync(TMP_DIR, { recursive: true });
	});

	it('未 initWithStore - index.status 返回 NULL_PROCESSOR 错误', async () => {
		const worker = new InlineWorker();
		const responses: unknown[] = [];

		await new Promise<void>((resolve) => {
			worker.on('message', (data) => {
				responses.push(data);
				resolve();
			});
			worker.postMessage({ type: 'index.status', payload: {}, _requestId: 'r1' });
		});

		expect(responses).toHaveLength(1);
		const res = responses[0] as { type: string; payload: { code: string } };
		expect(res.type).toBe('error');
		expect(res.payload.code).toBe('NULL_PROCESSOR');
	});

	it('initWithStore - index.full 能异步返回 indexed 计数', async () => {
		const worker = new InlineWorker();
		const store = new VectraStore(TMP_DIR, { embeddings: stubEmbedder, autoInit: true });
		await store.init();
		worker.initWithStore(store);

		const responses: unknown[] = [];
		await new Promise<void>((resolve) => {
			worker.on('message', (data) => {
				responses.push(data);
				resolve();
			});
			worker.postMessage({
				type: 'index.full',
				payload: { files: [{ path: 'inline.md', content: 'Inline worker test' }] },
				_requestId: 'r2',
			});
		});

		expect(responses).toHaveLength(1);
		const res = responses[0] as { type: string; payload: { indexed: number } };
		expect(res.type).toBe('index.done');
		expect(res.payload.indexed).toBe(1);
	});

	it('terminate - 不再响应后续消息', async () => {
		const worker = new InlineWorker();
		const store = new VectraStore(TMP_DIR, { embeddings: stubEmbedder, autoInit: true });
		await store.init();
		worker.initWithStore(store);
		worker.terminate();

		const responses: unknown[] = [];
		let resolved = false;
		worker.on('message', (data) => {
			responses.push(data);
		});
		worker.postMessage({ type: 'index.status', payload: {}, _requestId: 'r3' });

		// 等待一个事件循环,确认没有消息被触发。
		await new Promise<void>((resolve) => {
			setTimeout(() => {
				resolved = true;
				resolve();
			}, 50);
		});

		expect(resolved).toBe(true);
		expect(responses).toHaveLength(0);
	});
});
