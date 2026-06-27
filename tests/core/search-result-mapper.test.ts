/**
 * @file tests/core/search-result-mapper.test.ts
 * @description search-result-mapper 单元测试 — 扁平化 search_vault 结果
 */
import { describe, it, expect } from 'vitest';
import { mapSearchResults } from '../../src/core/search-result-mapper';

describe('mapSearchResults', () => {
	it('mapSearchResults - 正常结果 - 扁平化为 path + reranked=false', () => {
		const raw = [
			{ docId: 'd1', score: 0.9, metadata: { path: 'a.md' }, index: 0 },
			{ docId: 'd2', score: 0.8, metadata: { path: 'b.md' }, index: 1 },
		];
		const result = mapSearchResults(raw);
		expect(result).not.toBeNull();
		expect(result!.results).toHaveLength(2);
		expect(result!.results[0]).toEqual({ docId: 'd1', score: 0.9, path: 'a.md', index: 0 });
		expect(result!.reranked).toBe(false);
	});

	it('mapSearchResults - 含 reranked=true - 推断 reranked=true', () => {
		const raw = [
			{ docId: 'd1', score: 0.9, metadata: { path: 'a.md' }, index: 0, reranked: true },
		];
		const result = mapSearchResults(raw);
		expect(result!.reranked).toBe(true);
	});

	it('mapSearchResults - 缺 metadata.path - 过滤掉该条', () => {
		const raw = [
			{ docId: 'd1', score: 0.9, metadata: { path: 'a.md' }, index: 0 },
			{ docId: 'd2', score: 0.8, metadata: {}, index: 1 },
		];
		const result = mapSearchResults(raw);
		expect(result!.results).toHaveLength(1);
		expect(result!.results[0]!.docId).toBe('d1');
	});

	it('mapSearchResults - 全部缺 path - 返回 null', () => {
		const raw = [{ docId: 'd1', score: 0.9, metadata: {}, index: 0 }];
		const result = mapSearchResults(raw);
		expect(result).toBeNull();
	});

	it('mapSearchResults - 非数组输入 - 返回 null', () => {
		expect(mapSearchResults(null)).toBeNull();
		expect(mapSearchResults('not array')).toBeNull();
	});
});
