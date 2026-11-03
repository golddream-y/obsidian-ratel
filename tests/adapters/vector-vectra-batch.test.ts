/**
 * @file tests/adapters/vector-vectra-batch.test.ts
 * @description 批量写入 — N 篇文件的向量写入只落盘一次
 * @module tests/adapters/vector-vectra-batch
 *
 * 关键路径:Vectra 的存储接口是整文件读写,没有增量追加;唯一的降本手段是合并提交。
 * 本用例以「写 index.json 的次数」为口径,固定住「批内只写一次」这个契约。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VectraStore } from '../../src/adapters/vector-vectra';
import type { FileStorage } from 'vectra';
import { AtomicIndexStorage } from '../../src/adapters/atomic-index-storage';

const DIMENSIONS = 4;
let root = '';

beforeEach(async () => {
	root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ratel-batch-'));
});

afterEach(async () => {
	if (root) await fsp.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

/** 统计索引文件写入次数 — 挂在原子存储的文件系统层,任何落盘路径都绕不过它。 */
function countingStorage(): { storage: FileStorage; writes: () => number } {
	let writes = 0;
	const base = nodeFileSystem();
	const fileSystem = {
		...base,
		async openFile(absolutePath: string) {
			// 原子写入先写临时文件(.tmp- 标记),所以按包含判断而不是后缀。
			if (absolutePath.includes('index.json')) writes += 1;
			return base.openFile(absolutePath);
		},
	};
	const storage = new AtomicIndexStorage({ generationRoot: root, fileSystem });
	return { storage, writes: () => writes };
}

/** 真实 node 文件系统实现(与生产同一套语义)。 */
function nodeFileSystem() {
	return {
		async openFile(absolutePath: string) {
			const handle = await fsp.open(absolutePath, 'wx');
			return {
				async write(buffer: Uint8Array, offset: number, length: number) {
					const result = await handle.write(buffer, offset, length);
					return result.bytesWritten;
				},
				sync: () => handle.sync(),
				close: () => handle.close(),
			};
		},
		async openDirectory(absolutePath: string) {
			const handle = await fsp.open(absolutePath, 'r');
			return { sync: () => handle.sync(), close: () => handle.close() };
		},
		rename: (from: string, to: string) => fsp.rename(from, to),
		async removeFile(absolutePath: string) {
			await fsp.rm(absolutePath, { force: true });
		},
	};
}

/** 造一个文件的块集合。 */
function blocksFor(filePath: string, count = 2) {
	return Array.from({ length: count }, (_, index) => ({
		id: `${filePath}#chunk-${index}`,
		vector: Array.from({ length: DIMENSIONS }, () => 0.1),
		metadata: { path: filePath, chunkIndex: index, startOffset: index * 10, commitId: `c-${filePath}` },
	}));
}

describe('批量写入', () => {
	it('批内写三篇 - 索引只落盘一次', async () => {
		const { storage, writes } = countingStorage();
		const store = new VectraStore(root, { storage, autoInit: true });
		await store.init();
		// 建索引本身会写一次,统计增量时排除。
		const baseline = writes();
		await store.beginWriteBatch();
		for (const name of ['a.md', 'b.md', 'c.md']) {
			await store.replaceFile({ path: name, commitId: `c-${name}`, blocks: blocksFor(name) });
		}
		await store.endWriteBatch();
		// 批内三次 replaceFile → 一次 endUpdate → 一次写盘。
		expect(writes() - baseline).toBe(1);
		expect((await store.status()).totalDocs).toBeGreaterThan(0);
	});

	it('不批量 - 每篇各自落盘', async () => {
		const { storage, writes } = countingStorage();
		const store = new VectraStore(root, { storage, autoInit: true });
		await store.init();
		const baseline = writes();
		for (const name of ['a.md', 'b.md', 'c.md']) {
			await store.replaceFile({ path: name, commitId: `c-${name}`, blocks: blocksFor(name) });
		}
		expect(writes() - baseline).toBe(3);
	});

	it('批量期间未结束 - 不落盘', async () => {
		const { storage, writes } = countingStorage();
		const store = new VectraStore(root, { storage, autoInit: true });
		await store.init();
		// 建索引本身会写一次,统计增量时排除。
		const baseline = writes();
		await store.beginWriteBatch();
		// 以「开批之后」为基准:开批本身可能触发一次索引文件落地,不属于每篇写入。
		const batchBaseline = writes();
		await store.replaceFile({ path: 'a.md', commitId: 'c-a', blocks: blocksFor('a.md') });
		expect(writes() - batchBaseline).toBe(0);
		await store.endWriteBatch();
		expect(writes() - batchBaseline).toBe(1);
	});
});
