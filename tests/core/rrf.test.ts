/**
 * @file tests/core/rrf.test.ts
 * @description RRF(Reciprocal Rank Fusion)单元测试
 * @module tests/core/rrf
 */

import { describe, it, expect } from 'vitest';
import { reciprocalRankFusion } from '../../src/core/rrf';

describe('reciprocalRankFusion', () => {
	it('RRF - 空输入 - 返回空数组', () => {
		expect(reciprocalRankFusion([])).toEqual([]);
	});

	it('RRF - 单列表 - 原样返回(rank 从 0 开始)', () => {
		const lists = [[{ id: 'a', score: 0.9 }, { id: 'b', score: 0.8 }]];
		const result = reciprocalRankFusion(lists);
		// 关键路径:单列表 RRF score = 1/(60+rank),rank 从 0 开始
		expect(result).toHaveLength(2);
		expect(result[0]!.id).toBe('a');
		expect(result[0]!.rrfScore).toBeCloseTo(1 / 60, 5);
		expect(result[1]!.id).toBe('b');
		expect(result[1]!.rrfScore).toBeCloseTo(1 / 61, 5);
	});

	it('RRF - 多列表重叠项 - 分数累加', () => {
		// 关键路径:doc-a 在两个列表都排第 1,RRF 分数 = 1/60 + 1/60 = 2/60
		const lists = [
			[{ id: 'a', score: 0.9 }, { id: 'b', score: 0.8 }],
			[{ id: 'a', score: 0.85 }, { id: 'c', score: 0.7 }],
		];
		const result = reciprocalRankFusion(lists);
		expect(result).toHaveLength(3);
		// doc-a 分数最高(两列表都命中)
		expect(result[0]!.id).toBe('a');
		expect(result[0]!.rrfScore).toBeCloseTo(2 / 60, 5);
		expect(result[0]!.sourceScores).toEqual([0.9, 0.85]);
	});

	it('RRF - k 参数 - 影响 score 计算', () => {
		const lists = [[{ id: 'a', score: 0.9 }]];
		// 关键路径:k=40 → score = 1/(40+0) = 1/40
		const result = reciprocalRankFusion(lists, 40);
		expect(result[0]!.rrfScore).toBeCloseTo(1 / 40, 5);
	});

	it('RRF - topK 截断 - 只返回 topK 个', () => {
		const lists = [
			[
				{ id: 'a', score: 0.9 },
				{ id: 'b', score: 0.8 },
				{ id: 'c', score: 0.7 },
			],
		];
		const result = reciprocalRankFusion(lists, 60, 2);
		expect(result).toHaveLength(2);
		expect(result[0]!.id).toBe('a');
		expect(result[1]!.id).toBe('b');
	});

	it('RRF - 同 id 多次出现 - sourceScores 记录所有来源分数', () => {
		const lists = [
			[{ id: 'a', score: 0.9 }, { id: 'b', score: 0.8 }],
			[{ id: 'c', score: 0.7 }, { id: 'a', score: 0.85 }],
			[],
			// 关键路径:第三列表不含 a,sourceScores[2] 应为 undefined
		];
		const result = reciprocalRankFusion(lists);
		const itemA = result.find((r) => r.id === 'a');
		expect(itemA).toBeDefined();
		expect(itemA!.sourceScores).toEqual([0.9, 0.85, undefined]);
	});

	it('RRF - 按分数降序排列', () => {
		const lists = [
			[{ id: 'a', score: 0.9 }, { id: 'b', score: 0.8 }],
			[{ id: 'b', score: 0.85 }, { id: 'a', score: 0.7 }],
		];
		const result = reciprocalRankFusion(lists);
		// 关键路径:b 在两列表分别排第 1 和第 2,分数 = 1/60 + 1/61 > a 的 1/61 + 1/60... 实际相等,看顺序
		// a: rank0 in list1 + rank1 in list2 = 1/60 + 1/61
		// b: rank1 in list1 + rank0 in list2 = 1/61 + 1/60
		// 分数相同,顺序由实现决定(稳定排序保留首次出现顺序)
		expect(result).toHaveLength(2);
		// 关键路径:分数相等时,按首次出现顺序稳定排序(a 在 list1 rank 0 先于 b)
		expect(result[0]!.id).toBe('a');
		expect(result[0]!.rrfScore).toBeCloseTo(1 / 60 + 1 / 61, 5);
		expect(result[1]!.id).toBe('b');
		expect(result[1]!.rrfScore).toBeCloseTo(1 / 61 + 1 / 60, 5);
	});
});
