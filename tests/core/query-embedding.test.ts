/**
 * @file tests/core/query-embedding.test.ts
 * @description 查询嵌入端口 — 超时降级、取消不降级、空输入、动态解析主路径
 * @module tests/core/query-embedding
 */

import { describe, expect, it, vi } from 'vitest';
import { createQueryEmbeddingPort } from '../../src/core/query-embedding';
import type { EmbeddingPort } from '../../src/ports/embedding';

/** 造一个可控的嵌入端口。 */
function makePort(name: string, impl?: () => Promise<number[][]>): EmbeddingPort & { calls: number } {
	const port = {
		dimensions: 2,
		modelId: name,
		calls: 0,
		async embed(texts: string[]): Promise<number[][]> {
			port.calls += 1;
			if (impl !== undefined) return impl();
			return texts.map(() => [1, 2]);
		},
	};
	return port;
}

describe('查询嵌入端口', () => {
	it('主路径正常返回 - 不触碰降级实现', async () => {
		const primary = makePort('primary');
		const fallback = makePort('fallback');
		const port = createQueryEmbeddingPort({
			dimensions: 2,
			modelId: 'query',
			primary: () => primary,
			fallback,
			timeoutMs: 1_000,
		});
		expect(await port.embed(['工程化'])).toEqual([[1, 2]]);
		expect(primary.calls).toBe(1);
		expect(fallback.calls).toBe(0);
	});

	it('主路径超时 - 本次降级到备用实现并回报原因', async () => {
		// 关键路径:查询卡住不能让工具层等到 60 秒超时,必须自己先给出结论。
		const primary = makePort('primary', () => new Promise<number[][]>(() => {}));
		const fallback = makePort('fallback');
		const onFallback = vi.fn();
		const port = createQueryEmbeddingPort({
			dimensions: 2,
			modelId: 'query',
			primary: () => primary,
			fallback,
			timeoutMs: 30,
			onFallback,
		});
		expect(await port.embed(['工程化'])).toEqual([[1, 2]]);
		expect(fallback.calls).toBe(1);
		expect(onFallback).toHaveBeenCalledTimes(1);
	});

	it('主路径抛错 - 同样降级,不是把错误直接抛给检索', async () => {
		const primary = makePort('primary', async () => {
			throw new Error('worker 已崩溃');
		});
		const fallback = makePort('fallback');
		const port = createQueryEmbeddingPort({
			dimensions: 2,
			modelId: 'query',
			primary: () => primary,
			fallback,
			timeoutMs: 1_000,
		});
		expect(await port.embed(['工程化'])).toEqual([[1, 2]]);
		expect(fallback.calls).toBe(1);
	});

	it('调用方主动取消 - 不降级,按取消结束', async () => {
		// 关键路径:取消是用户意图,不能借机把重资源（CPU 会话）建起来。
		const primary = makePort('primary', () => new Promise<number[][]>(() => {}));
		const fallback = makePort('fallback');
		const onFallback = vi.fn();
		const port = createQueryEmbeddingPort({
			dimensions: 2,
			modelId: 'query',
			primary: () => primary,
			fallback,
			timeoutMs: 5_000,
			onFallback,
		});
		const controller = new AbortController();
		const pending = port.embed(['工程化'], { signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toThrow();
		expect(fallback.calls).toBe(0);
		expect(onFallback).not.toHaveBeenCalled();
	});

	it('空输入 - 主备都不调用', async () => {
		const primary = makePort('primary');
		const fallback = makePort('fallback');
		const port = createQueryEmbeddingPort({
			dimensions: 2,
			modelId: 'query',
			primary: () => primary,
			fallback,
			timeoutMs: 1_000,
		});
		expect(await port.embed([])).toEqual([]);
		expect(primary.calls).toBe(0);
		expect(fallback.calls).toBe(0);
	});

	it('主路径晚于构造才就绪 - 后续调用能解析到它', async () => {
		// 关键路径:Worker 代理在 onLayoutReady 才创建;构造时求值会永久绑定到降级实现。
		const fallback = makePort('fallback');
		let primary: EmbeddingPort | undefined;
		const port = createQueryEmbeddingPort({
			dimensions: 2,
			modelId: 'query',
			primary: () => primary,
			fallback,
			timeoutMs: 1_000,
		});
		await port.embed(['第一次']);
		expect(fallback.calls).toBe(1);

		const ready = makePort('primary');
		primary = ready;
		await port.embed(['第二次']);
		expect(ready.calls).toBe(1);
		expect(fallback.calls).toBe(1);
	});

	it('透传维度与模型标识', () => {
		const port = createQueryEmbeddingPort({
			dimensions: 512,
			modelId: 'local:bge-small-zh-v1.5',
			fallback: makePort('fallback'),
			timeoutMs: 1_000,
		});
		expect(port.dimensions).toBe(512);
		expect(port.modelId).toBe('local:bge-small-zh-v1.5');
	});
});
