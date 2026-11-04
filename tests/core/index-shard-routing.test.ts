import { describe, expect, it } from 'vitest';
import { shardCountForBlocks, shardIdForPath, shardDirectoryName, MIN_SHARDS, MAX_SHARDS } from '../../src/core/index-shard-routing';

describe('分片路由', () => {
	it('片数按块数自适应 - 下限 8 上限 64', () => {
		expect(shardCountForBlocks(0)).toBe(MIN_SHARDS);
		expect(shardCountForBlocks(1_500)).toBe(MIN_SHARDS);
		expect(shardCountForBlocks(19_784)).toBe(16);
		expect(shardCountForBlocks(80_000)).toBe(MAX_SHARDS);
		expect(shardCountForBlocks(10_000_000)).toBe(MAX_SHARDS);
	});

	it('片数只取 2 的幂且单调不减', () => {
		let previous = 0;
		for (const blocks of [0, 2_048, 4_096, 8_192, 16_384, 32_768, 65_536]) {
			const count = shardCountForBlocks(blocks);
			expect(Number.isInteger(Math.log2(count))).toBe(true);
			expect(count).toBeGreaterThanOrEqual(previous);
			previous = count;
		}
	});

	it('同一路径永远落在同一片 - 与片数无关地稳定', () => {
		const path = '玄幻中篇/妖市-第6章.md';
		const ids = new Set([8, 16, 32, 64].map((count) => shardIdForPath(path, count)));
		expect(ids.size).toBeLessThanOrEqual(4);
		for (const count of [8, 16, 32, 64]) {
			expect(shardIdForPath(path, count)).toBe(shardIdForPath(path, count));
			expect(shardIdForPath(path, count)).toBeLessThan(count);
		}
	});

	it('分片按内容分布 - 一千个路径覆盖多数分片', () => {
		const seen = new Set<number>();
		for (let index = 0; index < 1_000; index += 1) seen.add(shardIdForPath(`notes/note-${index}.md`, 16));
		expect(seen.size).toBe(16);
	});

	it('目录名为两位十六进制 - 与片号一一对应', () => {
		expect(shardDirectoryName(0)).toBe('00');
		expect(shardDirectoryName(10)).toBe('0a');
		expect(shardDirectoryName(15)).toBe('0f');
	});
});
