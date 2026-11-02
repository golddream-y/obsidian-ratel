/**
 * @file tests/core/index-embedding-arbiter.test.ts
 * @description 嵌入批次仲裁 — 查询插队、批次边界、队列上限与失败传播
 * @module tests/core/index-embedding-arbiter
 */

import { describe, expect, it } from 'vitest';
import { EmbeddingArbiter } from '../../src/core/index-embedding-arbiter';

/** 可控嵌入:每个批次都要等测试放行。 */
function makeControlledEmbed(): {
	embed: (texts: string[], workload: string) => Promise<number[][]>;
	calls: Array<{ texts: string[]; workload: string }>;
	release: () => void;
} {
	const calls: Array<{ texts: string[]; workload: string }> = [];
	const gates: Array<() => void> = [];
	const embed = async (texts: string[], workload: string): Promise<number[][]> => {
		calls.push({ texts, workload });
		await new Promise<void>((resolve) => {
			if (pendingReleases > 0) {
				pendingReleases -= 1;
				resolve();
				return;
			}
			gates.push(resolve);
		});
		return texts.map(() => [0.1]);
	};
	// 释放可能早于下一批被调用:先记下来,等下一个门出现时立即放行。
	let pendingReleases = 0;
	return {
		embed: embed as never,
		calls,
		release: () => {
			const gate = gates.shift();
			if (gate === undefined) pendingReleases += 1;
			else gate();
		},
	};
}

describe('嵌入批次仲裁', () => {
	it('查询插到索引批次之间 - 不排完整批', async () => {
		const controlled = makeControlledEmbed();
		const arbiter = new EmbeddingArbiter(controlled.embed as never, { maxBatchSize: 2 });
		const indexWork = arbiter.request(['a', 'b', 'c', 'd'], 'index');
		await Promise.resolve();
		// 第一批(index)已发出,其余在排队。
		const queryWork = arbiter.request(['q'], 'query');
		await Promise.resolve();

		controlled.release();
		await Promise.resolve();
		await Promise.resolve();
		// 第二批应当是查询,而不是索引的 c/d。
		expect(controlled.calls[1]).toMatchObject({ texts: ['q'], workload: 'query' });

		controlled.release();
		controlled.release();
		await Promise.all([indexWork, queryWork]);
	});

	it('一次请求按批拆分 - 结果按序拼接', async () => {
		const calls: string[][] = [];
		const arbiter = new EmbeddingArbiter(async (texts) => {
			calls.push([...texts]);
			return texts.map((text) => [text.length]);
		}, { maxBatchSize: 2 });
		const vectors = await arbiter.request(['aa', 'bbb', 'c'], 'index');
		expect(calls).toEqual([['aa', 'bbb'], ['c']]);
		expect(vectors).toEqual([[2], [3], [1]]);
	});

	it('同优先级保持先进先出', async () => {
		const controlled = makeControlledEmbed();
		const arbiter = new EmbeddingArbiter(controlled.embed as never, { maxBatchSize: 1 });
		void arbiter.request(['first'], 'index');
		await Promise.resolve();
		void arbiter.request(['second'], 'index');
		controlled.release();
		await Promise.resolve();
		await Promise.resolve();
		expect(controlled.calls[1]).toMatchObject({ texts: ['second'] });
	});

	it('队列上限 - 超出即拒绝 - 不堆积内存', async () => {
		const controlled = makeControlledEmbed();
		const arbiter = new EmbeddingArbiter(controlled.embed as never, { maxBatchSize: 1, maxQueued: 2 });
		void arbiter.request(['a', 'b'], 'index');
		await expect(arbiter.request(['c', 'd'], 'index')).rejects.toThrow('队列已满');
		controlled.release();
		controlled.release();
	});

	it('单批失败 - 只影响该批 - 后续批次继续', async () => {
		let call = 0;
		const arbiter = new EmbeddingArbiter(async (texts) => {
			call += 1;
			if (call === 1) throw new Error('模型挂了');
			return texts.map(() => [0.1]);
		}, { maxBatchSize: 1 });
		await expect(arbiter.request(['a'], 'index')).rejects.toThrow('模型挂了');
		await expect(arbiter.request(['b'], 'index')).resolves.toEqual([[0.1]]);
	});

	it('空输入 - 直接返回空 - 不占队列', async () => {
		const arbiter = new EmbeddingArbiter(async () => []);
		await expect(arbiter.request([], 'query')).resolves.toEqual([]);
		expect(arbiter.queued).toBe(0);
	});
});
