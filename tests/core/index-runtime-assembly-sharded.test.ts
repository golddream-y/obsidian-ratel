/**
 * @file tests/core/index-runtime-assembly-sharded.test.ts
 * @description 主线程与线程两条装配路径统一走分片存储 — 片数来自 layout,全新库补 layout
 * @module tests/core/index-runtime-assembly-sharded
 * @depends core/index-runtime-assembly, core/index-thread-assembly, core/index-shard-migration,
 *   core/index-shard-routing, core/index-generations, adapters/vector-vectra-sharded
 *
 * 关键路径:
 * - 两条装配路径都必须返回分片存储,且片数**只来自 `shards/layout.json`**(不重算、不进指纹);
 * - 全新代际没有 layout 也没有旧 `index.json` 时补写 layout(片数取下限 8),
 *   使新装用户从第一次索引起就是分片布局,且不产生单份 `index.json`;
 * - 迁移失败必须让装配 reject 且不留半成品 layout(否则下次启动会把坏布局当已完成)。
 *
 * 全部用例使用系统临时目录上的真实磁盘,不访问真实 Vault、不联网、不加载模型。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupWritableIndexRuntime } from '../../src/core/index-runtime-assembly';
import { assembleIndexThreadRuntime } from '../../src/core/index-thread-assembly';
import {
	computeConfigFingerprint,
	type IndexConfigDescriptor,
	INDEX_RECORD_SCHEMA_VERSION,
} from '../../src/core/index-persistence-types';
import { deriveGenerationId, type IndexGenerations } from '../../src/core/index-generations';
import { ensureShardLayout, readShardLayout } from '../../src/core/index-shard-migration';
import { MIN_SHARDS } from '../../src/core/index-shard-routing';
import { ShardedVectorStore } from '../../src/adapters/vector-vectra-sharded';
import type { IndexWriteOwner } from '../../src/core/index-write-owner';
import { FakeEmbeddingPort, T0_CHUNK_OPTIONS } from '../helpers/index-reliability-fixture';

// ==================== 夹具 ====================

/** 合成向量维度 — 保持小尺寸,避免用例把时间花在写盘上。 */
const DIMENSIONS = 8;

/** 合成笔记 — 只用于验证装配后的读写语义,不参与片数判定。 */
const NOTE_CONTENT = ['# 分片装配', '', '装配后写入必须落在分片目录。'].join('\n');

/** 基准配置 — 与 `T0_CHUNK_OPTIONS` 的分块参数保持一致。 */
function baseConfig(overrides: Partial<IndexConfigDescriptor> = {}): IndexConfigDescriptor {
	return {
		embeddingModelId: 'local:shard-assembly',
		embeddingModelRevision: null,
		embeddingDimension: DIMENSIONS,
		chunkerVersion: 1,
		chunkSize: T0_CHUNK_OPTIONS.maxTokens,
		chunkOverlap: T0_CHUNK_OPTIONS.overlapTokens,
		embeddingTextVersion: null,
		...overrides,
	};
}

/** 合成 Vault 端口 — 只暴露文件内容与 mtime,不触碰真实库。 */
function createVault(files: Record<string, string>): {
	listMarkdownFiles(): string[];
	readFile(filePath: string): Promise<string>;
	stat(filePath: string): { mtime: number; size: number } | null;
} {
	return {
		listMarkdownFiles: () => Object.keys(files),
		readFile: async (filePath: string) => files[filePath] ?? '',
		stat: (filePath: string) => (files[filePath] === undefined ? null : { mtime: 1, size: files[filePath].length }),
	};
}

/** 判断路径是否存在。 */
function exists(target: string): boolean {
	return fs.existsSync(target);
}

/** 读取并解析 layout — 断言字段而不是只断言文件存在。 */
function readLayoutFile(generationRoot: string): { version: number; shardCount: number; blockCount: number } {
	return JSON.parse(fs.readFileSync(path.join(generationRoot, 'shards', 'layout.json'), 'utf8')) as {
		version: number;
		shardCount: number;
		blockCount: number;
	};
}

/** 由配置派生代际目录 — 与 `IndexGenerations.generationRootOf` 同一规则。 */
async function generationRootOf(indexRoot: string, config: IndexConfigDescriptor): Promise<string> {
	const fingerprint = await computeConfigFingerprint(config);
	return path.join(indexRoot, 'generations', deriveGenerationId(fingerprint));
}

/** 线程装配用的最小代际替身 — 只读控制指针,不参与真实代际状态机。 */
function createGenerationsStub(generationId: string, generationRoot: string, fingerprint: string): IndexGenerations {
	return {
		readControl: async () => ({
			schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
			activeGenerationId: generationId,
			generations: {
				[generationId]: {
					schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
					generationId,
					fingerprint,
					kind: 'fresh' as const,
					status: 'active' as const,
					root: generationRoot,
					verifiedAt: 1,
					createdAt: 1,
				},
			},
		}),
		generationRootOf: (id: string) => (id === generationId ? generationRoot : path.join(path.dirname(generationRoot), id)),
	} as unknown as IndexGenerations;
}

/** 线程装配用的最小写所有权替身 — 本用例只验证装配,不驱动提交。 */
const OWNER_STUB = {
	epoch: 1,
	assertWritable: () => undefined,
	beginCommit: () => ({ settle: () => undefined }),
};

describe('两条装配路径统一走分片存储', () => {
	let roots: string[];
	/** 本用例装配出的写所有权 — `afterEach` 统一释放,失败路径也不留下锁。 */
	let leases: IndexWriteOwner[];
	/** 本用例装配出的看护 — 停掉定时器,避免句柄泄漏。 */
	let watchdogs: Array<{ stop(): void }>;

	beforeEach(() => {
		roots = [];
		leases = [];
		watchdogs = [];
	});

	afterEach(async () => {
		for (const watchdog of watchdogs.splice(0)) watchdog.stop();
		for (const lease of leases.splice(0)) await lease.release().catch(() => undefined);
		for (const root of roots.splice(0)) {
			// 关键路径:只清理本用例创建的系统临时目录。
			if (!root.startsWith(path.join(os.tmpdir(), 'ratel-shard-assembly-'))) throw new Error('测试目录归属不符');
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	/** 建一个系统临时索引根。 */
	function makeRoot(): string {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-shard-assembly-'));
		roots.push(root);
		return root;
	}

	it('两条装配路径都得到分片存储 - 片数来自 layout 而不是重算', async () => {
		const config = baseConfig();
		const fingerprint = await computeConfigFingerprint(config);

		// 主线程路径:先在派生出的代际目录里放一份 16 片布局。
		const mainRoot = makeRoot();
		const mainGenerationRoot = await generationRootOf(mainRoot, config);
		await ensureShardLayout(mainGenerationRoot, 16);
		const mainRuntime = await setupWritableIndexRuntime({
			indexRoot: mainRoot,
			config,
			configFingerprint: fingerprint,
			vault: createVault({ 'note.md': NOTE_CONTENT }),
			embedding: new FakeEmbeddingPort(DIMENSIONS),
			getChunkOptions: () => T0_CHUNK_OPTIONS,
			chunkLimits: { chunkSize: config.chunkSize, chunkOverlap: config.chunkOverlap },
			expectedDimension: DIMENSIONS,
		});
		leases.push(mainRuntime.lease);
		watchdogs.push(mainRuntime.pipeline.stallWatchdog);

		// 线程路径:代际替身指到同规则的临时目录,同样预置 16 片布局。
		const threadRoot = makeRoot();
		const threadGenerationRoot = await generationRootOf(threadRoot, config);
		const threadGenerationId = deriveGenerationId(fingerprint);
		await ensureShardLayout(threadGenerationRoot, 16);
		const threadRuntime = await assembleIndexThreadRuntime({
			indexRoot: threadRoot,
			generations: createGenerationsStub(threadGenerationId, threadGenerationRoot, fingerprint),
			config,
			owner: OWNER_STUB as never,
			expectedDimension: DIMENSIONS,
			embedding: new FakeEmbeddingPort(DIMENSIONS),
			vault: { listMarkdownFiles: () => [], readFile: async () => '' },
		});

		for (const store of [mainRuntime.pipeline.store, threadRuntime.pipeline?.store]) {
			expect(store).toBeInstanceOf(ShardedVectorStore);
			expect((store as ShardedVectorStore).shardCount).toBe(16);
		}

		// 主线程路径的写入必须落在分片目录,而不是代际根上的单份 index.json。
		const store = mainRuntime.pipeline.store as ShardedVectorStore;
		await store.replaceFile({
			path: 'note.md',
			commitId: 'commit-1',
			blocks: [{
				id: 'note.md#chunk-0',
				vector: [1, 0, 0, 0, 0, 0, 0, 0],
				metadata: { path: 'note.md', chunkIndex: 0, commitId: 'commit-1' },
			}],
		});
		expect(await store.inspectFile('note.md')).toHaveLength(1);
		expect(exists(path.join(mainGenerationRoot, 'index.json'))).toBe(false);
		expect(exists(path.join(mainGenerationRoot, 'shards', store.shardDirectoryOf(store.shardIdOf('note.md')), 'index.json'))).toBe(true);
	});

	it('全新空库装配 - 补写 layout 且片数为下限 - 不产生单份 index.json', async () => {
		const config = baseConfig();
		const fingerprint = await computeConfigFingerprint(config);

		const mainRoot = makeRoot();
		const mainGenerationRoot = await generationRootOf(mainRoot, config);
		const mainRuntime = await setupWritableIndexRuntime({
			indexRoot: mainRoot,
			config,
			configFingerprint: fingerprint,
			vault: createVault({}),
			embedding: new FakeEmbeddingPort(DIMENSIONS),
			getChunkOptions: () => T0_CHUNK_OPTIONS,
			chunkLimits: { chunkSize: config.chunkSize, chunkOverlap: config.chunkOverlap },
			expectedDimension: DIMENSIONS,
		});
		leases.push(mainRuntime.lease);
		watchdogs.push(mainRuntime.pipeline.stallWatchdog);

		const mainLayout = readLayoutFile(mainGenerationRoot);
		expect(mainLayout).toMatchObject({ version: 1, shardCount: MIN_SHARDS, blockCount: 0 });
		expect(await readShardLayout(mainGenerationRoot)).toMatchObject({ shardCount: MIN_SHARDS });
		expect(await mainRuntime.pipeline.store.isIndexCreated()).toBe(true);
		expect(exists(path.join(mainGenerationRoot, 'index.json'))).toBe(false);

		// 线程路径同样是全新代际:装配后必须有 layout,且没有单份 index.json。
		const threadRoot = makeRoot();
		const threadGenerationRoot = await generationRootOf(threadRoot, config);
		const threadGenerationId = deriveGenerationId(fingerprint);
		const threadRuntime = await assembleIndexThreadRuntime({
			indexRoot: threadRoot,
			generations: createGenerationsStub(threadGenerationId, threadGenerationRoot, fingerprint),
			config,
			owner: OWNER_STUB as never,
			expectedDimension: DIMENSIONS,
			embedding: new FakeEmbeddingPort(DIMENSIONS),
			vault: { listMarkdownFiles: () => [], readFile: async () => '' },
		});
		const threadLayout = readLayoutFile(threadGenerationRoot);
		expect(threadLayout).toMatchObject({ version: 1, shardCount: MIN_SHARDS, blockCount: 0 });
		expect(threadRuntime.pipeline?.store).toBeInstanceOf(ShardedVectorStore);
		expect((threadRuntime.pipeline?.store as ShardedVectorStore).shardCount).toBe(MIN_SHARDS);
		expect(exists(path.join(threadGenerationRoot, 'index.json'))).toBe(false);
	});

	it('迁移失败 - 装配 reject - 不留下半成品 layout', async () => {
		const config = baseConfig();
		const fingerprint = await computeConfigFingerprint(config);
		const root = makeRoot();
		const generationRoot = await generationRootOf(root, config);
		fs.mkdirSync(generationRoot, { recursive: true });
		// 关键路径:坏 JSON 让迁移在解析阶段失败 —— 此时还没写任何片与 layout。
		fs.writeFileSync(path.join(generationRoot, 'index.json'), '{ 这不是合法索引 ', 'utf8');

		await expect(setupWritableIndexRuntime({
			indexRoot: root,
			config,
			configFingerprint: fingerprint,
			vault: createVault({}),
			embedding: new FakeEmbeddingPort(DIMENSIONS),
			getChunkOptions: () => T0_CHUNK_OPTIONS,
			chunkLimits: { chunkSize: config.chunkSize, chunkOverlap: config.chunkOverlap },
			expectedDimension: DIMENSIONS,
		})).rejects.toThrow();

		expect(await readShardLayout(generationRoot)).toBeNull();
		expect(exists(path.join(generationRoot, 'shards', 'layout.json'))).toBe(false);
		// 装配失败不得改写旧文件:下次启动仍能读到同一份坏索引并重试(而不是误以为已迁移)。
		expect(exists(path.join(generationRoot, 'index.json'))).toBe(true);

		// 线程路径同样 fail-closed:迁移失败必须 reject,且不留下半成品 layout。
		const threadRoot = makeRoot();
		const threadGenerationRoot = await generationRootOf(threadRoot, config);
		const threadGenerationId = deriveGenerationId(fingerprint);
		fs.mkdirSync(threadGenerationRoot, { recursive: true });
		fs.writeFileSync(path.join(threadGenerationRoot, 'index.json'), '{ 仍不是合法索引 ', 'utf8');
		await expect(assembleIndexThreadRuntime({
			indexRoot: threadRoot,
			generations: createGenerationsStub(threadGenerationId, threadGenerationRoot, fingerprint),
			config,
			owner: OWNER_STUB as never,
			expectedDimension: DIMENSIONS,
			embedding: new FakeEmbeddingPort(DIMENSIONS),
			vault: { listMarkdownFiles: () => [], readFile: async () => '' },
		})).rejects.toThrow();
		expect(await readShardLayout(threadGenerationRoot)).toBeNull();
		expect(exists(path.join(threadGenerationRoot, 'shards', 'layout.json'))).toBe(false);
		expect(exists(path.join(threadGenerationRoot, 'index.json'))).toBe(true);
	});
});
