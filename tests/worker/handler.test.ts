/**
 * @file tests/worker/handler.test.ts
 * @description handleMessage 单元测试 — 已知 type 路由、未知 type 返回 UNKNOWN_REQUEST
 * @module tests/worker/handler
 * @depends worker/handler
 */

import { describe, it, expect } from 'vitest';
import { handleMessage } from '../../src/worker/handler';
import type { WorkerRequest } from '../../src/types';

describe('handleMessage', () => {
	it('index.status 返回占位成功响应', async () => {
		const response = await handleMessage({
			type: 'index.status',
			payload: {},
		});
		expect(response.type).toBe('index.status.result');
		expect(response.payload).toEqual({ totalDocs: 0, lastIndexTime: 0 });
	});

	it('未实现的 type(index.full)返回 NOT_IMPLEMENTED', async () => {
		const response = await handleMessage({
			type: 'index.full',
			payload: { vaultPath: '/test' },
		});
		expect(response.type).toBe('error');
		expect(response.payload).toEqual({
			code: 'NOT_IMPLEMENTED',
			message: 'index.full will be implemented in W2',
		});
	});

	it('未实现的 type(vector.search)返回 NOT_IMPLEMENTED', async () => {
		const response = await handleMessage({
			type: 'vector.search',
			payload: { vector: [0.1, 0.2, 0.3], topK: 5 },
		});
		expect(response.type).toBe('error');
		expect((response.payload as { code: string }).code).toBe('NOT_IMPLEMENTED');
	});

	it('未知 type 返回 UNKNOWN_REQUEST 结构化错误', async () => {
		// 关键路径:故意构造一个不存在的 type
		const bogus = { type: 'foo.bar', payload: {} } as unknown as WorkerRequest;
		const response = await handleMessage(bogus);
		expect(response.type).toBe('error');
		expect(response.payload).toEqual({
			code: 'UNKNOWN_REQUEST',
			message: 'Unknown request type: foo.bar',
		});
	});
});
