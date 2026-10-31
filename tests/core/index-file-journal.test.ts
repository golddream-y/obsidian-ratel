/**
 * @file tests/core/index-file-journal.test.ts
 * @description 文件日志与恢复状态机 — prepared 分片、完成记录、真实磁盘恢复决策与幂等清理
 * @module tests/core/index-file-journal
 * @depends core/index-file-journal, adapters/vector-vectra, adapters/atomic-index-storage,
 *   core/index-persistence-types, helpers/index-reliability-fixture
 *
 * 关键路径:
 * - 所有用例都在系统临时目录上跑真实磁盘;「重启」一律重新构造 `AtomicIndexStorage`、`VectraStore`
 *   与 `IndexFileJournal` 后再读磁盘,不用同一实例的内存状态冒充恢复。
 * - 恢复断言必须落到实际块 ID、块集合 hash、块数量与向量维度,并核对嵌入调用数;
 *   只检查返回值或状态字符串不算证明。日志自身从不嵌入,因此恢复路径上的嵌入调用数必须为 0。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VectraStore } from '../../src/adapters/vector-vectra';
import type { PreparedBlock } from '../../src/adapters/vector-vectra';
import { AtomicIndexStorage } from '../../src/adapters/atomic-index-storage';
import { IndexWriteOwnerError } from '../../src/core/index-write-owner';
import {
	IndexFileJournal,
	IndexFileJournalError,
	JOURNAL_FILES_DIRNAME,
	JOURNAL_GENERATION_QUARANTINE_FILENAME,
	JOURNAL_PENDING_DIRNAME,
	JOURNAL_PREPARED_FILENAME,
	JOURNAL_QUARANTINE_DIRNAME,
	JOURNAL_QUARANTINE_TRANSACTIONS_DIRNAME,
	type JournalRecoveryDecision,
	type JournalRecoveryReport,
	type JournalWriteOwner,
	type PreparedFile,
} from '../../src/core/index-file-journal';
import {
	EMPTY_BLOCK_SET_HASH,
	INDEX_RECORD_SCHEMA_VERSION,
	IndexValidationError,
	computeBlockSetHash,
} from '../../src/core/index-persistence-types';
import { FakeEmbeddingPort, deterministicVector } from '../helpers/index-reliability-fixture';
import { sha256 } from '../../src/utils/hash';

// ==================== 夹具 ====================

const DIMENSIONS = 64;
const GENERATION_ID = 'gen-1';
const CONFIG_FINGERPRINT = 'a'.repeat(64);

/** 可观测的写所有权门面替身 — 与 `IndexWriteOwner` 结构兼容。 */
class TestWriteOwner implements JournalWriteOwner {
	epoch = 1;
	writable = true;
	pendingCommits = 0;
	acquired = 0;

	assertWritable(): void {
		if (!this.writable) {
			throw new IndexWriteOwnerError('epoch-revoked', 'epoch 已被新实例接管(测试注入)');
		}
	}

	beginCommit(): { settle(): void } {
		this.acquired += 1;
		this.pendingCommits += 1;
		let settled = false;
		return {
			settle: (): void => {
				if (settled) return;
				settled = true;
				this.pendingCommits -= 1;
			},
		};
	}
}

/** 一次「进程生命周期」内的完整装配;对同一目录再次构造即为重启。 */
interface Harness {
	readonly dir: string;
	readonly gate: TestWriteOwner;
	readonly store: VectraStore;
	readonly storage: AtomicIndexStorage;
	readonly port: FakeEmbeddingPort;
	readonly journal: IndexFileJournal;
	readonly replaceSpy: ReturnType<typeof vi.spyOn>;
	replaceCalls(): number;
}

async function createHarness(dir: string): Promise<Harness> {
	const storage = new AtomicIndexStorage({ generationRoot: dir });
	const store = new VectraStore(dir, { storage });
	await store.init();
	const port = new FakeEmbeddingPort(DIMENSIONS);
	const gate = new TestWriteOwner();
	const journal = new IndexFileJournal({
		generationRoot: dir,
		generationId: GENERATION_ID,
		configFingerprint: CONFIG_FINGERPRINT,
		owner: gate,
		store,
		storage,
		expectedDimension: DIMENSIONS,
	});
	const replaceSpy = vi.spyOn(store, 'replaceFile');
	return {
		dir,
		gate,
		store,
		storage,
		port,
		journal,
		replaceSpy,
		replaceCalls: () => replaceSpy.mock.calls.length,
	};
}

/** 正文切片 — 日志不负责分块,这里是最小测试分块器。 */
function chunkText(content: string): string[] {
	return content.length === 0 ? [] : content.split('\n').filter((line) => line.length > 0);
}

/** 一次文件版本的暂存结果。 */
interface Draft {
	transactionId: string;
	prepared: PreparedFile;
	blocks: PreparedBlock[];
}

/** 只用日志准备一个版本(嵌入 → 分片 → prepared),不替换向量。 */
async function draftVersion(
	harness: Harness,
	filePath: string,
	content: string,
	options: { revision?: number } = {},
): Promise<Draft> {
	const texts = chunkText(content);
	const vectors = texts.length === 0 ? [] : await harness.port.embed(texts);
	const previous = await harness.journal.readReceipt(filePath);
	const blocks: PreparedBlock[] = texts.map((text, index) => ({
		id: `${filePath}#chunk-${index}`,
		vector: vectors[index] ?? deterministicVector(text, DIMENSIONS),
		metadata: { index, length: text.length },
	}));
	const result = await harness.journal.prepare({
		path: filePath,
		operation: 'replace',
		inputHash: await sha256(content),
		revision: options.revision ?? (previous?.revision ?? 0) + 1,
		previousCommitId: previous?.commitId ?? null,
		previousRevision: previous?.revision ?? 0,
		blocks,
	});
	// 断言口径:分片必须原样保存本次嵌入的块 ID 与向量;断言使用磁盘真实块(含日志补写的版本元数据)。
	const stored = await readShardBlocksFromDisk(harness, result.transactionId, result.prepared);
	expect(stored.map((block) => block.id)).toEqual(blocks.map((block) => block.id));
	expect(stored.map((block) => block.vector)).toEqual(blocks.map((block) => block.vector));
	return { ...result, blocks: stored };
}

/** 走日志完整提交一个版本。 */
async function indexThroughJournal(
	harness: Harness,
	filePath: string,
	content: string,
	options: { revision?: number } = {},
): Promise<Draft> {
	const draft = await draftVersion(harness, filePath, content, options);
	await harness.journal.commit(draft.transactionId);
	return draft;
}

/** 走日志提交一次删除(零块事务)。 */
async function deleteThroughJournal(harness: Harness, filePath: string): Promise<Draft> {
	const previous = await harness.journal.readReceipt(filePath);
	const result = await harness.journal.prepare({
		path: filePath,
		operation: 'delete',
		inputHash: null,
		revision: (previous?.revision ?? 0) + 1,
		previousCommitId: previous?.commitId ?? null,
		previousRevision: previous?.revision ?? 0,
		blocks: [],
	});
	await harness.journal.commit(result.transactionId);
	return { ...result, blocks: [] };
}

// ==================== 真实磁盘读取辅助 ====================

async function readPreparedFromDisk(harness: Harness, transactionId: string): Promise<PreparedFile> {
	const target = path.join(harness.dir, JOURNAL_PENDING_DIRNAME, transactionId, JOURNAL_PREPARED_FILENAME);
	return JSON.parse(await fs.promises.readFile(target, 'utf8')) as PreparedFile;
}

/** 直接读磁盘分片并还原成替换输入 — 证明重放来源是真实磁盘。 */
async function readShardBlocksFromDisk(
	harness: Harness,
	transactionId: string,
	prepared: PreparedFile,
): Promise<PreparedBlock[]> {
	const transactionDir = path.join(harness.dir, JOURNAL_PENDING_DIRNAME, transactionId);
	const blocks: PreparedBlock[] = [];
	for (const part of prepared.parts) {
		const raw = await fs.promises.readFile(path.join(transactionDir, part.name), 'utf8');
		blocks.push(...(JSON.parse(raw) as PreparedBlock[]));
	}
	return blocks;
}

/** 待提交事务目录内的全部文件(相对文件名 → 内容),用于把陈旧日志原样放回磁盘。 */
async function readTransactionFiles(harness: Harness, transactionId: string): Promise<Map<string, string>> {
	const transactionDir = path.join(harness.dir, JOURNAL_PENDING_DIRNAME, transactionId);
	const files = new Map<string, string>();
	for (const name of await fs.promises.readdir(transactionDir)) {
		files.set(name, await fs.promises.readFile(path.join(transactionDir, name), 'utf8'));
	}
	return files;
}

async function plantTransactionFiles(
	harness: Harness,
	transactionId: string,
	files: ReadonlyMap<string, string>,
): Promise<void> {
	const transactionDir = path.join(harness.dir, JOURNAL_PENDING_DIRNAME, transactionId);
	await fs.promises.mkdir(transactionDir, { recursive: true });
	for (const [name, content] of files) {
		await fs.promises.writeFile(path.join(transactionDir, name), content, 'utf8');
	}
}

function pendingTransactionIds(harness: Harness): string[] {
	const pendingRoot = path.join(harness.dir, JOURNAL_PENDING_DIRNAME);
	if (!fs.existsSync(pendingRoot)) return [];
	return fs.readdirSync(pendingRoot).sort();
}

function pathHashSync(filePath: string): string {
	const normalized = filePath.split(/[\\/]+/).filter((segment) => segment.length > 0).join('/');
	return createHash('sha256').update(normalized).digest('hex');
}

async function readReceiptFromDisk(
	harness: Harness,
	filePath: string,
): Promise<Record<string, unknown> | null> {
	const target = path.join(harness.dir, JOURNAL_FILES_DIRNAME, `${pathHashSync(filePath)}.json`);
	try {
		return JSON.parse(await fs.promises.readFile(target, 'utf8')) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/** 实际磁盘块集合的可核对形态。 */
interface DiskBlockSummary {
	ids: string[];
	commitIds: string[];
	dimensions: number[];
	hash: string;
	count: number;
	vectors: string[];
}

async function inspectDisk(harness: Harness, filePath: string): Promise<DiskBlockSummary> {
	const blocks = await harness.store.inspectFile(filePath);
	return {
		ids: blocks.map((block) => block.id),
		commitIds: [...new Set(blocks.map((block) => String(block.metadata.commitId)))],
		dimensions: [...new Set(blocks.map((block) => block.vector.length))],
		hash: await computeBlockSetHash(blocks),
		count: blocks.length,
		vectors: blocks.map((block) => JSON.stringify(block.vector)),
	};
}

/** 断言磁盘块集合逐项等于预期块:数量、有序 ID、向量值、维度与块集合 hash。 */
async function expectDiskEquals(harness: Harness, filePath: string, expected: PreparedBlock[]): Promise<void> {
	const actual = await inspectDisk(harness, filePath);
	expect(actual.count).toBe(expected.length);
	expect(actual.ids).toEqual(expected.map((block) => block.id));
	expect(actual.ids.length).toBe(new Set(actual.ids).size);
	expect(actual.vectors).toEqual(expected.map((block) => JSON.stringify(block.vector)));
	expect(actual.dimensions).toEqual(expected.length === 0 ? [] : [DIMENSIONS]);
	expect(actual.hash).toBe(await computeBlockSetHash(expected));
}

function decisionFor(report: JournalRecoveryReport, filePath: string): JournalRecoveryDecision | undefined {
	return report.decisions.find((entry) => entry.path === filePath);
}

function expectDecision(report: JournalRecoveryReport, filePath: string): JournalRecoveryDecision {
	const decision = decisionFor(report, filePath);
	if (decision === undefined) throw new Error(`恢复报告缺少路径 ${filePath} 的决策`);
	return decision;
}

/** 目录内容快照 — 只比较相对路径与文件内容,用于断言「磁盘未被改动」。 */
function snapshotDirectory(dir: string): Record<string, string> {
	const result: Record<string, string> = {};
	const walk = (current: string): void => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const absolute = path.join(current, entry.name);
			if (entry.isDirectory()) walk(absolute);
			else result[path.relative(dir, absolute)] = fs.readFileSync(absolute, 'utf8');
		}
	};
	walk(dir);
	return result;
}

// ==================== 用例 ====================

describe('文件日志 - 记录与目录约定', () => {
	let dir: string;
	let harness: Harness;

	beforeEach(async () => {
		dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ratel-journal-'));
		harness = await createHarness(dir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.promises.rm(dir, { recursive: true, force: true });
	});

	it('提交 - 走日志提交一篇文件 - 完成记录落在 files/<pathHash>.json 且块内 commitId 一致', async () => {
		const content = 'alpha\nbravo\ncharlie';
		const draft = await indexThroughJournal(harness, 'notes/a.md', content);

		// 目录与命名约定。
		expect(fs.existsSync(path.join(dir, JOURNAL_FILES_DIRNAME, `${pathHashSync('notes/a.md')}.json`))).toBe(true);
		expect(pendingTransactionIds(harness)).toEqual([]);

		const receipt = await harness.journal.readReceipt('notes/a.md');
		expect(receipt?.path).toBe('notes/a.md');
		expect(receipt?.schemaVersion).toBe(INDEX_RECORD_SCHEMA_VERSION);
		expect(receipt?.generationId).toBe(GENERATION_ID);
		expect(receipt?.configFingerprint).toBe(CONFIG_FINGERPRINT);
		expect(receipt?.state).toBe('present');
		expect(receipt?.inputHash).toBe(await sha256(content));
		expect(receipt?.revision).toBe(1);
		expect(receipt?.chunkCount).toBe(3);

		// 块内 commitId、块集合 hash 与实际磁盘逐一对应。
		const disk = await inspectDisk(harness, 'notes/a.md');
		expect(disk.commitIds).toEqual([receipt?.commitId]);
		expect(disk.ids).toEqual(['notes/a.md#chunk-0', 'notes/a.md#chunk-1', 'notes/a.md#chunk-2']);
		expect(disk.hash).toBe(receipt?.blockSetHash);
		expect(disk.dimensions).toEqual([DIMENSIONS]);
		await expectDiskEquals(harness, 'notes/a.md', draft.blocks);
	});

	it('校验 - 完成记录内的路径与文件名 pathHash 不匹配 - readReceipt 以 receipt-path-mismatch 拒绝', async () => {
		await indexThroughJournal(harness, 'notes/a.md', 'alpha');
		const stored = (await readReceiptFromDisk(harness, 'notes/a.md'))!;
		// 文件名按 notes/d.md 命名,记录内却声明 notes/e.md → 归属不一致。
		await fs.promises.writeFile(
			path.join(dir, JOURNAL_FILES_DIRNAME, `${pathHashSync('notes/d.md')}.json`),
			JSON.stringify({ ...stored, path: 'notes/e.md' }),
			'utf8',
		);
		await expect(harness.journal.readReceipt('notes/d.md')).rejects.toMatchObject({ code: 'receipt-path-mismatch' });
		expect((await harness.journal.readReceipt('notes/a.md'))?.path).toBe('notes/a.md');
	});

	it('校验 - 日志路径越界或非法 - 复用 T1 的 IndexValidationError 拒绝访问', async () => {
		await expect(harness.journal.readReceipt('../escape.md')).rejects.toBeInstanceOf(IndexValidationError);
		await expect(harness.journal.readReceipt('../escape.md')).rejects.toMatchObject({ code: 'path-traversal' });
		await expect(harness.journal.readReceipt('/abs/escape.md')).rejects.toMatchObject({ code: 'path-absolute' });
		await expect(harness.journal.cleanup('a/b')).rejects.toMatchObject({ code: 'part-name-invalid' });
		await expect(harness.journal.cleanup('..')).rejects.toMatchObject({ code: 'part-name-invalid' });
	});

	it('校验 - 分片未全部完整 - 不写 prepared.json 且不具备重放资格', async () => {
		const texts = ['alpha', 'bravo', 'charlie'];
		const vectors = await harness.port.embed(texts);
		const blocks: PreparedBlock[] = texts.map((text, index) => ({
			id: `notes/c.md#chunk-${index}`,
			vector: vectors[index] ?? deterministicVector(text, DIMENSIONS),
			metadata: { index },
		}));
		const original = harness.storage.upsertFile.bind(harness.storage);
		const upsert = vi.spyOn(harness.storage, 'upsertFile');
		let writes = 0;
		upsert.mockImplementation(async (filePath, content) => {
			writes += 1;
			if (writes === 2) throw new Error('注入故障:第二片写入失败');
			await original(filePath, content);
		});
		await expect(
			harness.journal.prepare({
				path: 'notes/c.md',
				operation: 'replace',
				inputHash: await sha256('alpha\nbravo\ncharlie'),
				revision: 1,
				previousCommitId: null,
				previousRevision: 0,
				blocks,
				partSize: 1,
			}),
		).rejects.toThrow('注入故障:第二片写入失败');
		upsert.mockRestore();

		const transactions = pendingTransactionIds(harness);
		expect(transactions).toHaveLength(1);
		expect(fs.existsSync(path.join(dir, JOURNAL_PENDING_DIRNAME, transactions[0]!, JOURNAL_PREPARED_FILENAME))).toBe(false);
		const disk = await inspectDisk(harness, 'notes/c.md');
		expect(disk.count).toBe(0);

		// 恢复只能按分片内的路径归属把该文件列为重算,且不允许重放。
		const restarted = await createHarness(dir);
		const report = await restarted.journal.recover();
		const decision = expectDecision(report, 'notes/c.md');
		expect(decision.action).toBe('requeue-current');
		expect(decision.reason).toBe('incomplete-prepared');
		expect(decision.requiresReindex).toBe(true);
		expect(decision.searchable).toBe(false);
		expect(restarted.replaceCalls()).toBe(0);
		expect(restarted.port.callCount).toBe(0);
		expect(pendingTransactionIds(restarted)).toEqual([]);
		expect((await inspectDisk(restarted, 'notes/c.md')).count).toBe(0);
	});

	it('校验 - 分片内容被改写且声明 checksum 同步更新 - 块集合 hash 仍拒绝该提交', async () => {
		const draft = await draftVersion(harness, 'notes/e.md', 'alpha\nbravo');
		const transactionDir = path.join(dir, JOURNAL_PENDING_DIRNAME, draft.transactionId);
		const stored = await readPreparedFromDisk(harness, draft.transactionId);
		const firstPart = stored.parts[0]!;
		const partPath = path.join(transactionDir, firstPart.name);
		const tampered = JSON.parse(await fs.promises.readFile(partPath, 'utf8')) as PreparedBlock[];
		tampered[0] = { ...tampered[0]!, vector: tampered[0]!.vector.map((value) => value + 1) };
		const tamperedText = JSON.stringify(tampered);
		await fs.promises.writeFile(partPath, tamperedText, 'utf8');
		// 分片字节 hash 同步更新,使分片级校验通过,只剩块集合 hash 能发现篡改。
		stored.parts[0] = { ...firstPart, hash: createHash('sha256').update(tamperedText).digest('hex') };
		await fs.promises.writeFile(
			path.join(transactionDir, JOURNAL_PREPARED_FILENAME),
			JSON.stringify(stored),
			'utf8',
		);

		await expect(harness.journal.commit(draft.transactionId)).rejects.toMatchObject({ code: 'checksum-mismatch' });
		expect(await harness.journal.readReceipt('notes/e.md')).toBeNull();
		expect((await inspectDisk(harness, 'notes/e.md')).count).toBe(0);
		expect(harness.replaceCalls()).toBe(0);
	});

	it('删除 - 零块删除事务 - 持久化为 deleted 且 blockSetHash 为空集合摘要', async () => {
		await indexThroughJournal(harness, 'notes/g.md', 'alpha\nbravo');
		await deleteThroughJournal(harness, 'notes/g.md');

		const receipt = await harness.journal.readReceipt('notes/g.md');
		expect(receipt?.state).toBe('deleted');
		expect(receipt?.inputHash).toBeNull();
		expect(receipt?.chunkCount).toBe(0);
		expect(receipt?.blockSetHash).toBe(EMPTY_BLOCK_SET_HASH);
		expect(receipt?.revision).toBe(2);
		const disk = await inspectDisk(harness, 'notes/g.md');
		expect(disk.count).toBe(0);
		expect(disk.ids).toEqual([]);
		expect(disk.hash).toBe(EMPTY_BLOCK_SET_HASH);
		// 事务完成后删除凭据仍留在磁盘上,不能被提前丢掉。
		expect(await readReceiptFromDisk(harness, 'notes/g.md')).not.toBeNull();
		// 清单视图排除 tombstone,但 readReceipt 仍能取到删除凭据。
		expect(await harness.journal.listReceipts()).toEqual([]);
		expect((await harness.journal.listTombstones()).map((entry) => entry.path)).toEqual(['notes/g.md']);
	});

	it('空文件 - 以 present 与真实内容 hash 提交 - 零块但仍可复用', async () => {
		await indexThroughJournal(harness, 'notes/empty.md', '');
		const receipt = await harness.journal.readReceipt('notes/empty.md');
		expect(receipt?.state).toBe('present');
		expect(receipt?.inputHash).toBe(await sha256(''));
		expect(receipt?.chunkCount).toBe(0);
		expect(receipt?.blockSetHash).toBe(EMPTY_BLOCK_SET_HASH);
		expect((await inspectDisk(harness, 'notes/empty.md')).count).toBe(0);
		expect((await harness.journal.listReceipts()).map((entry) => entry.path)).toEqual(['notes/empty.md']);
	});

	it('同路径重建 - 删除后重新创建 - revision 单调递增且新版本替换删除凭据', async () => {
		const first = await indexThroughJournal(harness, 'notes/h.md', 'alpha');
		await deleteThroughJournal(harness, 'notes/h.md');
		const deletion = await harness.journal.readReceipt('notes/h.md');
		expect(deletion?.revision).toBe(first.prepared.next.revision + 1);
		expect(deletion?.state).toBe('deleted');

		const recreated = await indexThroughJournal(harness, 'notes/h.md', 'alpha again');
		const after = await harness.journal.readReceipt('notes/h.md');
		expect(after?.state).toBe('present');
		expect(after?.revision).toBe((deletion?.revision ?? 0) + 1);
		expect(after?.inputHash).toBe(await sha256('alpha again'));
		await expectDiskEquals(harness, 'notes/h.md', recreated.blocks);
		expect(await harness.journal.listTombstones()).toEqual([]);
	});

	it('校验 - 列表视图跳过不可信记录 - 损坏完成记录不作为成功依据', async () => {
		await indexThroughJournal(harness, 'notes/ok.md', 'alpha');
		await fs.promises.writeFile(
			path.join(dir, JOURNAL_FILES_DIRNAME, `${pathHashSync('notes/broken.md')}.json`),
			'{broken',
			'utf8',
		);
		expect((await harness.journal.listReceipts()).map((entry) => entry.path)).toEqual(['notes/ok.md']);
		await expect(harness.journal.readReceipt('notes/broken.md')).rejects.toBeInstanceOf(IndexValidationError);
	});
});

describe('文件日志 - 提交与退出位置', () => {
	let dir: string;
	let harness: Harness;

	beforeEach(async () => {
		dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ratel-journal-'));
		harness = await createHarness(dir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.promises.rm(dir, { recursive: true, force: true });
	});

	it('退出位置 - prepared 写入前中断 - 重启后无恢复决策且已提交文件零嵌入', async () => {
		const draft = await indexThroughJournal(harness, 'notes/keep.md', 'keep me');
		const receipt = await harness.journal.readReceipt('notes/keep.md');
		const disk = await inspectDisk(harness, 'notes/keep.md');
		expect(pendingTransactionIds(harness)).toEqual([]);

		const restarted = await createHarness(dir);
		const report = await restarted.journal.recover({
			currentInputs: new Map([['notes/keep.md', draft.prepared.next.inputHash]]),
		});
		expect(report.decisions).toEqual([]);
		expect(restarted.port.callCount).toBe(0);
		expect(restarted.replaceCalls()).toBe(0);
		expect(await restarted.journal.readReceipt('notes/keep.md')).toEqual(receipt);
		await expectDiskEquals(restarted, 'notes/keep.md', draft.blocks);
		expect((await inspectDisk(restarted, 'notes/keep.md')).hash).toBe(disk.hash);
	});

	it('退出位置 - 向量提交前中断 - 重启后按磁盘分片重放且嵌入调用数为 0', async () => {
		await indexThroughJournal(harness, 'notes/i.md', 'alpha');
		const draft = await draftVersion(harness, 'notes/i.md', 'alpha\nbravo');
		const shardBlocks = await readShardBlocksFromDisk(harness, draft.transactionId, draft.prepared);

		const restarted = await createHarness(dir);
		const report = await restarted.journal.recover({
			currentInputs: new Map([['notes/i.md', draft.prepared.next.inputHash]]),
		});
		const decision = expectDecision(report, 'notes/i.md');
		expect(decision.action).toBe('replayed');
		expect(decision.reason).toBe('input-matches-replay');
		expect(decision.requiresReindex).toBe(false);
		expect(decision.searchable).toBe(true);
		// 关键路径:重放走磁盘分片,不再调用嵌入模型。
		expect(restarted.port.callCount).toBe(0);
		await expectDiskEquals(restarted, 'notes/i.md', shardBlocks);
		const receipt = await restarted.journal.readReceipt('notes/i.md');
		expect(receipt?.revision).toBe(draft.prepared.next.revision);
		expect(receipt?.commitId).toBe(draft.prepared.next.commitId);
		expect(receipt?.blockSetHash).toBe(await computeBlockSetHash(shardBlocks));
		expect(pendingTransactionIds(restarted)).toEqual([]);
	});

	it('退出位置 - 向量提交后完成记录前中断 - 重启后补写完成记录且嵌入调用数为 0', async () => {
		await indexThroughJournal(harness, 'notes/j.md', 'alpha');
		const draft = await draftVersion(harness, 'notes/j.md', 'alpha\nbravo');
		const shardBlocks = await readShardBlocksFromDisk(harness, draft.transactionId, draft.prepared);
		// 真实磁盘上已完成向量替换,但完成记录尚未写入。
		await harness.store.replaceFile({
			path: 'notes/j.md',
			commitId: draft.prepared.next.commitId,
			blocks: shardBlocks,
		});
		expect((await inspectDisk(harness, 'notes/j.md')).commitIds).toEqual([draft.prepared.next.commitId]);
		// 完成记录仍停在旧版本,新事务的完成记录尚未写出。
		expect((await harness.journal.readReceipt('notes/j.md'))?.revision).toBe(1);

		const restarted = await createHarness(dir);
		const report = await restarted.journal.recover({
			currentInputs: new Map([['notes/j.md', draft.prepared.next.inputHash]]),
		});
		const decision = expectDecision(report, 'notes/j.md');
		expect(decision.action).toBe('repaired-receipt');
		expect(decision.reason).toBe('receipt-missing-vectors-present');
		expect(decision.requiresReindex).toBe(false);
		expect(decision.searchable).toBe(true);
		expect(restarted.port.callCount).toBe(0);
		// 补写完成记录时不得再替换一次向量。
		expect(restarted.replaceCalls()).toBe(0);
		await expectDiskEquals(restarted, 'notes/j.md', shardBlocks);
		const receipt = await restarted.journal.readReceipt('notes/j.md');
		expect(receipt?.revision).toBe(draft.prepared.next.revision);
		expect(receipt?.commitId).toBe(draft.prepared.next.commitId);
		expect(receipt?.blockSetHash).toBe(draft.prepared.next.blockSetHash);
	});

	it('退出位置 - 完成记录保存后日志清理前中断 - 重启只清理日志且嵌入调用数为 0', async () => {
		await indexThroughJournal(harness, 'notes/k.md', 'alpha');
		const draft = await draftVersion(harness, 'notes/k.md', 'alpha\nbravo');
		const rm = vi.spyOn(fs.promises, 'rm').mockRejectedValue(new Error('注入故障:清理失败'));
		const committed = await harness.journal.commit(draft.transactionId);
		rm.mockRestore();
		expect(committed.cleanupPending).toBe(true);
		expect(pendingTransactionIds(harness)).toEqual([draft.transactionId]);
		const receiptAfterCommit = await harness.journal.readReceipt('notes/k.md');
		const diskAfterCommit = await inspectDisk(harness, 'notes/k.md');

		const restarted = await createHarness(dir);
		const report = await restarted.journal.recover({
			currentInputs: new Map([['notes/k.md', draft.prepared.next.inputHash]]),
		});
		const decision = expectDecision(report, 'notes/k.md');
		expect(decision.action).toBe('cleanup-only');
		expect(decision.reason).toBe('receipt-matches-prepared');
		expect(decision.requiresReindex).toBe(false);
		expect(decision.searchable).toBe(true);
		expect(report.cleanupPending).toEqual([]);
		expect(restarted.port.callCount).toBe(0);
		expect(restarted.replaceCalls()).toBe(0);
		// 完成记录与实际块都不因恢复改变 — 与恢复前的真实磁盘快照逐项比对,不是自比自。
		expect(await restarted.journal.readReceipt('notes/k.md')).toEqual(receiptAfterCommit);
		const recoveredDisk = await inspectDisk(restarted, 'notes/k.md');
		expect(recoveredDisk.ids).toEqual(diskAfterCommit.ids);
		expect(recoveredDisk.vectors).toEqual(diskAfterCommit.vectors);
		expect(recoveredDisk.commitIds).toEqual(diskAfterCommit.commitIds);
		expect((await inspectDisk(restarted, 'notes/k.md')).hash).toBe(diskAfterCommit.hash);
		expect(pendingTransactionIds(restarted)).toEqual([]);
	});

	it('退出位置 - 日志清理持续失败 - 每次恢复只重试清理且不重复嵌入', async () => {
		await indexThroughJournal(harness, 'notes/l.md', 'alpha');
		const draft = await draftVersion(harness, 'notes/l.md', 'alpha\nbravo');
		const rm = vi.spyOn(fs.promises, 'rm').mockRejectedValue(new Error('注入故障:清理持续失败'));
		expect((await harness.journal.commit(draft.transactionId)).cleanupPending).toBe(true);
		const diskAfterCommit = await inspectDisk(harness, 'notes/l.md');
		const receiptAfterCommit = await harness.journal.readReceipt('notes/l.md');

		for (const attempt of [1, 2]) {
			const restarted = await createHarness(dir);
			const report = await restarted.journal.recover();
			const decision = expectDecision(report, 'notes/l.md');
			expect(decision.action, `第 ${attempt} 次恢复`).toBe('cleanup-only');
			expect(decision.requiresReindex, `第 ${attempt} 次恢复`).toBe(false);
			expect(restarted.port.callCount, `第 ${attempt} 次恢复`).toBe(0);
			expect(restarted.replaceCalls(), `第 ${attempt} 次恢复`).toBe(0);
			expect(report.cleanupPending, `第 ${attempt} 次恢复`).toEqual([draft.transactionId]);
			expect(await restarted.journal.readReceipt('notes/l.md'), `第 ${attempt} 次恢复`).toEqual(receiptAfterCommit);
			expect((await inspectDisk(restarted, 'notes/l.md')).hash, `第 ${attempt} 次恢复`).toBe(diskAfterCommit.hash);
		}

		rm.mockRestore();
		const finalRestart = await createHarness(dir);
		const finalReport = await finalRestart.journal.recover();
		expect(expectDecision(finalReport, 'notes/l.md').action).toBe('cleanup-only');
		expect(finalReport.cleanupPending).toEqual([]);
		expect(finalRestart.port.callCount).toBe(0);
		expect(pendingTransactionIds(finalRestart)).toEqual([]);
	});

	it('退出位置 - 向量提交失败 - 不写完成记录且保留待提交日志供恢复', async () => {
		const draft = await draftVersion(harness, 'notes/m.md', 'alpha');
		const shardBlocks = await readShardBlocksFromDisk(harness, draft.transactionId, draft.prepared);
		harness.replaceSpy.mockRejectedValueOnce(new Error('注入故障:向量替换失败'));
		await expect(harness.journal.commit(draft.transactionId)).rejects.toThrow('注入故障:向量替换失败');
		expect(await harness.journal.readReceipt('notes/m.md')).toBeNull();
		expect(pendingTransactionIds(harness)).toEqual([draft.transactionId]);
		expect((await inspectDisk(harness, 'notes/m.md')).count).toBe(0);

		const restarted = await createHarness(dir);
		const report = await restarted.journal.recover({
			currentInputs: new Map([['notes/m.md', draft.prepared.next.inputHash]]),
		});
		expect(expectDecision(report, 'notes/m.md').action).toBe('replayed');
		expect(restarted.port.callCount).toBe(0);
		await expectDiskEquals(restarted, 'notes/m.md', shardBlocks);
		expect((await restarted.journal.readReceipt('notes/m.md'))?.commitId).toBe(draft.prepared.next.commitId);
	});

	it('重启 - 两篇均已提交且一篇遗留未完成日志 - 已提交且未变文件的嵌入调用数为 0', async () => {
		const first = await indexThroughJournal(harness, 'notes/n1.md', 'one');
		await indexThroughJournal(harness, 'notes/n2.md', 'two\nlines');
		// 让 n2 的日志留在磁盘上(完成记录写成功、清理未完成),然后重启。
		const draft = await draftVersion(harness, 'notes/n2.md', 'two\nlines');
		const rm = vi.spyOn(fs.promises, 'rm').mockRejectedValue(new Error('注入故障:清理失败'));
		const committed = await harness.journal.commit(draft.transactionId);
		rm.mockRestore();
		expect(committed.cleanupPending).toBe(true);
		expect(pendingTransactionIds(harness)).toEqual([draft.transactionId]);
		const receipts = {
			first: await harness.journal.readReceipt('notes/n1.md'),
			second: await harness.journal.readReceipt('notes/n2.md'),
		};
		const disk = {
			first: await inspectDisk(harness, 'notes/n1.md'),
			second: await inspectDisk(harness, 'notes/n2.md'),
		};
		expect(receipts.second?.revision).toBe(draft.prepared.next.revision);

		const restarted = await createHarness(dir);
		const report = await restarted.journal.recover({
			currentInputs: new Map([
				['notes/n1.md', first.prepared.next.inputHash],
				['notes/n2.md', draft.prepared.next.inputHash],
			]),
		});
		// 已提交且未变的文件不产生任何嵌入,磁盘块集合与完成记录逐字不变。
		expect(restarted.port.callCount).toBe(0);
		expect(restarted.replaceCalls()).toBe(0);
		expect((await inspectDisk(restarted, 'notes/n1.md')).hash).toBe(disk.first.hash);
		expect((await inspectDisk(restarted, 'notes/n1.md')).ids).toEqual(disk.first.ids);
		expect((await inspectDisk(restarted, 'notes/n2.md')).hash).toBe(disk.second.hash);
		expect((await inspectDisk(restarted, 'notes/n2.md')).vectors).toEqual(disk.second.vectors);
		expect(await restarted.journal.readReceipt('notes/n1.md')).toEqual(receipts.first);
		expect(await restarted.journal.readReceipt('notes/n2.md')).toEqual(receipts.second);
		const n2Decision = expectDecision(report, 'notes/n2.md');
		expect(n2Decision.action).toBe('cleanup-only');
		expect(n2Decision.requiresReindex).toBe(false);
		expect(decisionFor(report, 'notes/n1.md')).toBeUndefined();
		expect(pendingTransactionIds(restarted)).toEqual([]);
	});
});

describe('文件日志 - 恢复决策表', () => {
	let dir: string;
	let harness: Harness;

	beforeEach(async () => {
		dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ratel-journal-'));
		harness = await createHarness(dir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.promises.rm(dir, { recursive: true, force: true });
	});

	it('决策 1 - prepared 无效但可可信归属 - 隔离该路径并只重算该文件', async () => {
		await indexThroughJournal(harness, 'notes/p1.md', 'alpha');
		const other = await indexThroughJournal(harness, 'notes/p2.md', 'bravo');
		const pendingTransaction = 'f'.repeat(32);
		const transactionDir = path.join(dir, JOURNAL_PENDING_DIRNAME, pendingTransaction);
		await fs.promises.mkdir(transactionDir, { recursive: true });
		await fs.promises.writeFile(
			path.join(transactionDir, JOURNAL_PREPARED_FILENAME),
			JSON.stringify({
				schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
				operation: 'replace',
				next: { path: 'notes/p1.md', revision: 'not-a-number' },
				previousCommitId: null,
				previousRevision: 0,
				parts: [],
			}),
			'utf8',
		);

		const restarted = await createHarness(dir);
		const report = await restarted.journal.recover();
		const decision = expectDecision(report, 'notes/p1.md');
		expect(decision.action).toBe('quarantined-path');
		expect(decision.reason).toBe('invalid-prepared');
		expect(decision.requiresReindex).toBe(true);
		expect(decision.searchable).toBe(false);
		const state = await restarted.journal.readPathState('notes/p1.md');
		expect(state?.kind).toBe('quarantined');
		expect(state?.transactionId).toBe(pendingTransaction);
		expect(state?.diskCommitId).toBeNull();
		// 其他文件不被牵连。
		expect(report.decisions).toHaveLength(1);
		expect(await restarted.journal.readPathState('notes/p2.md')).toBeNull();
		expect((await inspectDisk(restarted, 'notes/p2.md')).hash).toBe(other.prepared.next.blockSetHash);
		expect(restarted.port.callCount).toBe(0);
		// 隔离记录持久化后可再次读取。
		const again = await createHarness(dir);
		expect((await again.journal.readPathState('notes/p1.md'))?.reason).toBe('invalid-prepared');
	});

	it('决策 1 - prepared 无效且无法归属 - 隔离整个代际并拒绝继续写入', async () => {
		await indexThroughJournal(harness, 'notes/q1.md', 'alpha');
		const pendingTransaction = 'e'.repeat(32);
		const transactionDir = path.join(dir, JOURNAL_PENDING_DIRNAME, pendingTransaction);
		await fs.promises.mkdir(transactionDir, { recursive: true });
		await fs.promises.writeFile(path.join(transactionDir, JOURNAL_PREPARED_FILENAME), '{not-json-at-all', 'utf8');

		const restarted = await createHarness(dir);
		const report = await restarted.journal.recover();
		expect(report.generationQuarantine?.reason).toBe('unattributable-prepared');
		const decision = report.decisions.find((entry) => entry.path === null);
		expect(decision?.action).toBe('quarantined-generation');
		expect(decision?.requiresReindex).toBe(false);
		expect(await restarted.journal.isGenerationQuarantined()).toBe(true);
		expect(
			fs.existsSync(path.join(dir, JOURNAL_QUARANTINE_DIRNAME, JOURNAL_GENERATION_QUARANTINE_FILENAME)),
		).toBe(true);
		expect(pendingTransactionIds(restarted)).toEqual([pendingTransaction]);

		// 代际隔离后不得再开始新的写入,也不得重放。
		const before = snapshotDirectory(dir);
		await expect(
			restarted.journal.prepare({
				path: 'notes/q2.md',
				operation: 'replace',
				inputHash: await sha256('later'),
				revision: 1,
				previousCommitId: null,
				previousRevision: 0,
				blocks: [],
			}),
		).rejects.toMatchObject({ code: 'generation-quarantined' });
		await expect(restarted.journal.recover()).resolves.toMatchObject({
			generationQuarantine: { reason: 'unattributable-prepared' },
		});
		expect(snapshotDirectory(dir)).toEqual(before);
		expect(restarted.port.callCount).toBe(0);
		expect(restarted.replaceCalls()).toBe(0);
	});

	it('决策 2 - 完成记录 revision 高于 prepared - 验证后清理旧日志且不覆盖后继版本', async () => {
		await indexThroughJournal(harness, 'notes/r.md', 'alpha');
		// 先准备一个 rev2 的陈旧日志并把它挪出 pending,再让后继提交到 rev3。
		const stale = await draftVersion(harness, 'notes/r.md', 'alpha\nbravo');
		const staleFiles = await readTransactionFiles(harness, stale.transactionId);
		await harness.journal.cleanup(stale.transactionId);
		await indexThroughJournal(harness, 'notes/r.md', 'alpha\ncharlie', { revision: 3 });
		const receipt = await harness.journal.readReceipt('notes/r.md');
		const disk = await inspectDisk(harness, 'notes/r.md');
		expect(receipt?.revision).toBe(3);
		expect(stale.prepared.next.revision).toBe(2);
		await plantTransactionFiles(harness, stale.transactionId, staleFiles);

		const restarted = await createHarness(dir);
		const report = await restarted.journal.recover({
			currentInputs: new Map([['notes/r.md', receipt?.inputHash ?? '']]),
		});
		const decision = expectDecision(report, 'notes/r.md');
		expect(decision.action).toBe('cleanup-only');
		expect(decision.reason).toBe('receipt-ahead');
		expect(decision.requiresReindex).toBe(false);
		expect(decision.searchable).toBe(true);
		expect(restarted.replaceCalls()).toBe(0);
		expect(restarted.port.callCount).toBe(0);
		// 后继版本绝不被旧日志覆盖。
		expect(await restarted.journal.readReceipt('notes/r.md')).toEqual(receipt);
		expect((await inspectDisk(restarted, 'notes/r.md')).hash).toBe(disk.hash);
		expect((await inspectDisk(restarted, 'notes/r.md')).commitIds).toEqual([receipt?.commitId]);
		expect(pendingTransactionIds(restarted)).toEqual([]);
	});

	it('决策 3 - prepared 有效且当前输入匹配 - 检查完整块集合后重放暂存向量', async () => {
		await indexThroughJournal(harness, 'notes/s.md', 'alpha');
		const draft = await draftVersion(harness, 'notes/s.md', 'alpha\nbravo');
		const shardBlocks = await readShardBlocksFromDisk(harness, draft.transactionId, draft.prepared);

		const restarted = await createHarness(dir);
		const report = await restarted.journal.recover({
			currentInputs: new Map([['notes/s.md', draft.prepared.next.inputHash]]),
		});
		const decision = expectDecision(report, 'notes/s.md');
		expect(decision.action).toBe('replayed');
		expect(decision.requiresReindex).toBe(false);
		expect(decision.searchable).toBe(true);
		expect(restarted.port.callCount).toBe(0);
		await expectDiskEquals(restarted, 'notes/s.md', shardBlocks);
		const receipt = await restarted.journal.readReceipt('notes/s.md');
		expect(receipt?.blockSetHash).toBe(await computeBlockSetHash(shardBlocks));
		expect(receipt?.chunkCount).toBe(shardBlocks.length);
		expect(receipt?.commitId).toBe(draft.prepared.next.commitId);
	});

	it('决策 3 - prepared 有效且当前输入匹配但向量已提交 - 检查完整块集合后补完成记录', async () => {
		await indexThroughJournal(harness, 'notes/t.md', 'alpha');
		const draft = await draftVersion(harness, 'notes/t.md', 'alpha\nbravo');
		const shardBlocks = await readShardBlocksFromDisk(harness, draft.transactionId, draft.prepared);
		await harness.store.replaceFile({
			path: 'notes/t.md',
			commitId: draft.prepared.next.commitId,
			blocks: shardBlocks,
		});

		const restarted = await createHarness(dir);
		const report = await restarted.journal.recover({
			currentInputs: new Map([['notes/t.md', draft.prepared.next.inputHash]]),
		});
		expect(expectDecision(report, 'notes/t.md').action).toBe('repaired-receipt');
		expect(restarted.replaceCalls()).toBe(0);
		expect(restarted.port.callCount).toBe(0);
		await expectDiskEquals(restarted, 'notes/t.md', shardBlocks);
		expect((await restarted.journal.readReceipt('notes/t.md'))?.commitId).toBe(draft.prepared.next.commitId);
	});

	it('决策 4 - prepared 已过期且磁盘仍是旧提交 - 保留旧完整结果并排队当前版本', async () => {
		const first = await indexThroughJournal(harness, 'notes/u.md', 'alpha');
		const oldReceipt = await harness.journal.readReceipt('notes/u.md');
		const oldDisk = await inspectDisk(harness, 'notes/u.md');
		await draftVersion(harness, 'notes/u.md', 'alpha\nbravo');

		const restarted = await createHarness(dir);
		const report = await restarted.journal.recover({
			// 当前内容既不是旧版本也不是暂存版本 → 暂存事务已过期。
			currentInputs: new Map([['notes/u.md', await sha256('alpha\nbravo\ncharlie')]]),
		});
		const decision = expectDecision(report, 'notes/u.md');
		expect(decision.action).toBe('requeue-current');
		expect(decision.reason).toBe('expired-input-old-disk');
		expect(decision.requiresReindex).toBe(true);
		expect(decision.searchable).toBe(true);
		expect(restarted.replaceCalls()).toBe(0);
		expect(restarted.port.callCount).toBe(0);
		// 旧完整结果原样保留。
		expect(await restarted.journal.readReceipt('notes/u.md')).toEqual(oldReceipt);
		expect((await inspectDisk(restarted, 'notes/u.md')).hash).toBe(oldDisk.hash);
		expect((await inspectDisk(restarted, 'notes/u.md')).ids).toEqual(oldDisk.ids);
		expect((await inspectDisk(restarted, 'notes/u.md')).vectors).toEqual(oldDisk.vectors);
		expect(await restarted.journal.readPathState('notes/u.md')).toBeNull();
		expect(pendingTransactionIds(restarted)).toEqual([]);
		expect(first.prepared.next.revision).toBe(1);
	});

	it('决策 4 - 过期事务且旧提交为空文件 - 磁盘无块仍判定为旧完整结果', async () => {
		// 空文件旧提交是 present + 零块;「磁盘无块」不能单独当成未提交或已提交。
		await indexThroughJournal(harness, 'notes/u2.md', '');
		const oldReceipt = await harness.journal.readReceipt('notes/u2.md');
		await draftVersion(harness, 'notes/u2.md', 'alpha\nbravo');

		const restarted = await createHarness(dir);
		const report = await restarted.journal.recover({
			currentInputs: new Map([['notes/u2.md', await sha256('changed')]]),
		});
		const decision = expectDecision(report, 'notes/u2.md');
		expect(decision.action).toBe('requeue-current');
		expect(decision.reason).toBe('expired-input-old-disk');
		expect(decision.searchable).toBe(true);
		expect(decision.requiresReindex).toBe(true);
		expect(await restarted.journal.readReceipt('notes/u2.md')).toEqual(oldReceipt);
		expect((await restarted.journal.verifyReceipt('notes/u2.md'))?.matches).toBe(true);
		expect((await inspectDisk(restarted, 'notes/u2.md')).count).toBe(0);
		expect(restarted.replaceCalls()).toBe(0);
		expect(restarted.port.callCount).toBe(0);
	});

	it('决策 5 - prepared 已过期且磁盘含过期新提交 - 持久过滤路径并保留恢复依据', async () => {
		await indexThroughJournal(harness, 'notes/v.md', 'alpha');
		const oldReceipt = await harness.journal.readReceipt('notes/v.md');
		const draft = await draftVersion(harness, 'notes/v.md', 'alpha\nbravo');
		const shardBlocks = await readShardBlocksFromDisk(harness, draft.transactionId, draft.prepared);
		// 向量已被过期事务替换,完成记录尚未写出。
		await harness.store.replaceFile({
			path: 'notes/v.md',
			commitId: draft.prepared.next.commitId,
			blocks: shardBlocks,
		});

		const restarted = await createHarness(dir);
		const report = await restarted.journal.recover({
			currentInputs: new Map([['notes/v.md', await sha256('alpha\nbravo\ncharlie')]]),
		});
		const decision = expectDecision(report, 'notes/v.md');
		expect(decision.action).toBe('blocked-current');
		expect(decision.reason).toBe('expired-input-committed');
		expect(decision.requiresReindex).toBe(true);
		expect(decision.searchable).toBe(false);
		// 不可用状态必须持久化,且旧完成记录仍在(不能把旧 receipt 当磁盘真值)。
		const state = await restarted.journal.readPathState('notes/v.md');
		expect(state?.kind).toBe('unavailable');
		expect(state?.reason).toBe('expired-input-committed');
		expect(state?.transactionId).toBe(draft.transactionId);
		expect(state?.diskCommitId).toBe(draft.prepared.next.commitId);
		expect(await restarted.journal.readReceipt('notes/v.md')).toEqual(oldReceipt);
		expect(restarted.port.callCount).toBe(0);
		await expectDiskEquals(restarted, 'notes/v.md', shardBlocks);
		// 恢复依据(待提交日志)仍在磁盘上,供当前版本重新提交时结算。
		expect(pendingTransactionIds(restarted)).toEqual([draft.transactionId]);

		// 当前版本重新提交后,不可用状态必须被清除。
		const current = await draftVersion(restarted, 'notes/v.md', 'alpha\nbravo\ncharlie');
		expect(current.prepared.next.revision).toBe((oldReceipt?.revision ?? 0) + 1);
		expect(
			fs.existsSync(
				path.join(
					dir,
					JOURNAL_QUARANTINE_DIRNAME,
					JOURNAL_QUARANTINE_TRANSACTIONS_DIRNAME,
					draft.transactionId,
					JOURNAL_PREPARED_FILENAME,
				),
			),
		).toBe(true);
		await restarted.journal.commit(current.transactionId);
		expect(await restarted.journal.readPathState('notes/v.md')).toBeNull();
		// 影响4:路径状态清除后,隔离区保留的旧事务依据必须被及时回收(spec §6)。
		expect(await restarted.journal.listQuarantinedTransactions()).toEqual([]);
		expect(
			fs.existsSync(
				path.join(
					dir,
					JOURNAL_QUARANTINE_DIRNAME,
					JOURNAL_QUARANTINE_TRANSACTIONS_DIRNAME,
					draft.transactionId,
				),
			),
		).toBe(false);
		const receipt = await restarted.journal.readReceipt('notes/v.md');
		expect(receipt?.inputHash).toBe(await sha256('alpha\nbravo\ncharlie'));
		await expectDiskEquals(restarted, 'notes/v.md', current.blocks);
		expect((await restarted.journal.verifyReceipt('notes/v.md'))?.matches).toBe(true);
		expect((await restarted.journal.listReceipts()).map((entry) => entry.path)).toEqual(['notes/v.md']);
		expect((await restarted.journal.listSearchableReceipts()).map((entry) => entry.path)).toEqual(['notes/v.md']);
	});

	it('决策 5 - 不可用状态未提交前 - 检索视图不把该路径当成功依据', async () => {
		await indexThroughJournal(harness, 'notes/v2.md', 'alpha');
		const draft = await draftVersion(harness, 'notes/v2.md', 'alpha\nbravo');
		const shardBlocks = await readShardBlocksFromDisk(harness, draft.transactionId, draft.prepared);
		await harness.store.replaceFile({
			path: 'notes/v2.md',
			commitId: draft.prepared.next.commitId,
			blocks: shardBlocks,
		});
		const restarted = await createHarness(dir);
		await restarted.journal.recover({
			currentInputs: new Map([['notes/v2.md', await sha256('changed again')]]),
		});
		// 完成记录仍指向旧版本,但磁盘块属于未记账事务 → 不能作为可检索依据。
		const verification = await restarted.journal.verifyReceipt('notes/v2.md');
		expect(verification?.matches).toBe(false);
		expect((await restarted.journal.listPathStates()).map((entry) => `${entry.path}:${entry.kind}`)).toEqual([
			'notes/v2.md:unavailable',
		]);
		// 记录本身仍在,检索视图必须排除它。
		expect((await restarted.journal.listReceipts()).map((entry) => entry.path)).toEqual(['notes/v2.md']);
		expect(await restarted.journal.listSearchableReceipts()).toEqual([]);
	});

	it('决策 6 - 完成记录与实际块匹配且事务仅剩清理 - 只清理不再嵌入', async () => {
		await indexThroughJournal(harness, 'notes/w.md', 'alpha');
		const draft = await draftVersion(harness, 'notes/w.md', 'alpha\nbravo');
		const rm = vi.spyOn(fs.promises, 'rm').mockRejectedValue(new Error('注入故障:清理失败'));
		await harness.journal.commit(draft.transactionId);
		rm.mockRestore();
		const receipt = await harness.journal.readReceipt('notes/w.md');
		const disk = await inspectDisk(harness, 'notes/w.md');
		expect(pendingTransactionIds(harness)).toEqual([draft.transactionId]);

		const restarted = await createHarness(dir);
		const report = await restarted.journal.recover({
			currentInputs: new Map([['notes/w.md', draft.prepared.next.inputHash]]),
		});
		const decision = expectDecision(report, 'notes/w.md');
		expect(decision.action).toBe('cleanup-only');
		expect(decision.reason).toBe('receipt-matches-prepared');
		expect(decision.requiresReindex).toBe(false);
		expect(restarted.replaceCalls()).toBe(0);
		expect(restarted.port.callCount).toBe(0);
		// 「验证后清理」:完成记录与实际块必须逐一匹配后才允许清理。
		const verification = await restarted.journal.verifyReceipt('notes/w.md');
		expect(verification?.matches).toBe(true);
		expect(verification?.blocks.map((block) => block.id)).toEqual(disk.ids);
		expect(verification?.blockSetHash).toBe(receipt?.blockSetHash);
		expect(verification?.blocks.every((block) => block.vector.length === DIMENSIONS)).toBe(true);
		expect(pendingTransactionIds(restarted)).toEqual([]);
	});

	it('决策 - 无未决事务且完成记录与实际块不匹配 - 不产生恢复决策也不把陈旧记录当依据', async () => {
		await indexThroughJournal(harness, 'notes/x.md', 'alpha');
		// 直接改写磁盘块,使完成记录与实际块不再一致。
		await harness.store.replaceFile({
			path: 'notes/x.md',
			commitId: 'foreign-commit',
			blocks: [{ id: 'notes/x.md#chunk-0', vector: deterministicVector('foreign', DIMENSIONS), metadata: { index: 0 } }],
		});
		const restarted = await createHarness(dir);
		const verification = await restarted.journal.verifyReceipt('notes/x.md');
		expect(verification?.matches).toBe(false);
		expect(verification?.blocks.map((block) => block.id)).toEqual(['notes/x.md#chunk-0']);
		const report = await restarted.journal.recover();
		expect(report.decisions).toEqual([]);
		expect(restarted.port.callCount).toBe(0);
		expect(restarted.replaceCalls()).toBe(0);
	});
});

describe('文件日志 - 上一个版本结算与单未决事务', () => {
	let dir: string;
	let harness: Harness;

	beforeEach(async () => {
		dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ratel-journal-'));
		harness = await createHarness(dir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.promises.rm(dir, { recursive: true, force: true });
	});

	it('版本结算 - 同路径前驱向量未提交 - 清理前驱后写入后继且同路径只有一个未决事务', async () => {
		await indexThroughJournal(harness, 'notes/y.md', 'alpha');
		const predecessor = await draftVersion(harness, 'notes/y.md', 'alpha\nbravo');
		const successor = await draftVersion(harness, 'notes/y.md', 'alpha\ncharlie');

		expect(successor.transactionId).not.toBe(predecessor.transactionId);
		expect(pendingTransactionIds(harness)).toEqual([successor.transactionId]);
		expect(await harness.journal.readPathState('notes/y.md')).toBeNull();

		await harness.journal.commit(successor.transactionId);
		const receipt = await harness.journal.readReceipt('notes/y.md');
		expect(receipt?.inputHash).toBe(await sha256('alpha\ncharlie'));
		expect(receipt?.revision).toBe(2);
		await expectDiskEquals(harness, 'notes/y.md', successor.blocks);
	});

	it('版本结算 - 同路径前驱向量已提交且输入已过期 - 先持久化不可用状态保留依据再处理当前版本', async () => {
		await indexThroughJournal(harness, 'notes/aa.md', 'alpha');
		const predecessor = await draftVersion(harness, 'notes/aa.md', 'alpha\nbravo');
		const predecessorBlocks = await readShardBlocksFromDisk(
			harness,
			predecessor.transactionId,
			predecessor.prepared,
		);
		await harness.store.replaceFile({
			path: 'notes/aa.md',
			commitId: predecessor.prepared.next.commitId,
			blocks: predecessorBlocks,
		});

		const successor = await draftVersion(harness, 'notes/aa.md', 'alpha\ncharlie');
		// 不可用状态先落盘,前驱日志移入隔离区作为保留依据。
		expect(await harness.journal.readPathState('notes/aa.md')).toMatchObject({
			kind: 'unavailable',
			reason: 'expired-input-committed',
			transactionId: predecessor.transactionId,
			diskCommitId: predecessor.prepared.next.commitId,
		});
		expect(pendingTransactionIds(harness)).toEqual([successor.transactionId]);
		expect(
			fs.existsSync(
				path.join(
					dir,
					JOURNAL_QUARANTINE_DIRNAME,
					JOURNAL_QUARANTINE_TRANSACTIONS_DIRNAME,
					predecessor.transactionId,
					JOURNAL_PREPARED_FILENAME,
				),
			),
		).toBe(true);

		await harness.journal.commit(successor.transactionId);
		expect(await harness.journal.readPathState('notes/aa.md')).toBeNull();
		const receipt = await harness.journal.readReceipt('notes/aa.md');
		expect(receipt?.inputHash).toBe(await sha256('alpha\ncharlie'));
		expect(receipt?.commitId).not.toBe(predecessor.prepared.next.commitId);
		await expectDiskEquals(harness, 'notes/aa.md', successor.blocks);
		expect((await harness.journal.verifyReceipt('notes/aa.md'))?.matches).toBe(true);
	});

	it('版本结算 - 同路径前驱向量已提交且输入仍是当前版本 - 补写前驱完成记录并拒绝后继', async () => {
		await indexThroughJournal(harness, 'notes/ab.md', 'alpha');
		const predecessor = await draftVersion(harness, 'notes/ab.md', 'alpha\nbravo');
		const predecessorBlocks = await readShardBlocksFromDisk(
			harness,
			predecessor.transactionId,
			predecessor.prepared,
		);
		await harness.store.replaceFile({
			path: 'notes/ab.md',
			commitId: predecessor.prepared.next.commitId,
			blocks: predecessorBlocks,
		});

		// 同一输入再次准备 → 前驱本身就是当前版本,应补写完成记录而不是覆盖它。
		await expect(draftVersion(harness, 'notes/ab.md', 'alpha\nbravo')).rejects.toMatchObject({
			code: 'prior-version-mismatch',
		});
		const receipt = await harness.journal.readReceipt('notes/ab.md');
		expect(receipt?.revision).toBe(2);
		expect(receipt?.commitId).toBe(predecessor.prepared.next.commitId);
		await expectDiskEquals(harness, 'notes/ab.md', predecessorBlocks);
		expect(pendingTransactionIds(harness)).toEqual([]);
		expect(await harness.journal.readPathState('notes/ab.md')).toBeNull();

		// 调用方按新的完成记录重试后继版本即可成功。
		const retry = await draftVersion(harness, 'notes/ab.md', 'alpha\ncharlie');
		await harness.journal.commit(retry.transactionId);
		expect((await harness.journal.readReceipt('notes/ab.md'))?.revision).toBe(3);
	});

	it('版本结算 - 前驱清理持续失败 - 后继提交成功且重启后只清理旧日志', async () => {
		const first = await indexThroughJournal(harness, 'notes/ak.md', 'alpha');
		const predecessor = await draftVersion(harness, 'notes/ak.md', 'alpha\nbravo');
		// 只让前驱目录的清理失败,验证「已结算但清理失败」的日志不会阻断后继版本。
		const originalRm = fs.promises.rm.bind(fs.promises);
		const rm = vi.spyOn(fs.promises, 'rm');
		rm.mockImplementation((async (
			target: Parameters<typeof originalRm>[0],
			options?: Parameters<typeof originalRm>[1],
		) => {
			if (String(target).includes(predecessor.transactionId)) {
				throw new Error('注入故障:前驱清理持续失败');
			}
			return originalRm(target, options);
		}) as typeof fs.promises.rm);
		const successor = await draftVersion(harness, 'notes/ak.md', 'alpha\ncharlie');
		expect(pendingTransactionIds(harness)).toEqual([predecessor.transactionId, successor.transactionId].sort());
		await harness.journal.commit(successor.transactionId);
		rm.mockRestore();
		const receipt = await harness.journal.readReceipt('notes/ak.md');
		expect(receipt?.inputHash).toBe(await sha256('alpha\ncharlie'));
		expect(receipt?.revision).toBe(first.prepared.next.revision + 1);
		expect((await harness.journal.verifyReceipt('notes/ak.md'))?.matches).toBe(true);
		expect(pendingTransactionIds(harness)).toEqual([predecessor.transactionId]);

		// 重启:旧日志仍在磁盘上,恢复只清理且零嵌入,后继版本绝不被覆盖。
		const restarted = await createHarness(dir);
		const report = await restarted.journal.recover({
			currentInputs: new Map([['notes/ak.md', receipt?.inputHash ?? '']]),
		});
		const decision = expectDecision(report, 'notes/ak.md');
		expect(decision.action).toBe('cleanup-only');
		expect(decision.reason).toBe('receipt-matches-prepared');
		expect(decision.requiresReindex).toBe(false);
		expect(report.decisions).toHaveLength(1);
		expect(restarted.port.callCount).toBe(0);
		expect(restarted.replaceCalls()).toBe(0);
		expect(await restarted.journal.readReceipt('notes/ak.md')).toEqual(receipt);
		await expectDiskEquals(restarted, 'notes/ak.md', successor.blocks);
		expect(pendingTransactionIds(restarted)).toEqual([]);
	});

	it('版本结算 - 声明的上一个版本 revision 与完成记录不一致 - 以 prior-version-mismatch 拒绝', async () => {
		await indexThroughJournal(harness, 'notes/ac.md', 'alpha');
		const receipt = await harness.journal.readReceipt('notes/ac.md');
		await expect(
			harness.journal.prepare({
				path: 'notes/ac.md',
				operation: 'replace',
				inputHash: await sha256('alpha\nbravo'),
				revision: 2,
				previousCommitId: null,
				previousRevision: 0,
				blocks: [],
			}),
		).rejects.toMatchObject({ code: 'prior-version-mismatch' });
		expect(await harness.journal.readReceipt('notes/ac.md')).toEqual(receipt);
		expect(pendingTransactionIds(harness)).toEqual([]);
	});

	it('清理 - 按 transactionId 校验幂等 - 重复清理成功且拒绝清理归属不符的事务', async () => {
		const draft = await draftVersion(harness, 'notes/ad.md', 'alpha');
		await harness.journal.cleanup(draft.transactionId);
		await harness.journal.cleanup(draft.transactionId);
		expect(pendingTransactionIds(harness)).toEqual([]);

		const other = await draftVersion(harness, 'notes/ae.md', 'bravo');
		const forged = '0'.repeat(32);
		await fs.promises.rename(
			path.join(dir, JOURNAL_PENDING_DIRNAME, other.transactionId),
			path.join(dir, JOURNAL_PENDING_DIRNAME, forged),
		);
		await expect(harness.journal.cleanup(forged)).rejects.toMatchObject({ code: 'transaction-mismatch' });
		expect(pendingTransactionIds(harness)).toEqual([forged]);
	});
});

describe('文件日志 - 写所有权与在途提交', () => {
	let dir: string;
	let harness: Harness;

	beforeEach(async () => {
		dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ratel-journal-'));
		harness = await createHarness(dir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.promises.rm(dir, { recursive: true, force: true });
	});

	it('写所有权 - epoch 被接管或租约失效 - 全部写入口拒绝且磁盘不变', async () => {
		await indexThroughJournal(harness, 'notes/af.md', 'alpha');
		const draft = await draftVersion(harness, 'notes/ag.md', 'bravo');
		const snapshot = snapshotDirectory(dir);
		const input = {
			path: 'notes/ah.md',
			operation: 'replace' as const,
			inputHash: await sha256('charlie'),
			revision: 1,
			previousCommitId: null,
			previousRevision: 0,
			blocks: [],
		};

		harness.gate.writable = false;
		await expect(harness.journal.prepare(input)).rejects.toMatchObject({ code: 'epoch-revoked' });
		await expect(harness.journal.commit(draft.transactionId)).rejects.toMatchObject({ code: 'epoch-revoked' });
		await expect(harness.journal.recover()).rejects.toMatchObject({ code: 'epoch-revoked' });
		await expect(harness.journal.cleanup(draft.transactionId)).rejects.toMatchObject({ code: 'epoch-revoked' });
		expect(snapshotDirectory(dir)).toEqual(snapshot);

		// 重新拿到写所有权后,绑定的旧 epoch 不再允许写入。
		harness.gate.writable = true;
		harness.gate.epoch = 2;
		await expect(harness.journal.prepare(input)).rejects.toMatchObject({ code: 'owner-epoch-mismatch' });
		await expect(harness.journal.commit(draft.transactionId)).rejects.toMatchObject({ code: 'owner-epoch-mismatch' });
		await expect(harness.journal.recover()).rejects.toMatchObject({ code: 'owner-epoch-mismatch' });
		await expect(harness.journal.cleanup(draft.transactionId)).rejects.toMatchObject({ code: 'owner-epoch-mismatch' });
		expect(snapshotDirectory(dir)).toEqual(snapshot);
	});

	it('写所有权 - 提交成功与失败 - 在途提交凭据都被结算', async () => {
		const draft = await draftVersion(harness, 'notes/ai.md', 'alpha');
		// 提交成功与失败都必须结算在途提交凭据;prepare 自身也登记一次磁盘写入。
		expect(harness.gate.pendingCommits).toBe(0);
		harness.replaceSpy.mockRejectedValueOnce(new Error('注入故障:向量替换失败'));
		await expect(harness.journal.commit(draft.transactionId)).rejects.toThrow('注入故障:向量替换失败');
		expect(harness.gate.pendingCommits).toBe(0);
		await harness.journal.commit(draft.transactionId);
		expect(harness.gate.pendingCommits).toBe(0);
		expect(harness.gate.acquired).toBe(3);
	});

	it('写所有权 - 恢复入口在日志损坏时 - 先校验所有权再读磁盘', async () => {
		const pendingTransaction = 'd'.repeat(32);
		await fs.promises.mkdir(path.join(dir, JOURNAL_PENDING_DIRNAME, pendingTransaction), { recursive: true });
		await fs.promises.writeFile(
			path.join(dir, JOURNAL_PENDING_DIRNAME, pendingTransaction, JOURNAL_PREPARED_FILENAME),
			'{broken',
			'utf8',
		);
		harness.gate.writable = false;
		await expect(harness.journal.recover()).rejects.toMatchObject({ code: 'epoch-revoked' });
		expect(await harness.journal.readPathState('notes/aj.md')).toBeNull();
		expect(
			fs.existsSync(path.join(dir, JOURNAL_QUARANTINE_DIRNAME, JOURNAL_GENERATION_QUARANTINE_FILENAME)),
		).toBe(false);
	});
});

// ==================== 阻断修复:空事务、代际隔离与显式解除 ====================

/** 造一个「有记录但不可归属」的待提交事务目录(无法解析的 prepared.json,零分片)。 */
async function plantUnattributableTransaction(dir: string, transactionId: string): Promise<void> {
	const transactionDir = path.join(dir, JOURNAL_PENDING_DIRNAME, transactionId);
	await fs.promises.mkdir(transactionDir, { recursive: true });
	await fs.promises.writeFile(path.join(transactionDir, JOURNAL_PREPARED_FILENAME), '{not-json-at-all', 'utf8');
}

/** 造一个零分片、无 prepared.json 的空事务目录(模拟 prepare 两步之间退出或 cleanup 被中断)。 */
async function plantEmptyTransaction(dir: string, transactionId: string): Promise<void> {
	await fs.promises.mkdir(path.join(dir, JOURNAL_PENDING_DIRNAME, transactionId), { recursive: true });
}

/** 隔离记录文件路径。 */
function generationQuarantineFile(dir: string): string {
	return path.join(dir, JOURNAL_QUARANTINE_DIRNAME, JOURNAL_GENERATION_QUARANTINE_FILENAME);
}

describe('文件日志 - 空事务与代际隔离解除', () => {
	let dir: string;
	let harness: Harness;

	beforeEach(async () => {
		dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ratel-journal-'));
		harness = await createHarness(dir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.promises.rm(dir, { recursive: true, force: true });
	});

	it('阻断 - 零块删除事务在写 prepared.json 时失败 - 重启只清理且代际仍可写', async () => {
		const original = harness.storage.upsertFile.bind(harness.storage);
		const upsert = vi.spyOn(harness.storage, 'upsertFile');
		upsert.mockImplementation(async (filePath: string, content: Buffer | string) => {
			if (String(filePath).endsWith(JOURNAL_PREPARED_FILENAME)) {
				throw new Error('注入故障:prepared.json 写入失败(模拟 ENOSPC)');
			}
			await original(filePath, content);
		});
		// 删除事务是零块事务:一个分片都不写,只在最后写 prepared.json。
		await expect(
			harness.journal.prepare({
				path: 'notes/gone.md',
				operation: 'delete',
				inputHash: null,
				revision: 1,
				previousCommitId: null,
				previousRevision: 0,
				blocks: [],
			}),
		).rejects.toThrow('注入故障:prepared.json 写入失败(模拟 ENOSPC)');
		upsert.mockRestore();

		const transactions = pendingTransactionIds(harness);
		expect(transactions).toHaveLength(1);
		const transactionDir = path.join(dir, JOURNAL_PENDING_DIRNAME, transactions[0]!);
		// 关键路径:事务目录推迟到第一次实际写入前才建 → 该窗口只留下一个空目录,既无记录也无分片。
		expect(fs.existsSync(path.join(transactionDir, JOURNAL_PREPARED_FILENAME))).toBe(false);
		expect(await fs.promises.readdir(transactionDir)).toEqual([]);

		const restarted = await createHarness(dir);
		const report = await restarted.journal.recover();
		// 空事务不得升级为代际隔离。
		expect(report.generationQuarantine).toBeNull();
		expect(report.failures).toEqual([]);
		expect(report.decisions).toEqual([
			{
				action: 'cleanup-only',
				reason: 'empty-transaction',
				path: null,
				transactionId: transactions[0]!,
				requiresReindex: false,
				searchable: true,
			},
		]);
		expect(await restarted.journal.isGenerationQuarantined()).toBe(false);
		expect(pendingTransactionIds(restarted)).toEqual([]);

		// 代际仍可写:继续提交新版本。
		const after = await indexThroughJournal(restarted, 'notes/after-empty.md', 'alpha');
		expect((await restarted.journal.readReceipt('notes/after-empty.md'))?.commitId).toBe(
			after.prepared.next.commitId,
		);
		expect(await restarted.journal.listSearchableReceipts()).toHaveLength(1);
	});

	it('阻断 - 首个分片写入前中断留下空目录 - 重启只清理且不隔离代际', async () => {
		const emptyTransaction = 'b'.repeat(32);
		await plantEmptyTransaction(dir, emptyTransaction);

		const restarted = await createHarness(dir);
		const report = await restarted.journal.recover();
		expect(report.generationQuarantine).toBeNull();
		expect(report.decisions).toHaveLength(1);
		expect(report.decisions[0]).toMatchObject({
			action: 'cleanup-only',
			reason: 'empty-transaction',
			path: null,
			transactionId: emptyTransaction,
		});
		expect(await restarted.journal.isGenerationQuarantined()).toBe(false);
		expect(pendingTransactionIds(restarted)).toEqual([]);
		expect(fs.existsSync(generationQuarantineFile(dir))).toBe(false);

		await indexThroughJournal(restarted, 'notes/after-empty2.md', 'alpha');
		expect((await restarted.journal.listReceipts()).map((entry) => entry.path)).toEqual(['notes/after-empty2.md']);
	});

	it('阻断 - 有分片但无法归属 - 仍然隔离整个代际(真分支不被放宽)', async () => {
		const badTransaction = 'c'.repeat(32);
		const transactionDir = path.join(dir, JOURNAL_PENDING_DIRNAME, badTransaction);
		await fs.promises.mkdir(transactionDir, { recursive: true });
		// 有内容(分片)但无法解析 → 「解析出内容却无法归属」,必须隔离代际。
		await fs.promises.writeFile(path.join(transactionDir, 'part-0000.json'), '{not-json', 'utf8');

		const restarted = await createHarness(dir);
		const report = await restarted.journal.recover();
		expect(report.generationQuarantine?.reason).toBe('unattributable-prepared');
		expect(report.decisions).toEqual([
			{
				action: 'quarantined-generation',
				reason: 'unattributable-prepared',
				path: null,
				transactionId: badTransaction,
				requiresReindex: false,
				searchable: false,
			},
		]);
		expect(await restarted.journal.isGenerationQuarantined()).toBe(true);
		expect(fs.existsSync(generationQuarantineFile(dir))).toBe(true);
		await expect(
			restarted.journal.prepare({
				path: 'notes/blocked.md',
				operation: 'replace',
				inputHash: await sha256('alpha'),
				revision: 1,
				previousCommitId: null,
				previousRevision: 0,
				blocks: [],
			}),
		).rejects.toMatchObject({ code: 'generation-quarantined' });
	});

	it('阻断 - 显式解除代际隔离 - 默认拒绝、确认后隔离记录移除且 prepare 恢复可用', async () => {
		const badTransaction = 'd'.repeat(32);
		await plantUnattributableTransaction(dir, badTransaction);
		const restarted = await createHarness(dir);
		const report = await restarted.journal.recover();
		expect(report.generationQuarantine?.reason).toBe('unattributable-prepared');
		expect((await restarted.journal.readGenerationQuarantine())?.transactionId).toBe(badTransaction);

		// 默认(缺省 / false)一律拒绝,不能自动解除。
		await expect(restarted.journal.clearGenerationQuarantine({ confirm: false })).rejects.toMatchObject({
			code: 'confirmation-required',
		});
		expect(await restarted.journal.isGenerationQuarantined()).toBe(true);

		expect(await restarted.journal.clearGenerationQuarantine({ confirm: true })).toBe(true);
		expect(await restarted.journal.isGenerationQuarantined()).toBe(false);
		expect(await restarted.journal.readGenerationQuarantine()).toBeNull();
		expect(fs.existsSync(generationQuarantineFile(dir))).toBe(false);
		// 已无记录时幂等返回 false。
		expect(await restarted.journal.clearGenerationQuarantine({ confirm: true })).toBe(false);

		// 隔离记录移除后 prepare 恢复可用;坏事务目录若仍在,下一次 recover 会重新隔离
		// (这正是「隔离只能显式解除」的含义),因此必须先由运维清掉坏依据。
		await restarted.journal.cleanup(badTransaction);
		expect((await restarted.journal.recover()).generationQuarantine).toBeNull();
		const draft = await indexThroughJournal(restarted, 'notes/released.md', 'alpha');
		expect((await restarted.journal.readReceipt('notes/released.md'))?.commitId).toBe(draft.prepared.next.commitId);
	});

	it('阻断 - 隔离记录损坏 - 仍按隔离处理且只能显式解除', async () => {
		await fs.promises.mkdir(path.join(dir, JOURNAL_QUARANTINE_DIRNAME), { recursive: true });
		await fs.promises.writeFile(generationQuarantineFile(dir), '{broken', 'utf8');

		const restarted = await createHarness(dir);
		// 记录损坏 → 视图为 null,但代际仍停止写入(不能因为解析不了就当没隔离过)。
		expect(await restarted.journal.readGenerationQuarantine()).toBeNull();
		expect(await restarted.journal.isGenerationQuarantined()).toBe(true);
		const report = await restarted.journal.recover();
		expect(report.decisions).toEqual([]);
		expect(report.generationQuarantine).toBeNull();
		await expect(
			restarted.journal.prepare({
				path: 'notes/corrupt.md',
				operation: 'replace',
				inputHash: await sha256('alpha'),
				revision: 1,
				previousCommitId: null,
				previousRevision: 0,
				blocks: [],
			}),
		).rejects.toMatchObject({ code: 'generation-quarantined' });

		expect(await restarted.journal.clearGenerationQuarantine({ confirm: true })).toBe(true);
		expect(await restarted.journal.isGenerationQuarantined()).toBe(false);
		await indexThroughJournal(restarted, 'notes/corrupt.md', 'alpha');
		expect((await restarted.journal.listReceipts()).map((entry) => entry.path)).toEqual(['notes/corrupt.md']);
	});

	it('影响2 - 隔离代际后立即停止本代际恢复 - 后续事务不再写盘', async () => {
		const healthy = await draftVersion(harness, 'notes/stop-order.md', 'alpha');
		const healthyBlocks = await readShardBlocksFromDisk(harness, healthy.transactionId, healthy.prepared);
		const badTransaction = '0'.repeat(32);
		await plantUnattributableTransaction(dir, badTransaction);
		// 排序口径:不可归属者必须排在前面,否则断言不到「隔离后停止」。
		expect(badTransaction < healthy.transactionId).toBe(true);

		const restarted = await createHarness(dir);
		const report = await restarted.journal.recover({
			currentInputs: new Map([['notes/stop-order.md', healthy.prepared.next.inputHash]]),
		});
		expect(report.generationQuarantine?.reason).toBe('unattributable-prepared');
		expect(report.decisions.map((entry) => entry.action)).toEqual(['quarantined-generation']);
		// 隔离之后不得再写完成记录、不得替换向量、不得继续清理后续事务。
		expect(restarted.replaceCalls()).toBe(0);
		expect(restarted.port.callCount).toBe(0);
		expect(await restarted.journal.readReceipt('notes/stop-order.md')).toBeNull();
		expect(pendingTransactionIds(restarted)).toEqual([badTransaction, healthy.transactionId].sort());

		// 解除隔离并清掉坏依据后,先前被跳过的事务仍能被正确重放(跳过没有破坏它)。
		expect(await restarted.journal.clearGenerationQuarantine({ confirm: true })).toBe(true);
		await restarted.journal.cleanup(badTransaction);
		const second = await restarted.journal.recover({
			currentInputs: new Map([['notes/stop-order.md', healthy.prepared.next.inputHash]]),
		});
		expect(expectDecision(second, 'notes/stop-order.md').action).toBe('replayed');
		await expectDiskEquals(restarted, 'notes/stop-order.md', healthyBlocks);
	});
});

describe('文件日志 - 同版本双未决与在途 prepare', () => {
	let dir: string;
	let harness: Harness;

	beforeEach(async () => {
		dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ratel-journal-'));
		harness = await createHarness(dir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.promises.rm(dir, { recursive: true, force: true });
	});

	it('影响3 - 同 revision 双未决且磁盘提交属于其中一条 - 另一条按结算清理且路径不再卡死', async () => {
		await indexThroughJournal(harness, 'notes/heal.md', 'alpha');
		const stale = await draftVersion(harness, 'notes/heal.md', 'alpha\nbravo');
		const staleBlocks = await readShardBlocksFromDisk(harness, stale.transactionId, stale.prepared);
		// 让 stale 的清理持续失败 → 同路径留下两条未决事务(前驱清理失败即可产生)。
		const originalRm = fs.promises.rm.bind(fs.promises);
		const rm = vi.spyOn(fs.promises, 'rm');
		rm.mockImplementation((async (
			target: Parameters<typeof originalRm>[0],
			options?: Parameters<typeof originalRm>[1],
		) => {
			if (String(target).includes(stale.transactionId)) {
				throw new Error('注入故障:上一个版本清理持续失败');
			}
			return originalRm(target, options);
		}) as typeof fs.promises.rm);
		const duplicate = await draftVersion(harness, 'notes/heal.md', 'alpha\ncharlie');
		rm.mockRestore();
		expect(pendingTransactionIds(harness)).toEqual([stale.transactionId, duplicate.transactionId].sort());
		// 后继在 replaceFile 与写完成记录之间中断:磁盘上只有 stale 的提交,完成记录仍停在 rev1。
		await harness.store.replaceFile({
			path: 'notes/heal.md',
			commitId: stale.prepared.next.commitId,
			blocks: staleBlocks,
		});
		expect((await harness.journal.readReceipt('notes/heal.md'))?.revision).toBe(1);

		// 旧行为会抛 prior-version-unresolved 把该路径永久卡死在这里。
		const restarted = await createHarness(dir);
		const current = await draftVersion(restarted, 'notes/heal.md', 'alpha\ndelta');
		await restarted.journal.commit(current.transactionId);
		const receipt = await restarted.journal.readReceipt('notes/heal.md');
		expect(receipt?.revision).toBe(2);
		expect(receipt?.inputHash).toBe(await sha256('alpha\ndelta'));
		await expectDiskEquals(restarted, 'notes/heal.md', current.blocks);
		// 成功后路径状态被清除,重复未决事务与保留依据都不再残留。
		expect(await restarted.journal.readPathState('notes/heal.md')).toBeNull();
		expect(pendingTransactionIds(restarted)).toEqual([]);
		expect(await restarted.journal.listQuarantinedTransactions()).toEqual([]);
	});

	it('影响3 - 磁盘提交无法由任何未决事务解释 - 仍以 prior-version-unresolved 拒绝并保留依据', async () => {
		await indexThroughJournal(harness, 'notes/unexplained.md', 'alpha');
		await draftVersion(harness, 'notes/unexplained.md', 'alpha\nbravo');
		await harness.store.replaceFile({
			path: 'notes/unexplained.md',
			commitId: 'foreign-commit',
			blocks: [
				{
					id: 'notes/unexplained.md#chunk-0',
					vector: deterministicVector('foreign', DIMENSIONS),
					metadata: { index: 0 },
				},
			],
		});
		await expect(draftVersion(harness, 'notes/unexplained.md', 'alpha\ncharlie')).rejects.toMatchObject({
			code: 'prior-version-unresolved',
		});
		const state = await harness.journal.readPathState('notes/unexplained.md');
		expect(state?.kind).toBe('unavailable');
		expect(state?.reason).toBe('prior-version-unresolved');
		expect(state?.diskCommitId).toBe('foreign-commit');
		expect(await harness.journal.listSearchableReceipts()).toEqual([]);
	});

	it('影响3 - 同路径并发 prepare - 第二条以 path-in-flight 拒绝且只产生一条未决事务', async () => {
		const vectors = await harness.port.embed(['alpha']);
		const input = {
			path: 'notes/inflight.md',
			operation: 'replace' as const,
			inputHash: await sha256('alpha'),
			revision: 1,
			previousCommitId: null,
			previousRevision: 0,
			blocks: [
				{
					id: 'notes/inflight.md#chunk-0',
					vector: vectors[0] ?? deterministicVector('alpha', DIMENSIONS),
					metadata: { index: 0 },
				},
			],
		};
		const settled = await Promise.allSettled([harness.journal.prepare(input), harness.journal.prepare(input)]);
		const fulfilled = settled.filter((entry) => entry.status === 'fulfilled');
		const rejected = settled.filter((entry) => entry.status === 'rejected');
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'path-in-flight' });
		// 只产生一条同路径未决事务,不会出现两条同 revision 事务。
		expect(pendingTransactionIds(harness)).toHaveLength(1);
		expect((fulfilled[0] as PromiseFulfilledResult<{ transactionId: string }>).value.transactionId).toBe(
			pendingTransactionIds(harness)[0],
		);

		// 守卫在 finally 释放:清理后同路径 prepare 恢复可用。
		await harness.journal.cleanup(pendingTransactionIds(harness)[0]!);
		const again = await harness.journal.prepare(input);
		expect(again.prepared.next.path).toBe('notes/inflight.md');
		await harness.journal.cleanup(again.transactionId);
		expect(pendingTransactionIds(harness)).toEqual([]);
	});
});

// ==================== 影响项:持久化、回收、失败范围、错误码、性能 ====================

describe('文件日志 - 决策 2 持久化与隔离区回收', () => {
	let dir: string;
	let harness: Harness;

	beforeEach(async () => {
		dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ratel-journal-'));
		harness = await createHarness(dir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.promises.rm(dir, { recursive: true, force: true });
	});

	it('影响1 - 完成记录领先但磁盘块不匹配 - 持久化不可用状态且重启后仍排除该路径', async () => {
		await indexThroughJournal(harness, 'notes/r2.md', 'alpha');
		const stale = await draftVersion(harness, 'notes/r2.md', 'alpha\nbravo');
		const staleFiles = await readTransactionFiles(harness, stale.transactionId);
		await harness.journal.cleanup(stale.transactionId);
		await indexThroughJournal(harness, 'notes/r2.md', 'alpha\ncharlie', { revision: 3 });
		const receipt = await harness.journal.readReceipt('notes/r2.md');
		expect(receipt?.revision).toBe(3);
		// 磁盘被外来提交替换 → 完成记录 revision 领先,但磁盘块与之不匹配。
		await harness.store.replaceFile({
			path: 'notes/r2.md',
			commitId: 'foreign-commit',
			blocks: [
				{ id: 'notes/r2.md#chunk-0', vector: deterministicVector('foreign', DIMENSIONS), metadata: { index: 0 } },
			],
		});
		expect((await harness.journal.verifyReceipt('notes/r2.md'))?.matches).toBe(false);
		await plantTransactionFiles(harness, stale.transactionId, staleFiles);

		const restarted = await createHarness(dir);
		const report = await restarted.journal.recover();
		const decision = expectDecision(report, 'notes/r2.md');
		expect(decision.action).toBe('cleanup-only');
		expect(decision.reason).toBe('receipt-ahead');
		expect(decision.searchable).toBe(false);
		// 关键路径:该分支必须落盘不可用状态,否则事务清理后重启不再产生决策。
		const state = await restarted.journal.readPathState('notes/r2.md');
		expect(state?.kind).toBe('unavailable');
		expect(state?.reason).toBe('unreceipted-disk-state');
		expect(state?.transactionId).toBe(stale.transactionId);
		expect(pendingTransactionIds(restarted)).toEqual([]);
		expect(restarted.replaceCalls()).toBe(0);

		// 重启(新实例)且没有任何未决事务:该路径仍不得进入可检索集。
		const afterRestart = await createHarness(dir);
		expect((await afterRestart.journal.listReceipts()).map((entry) => entry.path)).toEqual(['notes/r2.md']);
		expect(await afterRestart.journal.listSearchableReceipts()).toEqual([]);
		expect((await afterRestart.journal.recover()).decisions).toEqual([]);
		expect(await afterRestart.journal.listSearchableReceipts()).toEqual([]);
	});

	it('影响4 - 隔离区枚举与回收 - 仍被路径状态引用时孤儿回收保留,显式回收幂等', async () => {
		await indexThroughJournal(harness, 'notes/orphan.md', 'alpha');
		const expired = await draftVersion(harness, 'notes/orphan.md', 'alpha\nbravo');
		const expiredBlocks = await readShardBlocksFromDisk(harness, expired.transactionId, expired.prepared);
		await harness.store.replaceFile({
			path: 'notes/orphan.md',
			commitId: expired.prepared.next.commitId,
			blocks: expiredBlocks,
		});
		// 当前版本开始准备 → 过期事务进隔离区保留依据,路径状态引用它。
		await draftVersion(harness, 'notes/orphan.md', 'alpha\ncharlie');

		expect(await harness.journal.listQuarantinedTransactions()).toEqual([expired.transactionId]);
		expect((await harness.journal.readPathState('notes/orphan.md'))?.transactionId).toBe(expired.transactionId);
		// 仍有路径状态引用 → 孤儿回收必须保留它,不能误删仍需保留的依据。
		expect(await harness.journal.reclaimOrphanQuarantinedTransactions()).toEqual({
			reclaimed: [],
			retained: [expired.transactionId],
		});
		// 归属核对:目录名与记录推导出的 transactionId 不一致时拒绝回收,不误删仍需保留的依据。
		const quarantinedDir = path.join(
			dir,
			JOURNAL_QUARANTINE_DIRNAME,
			JOURNAL_QUARANTINE_TRANSACTIONS_DIRNAME,
			expired.transactionId,
		);
		const forgedId = 'e'.repeat(32);
		const forgedDir = path.join(path.dirname(quarantinedDir), forgedId);
		await fs.promises.rename(quarantinedDir, forgedDir);
		await expect(harness.journal.reclaimQuarantinedTransaction(forgedId)).rejects.toMatchObject({
			code: 'transaction-mismatch',
		});
		expect(fs.existsSync(forgedDir)).toBe(true);
		await fs.promises.rename(forgedDir, quarantinedDir);

		// 显式回收可以,且幂等。
		expect(await harness.journal.reclaimQuarantinedTransaction(expired.transactionId)).toBe(true);
		expect(await harness.journal.reclaimQuarantinedTransaction(expired.transactionId)).toBe(false);
		expect(await harness.journal.listQuarantinedTransactions()).toEqual([]);
		expect(
			fs.existsSync(
				path.join(
					dir,
					JOURNAL_QUARANTINE_DIRNAME,
					JOURNAL_QUARANTINE_TRANSACTIONS_DIRNAME,
					expired.transactionId,
				),
			),
		).toBe(false);
		// 路径状态本身不被回收动作改动:依据没了但路径仍不可检索,直到当前版本提交成功。
		expect((await harness.journal.readPathState('notes/orphan.md'))?.reason).toBe('expired-input-committed');
	});
});

describe('文件日志 - 失败范围与稳定错误码', () => {
	let dir: string;
	let harness: Harness;

	beforeEach(async () => {
		dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ratel-journal-'));
		harness = await createHarness(dir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.promises.rm(dir, { recursive: true, force: true });
	});

	it('影响5 - 单事务失败不中断整轮恢复 - 失败只影响该事务并计入报告', async () => {
		const failing = await draftVersion(harness, 'notes/bf1.md', 'alpha');
		const healthy = await draftVersion(harness, 'notes/bf2.md', 'bravo');
		const healthyBlocks = await readShardBlocksFromDisk(harness, healthy.transactionId, healthy.prepared);

		const restarted = await createHarness(dir);
		const original = restarted.store.inspectFile.bind(restarted.store);
		vi.spyOn(restarted.store, 'inspectFile').mockImplementation(async (filePath: string) => {
			if (filePath === 'notes/bf1.md') throw new Error('注入故障:磁盘读取失败');
			return original(filePath);
		});
		const report = await restarted.journal.recover({
			currentInputs: new Map([
				['notes/bf1.md', failing.prepared.next.inputHash],
				['notes/bf2.md', healthy.prepared.next.inputHash],
			]),
		});
		// 报告返回部分结果而不是整体 reject。
		expect(report.failures).toEqual([
			{ transactionId: failing.transactionId, code: 'unknown', message: '注入故障:磁盘读取失败' },
		]);
		// 失败范围可定位:另一个事务照常恢复,不因前者失败而中断本轮。
		expect(expectDecision(report, 'notes/bf2.md').action).toBe('replayed');
		expect(restarted.replaceCalls()).toBe(1);
		expect((await restarted.journal.readReceipt('notes/bf2.md'))?.commitId).toBe(healthy.prepared.next.commitId);
		await expectDiskEquals(restarted, 'notes/bf2.md', healthyBlocks);
		// 失败事务保持原状,下一轮可重试。
		expect(await restarted.journal.readReceipt('notes/bf1.md')).toBeNull();
		expect(pendingTransactionIds(restarted)).toEqual([failing.transactionId]);

		vi.restoreAllMocks();
		const retry = await createHarness(dir);
		const second = await retry.journal.recover({
			currentInputs: new Map([['notes/bf1.md', failing.prepared.next.inputHash]]),
		});
		expect(second.failures).toEqual([]);
		expect(expectDecision(second, 'notes/bf1.md').action).toBe('replayed');
		expect((await retry.journal.readReceipt('notes/bf1.md'))?.commitId).toBe(failing.prepared.next.commitId);
	});

	it('影响6 - 裸 fs 错误收敛为 io-failure - 保留 errno 且不把绝对路径送进文案', async () => {
		const mkdir = vi.spyOn(fs.promises, 'mkdir');
		mkdir.mockRejectedValue(
			Object.assign(new Error('EACCES: permission denied, mkdir /tmp/secret-abs-path/pending'), {
				code: 'EACCES',
			}),
		);
		let thrown: unknown = null;
		try {
			await harness.journal.prepare({
				path: 'notes/io.md',
				operation: 'replace',
				inputHash: await sha256('alpha'),
				revision: 1,
				previousCommitId: null,
				previousRevision: 0,
				blocks: [],
			});
		} catch (error) {
			thrown = error;
		}
		mkdir.mockRestore();
		expect(thrown).toBeInstanceOf(IndexFileJournalError);
		const failure = thrown as IndexFileJournalError;
		expect(failure.code).toBe('io-failure');
		expect(failure.detail).toMatchObject({ operation: 'create-transaction', scope: 'mkdir', errno: 'EACCES' });
		expect(failure.detail['cause']).toBeInstanceOf(Error);
		expect(failure.message).not.toContain('/tmp/secret-abs-path');
		expect(failure.message).not.toContain('EACCES');

		const readdir = vi.spyOn(fs.promises, 'readdir');
		readdir.mockRejectedValue(
			Object.assign(new Error('EACCES: permission denied, scandir /tmp/secret-abs-path/files'), {
				code: 'EACCES',
			}),
		);
		await expect(harness.journal.listReceipts()).rejects.toMatchObject({
			code: 'io-failure',
			detail: { operation: 'list-receipts', scope: 'readdir', errno: 'EACCES' },
		});
		readdir.mockRestore();
		expect(pendingTransactionIds(harness)).toEqual([]);
	});
});

describe('文件日志 - 性能护栏', () => {
	let dir: string;
	let harness: Harness;

	beforeEach(async () => {
		dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ratel-journal-'));
		harness = await createHarness(dir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.promises.rm(dir, { recursive: true, force: true });
	});

	it('影响7 - 完成记录清单在本实例内缓存 - 重复读取不访问目录且写后自动失效', async () => {
		await indexThroughJournal(harness, 'notes/cache1.md', 'alpha');
		// 先读一次填充完成记录与路径状态两个缓存(isIndexComplete 会在每处理一个文件后重复调用)。
		expect((await harness.journal.listReceipts()).map((entry) => entry.path)).toEqual(['notes/cache1.md']);
		expect((await harness.journal.listSearchableReceipts()).map((entry) => entry.path)).toEqual(['notes/cache1.md']);

		const readdir = vi.spyOn(fs.promises, 'readdir');
		const baseline = readdir.mock.calls.length;
		for (let index = 0; index < 8; index += 1) {
			await harness.journal.listReceipts();
			await harness.journal.listSearchableReceipts();
		}
		// 缓存命中:没有新增任何目录读。
		expect(readdir.mock.calls.length).toBe(baseline);

		// 自己的写操作后自动失效,新记录可见,不需要调用方手动失效。
		const draft = await draftVersion(harness, 'notes/cache2.md', 'bravo');
		await harness.journal.commit(draft.transactionId);
		expect((await harness.journal.listReceipts()).map((entry) => entry.path)).toEqual([
			'notes/cache1.md',
			'notes/cache2.md',
		]);
		readdir.mockRestore();
	});

	it('影响7 - findTransactionsOfPath 先按 prepared.json 预筛 - 不读无关事务的分片字节', async () => {
		const others: Draft[] = [];
		for (const otherPath of ['notes/other1.md', 'notes/other2.md', 'notes/other3.md']) {
			others.push(await draftVersion(harness, otherPath, 'alpha\nbravo\ncharlie'));
		}
		const otherDirs = others.map((entry) => path.join(dir, JOURNAL_PENDING_DIRNAME, entry.transactionId));

		const readFile = vi.spyOn(fs.promises, 'readFile');
		await draftVersion(harness, 'notes/target.md', 'alpha');
		const readsInOtherDirs = readFile.mock.calls.filter(([target]) =>
			otherDirs.some((otherDir) => String(target).startsWith(`${otherDir}${path.sep}`)),
		);
		const shardReads = readsInOtherDirs.filter(([target]) => path.basename(String(target)).startsWith('part-'));
		// 只允许读无关事务的 prepared.json 做路径预筛,不允许读它们的全部分片字节。
		expect(readsInOtherDirs.map(([target]) => path.basename(String(target)))).toEqual([
			JOURNAL_PREPARED_FILENAME,
			JOURNAL_PREPARED_FILENAME,
			JOURNAL_PREPARED_FILENAME,
		]);
		expect(shardReads).toEqual([]);
		readFile.mockRestore();
		expect(pendingTransactionIds(harness)).toHaveLength(4);
	});
});

describe('文件日志 - 交接期与缺失用例', () => {
	let dir: string;
	let harness: Harness;

	beforeEach(async () => {
		dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ratel-journal-'));
		harness = await createHarness(dir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.promises.rm(dir, { recursive: true, force: true });
	});

	it('影响11 - cleanup 登记在途提交 - 中断后凭据结算且目录可被再次清理', async () => {
		const draft = await draftVersion(harness, 'notes/cl.md', 'alpha');
		const before = harness.gate.acquired;
		const originalRm = fs.promises.rm.bind(fs.promises);
		const rm = vi.spyOn(fs.promises, 'rm');
		rm.mockImplementation((async (
			target: Parameters<typeof originalRm>[0],
			options?: Parameters<typeof originalRm>[1],
		) => {
			if (String(target).includes(draft.transactionId)) throw new Error('注入故障:cleanup 中断');
			return originalRm(target, options);
		}) as typeof fs.promises.rm);
		await expect(harness.journal.cleanup(draft.transactionId)).rejects.toMatchObject({ code: 'cleanup-failed' });
		rm.mockRestore();
		// 写入口登记并在 finally 结算在途提交,交接方不会被中断的 rm 挂住。
		expect(harness.gate.acquired).toBe(before + 1);
		expect(harness.gate.pendingCommits).toBe(0);
		await harness.journal.cleanup(draft.transactionId);
		expect(pendingTransactionIds(harness)).toEqual([]);
	});

	it('影响12 - 完成记录写入失败 - 向量已替换但重启后补写记录且零替换', async () => {
		await indexThroughJournal(harness, 'notes/rf.md', 'alpha');
		const draft = await draftVersion(harness, 'notes/rf.md', 'alpha\nbravo');
		const shardBlocks = await readShardBlocksFromDisk(harness, draft.transactionId, draft.prepared);
		const replacementsBefore = harness.replaceCalls();
		const originalMkdir = fs.promises.mkdir.bind(fs.promises);
		const mkdir = vi.spyOn(fs.promises, 'mkdir');
		mkdir.mockImplementation((async (
			target: Parameters<typeof originalMkdir>[0],
			options?: Parameters<typeof originalMkdir>[1],
		) => {
			if (path.basename(String(target)) === JOURNAL_FILES_DIRNAME) {
				throw Object.assign(new Error('EACCES: permission denied, mkdir /tmp/secret-abs-path/files'), {
					code: 'EACCES',
				});
			}
			return originalMkdir(target, options);
		}) as typeof fs.promises.mkdir);
		await expect(harness.journal.commit(draft.transactionId)).rejects.toMatchObject({ code: 'io-failure' });
		mkdir.mockRestore();
		// 向量替换已发生,完成记录仍是旧版本,事务保留供恢复。
		expect(harness.replaceCalls()).toBe(replacementsBefore + 1);
		expect((await inspectDisk(harness, 'notes/rf.md')).commitIds).toEqual([draft.prepared.next.commitId]);
		expect((await harness.journal.readReceipt('notes/rf.md'))?.revision).toBe(1);
		expect(pendingTransactionIds(harness)).toEqual([draft.transactionId]);

		const restarted = await createHarness(dir);
		const report = await restarted.journal.recover({
			currentInputs: new Map([['notes/rf.md', draft.prepared.next.inputHash]]),
		});
		expect(expectDecision(report, 'notes/rf.md').action).toBe('repaired-receipt');
		expect(restarted.replaceCalls()).toBe(0);
		await expectDiskEquals(restarted, 'notes/rf.md', shardBlocks);
		const receipt = await restarted.journal.readReceipt('notes/rf.md');
		expect(receipt?.commitId).toBe(draft.prepared.next.commitId);
		expect(receipt?.revision).toBe(2);
		expect(pendingTransactionIds(restarted)).toEqual([]);
	});

	it('影响12 - 未声明的多余分片 - prepared 有效也判为不可重放并只隔离该路径', async () => {
		await indexThroughJournal(harness, 'notes/extra.md', 'alpha');
		const draft = await draftVersion(harness, 'notes/extra.md', 'alpha\nbravo');
		const transactionDir = path.join(dir, JOURNAL_PENDING_DIRNAME, draft.transactionId);
		await fs.promises.writeFile(path.join(transactionDir, 'part-9999.json'), JSON.stringify([]), 'utf8');

		const restarted = await createHarness(dir);
		const report = await restarted.journal.recover();
		const decision = expectDecision(report, 'notes/extra.md');
		expect(decision.action).toBe('quarantined-path');
		expect(decision.reason).toBe('invalid-prepared');
		expect(decision.requiresReindex).toBe(true);
		expect(decision.searchable).toBe(false);
		expect(report.generationQuarantine).toBeNull();
		expect((await restarted.journal.readPathState('notes/extra.md'))?.reason).toBe('invalid-prepared');
		// 坏日志不能覆盖完成记录,也不替换向量。
		expect(restarted.replaceCalls()).toBe(0);
		expect((await restarted.journal.readReceipt('notes/extra.md'))?.revision).toBe(1);
		expect(await restarted.journal.listSearchableReceipts()).toEqual([]);
		expect(pendingTransactionIds(restarted)).toEqual([]);
	});

	it('影响12 - 删除后重建且陈旧删除事务仍在 - 重启只清理旧日志且重建版本不被覆盖', async () => {
		const first = await indexThroughJournal(harness, 'notes/dr.md', 'alpha');
		const previous = await harness.journal.readReceipt('notes/dr.md');
		const deletion = await harness.journal.prepare({
			path: 'notes/dr.md',
			operation: 'delete',
			inputHash: null,
			revision: (previous?.revision ?? 0) + 1,
			previousCommitId: previous?.commitId ?? null,
			previousRevision: previous?.revision ?? 0,
			blocks: [],
		});
		const originalRm = fs.promises.rm.bind(fs.promises);
		const rm = vi.spyOn(fs.promises, 'rm');
		rm.mockImplementation((async (
			target: Parameters<typeof originalRm>[0],
			options?: Parameters<typeof originalRm>[1],
		) => {
			if (String(target).includes(deletion.transactionId)) throw new Error('注入故障:删除事务清理失败');
			return originalRm(target, options);
		}) as typeof fs.promises.rm);
		expect((await harness.journal.commit(deletion.transactionId)).cleanupPending).toBe(true);
		expect(await harness.journal.readReceipt('notes/dr.md')).toMatchObject({ state: 'deleted', revision: 2 });
		// 陈旧删除事务仍在磁盘上时重建:必须能写入 present 版本而不被删除凭据挡住。
		const recreated = await indexThroughJournal(harness, 'notes/dr.md', 'alpha again');
		rm.mockRestore();
		expect(pendingTransactionIds(harness)).toEqual([deletion.transactionId]);
		expect(await harness.journal.readReceipt('notes/dr.md')).toMatchObject({
			state: 'present',
			revision: 3,
			inputHash: await sha256('alpha again'),
		});
		expect(first.prepared.next.revision).toBe(1);

		// 重启:陈旧删除事务 rev2 < 完成记录 rev3 → 决策 2 只清理,不覆盖重建版本。
		const restarted = await createHarness(dir);
		const report = await restarted.journal.recover({
			currentInputs: new Map([['notes/dr.md', recreated.prepared.next.inputHash]]),
		});
		const decision = expectDecision(report, 'notes/dr.md');
		expect(decision.action).toBe('cleanup-only');
		expect(decision.reason).toBe('receipt-ahead');
		expect(decision.searchable).toBe(true);
		expect(await restarted.journal.readReceipt('notes/dr.md')).toMatchObject({
			state: 'present',
			revision: 3,
		});
		await expectDiskEquals(restarted, 'notes/dr.md', recreated.blocks);
		expect(pendingTransactionIds(restarted)).toEqual([]);
		expect((await restarted.journal.listSearchableReceipts()).map((entry) => entry.path)).toEqual(['notes/dr.md']);
		expect(await restarted.journal.listTombstones()).toEqual([]);
	});
});