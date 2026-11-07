/**
 * @file tests/core/index-persistence-types.test.ts
 * @description 持久数据契约校验 — 记录 schema、路径越界、配置指纹、块集合与 checksum 的拒绝矩阵
 * @module tests/core/index-persistence-types
 * @depends src/core/index-persistence-types, node:fs, node:os, node:path, node:crypto
 *
 * 关键路径:本文件全部使用系统临时目录,不读写真实 Vault;
 * 断言一律检查错误码(`IndexValidationError.code`),不依赖错误文案措辞。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
	EMPTY_BLOCK_SET_HASH,
	INDEX_CONFIG_FINGERPRINT_FIELDS,
	INDEX_PHASES,
	INDEX_VALIDATION_ERROR_CODES,
	IndexValidationError,
	assertPathWithinRoot,
	assertSafePartName,
	assertSafeRecordPath,
	computeBlockSetHash,
	computeConfigFingerprint,
	validateBlockSet,
	validateFileCommit,
	validatePreparedFile,
	verifyPreparedChecksums,
} from '../../src/core/index-persistence-types';
import type {
	FileCommit,
	IndexBlockInput,
	IndexConfigDescriptor,
	IndexValidationErrorCode,
	PreparedFile,
} from '../../src/core/index-persistence-types';

// ==================== 夹具 ====================

/** 当前生效的索引配置(与生产 `EmbeddingPort` + 分块参数同形)。 */
const CONFIG: IndexConfigDescriptor = {
	embeddingModelId: 'local:bge-small-zh-v1.5',
	embeddingModelRevision: 'rev-2026-09',
	embeddingDimension: 512,
	chunkerVersion: 1,
	chunkSize: 100,
	chunkOverlap: 20,
	embeddingTextVersion: null,
};

/** 每个指纹字段各自变化的完整配置,避免用联合类型索引破坏类型收窄。 */
const ALTERNATE_CONFIGS: Record<(typeof INDEX_CONFIG_FINGERPRINT_FIELDS)[number], IndexConfigDescriptor> = {
	embeddingModelId: { ...CONFIG, embeddingModelId: 'api:text-embedding-3-small' },
	embeddingModelRevision: { ...CONFIG, embeddingModelRevision: 'rev-2026-10' },
	embeddingDimension: { ...CONFIG, embeddingDimension: 1024 },
	chunkerVersion: { ...CONFIG, chunkerVersion: 2 },
	chunkSize: { ...CONFIG, chunkSize: 200 },
	chunkOverlap: { ...CONFIG, chunkOverlap: 40 },
	embeddingTextVersion: { ...CONFIG, embeddingTextVersion: 'v2' },
};

const FINGERPRINT = await computeConfigFingerprint(CONFIG);

/** 合法的 present 提交记录基线。 */
const BASE_COMMIT: FileCommit = {
	schemaVersion: 2,
	generationId: 'gen-1',
	path: 'notes/a.md',
	configFingerprint: FINGERPRINT,
	commitId: 'commit-1',
	revision: 1,
	chunkCount: 3,
	blockSetHash: 'a'.repeat(64),
	state: 'present',
	inputHash: 'b'.repeat(64),
};

const COMMIT_OPTIONS = { generationId: 'gen-1', configFingerprint: FINGERPRINT } as const;

/** 计算分片内容摘要 — 测试侧独立实现,不复用被测代码。 */
function shardHash(content: string): string {
	return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** 构造合法的 replace 事务基线。 */
function createPreparedFile(): PreparedFile {
	const shards = ['shard-0', 'shard-1'];
	return {
		schemaVersion: 2,
		operation: 'replace',
		next: BASE_COMMIT,
		previousCommitId: 'commit-0',
		previousRevision: 0,
		parts: [
			{ name: shards[0] ?? '', hash: shardHash('part-0'), count: 2 },
			{ name: shards[1] ?? '', hash: shardHash('part-1'), count: 1 },
		],
	};
}

/** 断言 promise 以指定错误码拒绝。 */
async function expectValidationError(
	promise: Promise<unknown>,
	code: IndexValidationErrorCode,
): Promise<void> {
	await expect(promise).rejects.toBeInstanceOf(IndexValidationError);
	await expect(promise).rejects.toMatchObject({ code });
}

let tmpRoot = '';
let generationRoot = '';
let outsideRoot = '';
let transactionRoot = '';

beforeAll(async () => {
	tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'ratel-persistence-types-'));
	generationRoot = path.join(tmpRoot, 'generations', 'gen-1');
	outsideRoot = path.join(tmpRoot, 'outside');
	transactionRoot = path.join(generationRoot, 'pending', 'tx-1');
	await mkdir(generationRoot, { recursive: true });
	await mkdir(outsideRoot, { recursive: true });
	await mkdir(transactionRoot, { recursive: true });
	await writeFile(path.join(outsideRoot, 'secret.txt'), 'secret', 'utf8');
	// 关键路径:代际根内的符号链接指向根外,用于验证解析后的越界拒绝。
	await symlink(outsideRoot, path.join(generationRoot, 'escape-link'), 'dir');
	// 关键路径:事务目录内的分片名指向根外,用于验证 transactionRoot 的二次包含性防线。
	await symlink(path.join(outsideRoot, 'secret.txt'), path.join(transactionRoot, 'link-part.json'), 'file');
});

afterAll(async () => {
	await rm(tmpRoot, { recursive: true, force: true });
});

// ==================== 配置指纹 ====================

describe('配置指纹 computeConfigFingerprint', () => {
	it('计算配置指纹 - 相同配置重复计算 - 得到稳定的 64 位小写十六进制摘要', async () => {
		const first = await computeConfigFingerprint(CONFIG);
		const second = await computeConfigFingerprint({ ...CONFIG });
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect(second).toBe(first);
	});

	it('计算配置指纹 - 仅对象键书写顺序不同 - 指纹保持一致', async () => {
		const reordered: IndexConfigDescriptor = {
			embeddingTextVersion: CONFIG.embeddingTextVersion,
			chunkOverlap: CONFIG.chunkOverlap,
			chunkSize: CONFIG.chunkSize,
			chunkerVersion: CONFIG.chunkerVersion,
			embeddingDimension: CONFIG.embeddingDimension,
			embeddingModelRevision: CONFIG.embeddingModelRevision,
			embeddingModelId: CONFIG.embeddingModelId,
		};
		expect(await computeConfigFingerprint(reordered)).toBe(FINGERPRINT);
	});

	it.each(INDEX_CONFIG_FINGERPRINT_FIELDS)(
		'计算配置指纹 - 字段 %s 变化 - 指纹随之变化',
		async (field) => {
			expect(await computeConfigFingerprint(ALTERNATE_CONFIGS[field])).not.toBe(FINGERPRINT);
		},
	);

	it('计算配置指纹 - 携带凭证与临时任务状态 - 这些字段不参与指纹', async () => {
		const withRuntimeOnly = {
			...CONFIG,
			apiKey: 'sk-should-not-hash',
			baseUrl: 'https://example.invalid/v1',
			taskId: 'task-123',
			phase: 'processing',
			completedUnits: 7,
		};
		expect(await computeConfigFingerprint(withRuntimeOnly)).toBe(FINGERPRINT);
	});

	// 关键路径(S-WEBGPU-EMBEDDING 三条硬约束):执行后端不得进入指纹,
	// 否则 1.5 从 WASM 切到 WebGPU 会让 1.4.0 的索引全量重建。
	it('执行后端字段不参与指纹 - 切换 WASM/WebGPU 不重建索引', async () => {
		for (const forbidden of ['executionBackend', 'enableWebgpu', 'glueSource', 'webgpu', 'backend']) {
			expect(INDEX_CONFIG_FINGERPRINT_FIELDS).not.toContain(forbidden);
		}
		// 指纹字段清单固定 7 项;新增字段必须显式评审是否影响向量兼容性。
		expect(INDEX_CONFIG_FINGERPRINT_FIELDS).toHaveLength(7);
		const withBackend = {
			...CONFIG,
			enableWebgpu: true,
			glueSource: 'inline-jsep-glue',
			executionBackend: 'webgpu',
		};
		expect(await computeConfigFingerprint(withBackend as IndexConfigDescriptor)).toBe(FINGERPRINT);
	});

	it('计算配置指纹 - 向量维度不是正整数 - 以 config-invalid 拒绝', async () => {
		await expectValidationError(
			computeConfigFingerprint({ ...CONFIG, embeddingDimension: 0 }),
			'config-invalid',
		);
		await expectValidationError(
			computeConfigFingerprint({ ...CONFIG, chunkOverlap: -1 }),
			'config-invalid',
		);
	});
});

// ==================== 文件提交记录 ====================

describe('文件提交记录校验 validateFileCommit', () => {
	it('校验文件提交记录 - 合法 present 记录 - 通过并返回同一记录', async () => {
		await expect(validateFileCommit({ ...BASE_COMMIT }, COMMIT_OPTIONS)).resolves.toMatchObject({
			path: 'notes/a.md',
			state: 'present',
			chunkCount: 3,
		});
	});

	it('校验文件提交记录 - 合法 deleted 记录 - 通过且块数为零、blockSetHash 为空集合摘要', async () => {
		const deleted = {
			...BASE_COMMIT,
			state: 'deleted',
			inputHash: null,
			chunkCount: 0,
			blockSetHash: EMPTY_BLOCK_SET_HASH,
		};
		const record = await validateFileCommit(deleted, COMMIT_OPTIONS);
		expect(record.state).toBe('deleted');
		expect(record.chunkCount).toBe(0);
		// 关键路径:删除记录的 blockSetHash 语义定死为空集合摘要,不能沿用旧版本摘要。
		expect(record.blockSetHash).toBe(EMPTY_BLOCK_SET_HASH);
		expect(EMPTY_BLOCK_SET_HASH).toBe(await computeBlockSetHash([]));
	});

	it('校验文件提交记录 - deleted 记录沿用非空集合摘要 - 以 record-state-inconsistent 拒绝', async () => {
		await expectValidationError(
			validateFileCommit(
				{
					...BASE_COMMIT,
					state: 'deleted',
					inputHash: null,
					chunkCount: 0,
					blockSetHash: 'a'.repeat(64),
				},
				COMMIT_OPTIONS,
			),
			'record-state-inconsistent',
		);
	});

	it('校验文件提交记录 - 未知 schemaVersion - 以 schema-version-unknown 拒绝', async () => {
		await expectValidationError(
			validateFileCommit({ ...BASE_COMMIT, schemaVersion: 3 }, COMMIT_OPTIONS),
			'schema-version-unknown',
		);
		await expectValidationError(
			validateFileCommit({ ...BASE_COMMIT, schemaVersion: '2' }, COMMIT_OPTIONS),
			'schema-version-unknown',
		);
	});

	it('校验文件提交记录 - 代际与当前代际不符 - 以 generation-mismatch 拒绝', async () => {
		await expectValidationError(
			validateFileCommit({ ...BASE_COMMIT, generationId: 'gen-2' }, COMMIT_OPTIONS),
			'generation-mismatch',
		);
	});

	it('校验文件提交记录 - 配置指纹与当前配置不符 - 以 config-fingerprint-mismatch 拒绝', async () => {
		await expectValidationError(
			validateFileCommit({ ...BASE_COMMIT, configFingerprint: 'c'.repeat(64) }, COMMIT_OPTIONS),
			'config-fingerprint-mismatch',
		);
	});

	it('校验文件提交记录 - deleted 记录带非零块数 - 以 record-state-inconsistent 拒绝', async () => {
		await expectValidationError(
			validateFileCommit(
				{
					...BASE_COMMIT,
					state: 'deleted',
					inputHash: null,
					chunkCount: 1,
					blockSetHash: EMPTY_BLOCK_SET_HASH,
				},
				COMMIT_OPTIONS,
			),
			'record-state-inconsistent',
		);
	});

	it('校验文件提交记录 - blockSetHash 不是 64 位十六进制 - 以 record-checksum-malformed 拒绝', async () => {
		await expectValidationError(
			validateFileCommit({ ...BASE_COMMIT, blockSetHash: 'not-a-hash' }, COMMIT_OPTIONS),
			'record-checksum-malformed',
		);
	});

	it('校验文件提交记录 - revision 不是正整数 - 以 record-shape-invalid 拒绝', async () => {
		await expectValidationError(
			validateFileCommit({ ...BASE_COMMIT, revision: 0 }, COMMIT_OPTIONS),
			'record-shape-invalid',
		);
	});
});

// ==================== 路径越界 ====================

describe('记录路径校验 assertSafeRecordPath', () => {
	it('校验记录路径 - 绝对路径 - 以 path-absolute 拒绝', async () => {
		await expectValidationError(
			Promise.resolve().then(() => assertSafeRecordPath('/etc/passwd')),
			'path-absolute',
		);
		await expectValidationError(
			Promise.resolve().then(() => assertSafeRecordPath('C:\\Windows\\system.ini')),
			'path-absolute',
		);
	});

	it('校验记录路径 - 空字符串 - 以 path-empty 拒绝', async () => {
		await expectValidationError(
			Promise.resolve().then(() => assertSafeRecordPath('')),
			'path-empty',
		);
	});

	it('校验记录路径 - 含 NUL 字符 - 以 path-nul 拒绝', async () => {
		await expectValidationError(
			Promise.resolve().then(() => assertSafeRecordPath('notes/a\u0000.md')),
			'path-nul',
		);
	});

	it('校验记录路径 - 含 .. 父级段 - 以 path-traversal 拒绝', async () => {
		await expectValidationError(
			Promise.resolve().then(() => assertSafeRecordPath('notes/../../etc/passwd')),
			'path-traversal',
		);
		await expectValidationError(
			Promise.resolve().then(() => assertSafeRecordPath('notes\\..\\..\\etc\\passwd')),
			'path-traversal',
		);
	});

	it('校验记录路径 - 合法相对路径 - 返回正斜杠规范形式', () => {
		expect(assertSafeRecordPath('notes/sub/a.md')).toBe('notes/sub/a.md');
		expect(assertSafeRecordPath('notes\\sub\\a.md')).toBe('notes/sub/a.md');
	});
});

describe('存储路径校验 assertPathWithinRoot', () => {
	it('校验存储路径 - 解析后位于代际根之外 - 以 path-escape 拒绝', async () => {
		await expectValidationError(
			assertPathWithinRoot(path.join(generationRoot, '..', 'other', 'index.json'), generationRoot),
			'path-escape',
		);
	});

	it('校验存储路径 - 经由符号链接逃出代际根 - 以 path-symlink-escape 拒绝', async () => {
		await expectValidationError(
			assertPathWithinRoot(path.join(generationRoot, 'escape-link', 'secret.txt'), generationRoot),
			'path-symlink-escape',
		);
	});

	it('校验存储路径 - 相对路径 - 以 path-not-absolute 拒绝', async () => {
		await expectValidationError(
			assertPathWithinRoot('generations/gen-1/index.json', generationRoot),
			'path-not-absolute',
		);
	});

	it('校验存储路径 - 代际根内的普通文件 - 返回解析后的绝对路径', async () => {
		const target = path.join(generationRoot, 'index.json');
		await expect(assertPathWithinRoot(target, generationRoot)).resolves.toBe(target);
		await expect(assertPathWithinRoot(generationRoot, generationRoot)).resolves.toBe(generationRoot);
	});

	it('校验存储路径 - 代际根本身是符号链接 - 根内路径仍通过且重复调用结果稳定', async () => {
		const linkedRoot = path.join(tmpRoot, 'gen-link');
		await symlink(generationRoot, linkedRoot, 'dir');
		const target = path.join(linkedRoot, 'index.json');
		// 关键路径:根 realpath 按根缓存,第二次调用复用缓存,结果必须与第一次一致。
		await expect(assertPathWithinRoot(target, linkedRoot)).resolves.toBe(target);
		await expect(assertPathWithinRoot(target, linkedRoot)).resolves.toBe(target);
	});
});

// ==================== 块集合与 checksum ====================

/** 三个块的基线块集合。 */
function createBlocks(): IndexBlockInput[] {
	return [
		{ id: 'a.md#chunk-0', vector: [0.1, 0.2, 0.3], metadata: { path: 'a.md', chunkIndex: 0 } },
		{ id: 'a.md#chunk-1', vector: [0.4, 0.5, 0.6], metadata: { path: 'a.md', chunkIndex: 1 } },
		{ id: 'a.md#chunk-2', vector: [0.7, 0.8, 0.9], metadata: { path: 'a.md', chunkIndex: 2 } },
	];
}

describe('块集合校验和 computeBlockSetHash', () => {
	it('计算块集合校验和 - 相同块与元数据 - 结果稳定为 64 位十六进制', async () => {
		const first = await computeBlockSetHash(createBlocks());
		const second = await computeBlockSetHash(createBlocks());
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect(second).toBe(first);
	});

	it('计算块集合校验和 - 元数据对象键顺序不同 - 结果相同', async () => {
		const reordered = createBlocks().map((block) => ({
			...block,
			metadata: { chunkIndex: block.metadata?.['chunkIndex'], path: block.metadata?.['path'] },
		}));
		expect(await computeBlockSetHash(reordered)).toBe(await computeBlockSetHash(createBlocks()));
	});

	it('计算块集合校验和 - 块顺序不同 - 结果不同', async () => {
		const reversed = [...createBlocks()].reverse();
		expect(await computeBlockSetHash(reversed)).not.toBe(await computeBlockSetHash(createBlocks()));
	});

	it('计算块集合校验和 - 向量值被替换但块数与维度不变 - 结果不同', async () => {
		const tampered = createBlocks();
		const second = tampered[1];
		if (!second) throw new Error('夹具缺少第二个块');
		tampered[1] = { ...second, vector: [0.4, 0.5, 0.61] };
		expect(await computeBlockSetHash(tampered)).not.toBe(await computeBlockSetHash(createBlocks()));
	});
});

describe('块元数据规范化 computeBlockSetHash', () => {
	/** 用单个块的元数据计算指纹 — 元数据之外的输入保持完全相同。 */
	function metadataHash(metadata: unknown): Promise<string> {
		return computeBlockSetHash([
			{ id: 'meta#chunk-0', vector: [1], metadata: metadata as Record<string, unknown> },
		]);
	}

	it('计算块集合校验和 - 元数据含 Date、Map 或类实例 - 以 record-shape-invalid 拒绝', async () => {
		class SampleMetadata {
			readonly value = 1;
		}
		// 关键路径:这些值经 JSON.stringify 会折叠成 {} 或丢字段,不能参与指纹。
		await expectValidationError(metadataHash(new Date(0)), 'record-shape-invalid');
		await expectValidationError(metadataHash(new Map([['a', 1]])), 'record-shape-invalid');
		await expectValidationError(metadataHash(new SampleMetadata()), 'record-shape-invalid');
	});

	it('计算块集合校验和 - 对象字段值为 undefined - 与缺失该字段指纹一致', async () => {
		expect(await metadataHash({ a: undefined })).toBe(await metadataHash({}));
	});

	it('计算块集合校验和 - 元数据经 JSON 往返 - 指纹与往返前一致', async () => {
		const metadata = { b: 1, a: undefined, c: [1, undefined, { d: undefined, e: 2 }], f: null };
		const roundTripped = JSON.parse(JSON.stringify(metadata)) as unknown;
		expect(await metadataHash(metadata)).toBe(await metadataHash(roundTripped));
	});
});

describe('块集合校验 validateBlockSet', () => {
	it('校验块集合 - 向量含 NaN - 以 vector-non-finite 拒绝', async () => {
		const blocks = createBlocks();
		const first = blocks[0];
		if (!first) throw new Error('夹具缺少第一个块');
		blocks[0] = { ...first, vector: [0.1, Number.NaN, 0.3] };
		await expectValidationError(validateBlockSet(blocks), 'vector-non-finite');
	});

	it('校验块集合 - 向量含 Infinity - 以 vector-non-finite 拒绝', async () => {
		const blocks = createBlocks();
		const first = blocks[0];
		if (!first) throw new Error('夹具缺少第一个块');
		blocks[0] = { ...first, vector: [0.1, Number.POSITIVE_INFINITY, 0.3] };
		await expectValidationError(validateBlockSet(blocks), 'vector-non-finite');
	});

	it('校验块集合 - 重复块 ID - 以 block-id-duplicate 拒绝', async () => {
		const blocks = createBlocks();
		const first = blocks[0];
		if (!first) throw new Error('夹具缺少第一个块');
		blocks[2] = { ...first, vector: [0.7, 0.8, 0.9] };
		await expectValidationError(validateBlockSet(blocks), 'block-id-duplicate');
	});

	it('校验块集合 - 声明校验和与重算不符 - 以 checksum-mismatch 拒绝', async () => {
		const blocks = createBlocks();
		await expectValidationError(
			validateBlockSet(blocks, { expectedBlockSetHash: 'f'.repeat(64) }),
			'checksum-mismatch',
		);
	});

	it('校验块集合 - 块数与声明不符 - 以 block-count-mismatch 拒绝', async () => {
		await expectValidationError(
			validateBlockSet(createBlocks(), { expectedChunkCount: 4 }),
			'block-count-mismatch',
		);
	});

	it('校验块集合 - 维度与声明不符 - 以 vector-dimension-mismatch 拒绝', async () => {
		await expectValidationError(
			validateBlockSet(createBlocks(), { expectedDimension: 512 }),
			'vector-dimension-mismatch',
		);
	});

	it('校验块集合 - 声明与内容一致 - 通过', async () => {
		const blocks = createBlocks();
		await expect(
			validateBlockSet(blocks, {
				expectedBlockSetHash: await computeBlockSetHash(blocks),
				expectedChunkCount: 3,
				expectedDimension: 3,
			}),
		).resolves.toBeUndefined();
	});
});

// ==================== 待提交事务 ====================

describe('待提交事务校验 validatePreparedFile', () => {
	it('校验待提交事务 - 合法 replace 事务 - 通过', async () => {
		await expect(validatePreparedFile(createPreparedFile(), COMMIT_OPTIONS)).resolves.toMatchObject({
			operation: 'replace',
			previousCommitId: 'commit-0',
			previousRevision: 0,
		});
	});

	it('校验待提交事务 - delete 操作仍携带分片 - 以 record-state-inconsistent 拒绝', async () => {
		const prepared = createPreparedFile();
		await expectValidationError(
			validatePreparedFile(
				{
					...prepared,
					operation: 'delete',
					next: {
						...BASE_COMMIT,
						state: 'deleted',
						inputHash: null,
						chunkCount: 0,
						blockSetHash: EMPTY_BLOCK_SET_HASH,
					},
				},
				COMMIT_OPTIONS,
			),
			'record-state-inconsistent',
		);
	});

	it('校验待提交事务 - 分片计数之和与块数不符 - 以 part-count-mismatch 拒绝', async () => {
		const prepared = createPreparedFile();
		await expectValidationError(
			validatePreparedFile(
				{ ...prepared, next: { ...BASE_COMMIT, chunkCount: 9 } },
				COMMIT_OPTIONS,
			),
			'part-count-mismatch',
		);
	});

	it('校验待提交事务 - 分片名含路径分隔符 - 以 part-name-invalid 拒绝', async () => {
		const prepared = createPreparedFile();
		const first = prepared.parts[0];
		if (!first) throw new Error('夹具缺少第一个分片');
		await expectValidationError(
			validatePreparedFile(
				{ ...prepared, parts: [{ ...first, name: '../escape.json' }] },
				COMMIT_OPTIONS,
			),
			'part-name-invalid',
		);
	});

	it('校验待提交事务 - 后继 revision 未递增 - 以 revision-not-monotonic 拒绝', async () => {
		const prepared = createPreparedFile();
		await expectValidationError(
			validatePreparedFile(
				{
					...prepared,
					next: { ...BASE_COMMIT, revision: 1 },
					previousRevision: 1,
				},
				COMMIT_OPTIONS,
			),
			'revision-not-monotonic',
		);
	});

	it('校验待提交事务 - 未知 schemaVersion - 以 schema-version-unknown 拒绝', async () => {
		const prepared = createPreparedFile();
		await expectValidationError(
			validatePreparedFile({ ...prepared, schemaVersion: 1 }, COMMIT_OPTIONS),
			'schema-version-unknown',
		);
	});

	it('校验待提交事务 - 提供事务目录且分片名是目录内普通文件 - 通过', async () => {
		await expect(
			validatePreparedFile(createPreparedFile(), { ...COMMIT_OPTIONS, transactionRoot }),
		).resolves.toMatchObject({ operation: 'replace' });
	});

	it('校验待提交事务 - 分片名在事务目录内经符号链接指向根外 - 以 path-symlink-escape 拒绝', async () => {
		const prepared = createPreparedFile();
		const first = prepared.parts[0];
		if (!first) throw new Error('夹具缺少第一个分片');
		// 关键路径:分片名本身通过词法校验,事务目录的二次包含性检查是唯一防线。
		await expectValidationError(
			validatePreparedFile(
				{ ...prepared, parts: [{ ...first, name: 'link-part.json', count: 3 }] },
				{ ...COMMIT_OPTIONS, transactionRoot },
			),
			'path-symlink-escape',
		);
	});

	it('校验待提交事务 - 分片名是跨目录引用 - 以 part-name-invalid 拒绝', async () => {
		const prepared = createPreparedFile();
		const first = prepared.parts[0];
		if (!first) throw new Error('夹具缺少第一个分片');
		await expectValidationError(
			validatePreparedFile(
				{ ...prepared, parts: [{ ...first, name: '/etc/escape.json' }] },
				{ ...COMMIT_OPTIONS, transactionRoot },
			),
			'part-name-invalid',
		);
	});
});

describe('待提交事务分片校验 verifyPreparedChecksums', () => {
	it('校验待提交事务分片 - 分片内容与声明 hash 不符 - 以 checksum-mismatch 拒绝', async () => {
		const prepared = createPreparedFile();
		const shards = new Map<string, string>([
			['shard-0', 'tampered-0'],
			['shard-1', 'part-1'],
		]);
		await expectValidationError(verifyPreparedChecksums(prepared, shards), 'checksum-mismatch');
	});

	it('校验待提交事务分片 - 声明分片缺失 - 以 part-missing 拒绝', async () => {
		const prepared = createPreparedFile();
		const shards = new Map<string, string>([['shard-0', 'part-0']]);
		await expectValidationError(verifyPreparedChecksums(prepared, shards), 'part-missing');
	});

	it('校验待提交事务分片 - 出现未声明分片 - 以 part-unexpected 拒绝', async () => {
		const prepared = createPreparedFile();
		const shards = new Map<string, string>([
			['shard-0', 'part-0'],
			['shard-1', 'part-1'],
			['shard-2', 'part-2'],
		]);
		await expectValidationError(verifyPreparedChecksums(prepared, shards), 'part-unexpected');
	});

	it('校验待提交事务分片 - 分片内容与声明一致 - 通过', async () => {
		const prepared = createPreparedFile();
		const shards = new Map<string, string>([
			['shard-0', 'part-0'],
			['shard-1', 'part-1'],
		]);
		await expect(verifyPreparedChecksums(prepared, shards)).resolves.toBeUndefined();
	});
});

// ==================== 清单契约 ====================

describe('状态与错误码清单', () => {
	it('索引阶段清单 - 与计划契约一致 - 覆盖 8 个阶段且不含未知值', () => {
		expect([...INDEX_PHASES]).toEqual([
			'scanning',
			'processing',
			'stalled',
			'stopping',
			'paused',
			'partial-failure',
			'failed',
			'ready',
		]);
	});

	it('错误码清单 - 无重复项 - 保证判别式唯一', () => {
		expect(new Set(INDEX_VALIDATION_ERROR_CODES).size).toBe(INDEX_VALIDATION_ERROR_CODES.length);
	});

	it('校验错误类型 - 抛出时 - 携带 code 与中文消息', () => {
		let error: unknown = null;
		try {
			assertSafeRecordPath('');
		} catch (caught: unknown) {
			error = caught;
		}
		expect(error).toBeInstanceOf(IndexValidationError);
		if (!(error instanceof IndexValidationError)) throw new Error('未抛出校验错误');
		expect(error.code).toBe('path-empty');
		expect(error.message).toMatch(/[\u4e00-\u9fa5]/);
	});

	it('分片名校验 - 普通文件名 - 通过；含分隔符或为点段 - 拒绝', () => {
		expect(assertSafePartName('part-000.json')).toBe('part-000.json');
		expect(() => assertSafePartName('../x.json')).toThrow(IndexValidationError);
		expect(() => assertSafePartName('..')).toThrow(IndexValidationError);
		expect(() => assertSafePartName('')).toThrow(IndexValidationError);
	});
});
