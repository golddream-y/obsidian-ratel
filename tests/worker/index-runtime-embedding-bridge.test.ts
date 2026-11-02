/**
 * @file tests/worker/index-runtime-embedding-bridge.test.ts
 * @description 嵌入桥接 — 分批、维度校验、取消透传与空输入
 * @module tests/worker/index-runtime-embedding-bridge
 */

import { describe, expect, it, vi } from 'vitest';
import { createEmbeddingBridge } from '../../src/worker/index-runtime-embedding-bridge';
import type { EmbeddingPort } from '../../src/ports/embedding';

const DIMENSIONS = 8;

/** 记录调用并返回确定性向量。 */
function makePort(overrides: Partial<EmbeddingPort> = {}): { port: EmbeddingPort; calls: string[][] } {
	const calls: string[][] = [];
	const port: EmbeddingPort = {
		dimensions: DIMENSIONS,
		modelId: 'test:bridge',
		async embed(texts) {
			calls.push([...texts]);
			return texts.map(() => Array.from({ length: DIMENSIONS }, () => 0.1));
		},
		...overrides,
	};
	return { port, calls };
}

describe('嵌入桥接', () => {
	it('超过批次上界 - 按批拆分 - 结果按序拼接', async () => {
		const { port, calls } = makePort();
		const bridge = createEmbeddingBridge(port, { maxBatchSize: 2 });
		const vectors = await bridge(['a', 'b', 'c'], 'index');
		expect(calls).toEqual([['a', 'b'], ['c']]);
		expect(vectors).toHaveLength(3);
	});

	it('工作类型透出给观测回调 - 查询与索引可区分', async () => {
		const { port } = makePort();
		const seen: string[] = [];
		const bridge = createEmbeddingBridge(port, { maxBatchSize: 4, onCall: (workload) => seen.push(workload) });
		await bridge(['x'], 'query');
		await bridge(['y'], 'index');
		expect(seen).toEqual(['query', 'index']);
	});

	it('端口返回条数不符 - 明确失败 - 不静默补齐', async () => {
		const { port } = makePort({ embed: async () => [] });
		const bridge = createEmbeddingBridge(port);
		await expect(bridge(['a'], 'index')).rejects.toThrow('不一致');
	});

	it('向量维度不符 - 明确失败 - 防止检索错乱', async () => {
		const { port } = makePort({ embed: async (texts) => texts.map(() => [0.1, 0.2]) });
		const bridge = createEmbeddingBridge(port);
		await expect(bridge(['a'], 'index')).rejects.toThrow('维度');
	});

	it('端口取消 - 错误向上抛出 - 不转成空结果', async () => {
		const { port } = makePort({ embed: async () => { throw new Error('AbortError'); } });
		const bridge = createEmbeddingBridge(port);
		await expect(bridge(['a'], 'index')).rejects.toThrow('AbortError');
	});

	it('空输入 - 不调用端口', async () => {
		const embed = vi.fn(async () => []);
		const { port } = makePort({ embed });
		const bridge = createEmbeddingBridge(port);
		await expect(bridge([], 'query')).resolves.toEqual([]);
		expect(embed).not.toHaveBeenCalled();
	});
});
