/**
 * @file tests/core/index-generations.test.ts
 * @description 配置代际、旧索引迁移与代际回收 — 真实临时磁盘、零嵌入核对与清理边界
 * @module tests/core/index-generations
 * @depends core/index-generations, core/index-file-journal, core/index-persistence-types,
 *   core/index-manifest, adapters/vector-vectra, adapters/atomic-index-storage,
 *   helpers/index-reliability-fixture
 *
 * 关键路径:
 * - 所有用例都在系统临时目录上跑真实磁盘,不使用内存替身;`afterEach` 在失败路径同样清理。
 * - 「升级有效且未变化的旧索引 → 零嵌入」用可计数嵌入端口直接断言调用数为 0,并用日志
 *   `verifyReceipt` 的块集合匹配证明「文件确实无需重算」,不用返回值代替。
 * - 「真实 1.2.0 迁移后启动不复算」用**真实 `PersistentIndexBackend.smartReindex`** 判定
 *   (`skipped` = 全部文件、`indexed` = 0、嵌入调用数 = 0),并用同一真实后端在「未迁移」与
 *   「代际目录缺清单与戳」两种目录上做反向对照 —— 只看迁移返回值证明不了启动路径的门禁。
 * - 目录归属与清理范围用逐字摘要比对:`control`/`owner`/新代际摘要在清理前后必须完全一致。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VectraStore } from '../../src/adapters/vector-vectra';
import type { PreparedBlock } from '../../src/adapters/vector-vectra';
import { AtomicIndexStorage } from '../../src/adapters/atomic-index-storage';
import { IndexFileJournal, type JournalWriteOwner } from '../../src/core/index-file-journal';
import {
	INDEX_RECORD_SCHEMA_VERSION,
	type IndexConfigDescriptor,
} from '../../src/core/index-persistence-types';
import { CURRENT_CHUNKER_VERSION, IndexManifest, resolveIndexManifestPath, type IndexManifestData, type IndexManifestEntry } from '../../src/core/index-manifest';
import { isBuildStampCurrent, readBuildStamp, resolveBuildStampPath, type IndexBuildStamp } from '../../src/core/index-build-stamp';
import { PersistentIndexBackend, type FileRecordReader } from '../../src/core/persistent-index-backend';
import { InlineWorker } from '../../src/worker/inline-worker';
import { WorkerManager } from '../../src/worker/manager';
import {
	INDEX_GENERATIONS_DIRNAME,
	INDEX_GENERATION_CONTROL_FILENAME,
	INDEX_GENERATION_CONFIG_FILENAME,
	INDEX_GENERATION_ENTRY_FILENAME,
	INDEX_GENERATION_ERROR_CODES,
	INDEX_GENERATION_MIGRATION_STATE_FILENAME,
	MIGRATION_STATE_FLUSH_BYTE_INTERVAL,
	MIGRATION_STATE_FLUSH_FILE_INTERVAL,
	IndexGenerationError,
	IndexGenerations,
	confirmsLegacyConfigIdentity,
	isChunkerGenerationUnconfirmable,
	legacyIndexFileKind,
	mapLegacyConfigIdentity,
	normalizeLegacyEmbedModelId,
	validateLegacyFileBlocks,
} from '../../src/core/index-generations';
import type {
	GenerationLegacySource,
	GenerationMigrationInput,
	GenerationRecord,
	GenerationReconcileProbeResult,
	IndexGenerationsOptions,
} from '../../src/core/index-generations';
import { FakeEmbeddingPort, deterministicVector } from '../helpers/index-reliability-fixture';
import { sha256 } from '../../src/utils/hash';

// ==================== 夹具 ====================

const DIMENSIONS = 64;
const CHUNK_SIZE = 100;
const CHUNK_OVERLAP = 20;

/** 当前生效配置 — 本地已知模型 + 可确认修订。 */
function currentConfig(overrides: Partial<IndexConfigDescriptor> = {}): IndexConfigDescriptor {
	return {
		embeddingModelId: 'local:bge-small-zh-v1.5',
		embeddingModelRevision: 'v1.5',
		embeddingDimension: DIMENSIONS,
		chunkerVersion: CURRENT_CHUNKER_VERSION,
		chunkSize: CHUNK_SIZE,
		chunkOverlap: CHUNK_OVERLAP,
		embeddingTextVersion: null,
		...overrides,
	};
}

/** 可观测写所有权门面替身 — 与 `IndexWriteOwner` 结构兼容。 */
class TestWriteOwner implements JournalWriteOwner {
	epoch = 1;
	writable = true;
	/** 断言次数 — 用于证明发布前确实复核过写所有权。 */
	assertCount = 0;

	assertWritable(): void {
		this.assertCount += 1;
		if (!this.writable) throw new Error('epoch 已被接管(测试注入)');
	}

	beginCommit(): { settle(): void } {
		return { settle: (): void => undefined };
	}
}

/** 系统临时目录上的独立工作区。 */
interface Workspace {
	readonly root: string;
	dispose(): void;
}

let workspace: Workspace | null = null;

function createWorkspace(): Workspace {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `ratel-t6-${process.pid}-`));
	return {
		root,
		dispose: (): void => {
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}

beforeEach(() => {
	workspace = createWorkspace();
});

afterEach(() => {
	workspace?.dispose();
	workspace = null;
});

function requireWorkspace(): Workspace {
	if (workspace === null) throw new Error('测试工作区未初始化');
	return workspace;
}

/** 测试分块器 — 每个非空行一块,确定且可预期。 */
function chunkLines(content: string): string[] {
	return content.length === 0 ? [] : content.split('\n').filter((line) => line.length > 0);
}

/** 按工作区根构造代际存储 — owner 门面是构造必填项。 */
function generationsFor(ws: Workspace, owner: JournalWriteOwner = new TestWriteOwner()): IndexGenerations {
	return new IndexGenerations({ indexRoot: path.join(ws.root, '.index'), owner });
}

/** 在一个真实 vectra 目录里写入若干文件的块。 */
async function writeIndexBlocks(
	dir: string,
	files: ReadonlyArray<{ path: string; content: string; commitId: string }>,
): Promise<VectraStore> {
	fs.mkdirSync(dir, { recursive: true });
	const index = new VectraStore(dir, { storage: new AtomicIndexStorage({ generationRoot: dir }) });
	await index.init();
	for (const file of files) {
		const blocks: PreparedBlock[] = chunkLines(file.content).map((text, position) => ({
			id: `${file.path}#chunk-${position}`,
			vector: deterministicVector(text, DIMENSIONS),
			metadata: {
				path: file.path,
				chunkIndex: position,
				startOffset: position * 100,
				prefix: '',
				headingPath: [],
			},
		}));
		await index.replaceFile({ path: file.path, commitId: file.commitId, blocks });
	}
	return index;
}

/** 构造旧版清单数据 — 与旧版 `IndexManifestData` 结构一致。 */
function legacyManifest(
	files: ReadonlyArray<{ path: string; hash: string; chunkCount: number }>,
	overrides: Partial<IndexManifestData> = {},
): IndexManifestData {
	const entries: Record<string, IndexManifestEntry> = {};
	for (const file of files) {
		entries[file.path] = { path: file.path, hash: file.hash, mtime: 1_700_000_000_000, chunkCount: file.chunkCount };
	}
	return {
		version: 1,
		embedModelId: 'local:bge-small-zh-v1.5',
		chunkSize: CHUNK_SIZE,
		chunkOverlap: CHUNK_OVERLAP,
		chunkerVersion: CURRENT_CHUNKER_VERSION,
		lastIndexTime: 1_700_000_000_000,
		entries,
		...overrides,
	};
}

/** 旧索引目录内的白名单文件名(排序后)—— 迁移复制只作用于它们。 */
function whitelistFileNames(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && legacyIndexFileKind(entry.name) !== null)
		.map((entry) => entry.name)
		.sort((left, right) => left.localeCompare(right));
}

/** 统计目录树内所有文件的摘要(相对路径 → sha256)。 */
function digestTree(target: string): Map<string, string> {
	const result = new Map<string, string>();
	const walk = (current: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const absolute = path.join(current, entry.name);
			if (entry.isDirectory()) {
				walk(absolute);
				continue;
			}
			result.set(path.relative(target, absolute), createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'));
		}
	};
	walk(target);
	return result;
}

/** legacy 旧索引源 — 目录 + 清单文件。 */
interface LegacyFixture {
	readonly legacyDir: string;
	readonly manifestPath: string;
	readonly files: ReadonlyArray<{ path: string; content: string; commitId: string }>;
	readonly manifest: IndexManifestData;
	readonly store: VectraStore;
}

/**
 * 构造一份「有效且未变化」的旧索引:legacy Vectra 目录 + 旧版清单。
 *
 * @param workspace - 工作区。
 * @param files - 合成文件(路径、正文、commitId)。
 * @param manifestOverrides - 覆盖清单全局字段(用于同名异端点等场景)。
 * @returns legacy 夹具。
 */
async function createLegacyFixture(
	workspace: Workspace,
	files: ReadonlyArray<{ path: string; content: string; commitId: string }>,
	manifestOverrides: Partial<IndexManifestData> = {},
): Promise<LegacyFixture> {
	const legacyDir = path.join(workspace.root, 'legacy-index');
	const store = await writeIndexBlocks(legacyDir, files);
	const manifestPath = path.join(workspace.root, 'legacy-manifest.json');
	const entries = await Promise.all(
		files.map(async (file) => ({
			path: file.path,
			hash: await sha256(file.content),
			chunkCount: chunkLines(file.content).length,
		})),
	);
	const manifest = legacyManifest(entries, manifestOverrides);
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
	return { legacyDir, manifestPath, files, manifest, store };
}

/** 改写 legacy 清单文件(用于构造异常清单)。 */
function rewriteManifest(legacy: LegacyFixture, mutate: (manifest: IndexManifestData) => void): void {
	const manifest = JSON.parse(fs.readFileSync(legacy.manifestPath, 'utf8')) as IndexManifestData;
	const entryList = Object.values(manifest.entries);
	const rebuilt = legacyManifest(
		entryList.map((entry) => ({ path: entry.path, hash: entry.hash, chunkCount: entry.chunkCount })),
		{
			embedModelId: manifest.embedModelId,
			chunkSize: manifest.chunkSize,
			chunkOverlap: manifest.chunkOverlap,
			chunkerVersion: manifest.chunkerVersion,
			lastIndexTime: manifest.lastIndexTime,
		},
	);
	mutate(rebuilt);
	fs.writeFileSync(legacy.manifestPath, JSON.stringify(rebuilt, null, 2), 'utf8');
}

/** 当前内容 hash 视图。 */
async function inputHashes(files: ReadonlyArray<{ path: string; content: string }>): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	for (const file of files) map.set(file.path, await sha256(file.content));
	return map;
}

/** 迁移输入装配 — 迁移入口与代际存储共用同一个写所有权门面。 */
function migrationInput(
	ws: Workspace,
	legacy: LegacyFixture,
	config: IndexConfigDescriptor,
): GenerationMigrationInput {
	const indexRoot = path.join(ws.root, '.index');
	const owner = new TestWriteOwner();
	return {
		indexRoot,
		generations: new IndexGenerations({ indexRoot, owner }),
		config,
		legacy: {
			legacyIndexDir: legacy.legacyDir,
			manifestPath: legacy.manifestPath,
			store: legacy.store,
		},
		owner,
		currentInputs: new Map(),
		chunkLimits: { chunkSize: CHUNK_SIZE, chunkOverlap: CHUNK_OVERLAP },
	};
}

/** 迁移后按活动代际目录构造日志 — 用于核对完成记录与真实块是否匹配。 */
async function journalForGeneration(ws: Workspace, generationId: string, fingerprint: string): Promise<IndexFileJournal> {
	const generations = generationsFor(ws);
	const record = await generations.getGenerationById(generationId);
	if (record === null) throw new Error(`代际 ${generationId} 不存在`);
	const storage = new AtomicIndexStorage({ generationRoot: record.generationRoot });
	const store = new VectraStore(record.generationRoot, { storage });
	await store.init();
	return new IndexFileJournal({
		generationRoot: record.generationRoot,
		generationId,
		configFingerprint: fingerprint,
		owner: new TestWriteOwner(),
		store,
		storage,
		expectedDimension: DIMENSIONS,
	});
}

/** 一次启动扫描的结论。 */
interface ScanOutcome {
	/** 完全复用(未嵌入)的路径。 */
	reused: string[];
	/** 需要重新嵌入的路径。 */
	reembedded: string[];
	/** 嵌入端口被调用的次数。 */
	embedCalls: number;
}

/**
 * 启动扫描探针 — 复刻生产的「读完成记录 + 比对内容 hash」判定,只对判定为需重算的路径调用嵌入。
 *
 * 关键路径:这是「升级有效且未变化的旧索引 → 零嵌入」的可失败证据 —— 迁移本身从不调用模型,
 * 因此若完成记录缺失、指纹不符或块集合不匹配,这里的 `embedCalls` 就会大于 0。
 */
async function probeStartupScan(input: {
	journal: IndexFileJournal;
	port: FakeEmbeddingPort;
	files: ReadonlyArray<{ path: string; content: string }>;
}): Promise<ScanOutcome> {
	const reused: string[] = [];
	const reembedded: string[] = [];
	for (const file of input.files) {
		const receipt = await input.journal.readReceipt(file.path);
		const hash = await sha256(file.content);
		if (receipt !== null && receipt.state === 'present' && receipt.inputHash === hash) {
			const verified = await input.journal.verifyReceipt(file.path);
			if (verified?.matches === true) {
				reused.push(file.path);
				continue;
			}
		}
		await input.port.embed([file.content]);
		reembedded.push(file.path);
	}
	return { reused, reembedded, embedCalls: input.port.callCount };
}

// ==================== 1. 目录与代际布局 ====================

describe('IndexGenerations - 目录与代际布局', () => {
	it('layout - 新建代际 - 日志与 control/owner 在 .index 根,数据在 generations/<id> 内', async () => {
		const ws = requireWorkspace();
		const indexRoot = path.join(ws.root, '.index');
		const generations = new IndexGenerations({ indexRoot, owner: new TestWriteOwner() });
		fs.mkdirSync(indexRoot, { recursive: true });
		// 根下的锁与恢复门文件由 T2 写入,这里模拟已存在。
		fs.writeFileSync(path.join(indexRoot, 'owner.lock'), '{}', 'utf8');
		fs.writeFileSync(path.join(indexRoot, 'owner.recovery.lock'), '{}', 'utf8');

		const record = await generations.ensureGeneration({ config: currentConfig() });
		expect(record.generationId).toMatch(/^gen-[0-9a-f]{16}$/);
		expect(path.dirname(record.generationRoot)).toBe(path.join(indexRoot, INDEX_GENERATIONS_DIRNAME));

		// 控制指针、代际入口与代际配置快照都在约定位置。
		expect(fs.existsSync(path.join(indexRoot, INDEX_GENERATION_CONTROL_FILENAME))).toBe(true);
		expect(fs.existsSync(path.join(record.generationRoot, INDEX_GENERATION_ENTRY_FILENAME))).toBe(true);
		expect(fs.existsSync(path.join(record.generationRoot, INDEX_GENERATION_CONFIG_FILENAME))).toBe(true);
		const snapshot = JSON.parse(
			fs.readFileSync(path.join(record.generationRoot, INDEX_GENERATION_CONFIG_FILENAME), 'utf8'),
		) as { generationId: string; fingerprint: string; config: { embeddingModelId: string } };
		expect(snapshot.generationId).toBe(record.generationId);
		expect(snapshot.fingerprint).toBe(record.fingerprint);
		expect(snapshot.config.embeddingModelId).toBe('local:bge-small-zh-v1.5');
		// 数据位置只在代际目录内:在代际目录建向量索引后,.index 根下不得出现 index.json。
		const store = new VectraStore(record.generationRoot, {
			storage: new AtomicIndexStorage({ generationRoot: record.generationRoot }),
		});
		await store.init();
		expect(fs.existsSync(path.join(record.generationRoot, 'index.json'))).toBe(true);
		expect(fs.existsSync(path.join(indexRoot, 'index.json'))).toBe(false);
	});

	it('isIndexRootDroppable - .index 根与 generations - 一律 false;代际目录层才为 true', async () => {
		const ws = requireWorkspace();
		const indexRoot = path.join(ws.root, '.index');
		const generations = new IndexGenerations({ indexRoot, owner: new TestWriteOwner() });
		fs.mkdirSync(indexRoot, { recursive: true });
		expect(generations.isIndexRootDroppable(indexRoot)).toBe(false);
		expect(generations.isIndexRootDroppable(path.join(indexRoot, INDEX_GENERATIONS_DIRNAME))).toBe(false);
		expect(await generations.isGenerationDirectory(indexRoot)).toBe(false);
		expect(await generations.isGenerationDirectory(path.join(indexRoot, 'unknown-dir'))).toBe(false);

		const record = await generations.ensureGeneration({ config: currentConfig() });
		expect(generations.isIndexRootDroppable(record.generationRoot)).toBe(true);
		expect(await generations.isGenerationDirectory(record.generationRoot)).toBe(true);
	});

	it('dropSafeGeneration - 删除代际目录 - control/owner/未知文件与保留代际逐字不变', async () => {
		const ws = requireWorkspace();
		const indexRoot = path.join(ws.root, '.index');
		const generations = new IndexGenerations({ indexRoot, owner: new TestWriteOwner() });
		fs.mkdirSync(indexRoot, { recursive: true });
		fs.writeFileSync(path.join(indexRoot, 'owner.lock'), 'owner-token', 'utf8');
		fs.writeFileSync(path.join(indexRoot, 'owner.recovery.lock'), 'gate-token', 'utf8');
		fs.writeFileSync(path.join(indexRoot, 'unknown.dat'), '未知文件必须保留', 'utf8');

		const keep = await generations.ensureGeneration({ config: currentConfig() });
		const doomed = await generations.ensureGeneration({
			config: currentConfig({ embeddingModelId: 'local:other-model' }),
		});

		const before = digestTree(indexRoot);
		await generations.dropSafeGeneration(doomed.generationRoot);
		const after = digestTree(indexRoot);

		expect(fs.existsSync(doomed.generationRoot)).toBe(false);
		expect(before.size).toBeGreaterThan(after.size);
		for (const key of ['owner.lock', 'owner.recovery.lock', 'unknown.dat', INDEX_GENERATION_CONTROL_FILENAME]) {
			expect(after.get(key)).toBe(before.get(key));
		}
		// 保留代际的每个文件摘要必须逐字不变。
		const keptPrefix = `${path.relative(indexRoot, keep.generationRoot)}${path.sep}`;
		for (const [key, digest] of before) {
			if (!key.startsWith(keptPrefix)) continue;
			expect(after.get(key)).toBe(digest);
		}
	});

	it('dropSafeGeneration - 目标为 .index 根或 generations - 拒绝且不删除任何文件', async () => {
		const ws = requireWorkspace();
		const indexRoot = path.join(ws.root, '.index');
		const generations = new IndexGenerations({ indexRoot, owner: new TestWriteOwner() });
		fs.mkdirSync(path.join(indexRoot, INDEX_GENERATIONS_DIRNAME), { recursive: true });
		const before = digestTree(indexRoot);
		await expect(generations.dropSafeGeneration(indexRoot)).rejects.toMatchObject({ code: 'generation-not-droppable' });
		await expect(generations.dropSafeGeneration(path.join(indexRoot, INDEX_GENERATIONS_DIRNAME)))
			.rejects.toMatchObject({ code: 'generation-not-droppable' });
		expect(digestTree(indexRoot)).toEqual(before);
	});

	it('dropSafeGeneration - 目录名像代际但无入口文件 - 拒绝清理外来目录', async () => {
		const ws = requireWorkspace();
		const indexRoot = path.join(ws.root, '.index');
		const generations = new IndexGenerations({ indexRoot, owner: new TestWriteOwner() });
		const foreign = path.join(indexRoot, INDEX_GENERATIONS_DIRNAME, 'gen-0123456789abcdef');
		fs.mkdirSync(foreign, { recursive: true });
		fs.writeFileSync(path.join(foreign, 'index.json'), '{"items":[]}', 'utf8');
		await expect(generations.dropSafeGeneration(foreign)).rejects.toMatchObject({ code: 'generation-directory-foreign' });
		expect(fs.existsSync(path.join(foreign, 'index.json'))).toBe(true);
	});

	it('dropIndex - 代际目录交给 VectraStore - 只删代际,.index 根与兄弟代际逐字不变', async () => {
		const ws = requireWorkspace();
		const indexRoot = path.join(ws.root, '.index');
		const generations = new IndexGenerations({ indexRoot, owner: new TestWriteOwner() });
		fs.mkdirSync(indexRoot, { recursive: true });
		fs.writeFileSync(path.join(indexRoot, 'owner.lock'), 'owner-token', 'utf8');
		fs.writeFileSync(path.join(indexRoot, 'owner.recovery.lock'), 'gate-token', 'utf8');
		fs.writeFileSync(path.join(indexRoot, 'unknown.dat'), '未知文件', 'utf8');

		// 目录布局硬约束:T1/T2 的布局要求「代际目录」才是 VectraStore 的工作目录,
		// 因此这里模拟装配层把代际根交给存储,而不是把 .index 根交出去。
		const active = await generations.ensureGeneration({ config: currentConfig() });
		const sibling = await generations.ensureGeneration({
			config: currentConfig({ embeddingModelId: 'local:other-model' }),
		});
		const target = new VectraStore(active.generationRoot, {
			storage: new AtomicIndexStorage({ generationRoot: active.generationRoot }),
		});
		await target.init();
		// 兄弟代际内也放一份数据,验证递归删除不会越界。
		const siblingStore = new VectraStore(sibling.generationRoot, {
			storage: new AtomicIndexStorage({ generationRoot: sibling.generationRoot }),
		});
		await siblingStore.init();
		expect(fs.existsSync(path.join(active.generationRoot, 'index.json'))).toBe(true);

		const siblingBefore = digestTree(sibling.generationRoot);
		const rootBefore = new Map(
			['owner.lock', 'owner.recovery.lock', 'unknown.dat', INDEX_GENERATION_CONTROL_FILENAME]
				.map((key) => [key, digestTree(indexRoot).get(key)] as [string, string | undefined]),
		);
		await target.dropIndex();

		// 递归删除只作用于传进去的代际目录:该代际被清空并由 init 重建,兄弟代际与根文件不受影响。
		expect(fs.existsSync(active.generationRoot)).toBe(true);
		expect(fs.existsSync(path.join(active.generationRoot, 'index.json'))).toBe(true);
		// 代际目录内被清空的文件确实消失了,证明 dropIndex 真的清理了目标目录本身。
		expect(fs.existsSync(path.join(active.generationRoot, INDEX_GENERATION_ENTRY_FILENAME))).toBe(false);
		expect(digestTree(sibling.generationRoot)).toEqual(siblingBefore);
		for (const [key, digest] of rootBefore) {
			expect(digestTree(indexRoot).get(key)).toBe(digest);
		}
	});

	it('legacyIndexFileKind - 旧 Vectra 文件白名单 - 只识别已验证的索引文件', () => {
		expect(legacyIndexFileKind('index.json')).toBe('index');
		expect(legacyIndexFileKind('catalog.json')).toBe('catalog');
		expect(legacyIndexFileKind('0e1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8.json')).toBe('metadata');
		expect(legacyIndexFileKind('ratel-manifest.json')).toBe(null);
		expect(legacyIndexFileKind('build-stamp.json')).toBe(null);
		expect(legacyIndexFileKind('owner.lock')).toBe(null);
		expect(legacyIndexFileKind('mystery.bin')).toBe(null);
	});

	it('cleanupLegacyIndexFiles - 白名单外文件、目录与符号链接 - 一律保留且出现在 retained 报告', async () => {
		const ws = requireWorkspace();
		const indexRoot = path.join(ws.root, '.index');
		const generations = new IndexGenerations({ indexRoot, owner: new TestWriteOwner() });
		const legacyDir = path.join(ws.root, 'legacy-copy');
		fs.mkdirSync(legacyDir, { recursive: true });
		fs.writeFileSync(path.join(legacyDir, 'index.json'), '{"items":[]}', 'utf8');
		fs.writeFileSync(path.join(legacyDir, 'catalog.json'), '{"entries":[]}', 'utf8');
		fs.writeFileSync(path.join(legacyDir, 'mystery.bin'), '未知文件', 'utf8');
		// 目录与符号链接都不得被删除,并且必须出现在 retained 报告里(不能静默消失)。
		fs.mkdirSync(path.join(legacyDir, 'generations'), { recursive: true });
		fs.writeFileSync(path.join(ws.root, 'outside.json'), '根外文件', 'utf8');
		fs.symlinkSync(path.join(ws.root, 'outside.json'), path.join(legacyDir, 'linked.json'));
		fs.mkdirSync(indexRoot, { recursive: true });
		fs.writeFileSync(path.join(indexRoot, 'owner.lock'), 'owner-token', 'utf8');
		const record = await generations.ensureGeneration({ config: currentConfig() });
		const keepDigest = digestTree(record.generationRoot);

		const result = await generations.cleanupLegacyIndexFiles({
			targetDir: legacyDir,
			verifiedFiles: ['index.json', 'catalog.json'],
		});

		expect([...result.removed].sort()).toEqual(['catalog.json', 'index.json']);
		expect([...result.retained].sort()).toEqual(['generations', 'linked.json', 'mystery.bin']);
		expect(fs.existsSync(path.join(legacyDir, 'mystery.bin'))).toBe(true);
		expect(fs.statSync(path.join(legacyDir, 'generations')).isDirectory()).toBe(true);
		expect(fs.lstatSync(path.join(legacyDir, 'linked.json')).isSymbolicLink()).toBe(true);
		expect(fs.existsSync(path.join(indexRoot, 'owner.lock'))).toBe(true);
		// 新代际摘要逐字不变。
		expect(digestTree(record.generationRoot)).toEqual(keepDigest);
	});

	it('isGenerationDirectory - 符号链接解析后逃出 generations - 不承认归属且拒绝清理', async () => {
		const ws = requireWorkspace();
		const indexRoot = path.join(ws.root, '.index');
		const generations = new IndexGenerations({ indexRoot, owner: new TestWriteOwner() });
		const id = 'gen-0123456789abcdef';
		const outside = path.join(ws.root, 'outside-generation', id);
		fs.mkdirSync(outside, { recursive: true });
		// 入口记录形状完全合法 —— 唯一的问题是这个目录物理上在 generations/ 之外。
		fs.writeFileSync(
			path.join(outside, INDEX_GENERATION_ENTRY_FILENAME),
			JSON.stringify({
				schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
				generationId: id,
				fingerprint: 'a'.repeat(64),
				kind: 'fresh',
				status: 'building',
				createdAt: 1,
			}),
			'utf8',
		);
		const link = path.join(indexRoot, INDEX_GENERATIONS_DIRNAME, id);
		fs.mkdirSync(path.dirname(link), { recursive: true });
		fs.symlinkSync(outside, link, 'dir');

		expect(await generations.isGenerationDirectory(link)).toBe(false);
		await expect(generations.dropSafeGeneration(link)).rejects.toMatchObject({ code: 'generation-directory-foreign' });
		expect(fs.existsSync(path.join(outside, INDEX_GENERATION_ENTRY_FILENAME))).toBe(true);
	});

	it('isGenerationDirectory - 伪造或缺字段的入口记录 - 不构成归属证据', async () => {
		const ws = requireWorkspace();
		const indexRoot = path.join(ws.root, '.index');
		const generations = new IndexGenerations({ indexRoot, owner: new TestWriteOwner() });
		const generationsRoot = path.join(indexRoot, INDEX_GENERATIONS_DIRNAME);

		// 只写了 generationId:旧实现只比对一个字段就承认归属,这里必须拒绝。
		const forgedId = 'gen-0123456789abcdef';
		const forged = path.join(generationsRoot, forgedId);
		fs.mkdirSync(forged, { recursive: true });
		fs.writeFileSync(path.join(forged, INDEX_GENERATION_ENTRY_FILENAME), JSON.stringify({ generationId: forgedId }), 'utf8');
		expect(await generations.isGenerationDirectory(forged)).toBe(false);
		await expect(generations.dropSafeGeneration(forged)).rejects.toMatchObject({ code: 'generation-directory-foreign' });

		// 形状自洽但未登记在 control:归属成立,但清理仍必须拒绝。
		const unregisteredId = 'gen-aaaaaaaaaaaaaaaa';
		const unregistered = path.join(generationsRoot, unregisteredId);
		fs.mkdirSync(unregistered, { recursive: true });
		fs.writeFileSync(
			path.join(unregistered, INDEX_GENERATION_ENTRY_FILENAME),
			JSON.stringify({
				schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
				generationId: unregisteredId,
				fingerprint: 'a'.repeat(64),
				kind: 'fresh',
				status: 'building',
				createdAt: 1,
			}),
			'utf8',
		);
		expect(await generations.isGenerationDirectory(unregistered)).toBe(true);
		await expect(generations.dropSafeGeneration(unregistered)).rejects.toMatchObject({ code: 'generation-unknown' });
		expect(fs.existsSync(unregistered)).toBe(true);
	});

	it('dropSafeGeneration - 活动代际 - 拒绝清理', async () => {
		const ws = requireWorkspace();
		const generations = generationsFor(ws);
		const record = await generations.ensureGeneration({ config: currentConfig() });
		await generations.publishActiveGeneration({ generationId: record.generationId, mode: 'upgrade' });

		await expect(generations.dropSafeGeneration(record.generationRoot)).rejects.toMatchObject({ code: 'generation-not-droppable' });
		expect(fs.existsSync(record.generationRoot)).toBe(true);
		expect((await generations.readControl()).activeGenerationId).toBe(record.generationId);
	});

	it('isIndexRootDroppable - 尾分隔符与 .. 归一 - 按解析后路径判定;大小写不同不视为同一代际', async () => {
		const ws = requireWorkspace();
		const generations = generationsFor(ws);
		const record = await generations.ensureGeneration({ config: currentConfig() });
		const basename = path.basename(record.generationRoot);

		expect(generations.isIndexRootDroppable(`${record.generationRoot}${path.sep}`)).toBe(true);
		expect(generations.isIndexRootDroppable(path.join(record.generationRoot, '..', basename))).toBe(true);
		expect(await generations.isGenerationDirectory(`${record.generationRoot}${path.sep}`)).toBe(true);
		expect(await generations.isGenerationDirectory(path.join(record.generationRoot, '..', basename))).toBe(true);
		// `generations/..` 归一后就是 .index 根,永远不可作为递归删除目标。
		expect(generations.isIndexRootDroppable(path.join(generations.generationsRoot, '..'))).toBe(false);
		expect(generations.isIndexRootDroppable(path.join(generations.generationsRoot, basename.toUpperCase()))).toBe(false);
		expect(await generations.isGenerationDirectory(path.join(generations.generationsRoot, basename.toUpperCase()))).toBe(false);
	});

	it('reconcileForNewGeneration - 未登记的孤儿代际目录 - 按入口自洽性回收,不自洽的一律不动', async () => {
		const ws = requireWorkspace();
		const generations = generationsFor(ws);
		const generationsRoot = generations.generationsRoot;
		const writeEntry = (dir: string, entry: unknown): void => {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, INDEX_GENERATION_ENTRY_FILENAME), JSON.stringify(entry), 'utf8');
		};
		// ensureGeneration 先建目录与入口、再写 control,中断留下的正是这种目录。
		const orphanId = 'gen-aaaaaaaaaaaaaaaa';
		const orphanRoot = path.join(generationsRoot, orphanId);
		writeEntry(orphanRoot, {
			schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
			generationId: orphanId,
			fingerprint: 'a'.repeat(64),
			kind: 'fresh',
			status: 'building',
			createdAt: 1,
		});
		// 指纹派生不出同一代际 ID 的目录:形状看着像,自洽性不成立,绝不回收。
		const forgedId = 'gen-bbbbbbbbbbbbbbbb';
		const forgedRoot = path.join(generationsRoot, forgedId);
		writeEntry(forgedRoot, {
			schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
			generationId: forgedId,
			fingerprint: 'a'.repeat(64),
			kind: 'fresh',
			status: 'building',
			createdAt: 1,
		});

		const decision = await generations.reconcileForNewGeneration({ probes: new Map(), requestedFingerprint: 'f'.repeat(64) });

		expect(decision.orphanDirectories).toEqual([orphanId]);
		expect(fs.existsSync(orphanRoot)).toBe(false);
		expect(fs.existsSync(forgedRoot)).toBe(true);
	});

	it('reconcileForNewGeneration - 读到回收候选入口后 owner 被接管 - 删除动作前再次断言并保留目录', async () => {
		const ws = requireWorkspace();
		const owner = new TestWriteOwner();
		const generations = generationsFor(ws, owner);
		const orphanId = 'gen-aaaaaaaaaaaaaaaa';
		const orphanRoot = path.join(generations.generationsRoot, orphanId);
		fs.mkdirSync(orphanRoot, { recursive: true });
		fs.writeFileSync(path.join(orphanRoot, INDEX_GENERATION_ENTRY_FILENAME), JSON.stringify({
			schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
			generationId: orphanId,
			fingerprint: 'a'.repeat(64),
			kind: 'fresh',
			status: 'building',
			createdAt: 1,
		}), 'utf8');

		// 关键路径(TOCTOU 窗口):入口断言与 `rm` 之间隔着 realpath + 读入口文件的多次 await。
		// 这里在「读代际入口文件」这一刻撤销写所有权,精确落在该窗口内。
		const originalReadFile = fs.promises.readFile.bind(fs.promises);
		const spy = vi.spyOn(fs.promises, 'readFile').mockImplementation(((...args: unknown[]) => {
			if (String(args[0]).endsWith(INDEX_GENERATION_ENTRY_FILENAME)) owner.writable = false;
			return (originalReadFile as (...innerArgs: unknown[]) => Promise<unknown>)(...args);
		}) as typeof fs.promises.readFile);
		try {
			await expect(generations.reconcileForNewGeneration({ probes: new Map(), requestedFingerprint: 'f'.repeat(64) }))
				.rejects.toMatchObject({ code: 'owner-not-writable' });
		}
		finally {
			spy.mockRestore();
		}

		// 关键路径:只依赖入口断言时这里目录已被递归删除;紧邻删除处的断言必须拦住它。
		expect(fs.existsSync(orphanRoot)).toBe(true);
		expect(fs.existsSync(path.join(orphanRoot, INDEX_GENERATION_ENTRY_FILENAME))).toBe(true);
	});

	it('writeGenerationConfig 与 writeGenerationEntry - owner 不可写 - 两者都被拒且磁盘无变化', async () => {
		const ws = requireWorkspace();
		const owner = new TestWriteOwner();
		const generations = generationsFor(ws, owner);
		const generationId = 'gen-0123456789abcdef';
		const generationRoot = path.join(generations.generationsRoot, generationId);
		// 目标目录预先存在并带哨兵文件:断言的是「磁盘无变化」,不是「目录没被创建」。
		fs.mkdirSync(generationRoot, { recursive: true });
		const sentinel = path.join(generationRoot, 'keep.txt');
		fs.writeFileSync(sentinel, '哨兵', 'utf8');
		const record: GenerationRecord = {
			schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
			generationId,
			fingerprint: 'a'.repeat(64),
			kind: 'fresh',
			status: 'building',
			root: generationRoot,
			verifiedAt: null,
			quarantineReason: null,
			createdAt: 1,
			updatedAt: 1,
		};
		owner.writable = false;

		// 关键路径:两者都是公开写入口,不能依赖调用方在自己的入口断言过 —— 迁移从入口断言
		// 到调用它们之间隔着大量 await。审查者实测:补断言前 owner 不可写时两者**都成功写盘**。
		await expect(generations.writeGenerationConfig(generationRoot, generationId, record.fingerprint, currentConfig()))
			.rejects.toMatchObject({ code: 'owner-not-writable' });
		await expect(generations.writeGenerationEntry(generationRoot, record))
			.rejects.toMatchObject({ code: 'owner-not-writable' });

		expect(fs.readFileSync(sentinel, 'utf8')).toBe('哨兵');
		expect(fs.readdirSync(generationRoot)).toEqual(['keep.txt']);
		expect(fs.existsSync(path.join(generationRoot, INDEX_GENERATION_CONFIG_FILENAME))).toBe(false);
		expect(fs.existsSync(path.join(generationRoot, INDEX_GENERATION_ENTRY_FILENAME))).toBe(false);
		expect(fs.existsSync(generations.controlPath)).toBe(false);

		// 对照:恢复可写后同一组调用必须成功 —— 证明拒绝来自写所有权断言,而不是路径/方法本身不可用。
		owner.writable = true;
		await generations.writeGenerationConfig(generationRoot, generationId, record.fingerprint, currentConfig());
		await generations.writeGenerationEntry(generationRoot, record);
		expect(fs.existsSync(path.join(generationRoot, INDEX_GENERATION_CONFIG_FILENAME))).toBe(true);
		expect(fs.existsSync(path.join(generationRoot, INDEX_GENERATION_ENTRY_FILENAME))).toBe(true);
		expect(fs.readFileSync(sentinel, 'utf8')).toBe('哨兵');
	});

	it('writeControl - 唯一临时名与 flush - 不覆盖同名遗留临时文件,rename 前刷临时文件、提交后刷父目录', async () => {
		const ws = requireWorkspace();
		const generations = generationsFor(ws);
		const controlPath = generations.controlPath;
		fs.mkdirSync(path.dirname(controlPath), { recursive: true });
		// 旧实现固定用 `<target>.tmp`;遗留文件必须原样保留,证明临时名已唯一化。
		const legacyTmp = `${controlPath}.tmp`;
		fs.writeFileSync(legacyTmp, '遗留固定名临时文件', 'utf8');

		const opened: string[] = [];
		const originalOpen = fs.promises.open.bind(fs.promises);
		const spy = vi.spyOn(fs.promises, 'open').mockImplementation(((...args: unknown[]) => {
			opened.push(String(args[0]));
			return (originalOpen as (...innerArgs: unknown[]) => Promise<fs.promises.FileHandle>)(...args);
		}) as typeof fs.promises.open);
		try {
			await generations.writeControl({ schemaVersion: INDEX_RECORD_SCHEMA_VERSION, activeGenerationId: null, generations: {} });
		} finally {
			spy.mockRestore();
		}

		expect(fs.readFileSync(legacyTmp, 'utf8')).toBe('遗留固定名临时文件');
		// 关键路径:提交语义是「刷临时文件 → rename → 刷父目录」;rename 不改变 inode,
		// 数据已在临时句柄刷过,因此不再重开目标文件刷一次(重开是冗余,不是更强的保证)。
		expect(opened.some((target) => target.startsWith(`${controlPath}.tmp-`))).toBe(true);
		expect(opened).toContain(path.dirname(controlPath));
		expect(fs.readdirSync(path.dirname(controlPath)).some((name) => name.startsWith('control.json.tmp-'))).toBe(false);
	});
});

// ==================== 2. 配置指纹与兼容判定 ====================

describe('IndexGenerations - 配置指纹与兼容判定', () => {
	it('confirmsLegacyConfigIdentity - API 无修订信息 - 判定不兼容且原因稳定', () => {
		const unrevisioned = confirmsLegacyConfigIdentity(currentConfig({
			embeddingModelId: 'api:text-embedding-3-small',
			embeddingModelRevision: null,
		}));
		expect(unrevisioned).toEqual({ confirmed: false, reason: 'api-identity-unrevisioned' });

		const revisioned = confirmsLegacyConfigIdentity(currentConfig({
			embeddingModelId: 'api:text-embedding-3-small',
			embeddingModelRevision: '2024-02-01',
		}));
		expect(revisioned.confirmed).toBe(true);

		// 本地已知模型身份可由模型文件自身重建。
		expect(confirmsLegacyConfigIdentity(currentConfig({ embeddingModelRevision: null })).confirmed).toBe(true);

		const malformed = confirmsLegacyConfigIdentity(currentConfig({ embeddingModelId: 'bge-small-zh-v1.5' }));
		expect(malformed).toEqual({ confirmed: false, reason: 'model-id-unrecognized' });
	});

	it('ensureGeneration - 同一配置重复调用 - 返回同一代际且不新建空目录', async () => {
		const ws = requireWorkspace();
		const generations = generationsFor(ws);
		const first = await generations.ensureGeneration({ config: currentConfig() });
		const second = await generations.ensureGeneration({ config: currentConfig() });
		expect(second.generationId).toBe(first.generationId);
		const state = await generations.readControl();
		expect(Object.keys(state.generations)).toEqual([first.generationId]);
	});

	it('ensureGeneration - 切换对话模型但嵌入/分块不变 - 指纹不变且不触发新代际', async () => {
		const ws = requireWorkspace();
		const generations = generationsFor(ws);
		// 对话模型不是配置指纹的参与字段(见 INDEX_CONFIG_FINGERPRINT_FIELDS),这里用同一描述验证幂等。
		const first = await generations.ensureGeneration({ config: currentConfig() });
		const second = await generations.getGeneration({ config: currentConfig() });
		expect(second?.fingerprint).toBe(first.fingerprint);
		expect((await generations.readControl()).activeGenerationId).toBe(null);
	});

	it('ensureGeneration - 嵌入模型变化 - 产生不同指纹的新代际且不覆盖旧代际', async () => {
		const ws = requireWorkspace();
		const generations = generationsFor(ws);
		const first = await generations.ensureGeneration({ config: currentConfig() });
		const second = await generations.ensureGeneration({ config: currentConfig({ embeddingModelId: 'local:other-model' }) });
		expect(second.generationId).not.toBe(first.generationId);
		expect(fs.existsSync(first.generationRoot)).toBe(true);
		expect(fs.existsSync(second.generationRoot)).toBe(true);
	});
});

// ==================== 3. 兼容旧文件校验 ====================

describe('IndexGenerations - 兼容旧文件校验', () => {
	it('migrate - 有效且未变化的旧索引 - 文件可复用、完成记录匹配且嵌入调用数为 0', async () => {
		const ws = requireWorkspace();
		const files = [
			{ path: 'notes/a.md', content: '第一行\n第二行\n第三行', commitId: 'commit-a' },
			{ path: 'notes/b.md', content: '乙甲丙', commitId: 'commit-b' },
		];
		const legacy = await createLegacyFixture(ws, files);
		const embedPort = new FakeEmbeddingPort(DIMENSIONS);
		// 成功迁移同样必须只读旧索引:迁移前后旧目录逐字摘要不变。
		const legacyBefore = digestTree(legacy.legacyDir);
		const result = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, currentConfig()),
			currentInputs: await inputHashes(files),
		});

		expect(result.published).toBe(true);
		expect(result.committed).toBe(true);
		// 迁移状态文件确实落盘(发布后的收尾结论)。
		expect(result.statePersisted).toBe(true);
		expect(result.files.map((file) => file.status)).toEqual(['reusable', 'reusable']);
		expect(result.activeGenerationId).toBe(result.generationId);
		expect(result.files.map((file) => file.blockSetHash)).not.toContain(null);
		expect(digestTree(legacy.legacyDir)).toEqual(legacyBefore);

		// 完成记录必须与真实磁盘块集合匹配 —— 这是「启动扫描不会重算」的直接证据。
		// 迁移后的代际目录内必须同时有身份文件与数据位置。
		const generationRoot = path.join(ws.root, '.index', INDEX_GENERATIONS_DIRNAME, result.generationId!);
		expect(fs.existsSync(path.join(generationRoot, INDEX_GENERATION_ENTRY_FILENAME))).toBe(true);
		expect(fs.existsSync(path.join(generationRoot, INDEX_GENERATION_CONFIG_FILENAME))).toBe(true);
		expect(fs.existsSync(path.join(generationRoot, 'pending'))).toBe(true);
		expect(fs.existsSync(path.join(generationRoot, 'quarantine'))).toBe(true);

		const journal = await journalForGeneration(ws, result.generationId!, result.configFingerprint!);
		for (const file of files) {
			const verified = await journal.verifyReceipt(file.path);
			expect(verified?.matches).toBe(true);
			expect(verified?.blocks.length).toBe(chunkLines(file.content).length);
		}

		// 关键验收:升级有效且未变化的旧索引后启动扫描,嵌入调用数必须为 0。
		const scan = await probeStartupScan({ journal, port: embedPort, files });
		expect(scan.reembedded).toEqual([]);
		expect(scan.reused).toEqual(files.map((file) => file.path));
		expect(scan.embedCalls).toBe(0);
		expect(embedPort.callCount).toBe(0);
	});

	it('probe - 未迁移的旧目录 - 探针判定为需重算并真实调用嵌入(对照证明计数有效)', async () => {
		const ws = requireWorkspace();
		const files = [{ path: 'notes/control.md', content: '甲\n乙', commitId: 'commit-control' }];
		const legacy = await createLegacyFixture(ws, files);
		const generations = generationsFor(ws);
		const record = await generations.ensureGeneration({ config: currentConfig() });
		const storage = new AtomicIndexStorage({ generationRoot: record.generationRoot });
		const store = new VectraStore(record.generationRoot, { storage });
		await store.init();
		const journal = new IndexFileJournal({
			generationRoot: record.generationRoot,
			generationId: record.generationId,
			configFingerprint: record.fingerprint,
			owner: new TestWriteOwner(),
			store,
			storage,
			expectedDimension: DIMENSIONS,
		});
		const port = new FakeEmbeddingPort(DIMENSIONS);
		void legacy;
		const scan = await probeStartupScan({ journal, port, files });
		expect(scan.reembedded).toEqual(['notes/control.md']);
		expect(scan.embedCalls).toBe(1);
	});

	it('migrate - 旧清单块数为 0 但磁盘实际有块 - 不当作空文件,单独重算', async () => {
		const ws = requireWorkspace();
		const files = [{ path: 'notes/c.md', content: '甲\n乙', commitId: 'commit-c' }];
		const legacy = await createLegacyFixture(ws, files);
		rewriteManifest(legacy, (manifest) => {
			manifest.entries['notes/c.md'] = { ...manifest.entries['notes/c.md']!, chunkCount: 0 };
		});
		expect((await legacy.store.inspectFile('notes/c.md')).length).toBe(2);

		const result = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, currentConfig()),
			currentInputs: await inputHashes(files),
		});
		expect(result.files).toEqual([
			expect.objectContaining({ path: 'notes/c.md', status: 'reindex', reason: 'zero-chunk-without-blocks' }),
		]);
		// 该文件不得留下完成记录,后续按新规则重算。
		const journal = await journalForGeneration(ws, result.generationId!, result.configFingerprint!);
		expect(await journal.readReceipt('notes/c.md')).toBe(null);
	});

	it('migrate - 清单块数为 0 且磁盘确实无块 - 按空文件复用', async () => {
		const ws = requireWorkspace();
		const files = [{ path: 'notes/d.md', content: '只有一行', commitId: 'commit-d' }];
		const legacy = await createLegacyFixture(ws, files);
		await legacy.store.deleteByPath('notes/d.md');
		await legacy.store.reload();
		expect(await legacy.store.inspectFile('notes/d.md')).toEqual([]);
		rewriteManifest(legacy, (manifest) => {
			manifest.entries['notes/d.md'] = { ...manifest.entries['notes/d.md']!, chunkCount: 0 };
		});

		const result = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, currentConfig()),
			currentInputs: await inputHashes(files),
		});
		expect(result.files).toEqual([
			expect.objectContaining({ path: 'notes/d.md', status: 'reusable', actualChunkCount: 0 }),
		]);
	});

	it('migrate - 向量维度与当前配置不一致 - 该文件重算', async () => {
		const ws = requireWorkspace();
		const files = [{ path: 'notes/e.md', content: '甲\n乙\n丙', commitId: 'commit-e' }];
		const legacy = await createLegacyFixture(ws, files);
		const result = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, currentConfig()),
			currentInputs: await inputHashes(files),
			expectedDimension: 768,
		});
		expect(result.files).toEqual([
			expect.objectContaining({ path: 'notes/e.md', status: 'reindex', reason: 'dimension-mismatch' }),
		]);
	});

	it('migrate - 块序号缺号或多余块 - 该文件重算,其他已验证文件不受影响', async () => {
		const ws = requireWorkspace();
		const files = [
			{ path: 'notes/ok.md', content: '甲\n乙', commitId: 'commit-ok' },
			{ path: 'notes/bad.md', content: '丙\n丁\n戊', commitId: 'commit-bad' },
		];
		const legacy = await createLegacyFixture(ws, files);
		// 删掉 bad.md 的中间块 —— 制造缺号,而清单仍声明 3 块。
		const items = await legacy.store.inspectFile('notes/bad.md');
		await legacy.store.replaceFile({
			path: 'notes/bad.md',
			commitId: 'commit-bad',
			blocks: items.filter((block) => block.metadata['chunkIndex'] !== 1),
		});
		await legacy.store.reload();
		expect((await legacy.store.inspectFile('notes/bad.md')).length).toBe(2);

		const result = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, currentConfig()),
			currentInputs: await inputHashes(files),
		});
		const byPath = new Map(result.files.map((file) => [file.path, file]));
		expect(byPath.get('notes/ok.md')?.status).toBe('reusable');
		expect(byPath.get('notes/bad.md')?.status).toBe('reindex');
		// 个别文件不兼容不得让已验证文件被重算。
		const journal = await journalForGeneration(ws, result.generationId!, result.configFingerprint!);
		expect((await journal.verifyReceipt('notes/ok.md'))?.matches).toBe(true);
		expect(await journal.readReceipt('notes/bad.md')).toBe(null);
	});

	it('migrate - 当前内容已变化的文件 - 不复用并单独排队', async () => {
		const ws = requireWorkspace();
		const files = [{ path: 'notes/f.md', content: '原始内容', commitId: 'commit-f' }];
		const legacy = await createLegacyFixture(ws, files);
		const result = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, currentConfig()),
			currentInputs: new Map([['notes/f.md', await sha256('已经改过的内容')]]),
		});
		expect(result.files).toEqual([
			expect.objectContaining({ path: 'notes/f.md', status: 'reindex', reason: 'input-hash-mismatch' }),
		]);
	});

	it('migrate - 条目键与条目内路径不一致 - 该文件按不可信条目重算', async () => {
		const ws = requireWorkspace();
		const files = [
			{ path: 'notes/m1.md', content: '甲\n乙', commitId: 'commit-m1' },
			{ path: 'notes/m2.md', content: '丙', commitId: 'commit-m2' },
		];
		const legacy = await createLegacyFixture(ws, files);
		rewriteManifest(legacy, (manifest) => {
			const entry = manifest.entries['notes/m2.md']!;
			delete manifest.entries['notes/m2.md'];
			// 键与记录内路径不一致 —— 记录内路径不参与任何文件访问,只能拒绝。
			manifest.entries['notes/other.md'] = { ...entry, path: 'notes/m2.md' };
		});
		const result = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, currentConfig()),
			currentInputs: await inputHashes(files),
		});
		const byPath = new Map(result.files.map((file) => [file.path, file]));
		expect(byPath.get('notes/m1.md')?.status).toBe('reusable');
		expect(byPath.get('notes/other.md')).toMatchObject({ status: 'reindex', reason: 'manifest-entry-missing' });
	});

	it('migrate - 构建戳存在但损坏 - 按不兼容处理', async () => {
		const ws = requireWorkspace();
		const files = [{ path: 'notes/n.md', content: '甲', commitId: 'commit-n' }];
		const legacy = await createLegacyFixture(ws, files);
		fs.writeFileSync(path.join(legacy.legacyDir, 'build-stamp.json'), '{ 半截 JSON', 'utf8');
		const result = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, currentConfig()),
			currentInputs: await inputHashes(files),
		});
		expect(result.published).toBe(false);
		expect(result.reason).toBe('legacy-manifest-invalid');
	});

	it('migrate - 构建戳与清单互相矛盾 - 按不兼容处理', async () => {
		const ws = requireWorkspace();
		const files = [{ path: 'notes/o.md', content: '甲', commitId: 'commit-o' }];
		const legacy = await createLegacyFixture(ws, files);
		fs.writeFileSync(
			path.join(legacy.legacyDir, 'build-stamp.json'),
			JSON.stringify({
				chunkerVersion: CURRENT_CHUNKER_VERSION,
				chunkSize: CHUNK_SIZE,
				chunkOverlap: CHUNK_OVERLAP,
				embedModelId: 'local:另一个模型',
			}),
			'utf8',
		);
		const result = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, currentConfig()),
			currentInputs: await inputHashes(files),
		});
		expect(result.published).toBe(false);
		expect(result.reason).toBe('config-identity-unconfirmed');
	});

	it('migrate - 缺构建戳的旧索引 - 仍按清单与实际块集合完成迁移', async () => {
		const ws = requireWorkspace();
		const files = [{ path: 'notes/p.md', content: '甲\n乙', commitId: 'commit-p' }];
		const legacy = await createLegacyFixture(ws, files);
		expect(fs.existsSync(path.join(legacy.legacyDir, 'build-stamp.json'))).toBe(false);
		const result = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, currentConfig()),
			currentInputs: await inputHashes(files),
		});
		expect(result.published).toBe(true);
		expect(result.files).toEqual([expect.objectContaining({ path: 'notes/p.md', status: 'reusable' })]);
	});

	it('migrate - 旧清单缺分块字段 - 按不兼容处理并报告,不补造身份', async () => {
		const ws = requireWorkspace();
		const files = [{ path: 'notes/g.md', content: '甲', commitId: 'commit-g' }];
		const legacy = await createLegacyFixture(ws, files, { chunkSize: undefined as never, chunkOverlap: undefined as never });
		const result = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, currentConfig()),
			currentInputs: await inputHashes(files),
		});
		expect(result.published).toBe(false);
		expect(result.reason).toBe('legacy-manifest-invalid');
		expect(fs.existsSync(path.join(ws.root, '.index', INDEX_GENERATION_CONTROL_FILENAME))).toBe(false);
	});

	it('migrate - API 同名异端点且无修订信息 - 拒绝迁移且不假设兼容', async () => {
		const ws = requireWorkspace();
		const files = [{ path: 'notes/h.md', content: '甲', commitId: 'commit-h' }];
		const legacy = await createLegacyFixture(ws, files, { embedModelId: 'api:text-embedding-3-small' });
		const input = migrationInput(ws, legacy, currentConfig({
			embeddingModelId: 'api:text-embedding-3-small',
			embeddingModelRevision: null,
		}));
		const result = await IndexGenerations.migrateLegacyIndex({
			...input,
			currentInputs: await inputHashes(files),
		});
		expect(result.published).toBe(false);
		expect(result.reason).toBe('config-identity-unconfirmed');
		expect(result.errorCode).toBe('config-identity-unconfirmed');
		expect(result.files).toEqual([]);
		expect((await input.generations.readControl()).activeGenerationId).toBe(null);
	});

	it('migrate - owner 已释放 - 拒绝迁移', async () => {
		const ws = requireWorkspace();
		const files = [{ path: 'notes/i.md', content: '甲', commitId: 'commit-i' }];
		const legacy = await createLegacyFixture(ws, files);
		const owner = new TestWriteOwner();
		owner.writable = false;
		const result = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, currentConfig()),
			owner,
			currentInputs: await inputHashes(files),
		});
		expect(result.published).toBe(false);
		expect(result.reason).toBe('owner-not-writable');
	});

	it('migrate - 旧清单仅缺 chunkerVersion - 分块身份不可确认,绝不按当前值补造后复用', async () => {
		const ws = requireWorkspace();
		const files = [{ path: 'notes/legacy-chunker.md', content: '甲\n乙', commitId: 'commit-chunker' }];
		// 关键路径(B1):除 chunkerVersion 外全部字段齐全 —— 旧清单本身合法,缺的是分块代数。
		const legacy = await createLegacyFixture(ws, files, { chunkerVersion: undefined as never });
		expect((JSON.parse(fs.readFileSync(legacy.manifestPath, 'utf8')) as Record<string, unknown>)['chunkerVersion']).toBeUndefined();

		const input = migrationInput(ws, legacy, currentConfig());
		const result = await IndexGenerations.migrateLegacyIndex({
			...input,
			currentInputs: await inputHashes(files),
		});

		expect(result.published).toBe(false);
		expect(result.reason).toBe('config-identity-unconfirmed');
		expect(result.errorCode).toBe('config-identity-unconfirmed');
		// 没有任何文件被判为可复用:身份不可证明时一块都不采用。
		expect(result.files).toEqual([]);
		expect((await input.generations.readControl()).activeGenerationId).toBe(null);
		// 连复制都没有开始 —— 不留下半成品代际目录。
		expect(fs.existsSync(path.join(ws.root, '.index', INDEX_GENERATIONS_DIRNAME))).toBe(false);
	});

	it('mapLegacyConfigIdentity - 仅缺 chunkerVersion - 返回 null 且判定为分块代数不可确认', () => {
		const incomplete = legacyManifest([], { chunkerVersion: undefined as never });
		expect(isChunkerGenerationUnconfirmable(incomplete)).toBe(true);
		expect(mapLegacyConfigIdentity(incomplete, { embeddingDimension: DIMENSIONS })).toBe(null);

		// 对照组:补齐 chunkerVersion 后身份可确认,并原样采用清单声明的代数。
		const complete = legacyManifest([], { chunkerVersion: CURRENT_CHUNKER_VERSION + 1 });
		expect(isChunkerGenerationUnconfirmable(complete)).toBe(false);
		expect(mapLegacyConfigIdentity(complete, { embeddingDimension: DIMENSIONS })?.chunkerVersion).toBe(CURRENT_CHUNKER_VERSION + 1);
	});

	it('validateLegacyFileBlocks - 边界倒退/起点缺失/headingPath 形状非法 - 判定为不可复用', () => {
		const block = (chunkIndex: number, metadata: Record<string, unknown>): PreparedBlock => ({
			id: `notes/s.md#chunk-${chunkIndex}`,
			vector: deterministicVector(`块${chunkIndex}`, DIMENSIONS),
			metadata: { path: 'notes/s.md', chunkIndex, startOffset: chunkIndex * 100, headingPath: [], ...metadata },
		});
		const base = { path: 'notes/s.md', declaredChunkCount: 2, expectedDimension: DIMENSIONS };

		expect(validateLegacyFileBlocks({ ...base, blocks: [block(0, {}), block(1, {})] })).toEqual({ reason: null });
		// 起点随分块序号倒退(边界重叠/乱序)。
		expect(validateLegacyFileBlocks({ ...base, blocks: [block(0, { startOffset: 500 }), block(1, { startOffset: 100 })] })).toEqual({ reason: 'boundary-overlap' });
		// 缺失结构元数据。
		expect(validateLegacyFileBlocks({ ...base, blocks: [block(0, { startOffset: undefined }), block(1, {})] })).toEqual({ reason: 'structural-metadata-missing' });
		expect(validateLegacyFileBlocks({ ...base, blocks: [block(0, { startOffset: -1 }), block(1, {})] })).toEqual({ reason: 'structural-metadata-missing' });
		// headingPath 形状/层级非法(Markdown 只有 1~6 级标题)。
		expect(validateLegacyFileBlocks({ ...base, blocks: [block(0, { headingPath: ['a', 7] }), block(1, {})] })).toEqual({ reason: 'structural-metadata-missing' });
		expect(validateLegacyFileBlocks({ ...base, blocks: [block(0, { headingPath: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }), block(1, {})] })).toEqual({ reason: 'structural-metadata-missing' });
	});

	it('migrate - 缺 startOffset 的旧块 - 该文件单独重算,不当作可复用', async () => {
		const ws = requireWorkspace();
		const files = [{ path: 'notes/s.md', content: '甲\n乙', commitId: 'commit-s' }];
		const legacy = await createLegacyFixture(ws, files);
		const blocks = await legacy.store.inspectFile('notes/s.md');
		await legacy.store.replaceFile({
			path: 'notes/s.md',
			commitId: 'commit-s',
			blocks: blocks.map((item) => {
				const metadata = { ...item.metadata };
				delete metadata['startOffset'];
				return { ...item, metadata };
			}),
		});
		await legacy.store.reload();

		const result = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, currentConfig()),
			currentInputs: await inputHashes(files),
		});
		expect(result.files).toEqual([
			expect.objectContaining({ path: 'notes/s.md', status: 'reindex', reason: 'structural-metadata-missing' }),
		]);
		const journal = await journalForGeneration(ws, result.generationId!, result.configFingerprint!);
		expect(await journal.readReceipt('notes/s.md')).toBe(null);
	});

	it('migrate - 边界倒退的旧块 - 该文件重算;修复后同一目录可再次核对为可复用', async () => {
		const ws = requireWorkspace();
		const files = [{ path: 'notes/b.md', content: '甲\n乙', commitId: 'commit-b' }];
		const legacy = await createLegacyFixture(ws, files);
		const original = await legacy.store.inspectFile('notes/b.md');
		// 让后一块的起点早于前一块:边界随分块序号倒退。
		await legacy.store.replaceFile({
			path: 'notes/b.md',
			commitId: 'commit-b',
			blocks: original.map((item) => {
				const startOffset = item.metadata['chunkIndex'] === 1 ? 10 : 500;
				return { ...item, metadata: { ...item.metadata, startOffset } };
			}),
		});
		await legacy.store.reload();

		const broken = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, currentConfig()),
			currentInputs: await inputHashes(files),
		});
		expect(broken.files).toEqual([
			expect.objectContaining({ path: 'notes/b.md', status: 'reindex', reason: 'boundary-overlap' }),
		]);

		// 修复边界后再跑一次:同一个代际目录、同一份清单,结论必须变成可复用。
		await legacy.store.replaceFile({ path: 'notes/b.md', commitId: 'commit-b', blocks: original });
		await legacy.store.reload();
		const repaired = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, currentConfig()),
			currentInputs: await inputHashes(files),
		});
		expect(repaired.files).toEqual([expect.objectContaining({ path: 'notes/b.md', status: 'reusable' })]);
	});

	it('migrate - 旧块在两次迁移之间发生变化 - 代际内既有完成记录判为过期并重算', async () => {
		const ws = requireWorkspace();
		const files = [{ path: 'notes/stale.md', content: '甲\n乙', commitId: 'commit-stale' }];
		const legacy = await createLegacyFixture(ws, files);
		const hashes = await inputHashes(files);

		const first = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, currentConfig()),
			currentInputs: hashes,
		});
		expect(first.files).toEqual([expect.objectContaining({ status: 'reusable' })]);

		// 清单仍声明同样的输入 hash 与块数,但块内容(向量)已变 —— 既有记录已过期。
		const blocks = await legacy.store.inspectFile('notes/stale.md');
		await legacy.store.replaceFile({
			path: 'notes/stale.md',
			commitId: 'commit-stale',
			blocks: blocks.map((item) => ({ ...item, vector: item.vector.map((value) => value + 1) })),
		});
		await legacy.store.reload();

		const second = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, currentConfig()),
			currentInputs: hashes,
		});
		expect(second.files).toEqual([
			expect.objectContaining({ path: 'notes/stale.md', status: 'reindex', reason: 'block-set-hash-mismatch' }),
		]);
		const journal = await journalForGeneration(ws, second.generationId!, second.configFingerprint!);
		expect(await journal.readReceipt('notes/stale.md')).toBe(null);
	});

	it('migrate - 内容已变化的路径 - 代际内不得留下可被误用的完成记录', async () => {
		const ws = requireWorkspace();
		const files = [{ path: 'notes/changed.md', content: '原始内容', commitId: 'commit-changed' }];
		const legacy = await createLegacyFixture(ws, files);
		// 先完成一次迁移,使代际内存在该路径的完成记录。
		const first = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, currentConfig()),
			currentInputs: await inputHashes(files),
		});
		const journal = await journalForGeneration(ws, first.generationId!, first.configFingerprint!);
		expect((await journal.readReceipt('notes/changed.md'))?.inputHash).toBe(await sha256('原始内容'));

		// 内容已变(清单仍是旧 hash):本轮判为重算,并且旧记录必须被清掉 ——
		// `verifyReceipt.matches` 不比对 inputHash,留下记录会让调用方误判为已索引。
		const second = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, currentConfig()),
			currentInputs: new Map([['notes/changed.md', await sha256('已经改过的内容')]]),
		});
		expect(second.files).toEqual([
			expect.objectContaining({ path: 'notes/changed.md', status: 'reindex', reason: 'input-hash-mismatch' }),
		]);
		const after = await journalForGeneration(ws, second.generationId!, second.configFingerprint!);
		expect(await after.readReceipt('notes/changed.md')).toBe(null);
	});

	it('migrate - 批量枚举接缝 - 优先一次枚举,缺失时逐条回退且结论一致', async () => {
		const ws = requireWorkspace();
		const files = [
			{ path: 'notes/e1.md', content: '甲\n乙', commitId: 'commit-e1' },
			{ path: 'notes/e2.md', content: '丙', commitId: 'commit-e2' },
			{ path: 'notes/e3.md', content: '丁\n戊\n己', commitId: 'commit-e3' },
		];
		const legacy = await createLegacyFixture(ws, files);
		const hashes = await inputHashes(files);

		// 回退路径:只提供 inspectFile。
		const fallbackCalls = { single: 0, batch: 0 };
		const fallback = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, currentConfig()),
			legacy: {
				legacyIndexDir: legacy.legacyDir,
				manifestPath: legacy.manifestPath,
				store: {
					inspectFile: async (path: string): Promise<PreparedBlock[]> => {
						fallbackCalls.single += 1;
						return legacy.store.inspectFile(path);
					},
				},
			},
			currentInputs: hashes,
		});

		// 批量路径:一次枚举全部分组。
		const batchCalls = { single: 0, batch: 0 };
		const batchRoot = path.join(ws.root, '.index-batch');
		const batch = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, currentConfig()),
			indexRoot: batchRoot,
			generations: new IndexGenerations({ indexRoot: batchRoot, owner: new TestWriteOwner() }),
			legacy: {
				legacyIndexDir: legacy.legacyDir,
				manifestPath: legacy.manifestPath,
				store: {
					inspectFile: async (path: string): Promise<PreparedBlock[]> => {
						batchCalls.single += 1;
						return legacy.store.inspectFile(path);
					},
					inspectFiles: async (paths: string[]): Promise<Map<string, PreparedBlock[]>> => {
						batchCalls.batch += 1;
						const grouped = new Map<string, PreparedBlock[]>();
						for (const path of paths) grouped.set(path, await legacy.store.inspectFile(path));
						return grouped;
					},
				},
			},
			currentInputs: hashes,
		});

		// 结论必须逐字一致,只是枚举次数不同。
		expect(batch.published).toBe(true);
		expect(batch.files).toEqual(fallback.files);
		expect(fallbackCalls.single).toBe(3);
		expect(fallbackCalls.batch).toBe(0);
		expect(batchCalls.batch).toBe(1);
		expect(batchCalls.single).toBe(0);
	});

	it('migrate - 真实 VectraStore 的 inspectFiles 接缝 - 结论与逐条枚举一致且单条调用归零', async () => {
		const ws = requireWorkspace();
		const files = [
			{ path: 'notes/v1.md', content: '甲\n乙', commitId: 'commit-v1' },
			{ path: 'notes/v2.md', content: '丙\n丁\n戊', commitId: 'commit-v2' },
		];
		const legacy = await createLegacyFixture(ws, files);
		const hashes = await inputHashes(files);

		// 真实存储已实现批量枚举(与 T6 约定同一签名):这里必须真的被调用,而不是被当成普通对象跳过。
		const batchSpy = vi.spyOn(legacy.store, 'inspectFiles');
		const singleSpy = vi.spyOn(legacy.store, 'inspectFile');
		const viaRealStore = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, currentConfig()),
			legacy: { legacyIndexDir: legacy.legacyDir, manifestPath: legacy.manifestPath, store: legacy.store },
			currentInputs: hashes,
		});
		expect(batchSpy).toHaveBeenCalledTimes(1);
		expect(batchSpy.mock.calls[0]?.[0]).toEqual(files.map((file) => file.path));
		// 批量路径下迁移自身不再逐条枚举(一次 listItems 由 inspectFiles 内部完成)。
		expect(singleSpy).not.toHaveBeenCalled();

		// 逐条回退路径:同一份旧数据、同一个清单,结论必须逐字一致。
		let fallbackSingle = 0;
		const viaSingleFile = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, currentConfig()),
			indexRoot: path.join(ws.root, '.index-single'),
			generations: new IndexGenerations({ indexRoot: path.join(ws.root, '.index-single'), owner: new TestWriteOwner() }),
			legacy: {
				legacyIndexDir: legacy.legacyDir,
				manifestPath: legacy.manifestPath,
				store: {
					inspectFile: async (path: string): Promise<PreparedBlock[]> => {
						fallbackSingle += 1;
						return legacy.store.inspectFile(path);
					},
				},
			},
			currentInputs: hashes,
		});
		batchSpy.mockRestore();
		singleSpy.mockRestore();

		expect(viaRealStore.published).toBe(true);
		expect(viaRealStore.files).toEqual(viaSingleFile.files);
		expect(fallbackSingle).toBe(files.length);
	});

	it('migrate - 批量枚举漏掉某路径 - 该文件按缺块重算,其余不受影响', async () => {
		const ws = requireWorkspace();
		const files = [
			{ path: 'notes/p1.md', content: '甲', commitId: 'commit-p1' },
			{ path: 'notes/p2.md', content: '乙', commitId: 'commit-p2' },
		];
		const legacy = await createLegacyFixture(ws, files);

		const result = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, currentConfig()),
			legacy: {
				legacyIndexDir: legacy.legacyDir,
				manifestPath: legacy.manifestPath,
				store: {
					inspectFile: async (path: string): Promise<PreparedBlock[]> => legacy.store.inspectFile(path),
					inspectFiles: async (): Promise<Map<string, PreparedBlock[]>> => new Map([['notes/p1.md', await legacy.store.inspectFile('notes/p1.md')]]),
				},
			},
			currentInputs: await inputHashes(files),
		});
		const byPath = new Map(result.files.map((file) => [file.path, file]));
		expect(byPath.get('notes/p1.md')?.status).toBe('reusable');
		expect(byPath.get('notes/p2.md')).toMatchObject({ status: 'reindex', reason: 'legacy-block-missing' });
	});

	it('migrate - 完成记录写入阶段故障 - 不发布控制指针且旧数据不变', async () => {
		const ws = requireWorkspace();
		const files = [{ path: 'notes/r.md', content: '甲\n乙', commitId: 'commit-r' }];
		const legacy = await createLegacyFixture(ws, files);
		const legacyBefore = digestTree(legacy.legacyDir);
		const input = migrationInput(ws, legacy, currentConfig());

		const result = await IndexGenerations.migrateLegacyIndex({
			...input,
			currentInputs: await inputHashes(files),
			io: { failReceiptWrite: 'EIO' },
		});

		expect(result.published).toBe(false);
		expect(result.committed).toBe(false);
		expect(result.phase).toBe('receipts');
		expect(result.reason).toBe('io-failed');
		expect(result.errorCode).toBe('migration-io-failed');
		expect(result.statePersisted).toBe(false);
		expect((await input.generations.readControl()).activeGenerationId).toBe(null);
		expect(digestTree(legacy.legacyDir)).toEqual(legacyBefore);
	});
});

// ==================== 3b. 历史模型标识归一化与真实 1.2.0 升级 ====================

/** 历史(1.2.0 及更早)本地模式下清单与构建戳写入的模型标识 — 无前缀。 */
const LEGACY_LOCAL_DEFAULT_MODEL_ID = 'Xenova/bge-small-zh-v1.5';
/** 历史 API 模式的模型标识 — `<embedApiBase>::<embedApiModel>`,无 `api:` 前缀。 */
const LEGACY_API_MODEL_ID = 'http://localhost:11434/v1::bge-m3';

/** 内置默认本地模型在 T6 约定下的当前标识 — 与默认设置下的 `resolveCurrentEmbedModelId` 一致。 */
function currentConfigForBuiltinLocal(overrides: Partial<IndexConfigDescriptor> = {}): IndexConfigDescriptor {
	return currentConfig({ embeddingModelId: `local:${LEGACY_LOCAL_DEFAULT_MODEL_ID}`, embeddingModelRevision: null, ...overrides });
}

/**
 * 构造真实的 1.2.0 风格旧索引:Vectra 数据、`ratel-manifest.json` 与 `build-stamp.json` 同处
 * `.index` 根(旧版 `indexDir`),模型标识使用历史无前缀形式。
 *
 * 关键路径:1.2.0 的清单与构建戳由**同一个** `resolveCurrentEmbedModelId` 写出,因此两者标识
 * 逐字相同;夹具必须保留这一点,否则测不出「戳侧也要归一化」。
 *
 * @param workspace - 工作区。
 * @param files - 合成文件(路径、正文、commitId)。
 * @param embedModelId - 历史模型标识;缺省用内置默认本地模型。
 * @returns legacy 夹具(索引目录即 `.index` 根)。
 */
async function createLegacyIndexV120(
	workspace: Workspace,
	files: ReadonlyArray<{ path: string; content: string; commitId: string }>,
	embedModelId: string = LEGACY_LOCAL_DEFAULT_MODEL_ID,
): Promise<LegacyFixture> {
	const legacyDir = path.join(workspace.root, '.index');
	const store = await writeIndexBlocks(legacyDir, files);
	const entries = await Promise.all(
		files.map(async (file) => ({
			path: file.path,
			hash: await sha256(file.content),
			chunkCount: chunkLines(file.content).length,
		})),
	);
	const manifest = legacyManifest(entries, { embedModelId });
	const manifestPath = path.join(legacyDir, 'ratel-manifest.json');
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
	fs.writeFileSync(
		path.join(legacyDir, 'build-stamp.json'),
		JSON.stringify(
			{
				chunkerVersion: CURRENT_CHUNKER_VERSION,
				chunkSize: CHUNK_SIZE,
				chunkOverlap: CHUNK_OVERLAP,
				embedModelId,
			},
			null,
			2,
		),
		'utf8',
	);
	return { legacyDir, manifestPath, files, manifest, store };
}

/** 旧索引自身文件的摘要(白名单数据文件 + 清单 + 构建戳)—— 迁移只读性的比对基线。 */
function legacyOwnFileDigest(dir: string): Map<string, string> {
	const result = new Map<string, string>();
	for (const name of [...whitelistFileNames(dir), 'ratel-manifest.json', 'build-stamp.json']) {
		const target = path.join(dir, name);
		if (fs.existsSync(target)) {
			result.set(name, createHash('sha256').update(fs.readFileSync(target)).digest('hex'));
		}
	}
	return result;
}

describe('IndexGenerations - 历史模型标识归一化', () => {
	it('normalizeLegacyEmbedModelId - 白名单内的历史形式 - 归一到内置默认本地模型的当前标识', () => {
		// 表内两行都必须落到同一规范标识,且与默认设置下 `resolveCurrentEmbedModelId` 的输出逐字一致。
		expect(normalizeLegacyEmbedModelId('local-default')).toBe(`local:${LEGACY_LOCAL_DEFAULT_MODEL_ID}`);
		expect(normalizeLegacyEmbedModelId(LEGACY_LOCAL_DEFAULT_MODEL_ID)).toBe(`local:${LEGACY_LOCAL_DEFAULT_MODEL_ID}`);
		// 已是当前约定形式的不被二次改写。
		expect(normalizeLegacyEmbedModelId(`local:${LEGACY_LOCAL_DEFAULT_MODEL_ID}`)).toBe(`local:${LEGACY_LOCAL_DEFAULT_MODEL_ID}`);
	});

	it('normalizeLegacyEmbedModelId - 白名单外形式 - 原样保留并落回不可确认', () => {
		// 历史 API 形式:端点/模型身份不可追溯,按 spec 不归一化。
		expect(normalizeLegacyEmbedModelId(LEGACY_API_MODEL_ID)).toBe(LEGACY_API_MODEL_ID);
		// 自定义本地 id 与近似拼写(大小写、空白)不得被视为同一身份。
		expect(normalizeLegacyEmbedModelId('Xenova/bge-m3')).toBe('Xenova/bge-m3');
		expect(normalizeLegacyEmbedModelId('xenova/bge-small-zh-v1.5')).toBe('xenova/bge-small-zh-v1.5');
		expect(normalizeLegacyEmbedModelId(` ${LEGACY_LOCAL_DEFAULT_MODEL_ID} `)).toBe(` ${LEGACY_LOCAL_DEFAULT_MODEL_ID} `);
		expect(normalizeLegacyEmbedModelId('')).toBe('');
		// 白名单外形式映射出的描述仍被判定不可确认(不是被归一化后蒙混过关)。
		const mapped = mapLegacyConfigIdentity(legacyManifest([], { embedModelId: LEGACY_API_MODEL_ID }), { embeddingDimension: DIMENSIONS });
		expect(mapped?.embeddingModelId).toBe(LEGACY_API_MODEL_ID);
		expect(mapped === null ? null : confirmsLegacyConfigIdentity(mapped)).toEqual({ confirmed: false, reason: 'model-id-unrecognized' });
	});

	it('mapLegacyConfigIdentity - 历史本地默认标识 - 归一化标识且修订仍为 null,不读当前设置', () => {
		const mapped = mapLegacyConfigIdentity(legacyManifest([], { embedModelId: 'local-default' }), { embeddingDimension: DIMENSIONS });
		expect(mapped).toEqual({
			embeddingModelId: `local:${LEGACY_LOCAL_DEFAULT_MODEL_ID}`,
			embeddingModelRevision: null,
			embeddingDimension: DIMENSIONS,
			chunkerVersion: CURRENT_CHUNKER_VERSION,
			chunkSize: CHUNK_SIZE,
			chunkOverlap: CHUNK_OVERLAP,
			embeddingTextVersion: null,
		});
		expect(mapped === null ? null : confirmsLegacyConfigIdentity(mapped)).toEqual({ confirmed: true });
	});

	it('migrate - 真实 1.2.0 风格旧索引(无前缀标识 + 构建戳)- 迁移成功且启动扫描嵌入调用数为 0', async () => {
		const ws = requireWorkspace();
		const files = [
			{ path: 'notes/v120-a.md', content: '第一行\n第二行\n第三行', commitId: 'commit-v120-a' },
			{ path: 'notes/v120-b.md', content: '甲乙\n丙', commitId: 'commit-v120-b' },
		];
		const legacy = await createLegacyIndexV120(ws, files);
		// 老索引的两处标识都是历史无前缀形式,且逐字相同(同一生产者)。
		expect((JSON.parse(fs.readFileSync(legacy.manifestPath, 'utf8')) as IndexManifestData).embedModelId).toBe(LEGACY_LOCAL_DEFAULT_MODEL_ID);
		expect(
			(JSON.parse(fs.readFileSync(path.join(legacy.legacyDir, 'build-stamp.json'), 'utf8')) as { embedModelId: string }).embedModelId,
		).toBe(LEGACY_LOCAL_DEFAULT_MODEL_ID);

		const embedPort = new FakeEmbeddingPort(DIMENSIONS);
		const legacyBefore = legacyOwnFileDigest(legacy.legacyDir);
		const result = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, currentConfigForBuiltinLocal()),
			currentInputs: await inputHashes(files),
		});

		expect(result.published).toBe(true);
		expect(result.committed).toBe(true);
		expect(result.reason).toBe(null);
		expect(result.files.map((file) => file.status)).toEqual(['reusable', 'reusable']);
		expect(result.activeGenerationId).toBe(result.generationId);
		// 迁移是只读复制:旧索引自身文件逐字不变(代际目录与控制指针属于新增,不在比对范围)。
		expect(legacyOwnFileDigest(legacy.legacyDir)).toEqual(legacyBefore);

		// receipt 必须与旧索引磁盘上的真实块集合匹配 —— 否则下面那行零嵌入只是假绿。
		const journal = await journalForGeneration(ws, result.generationId!, result.configFingerprint!);
		for (const file of files) {
			const verified = await journal.verifyReceipt(file.path);
			expect(verified?.matches).toBe(true);
			expect(verified?.blocks.length).toBe(chunkLines(file.content).length);
		}

		// 关键验收:真实 1.2.0 老索引升级后,嵌入端口一次都不该被调用。
		const scan = await probeStartupScan({ journal, port: embedPort, files });
		expect(scan.reembedded).toEqual([]);
		expect(scan.reused).toEqual(files.map((file) => file.path));
		expect(scan.embedCalls).toBe(0);
		expect(embedPort.callCount).toBe(0);
	});

	it('migrate - 历史 local-default 回落字面量 - 当前仍用内置默认本地模型时同样零嵌入', async () => {
		const ws = requireWorkspace();
		const files = [{ path: 'notes/v120-c.md', content: '甲\n乙\n丙', commitId: 'commit-v120-c' }];
		const legacy = await createLegacyIndexV120(ws, files, 'local-default');
		const embedPort = new FakeEmbeddingPort(DIMENSIONS);

		const result = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, currentConfigForBuiltinLocal()),
			currentInputs: await inputHashes(files),
		});

		expect(result.published).toBe(true);
		expect(result.files).toEqual([expect.objectContaining({ path: 'notes/v120-c.md', status: 'reusable' })]);
		const journal = await journalForGeneration(ws, result.generationId!, result.configFingerprint!);
		expect((await journal.verifyReceipt('notes/v120-c.md'))?.matches).toBe(true);
		const scan = await probeStartupScan({ journal, port: embedPort, files });
		expect(scan.embedCalls).toBe(0);
	});

	it('migrate - 历史无前缀标识但当前本地模型不同 - 判不可确认,不复制、不登记、不发布', async () => {
		const ws = requireWorkspace();
		const files = [{ path: 'notes/v120-d.md', content: '甲\n乙', commitId: 'commit-v120-d' }];
		const legacy = await createLegacyIndexV120(ws, files);
		const input = migrationInput(ws, legacy, currentConfigForBuiltinLocal({ embeddingModelId: 'local:Xenova/bge-m3' }));

		const result = await IndexGenerations.migrateLegacyIndex({ ...input, currentInputs: await inputHashes(files) });

		expect(result.published).toBe(false);
		expect(result.committed).toBe(false);
		expect(result.reason).toBe('config-identity-unconfirmed');
		expect(result.errorCode).toBe('config-identity-unconfirmed');
		expect(result.files).toEqual([]);
		expect(result.generationId).toBe(null);
		expect(result.copiedFileNames).toEqual([]);
		expect(result.copiedBytes).toBe(0);
		// 控制指针未落盘、没有登记任何代际、没有新建代际目录(复制都没开始)。
		const control = await input.generations.readControl();
		expect(control.activeGenerationId).toBe(null);
		expect(control.generations).toEqual({});
		expect(fs.existsSync(path.join(ws.root, '.index', INDEX_GENERATIONS_DIRNAME))).toBe(false);
	});

	it('migrate - 历史 API 形式 <base>::<model> - 当前配置即使带修订也不兼容', async () => {
		const ws = requireWorkspace();
		const files = [{ path: 'notes/v120-e.md', content: '甲\n乙', commitId: 'commit-v120-e' }];
		const legacy = await createLegacyIndexV120(ws, files, LEGACY_API_MODEL_ID);
		// 反证:当前侧的 `api:` 身份带修订、本身可确认 —— 拒绝必须来自「旧身份不可重建」,
		// 而不是被当前侧的不确认掩盖。
		const config = currentConfig({
			embeddingModelId: `api:${LEGACY_API_MODEL_ID}`,
			embeddingModelRevision: '2024-02-01',
		});
		expect(confirmsLegacyConfigIdentity(config)).toEqual({ confirmed: true });
		const input = migrationInput(ws, legacy, config);

		const result = await IndexGenerations.migrateLegacyIndex({ ...input, currentInputs: await inputHashes(files) });

		expect(result.published).toBe(false);
		expect(result.reason).toBe('config-identity-unconfirmed');
		expect(result.errorCode).toBe('config-identity-unconfirmed');
		expect(result.files).toEqual([]);
		expect((await input.generations.readControl()).activeGenerationId).toBe(null);
		expect(fs.existsSync(path.join(ws.root, '.index', INDEX_GENERATIONS_DIRNAME))).toBe(false);
	});

	it('migrate - 构建戳与清单的互证 - 归一化后同类标识视为一致,不同模型仍判矛盾', async () => {
		const ws = requireWorkspace();
		const files = [{ path: 'notes/v120-f.md', content: '甲', commitId: 'commit-v120-f' }];
		// 清单写内置默认模型原始 id、构建戳写回落字面量:两者指向同一模型,归一化后一致。
		const legacy = await createLegacyIndexV120(ws, files);
		fs.writeFileSync(
			path.join(legacy.legacyDir, 'build-stamp.json'),
			JSON.stringify(
				{ chunkerVersion: CURRENT_CHUNKER_VERSION, chunkSize: CHUNK_SIZE, chunkOverlap: CHUNK_OVERLAP, embedModelId: 'local-default' },
				null,
				2,
			),
			'utf8',
		);
		const accepted = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, currentConfigForBuiltinLocal()),
			currentInputs: await inputHashes(files),
		});
		expect(accepted.published).toBe(true);
		expect(accepted.files).toEqual([expect.objectContaining({ path: 'notes/v120-f.md', status: 'reusable' })]);

		// 对照组:戳指向另一个本地模型 —— 互证失败,一律不迁移。
		const second = createWorkspace();
		try {
			const files2 = [{ path: 'notes/v120-g.md', content: '乙', commitId: 'commit-v120-g' }];
			const legacy2 = await createLegacyIndexV120(second, files2);
			fs.writeFileSync(
				path.join(legacy2.legacyDir, 'build-stamp.json'),
				JSON.stringify(
					{ chunkerVersion: CURRENT_CHUNKER_VERSION, chunkSize: CHUNK_SIZE, chunkOverlap: CHUNK_OVERLAP, embedModelId: 'Xenova/bge-m3' },
					null,
					2,
				),
				'utf8',
			);
			const rejected = await IndexGenerations.migrateLegacyIndex({
				...migrationInput(second, legacy2, currentConfigForBuiltinLocal()),
				currentInputs: await inputHashes(files2),
			});
			expect(rejected.published).toBe(false);
			expect(rejected.reason).toBe('config-identity-unconfirmed');
			expect(rejected.files).toEqual([]);
		} finally {
			second.dispose();
		}
	});
});

// ==================== 3c. 迁移派生视图(清单 + 构建戳)与启动路径门禁 ====================

/** 由当前配置推导装配层会写出的构建戳 — 与 `main.ts` 的 `currentBuildStamp()` 同口径。 */
function buildStampOf(config: IndexConfigDescriptor): IndexBuildStamp {
	return {
		chunkerVersion: config.chunkerVersion,
		chunkSize: config.chunkSize,
		chunkOverlap: config.chunkOverlap,
		embedModelId: config.embeddingModelId,
	};
}

/** 真实后端夹具 — 装配关系与 `main.ts` 同构:`indexDir` 即代际目录,清单/戳都落在该目录内。 */
interface RealBackendFixture {
	readonly backend: PersistentIndexBackend;
	readonly store: VectraStore;
	/** 嵌入端口的**调用次数**(不是文本条数)。 */
	embedCalls(): number;
	dispose(): void;
}

/**
 * 在给定目录上装配真实 `PersistentIndexBackend`。
 *
 * 关键路径:验收必须用**真实后端**判定启动路径是否全量重算 —— 只看迁移返回值无法证明
 * `smartReindex` 的门禁(清单存在 + 参数兼容 + 构建戳一致 + 与 vault 快照逐文件 hash 一致)。
 * 这里不注入 `assertDropOwnership`,走后端缺省的归属判定,与生产装配只差归属白名单。
 *
 * @param input - 索引目录、vault 文件快照、构建戳与可选的完成记录端口。
 * @returns 真实后端夹具;`dispose` 负责回收 Worker。
 */
async function createRealBackend(input: {
	indexDir: string;
	files: ReadonlyArray<{ path: string; content: string }>;
	stamp: IndexBuildStamp;
	fileRecords?: FileRecordReader | null;
}): Promise<RealBackendFixture> {
	const store = new VectraStore(input.indexDir, {
		storage: new AtomicIndexStorage({ generationRoot: input.indexDir }),
	});
	await store.isIndexCreated();
	const contents = new Map(input.files.map((file) => [file.path, file.content] as const));
	let embedCalls = 0;
	const inline = new InlineWorker();
	inline.initWithStore(store, {
		modelId: input.stamp.embedModelId,
		dimensions: DIMENSIONS,
		embed: async (texts: string[]): Promise<number[][]> => {
			embedCalls += 1;
			return texts.map((text) => deterministicVector(text, DIMENSIONS));
		},
	});
	const worker = new WorkerManager(inline, { timeoutMs: 5_000 });
	const backend = new PersistentIndexBackend({
		indexDir: input.indexDir,
		manifest: new IndexManifest(resolveIndexManifestPath(input.indexDir)),
		worker,
		getStore: () => store,
		vault: {
			listMarkdownFiles: () => [...contents.keys()],
			readFile: async (filePath: string) => contents.get(filePath) ?? '',
			stat: () => ({ mtime: 1 }),
		},
		getBuildStamp: () => input.stamp,
		getChunkOptions: () => ({ maxTokens: CHUNK_SIZE, overlapTokens: CHUNK_OVERLAP }),
		...(input.fileRecords === undefined ? {} : { fileRecords: input.fileRecords }),
	});
	return {
		backend,
		store,
		embedCalls: () => embedCalls,
		dispose: () => {
			worker.destroy();
		},
	};
}

describe('IndexGenerations - 迁移派生视图与启动路径门禁', () => {
	it('migrate - 有效旧索引迁移成功 - 代际目录内含只覆盖已复用文件的清单与当前配置的构建戳', async () => {
		const ws = requireWorkspace();
		const config = currentConfig();
		const files = [
			{ path: 'notes/view-a.md', content: '第一行\n第二行', commitId: 'commit-view-a' },
			{ path: 'notes/view-b.md', content: '甲\n乙\n丙', commitId: 'commit-view-b' },
		];
		const legacy = await createLegacyFixture(ws, files);
		const result = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, config),
			// 只给 `notes/view-a.md` 的当前内容 hash —— `notes/view-b.md` 视为内容未知,按重算处理。
			currentInputs: await inputHashes([files[0]!]),
		});

		expect(result.published).toBe(true);
		const statusByPath = new Map(result.files.map((file) => [file.path, file.status] as const));
		expect(statusByPath.get('notes/view-a.md')).toBe('reusable');
		expect(statusByPath.get('notes/view-b.md')).toBe('reindex');

		const generationRoot = path.join(ws.root, '.index', INDEX_GENERATIONS_DIRNAME, result.generationId!);
		// 关键路径:派生视图必须落在**代际目录**内(装配层把 indexDir 绑到这里),不在 `.index` 根。
		expect(fs.existsSync(path.join(generationRoot, 'ratel-manifest.json'))).toBe(true);
		expect(fs.existsSync(path.join(generationRoot, 'build-stamp.json'))).toBe(true);
		expect(fs.existsSync(path.join(ws.root, '.index', 'ratel-manifest.json'))).toBe(false);
		expect(fs.existsSync(path.join(ws.root, '.index', 'build-stamp.json'))).toBe(false);

		const manifestStore = new IndexManifest(resolveIndexManifestPath(generationRoot));
		const data = await manifestStore.load();
		expect(data).not.toBe(null);
		// 关键路径:条目只覆盖已复用文件 —— 未复用路径不得出现在清单里(它必须按 toAdd 重算)。
		expect(Object.keys(data!.entries)).toEqual(['notes/view-a.md']);
		expect(data!.entries['notes/view-a.md']).toEqual({
			path: 'notes/view-a.md',
			hash: await sha256(files[0]!.content),
			mtime: 1_700_000_000_000,
			chunkCount: chunkLines(files[0]!.content).length,
		});

		const stamp = buildStampOf(config);
		expect(data).toMatchObject({ version: 1, ...stamp });
		expect(Number.isFinite(data!.lastIndexTime)).toBe(true);
		expect(await readBuildStamp(generationRoot)).toEqual(stamp);
		// 门禁判定:迁移写出的清单与戳必须让启动路径的「是否需要全量重建」为 false。
		expect(
			manifestStore.shouldFullRebuild(data!, stamp.embedModelId, stamp.chunkSize, stamp.chunkOverlap, stamp.chunkerVersion),
		).toBe(false);
		expect(isBuildStampCurrent(await readBuildStamp(generationRoot), stamp)).toBe(true);
	});

	it('启动路径 - 真实 1.2.0 旧索引迁移后 - 真实 smartReindex 不触发全量重算且嵌入调用数为 0', async () => {
		const ws = requireWorkspace();
		const config = currentConfigForBuiltinLocal();
		const files = [
			{ path: 'notes/view-v120-a.md', content: '第一行\n第二行\n第三行', commitId: 'commit-view-v120-a' },
			{ path: 'notes/view-v120-b.md', content: '甲乙\n丙', commitId: 'commit-view-v120-b' },
		];
		const legacy = await createLegacyIndexV120(ws, files);
		const result = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, config),
			currentInputs: await inputHashes(files),
		});
		expect(result.published).toBe(true);
		expect(result.files.map((file) => file.status)).toEqual(['reusable', 'reusable']);

		const generationRoot = path.join(ws.root, '.index', INDEX_GENERATIONS_DIRNAME, result.generationId!);
		// 装配层真实口径:清单绑代际目录、构建戳 `local:<内置模型>`(旧索引的无前缀标识不再被读到)。
		const fixture = await createRealBackend({
			indexDir: generationRoot,
			files,
			stamp: buildStampOf(config),
			fileRecords: await journalForGeneration(ws, result.generationId!, result.configFingerprint!),
		});
		try {
			const outcome = await fixture.backend.smartReindex();
			// 关键验收:三者同时成立才说明走的是 hash diff 分支而不是全量分支
			// (`full()` 的返回是 `skipped: 0` 且逐文件重嵌入)。
			expect(outcome.skipped).toBe(files.length);
			expect(outcome.indexed).toBe(0);
			expect(outcome.errors).toBe(0);
			expect(fixture.embedCalls()).toBe(0);
			// 凭据门禁(清单 + 构建戳 + index.json)一致;全量分支会先 dropStore,目录内文件不会留存。
			expect(await fixture.backend.readCommittedState()).not.toBe(null);
			expect(fs.existsSync(path.join(generationRoot, 'ratel-manifest.json'))).toBe(true);
			expect(fs.existsSync(path.join(generationRoot, 'build-stamp.json'))).toBe(true);
			expect(fs.existsSync(path.join(generationRoot, 'index.json'))).toBe(true);
		} finally {
			fixture.dispose();
		}
	});

	it('启动路径 - 未迁移的 1.2.0 目录直接装配 - 真实 smartReindex 判定全量重建并真实调用嵌入(对照)', async () => {
		const ws = requireWorkspace();
		const config = currentConfigForBuiltinLocal();
		const files = [
			{ path: 'notes/view-control-a.md', content: '甲\n乙', commitId: 'commit-view-control-a' },
			{ path: 'notes/view-control-b.md', content: '丙\n丁\n戊', commitId: 'commit-view-control-b' },
		];
		const legacy = await createLegacyIndexV120(ws, files);
		// 未迁移:装配层把 `.index` 根当代际目录,读到的是 1.2.0 的无前缀清单 —— 与当前戳逐字不等。
		const fixture = await createRealBackend({ indexDir: legacy.legacyDir, files, stamp: buildStampOf(config) });
		try {
			const outcome = await fixture.backend.smartReindex();
			// 对照证明门禁真实且嵌入计数有效:`skipped` 为 0 并逐文件真实重嵌入。
			expect(outcome.skipped).toBe(0);
			expect(outcome.indexed).toBe(files.length);
			expect(fixture.embedCalls()).toBeGreaterThan(0);

			// 清单与戳缺失且没有可核验的完成记录时，必须保留向量并拒绝旧式清库回退。
			// 反向对照：不能因 index.json 存在就补造可信记录，也不能用重嵌入掩盖身份缺失。
			fs.rmSync(resolveIndexManifestPath(legacy.legacyDir), { force: true });
			fs.rmSync(resolveBuildStampPath(legacy.legacyDir), { force: true });
			const embedBefore = fixture.embedCalls();
			const vectorsBefore = fs.readFileSync(path.join(legacy.legacyDir, 'index.json'));
			await expect(fixture.backend.smartReindex()).rejects.toThrow();
			expect(fixture.embedCalls()).toBe(embedBefore);
			expect(fs.readFileSync(path.join(legacy.legacyDir, 'index.json'))).toEqual(vectorsBefore);
			expect(fs.existsSync(resolveIndexManifestPath(legacy.legacyDir))).toBe(false);
		} finally {
			fixture.dispose();
		}
	});

	it('migrate - 派生视图写入失败 - 不发布控制指针也不留下清单与构建戳', async () => {
		const ws = requireWorkspace();
		const files = [{ path: 'notes/view-io.md', content: '甲\n乙', commitId: 'commit-view-io' }];
		const legacy = await createLegacyFixture(ws, files);
		const input = migrationInput(ws, legacy, currentConfig());

		const result = await IndexGenerations.migrateLegacyIndex({
			...input,
			currentInputs: await inputHashes(files),
			io: { failManifestWrite: 'EIO' },
		});

		expect(result.published).toBe(false);
		expect(result.committed).toBe(false);
		expect(result.phase).toBe('receipts');
		expect(result.reason).toBe('io-failed');
		expect(result.errorCode).toBe('migration-io-failed');
		expect(result.statePersisted).toBe(false);
		// 控制指针未动、代际未登记:派生视图写失败发生在原子发布之前。
		const control = await input.generations.readControl();
		expect(control.activeGenerationId).toBe(null);
		expect(control.generations).toEqual({});
		const generationRoot = path.join(ws.root, '.index', INDEX_GENERATIONS_DIRNAME, result.generationId!);
		expect(fs.existsSync(path.join(generationRoot, 'ratel-manifest.json'))).toBe(false);
		expect(fs.existsSync(path.join(generationRoot, 'build-stamp.json'))).toBe(false);
	});

	it('migrate - 身份不可确认 - 不写清单与戳,连代际目录都不建(反向对照)', async () => {
		const ws = requireWorkspace();
		const files = [{ path: 'notes/view-reverse.md', content: '甲\n乙', commitId: 'commit-view-reverse' }];
		// 旧清单缺 `chunkerVersion` → 分块身份不可确认,一块都不复用(不是「清单非法」)。
		const legacy = await createLegacyFixture(ws, files, { chunkerVersion: undefined as never });
		const input = migrationInput(ws, legacy, currentConfig());
		const legacyBefore = legacyOwnFileDigest(legacy.legacyDir);

		const result = await IndexGenerations.migrateLegacyIndex({
			...input,
			currentInputs: await inputHashes(files),
		});

		expect(result.published).toBe(false);
		expect(result.reason).toBe('config-identity-unconfirmed');
		expect(result.files).toEqual([]);
		expect(result.generationId).toBe(null);
		// 反向对照:没有代际目录,也就没有任何清单/构建戳被写出来。
		expect(fs.existsSync(path.join(ws.root, '.index'))).toBe(false);
		expect(fs.existsSync(path.join(ws.root, '.index', INDEX_GENERATIONS_DIRNAME))).toBe(false);
		// 旧索引目录保持只读:不追加清单与戳。
		expect(legacyOwnFileDigest(legacy.legacyDir)).toEqual(legacyBefore);
		expect(fs.existsSync(path.join(legacy.legacyDir, 'build-stamp.json'))).toBe(false);
	});
});

// ==================== 4. 迁移中断与空间不足 ====================

describe('IndexGenerations - 迁移中断与空间不足', () => {
	it('migrate - 复制中断后重入 - 可完成迁移且不重复嵌入', async () => {
		const ws = requireWorkspace();
		const files = [
			{ path: 'notes/j1.md', content: '甲\n乙', commitId: 'commit-j1' },
			{ path: 'notes/j2.md', content: '丙\n丁', commitId: 'commit-j2' },
			{ path: 'notes/j3.md', content: '戊', commitId: 'commit-j3' },
		];
		const legacy = await createLegacyFixture(ws, files);

		const interrupted = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, currentConfig()),
			currentInputs: await inputHashes(files),
			io: { failAfterBytes: 1, failErrno: 'EIO' },
		});
		expect(interrupted.published).toBe(false);
		expect(interrupted.reason).toBe('io-failed');
		// 失败不得删除旧数据。
		expect(digestTree(legacy.legacyDir).size).toBeGreaterThan(0);

		const resumed = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, currentConfig()),
			currentInputs: await inputHashes(files),
		});
		expect(resumed.published).toBe(true);
		expect(resumed.files.map((file) => file.status)).toEqual(['reusable', 'reusable', 'reusable']);
		// 已成功复制的文件不重复复制:首轮恰好复制了排序后的第一个白名单文件,
		// 因此续做的复制数必须精确等于「白名单文件数 − 1」。
		expect(resumed.copiedFileNames.length).toBe(whitelistFileNames(legacy.legacyDir).length - 1);

		const journal = await journalForGeneration(ws, resumed.generationId!, resumed.configFingerprint!);
		for (const file of files) {
			expect((await journal.verifyReceipt(file.path))?.matches).toBe(true);
		}
	});

	it('migrate - 空间不足 - 只报告失败,不先删旧数据腾空间', async () => {
		const ws = requireWorkspace();
		const files = [{ path: 'notes/k.md', content: '甲\n乙\n丙', commitId: 'commit-k' }];
		const legacy = await createLegacyFixture(ws, files);
		const legacyBefore = digestTree(legacy.legacyDir);
		const result = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, currentConfig()),
			currentInputs: await inputHashes(files),
			io: { failAfterBytes: 0, failErrno: 'ENOSPC' },
		});
		expect(result.published).toBe(false);
		expect(result.reason).toBe('space-insufficient');
		expect(result.errorCode).toBe('migration-space-insufficient');
		expect(digestTree(legacy.legacyDir)).toEqual(legacyBefore);
	});

	it('migrate - 复制字节超预算 - 报告空间不足且旧数据逐字不变', async () => {
		const ws = requireWorkspace();
		const files = [{ path: 'notes/l.md', content: '甲\n乙\n丙', commitId: 'commit-l' }];
		const legacy = await createLegacyFixture(ws, files);
		const legacyBefore = digestTree(legacy.legacyDir);
		const result = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, currentConfig()),
			currentInputs: await inputHashes(files),
			spaceBudgetBytes: 1,
		});
		expect(result.published).toBe(false);
		expect(result.reason).toBe('space-insufficient');
		expect(digestTree(legacy.legacyDir)).toEqual(legacyBefore);
	});

	it('migrate - 进度状态刷新 - 按阈值批量落盘而非每文件一次(近线性)', async () => {
		const ws = requireWorkspace();
		// 手工构造一个只含白名单文件的旧目录:复制次数完全由文件数决定,不受 vectra 内部布局影响。
		const legacyDir = path.join(ws.root, 'legacy-many');
		fs.mkdirSync(legacyDir, { recursive: true });
		const names = ['index.json', 'catalog.json'];
		for (let index = 0; index < 40; index += 1) {
			const prefix = index.toString(16).padStart(8, '0');
			names.push(`${prefix}-1111-2222-3333-444455556666.json`);
		}
		for (const name of names) fs.writeFileSync(path.join(legacyDir, name), JSON.stringify({ payload: name }), 'utf8');
		const manifestPath = path.join(ws.root, 'legacy-many-manifest.json');
		fs.writeFileSync(manifestPath, JSON.stringify(legacyManifest([]), null, 2), 'utf8');

		const indexRoot = path.join(ws.root, '.index');
		const owner = new TestWriteOwner();
		const flushes: Array<{ copied: number; payloadBytes: number }> = [];
		const result = await IndexGenerations.migrateLegacyIndex({
			indexRoot,
			generations: new IndexGenerations({ indexRoot, owner }),
			config: currentConfig(),
			legacy: { legacyIndexDir: legacyDir, manifestPath, store: { inspectFile: async (): Promise<PreparedBlock[]> => [] } },
			owner,
			currentInputs: new Map(),
			chunkLimits: { chunkSize: CHUNK_SIZE, chunkOverlap: CHUNK_OVERLAP },
			io: { onStateFlush: (info) => flushes.push({ ...info }) },
		});

		expect(result.published).toBe(true);
		const total = whitelistFileNames(legacyDir).length;
		expect(total).toBe(42);
		// 每 K 个文件刷新一次 + 阶段结束强制刷一次 = floor(N/K) + 1;旧实现是 N 次。
		expect(flushes.length).toBe(Math.floor(total / MIGRATION_STATE_FLUSH_FILE_INTERVAL) + 1);
		expect(flushes.length).toBeLessThan(total);
		expect(flushes[flushes.length - 1]?.copied).toBe(total);
		// 单次刷新的负载有上界,不会随文件数无限膨胀。
		expect(flushes[flushes.length - 1]!.payloadBytes).toBeLessThan(MIGRATION_STATE_FLUSH_BYTE_INTERVAL);

		// 进度状态文件只保留重入真正需要的 `copied` 视图:只写不读的 phase 字段已删除。
		const statePath = path.join(indexRoot, INDEX_GENERATIONS_DIRNAME, result.generationId!, INDEX_GENERATION_MIGRATION_STATE_FILENAME);
		const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
		expect(Object.keys(state['copied'] as Record<string, string>)).toHaveLength(total);
		expect(state['phase']).toBeUndefined();
	});

	it('migrate - 复制阶段被 owner 接管 - 发布前拒绝且控制指针不变', async () => {
		const ws = requireWorkspace();
		const files = [{ path: 'notes/o.md', content: '甲\n乙', commitId: 'commit-o' }];
		const legacy = await createLegacyFixture(ws, files);
		const owner = new TestWriteOwner();
		const indexRoot = path.join(ws.root, '.index');
		const generations = new IndexGenerations({ indexRoot, owner });
		// 关键注入:复制阶段第一次状态刷新时撤销写所有权 —— 发布前必须再断言一次。
		const result = await IndexGenerations.migrateLegacyIndex({
			indexRoot,
			generations,
			config: currentConfig(),
			legacy: { legacyIndexDir: legacy.legacyDir, manifestPath: legacy.manifestPath, store: legacy.store },
			owner,
			currentInputs: await inputHashes(files),
			chunkLimits: { chunkSize: CHUNK_SIZE, chunkOverlap: CHUNK_OVERLAP },
			io: { onStateFlush: () => { owner.writable = false; } },
		});

		expect(result.published).toBe(false);
		expect(result.committed).toBe(false);
		expect(result.reason).toBe('owner-not-writable');
		expect(result.errorCode).toBe('owner-not-writable');
		expect(result.phase).toBe('publish');
		expect((await generations.readControl()).activeGenerationId).toBe(null);
	});

	it('migrate - publish 之后状态写失败 - published 仍为 true 且控制指针真实指向新代际', async () => {
		const ws = requireWorkspace();
		const files = [{ path: 'notes/w.md', content: '甲\n乙', commitId: 'commit-w' }];
		const legacy = await createLegacyFixture(ws, files);
		const generations = generationsFor(ws);

		const result = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, currentConfig()),
			generations,
			currentInputs: await inputHashes(files),
			io: { failMigrationStateWrite: 'EIO' },
		});

		// 关键路径:发布已经发生,不能被后续状态写失败改写成「未发布」。
		expect(result.published).toBe(true);
		expect(result.committed).toBe(true);
		expect(result.phase).toBe('done');
		expect(result.reason).toBe(null);
		// 独立结论:已发布但状态未写。
		expect(result.statePersisted).toBe(false);
		const control = await generations.readControl();
		expect(control.activeGenerationId).toBe(result.generationId);
		expect(control.generations[result.generationId!]?.status).toBe('active');
	});
});

// ==================== 5. 代际切换与回收 ====================

describe('IndexGenerations - 代际切换与回收', () => {
	it('publishActiveGeneration - 首次无活动代际 - 登记活动代际并允许部分检索', async () => {
		const ws = requireWorkspace();
		const generations = generationsFor(ws);
		const record = await generations.ensureGeneration({ config: currentConfig() });
		expect(record.status).toBe('building');
		expect((await generations.readControl()).activeGenerationId).toBe(null);

		await generations.publishActiveGeneration({ generationId: record.generationId, mode: 'upgrade' });
		const state = await generations.readControl();
		expect(state.activeGenerationId).toBe(record.generationId);
		expect(state.generations[record.generationId]?.status).toBe('active');
	});

	it('publishActiveGeneration - 配置变化构建未核对 - 拒绝切换活动指针', async () => {
		const ws = requireWorkspace();
		const generations = generationsFor(ws);
		const active = await generations.ensureGeneration({ config: currentConfig() });
		await generations.publishActiveGeneration({ generationId: active.generationId, mode: 'upgrade' });
		const building = await generations.ensureGeneration({
			config: currentConfig({ embeddingModelId: 'local:other-model' }),
		});
		await expect(
			generations.publishActiveGeneration({ generationId: building.generationId, mode: 'configured-switch' }),
		).rejects.toMatchObject({ code: 'switch-not-verified' });
		// 部分失败不能切换:活动指针必须保持原值。
		expect((await generations.readControl()).activeGenerationId).toBe(active.generationId);

		// 全部核对完成后才允许切换。
		await generations.markGenerationMigrated({ generationId: building.generationId });
		await generations.publishActiveGeneration({ generationId: building.generationId, mode: 'configured-switch' });
		const state = await generations.readControl();
		expect(state.activeGenerationId).toBe(building.generationId);
		expect(state.generations[active.generationId]?.status).toBe('migrated');
	});

	it('beginVerification - 切回同一配置 - 必须先降级再重新核对,不能凭旧状态切回', async () => {
		const ws = requireWorkspace();
		const generations = generationsFor(ws);
		const record = await generations.ensureGeneration({ config: currentConfig() });
		await generations.publishActiveGeneration({ generationId: record.generationId, mode: 'upgrade' });
		await generations.beginVerification({ generationId: record.generationId });
		const state = await generations.readControl();
		expect(state.generations[record.generationId]?.status).toBe('verifying');
		// 关键路径:降级同时清空「本轮已验证」标记 —— 旧 ready 不能被直接恢复。
		expect(state.generations[record.generationId]?.verifiedAt).toBe(null);
		expect(state.activeGenerationId).toBe(record.generationId);

		// 只降级不重新核对时,切换必须被拒绝。
		await expect(
			generations.publishActiveGeneration({ generationId: record.generationId, mode: 'configured-switch' }),
		).rejects.toMatchObject({ code: 'switch-not-verified' });
		expect((await generations.readControl()).generations[record.generationId]?.status).toBe('verifying');

		// 重新核对完成(写回 verifiedAt)后才回到活动状态。
		await generations.markGenerationMigrated({ generationId: record.generationId });
		expect((await generations.readControl()).generations[record.generationId]?.verifiedAt).not.toBe(null);
		await generations.publishActiveGeneration({ generationId: record.generationId, mode: 'configured-switch' });
		expect((await generations.readControl()).generations[record.generationId]?.status).toBe('active');
	});

	it('reconcileForNewGeneration - 第三配置不可回收时 - 暂停新建并保留活动索引', async () => {
		const ws = requireWorkspace();
		const generations = generationsFor(ws);
		const active = await generations.ensureGeneration({ config: currentConfig() });
		await generations.publishActiveGeneration({ generationId: active.generationId, mode: 'upgrade' });
		const pending = await generations.ensureGeneration({
			config: currentConfig({ embeddingModelId: 'local:second-model' }),
		});
		const probes = new Map<string, GenerationReconcileProbeResult>([
			[active.generationId, { pendingPaths: 0, generationQuarantined: false, pathQuarantined: 0, quarantinedTransactions: 0 }],
			[pending.generationId, { pendingPaths: 2, generationQuarantined: false, pathQuarantined: 1, quarantinedTransactions: 0 }],
		]);

		const decision = await generations.reconcileForNewGeneration({
			probes,
			requestedFingerprint: 'f'.repeat(64),
		});
		expect(decision.blockedReason).toBe('all-generations-retained');
		expect(decision.reclaimed).toEqual([]);
		expect(decision.canCreate).toBe(false);
		expect((await generations.readControl()).activeGenerationId).toBe(active.generationId);
		expect(fs.existsSync(pending.generationRoot)).toBe(true);
	});

	it('reconcileForNewGeneration - 可回收不活动且无未解决事务的代际 - 回收后允许新建', async () => {
		const ws = requireWorkspace();
		const generations = generationsFor(ws);
		const active = await generations.ensureGeneration({ config: currentConfig() });
		await generations.publishActiveGeneration({ generationId: active.generationId, mode: 'upgrade' });
		const idle = await generations.ensureGeneration({ config: currentConfig({ embeddingModelId: 'local:idle-model' }) });
		await generations.markGenerationMigrated({ generationId: idle.generationId });
		const probes = new Map<string, GenerationReconcileProbeResult>([
			[active.generationId, { pendingPaths: 0, generationQuarantined: false, pathQuarantined: 0, quarantinedTransactions: 0 }],
			[idle.generationId, { pendingPaths: 0, generationQuarantined: false, pathQuarantined: 0, quarantinedTransactions: 0 }],
		]);

		const decision = await generations.reconcileForNewGeneration({ probes, requestedFingerprint: 'f'.repeat(64) });
		expect(decision.reclaimed).toEqual([idle.generationId]);
		// 活动代际由规则保留,不属于「未能回收」。
		expect(decision.retained).toEqual([]);
		expect(decision.canCreate).toBe(true);
		expect(fs.existsSync(idle.generationRoot)).toBe(false);
		expect(fs.existsSync(active.generationRoot)).toBe(true);
	});

	it('reconcileForNewGeneration - 代际被隔离或存在未决事务 - 一律不回收', async () => {
		const ws = requireWorkspace();
		const generations = generationsFor(ws);
		const active = await generations.ensureGeneration({ config: currentConfig() });
		await generations.publishActiveGeneration({ generationId: active.generationId, mode: 'upgrade' });
		const blocked = await generations.ensureGeneration({ config: currentConfig({ embeddingModelId: 'local:blocked-model' }) });
		await generations.markGenerationMigrated({ generationId: blocked.generationId });
		const quarantined = await generations.ensureGeneration({
			config: currentConfig({ embeddingModelId: 'local:quarantined-model' }),
		});
		await generations.markGenerationMigrated({ generationId: quarantined.generationId });
		const probes = new Map<string, GenerationReconcileProbeResult>([
			[active.generationId, { pendingPaths: 0, generationQuarantined: false, pathQuarantined: 0, quarantinedTransactions: 0 }],
			[blocked.generationId, { pendingPaths: 1, generationQuarantined: false, pathQuarantined: 0, quarantinedTransactions: 0 }],
			[quarantined.generationId, { pendingPaths: 0, generationQuarantined: false, pathQuarantined: 3, quarantinedTransactions: 0 }],
		]);
		const decision = await generations.reconcileForNewGeneration({ probes, requestedFingerprint: 'e'.repeat(64) });
		expect(decision.reclaimed).toEqual([]);
		expect(decision.canCreate).toBe(false);
		expect(decision.blockedReason).toBe('all-generations-retained');
		expect(fs.existsSync(blocked.generationRoot)).toBe(true);
		expect(fs.existsSync(quarantined.generationRoot)).toBe(true);
	});

	it('reconcileForNewGeneration - 不得回收活动代际', async () => {
		const ws = requireWorkspace();
		const generations = generationsFor(ws);
		const active = await generations.ensureGeneration({ config: currentConfig() });
		await generations.publishActiveGeneration({ generationId: active.generationId, mode: 'upgrade' });
		const probes = new Map<string, GenerationReconcileProbeResult>([
			[active.generationId, { pendingPaths: 0, generationQuarantined: false, pathQuarantined: 0, quarantinedTransactions: 0 }],
		]);
		const decision = await generations.reconcileForNewGeneration({ probes, requestedFingerprint: 'd'.repeat(64) });
		expect(decision.reclaimed).toEqual([]);
		expect(decision.retained).toEqual([]);
		expect(decision.canCreate).toBe(true);
		expect(fs.existsSync(active.generationRoot)).toBe(true);
	});

	it('clearGenerationQuarantine - 显式确认 - 解除隔离并恢复可写', async () => {
		const ws = requireWorkspace();
		const generations = generationsFor(ws);
		const record = await generations.ensureGeneration({ config: currentConfig() });
		await generations.markGenerationQuarantined({ generationId: record.generationId, reason: 'unattributable-prepared' });
		expect((await generations.getGenerationByFingerprint(record.fingerprint))?.status).toBe('quarantined');
		// 代际内部的隔离记录文件也必须被清掉。
		const quarantineFile = path.join(
			record.generationRoot,
			'quarantine',
			'generation.json',
		);
		fs.mkdirSync(path.dirname(quarantineFile), { recursive: true });
		fs.writeFileSync(quarantineFile, JSON.stringify({ schemaVersion: INDEX_RECORD_SCHEMA_VERSION }), 'utf8');

		const cleared = await generations.clearGenerationQuarantine({ generationId: record.generationId, confirm: true });
		expect(cleared).toBe(true);
		expect(fs.existsSync(quarantineFile)).toBe(false);
		expect((await generations.getGenerationByFingerprint(record.fingerprint))?.status).toBe('building');
	});

	it('clearGenerationQuarantine - 未显式确认 - 拒绝解除', async () => {
		const ws = requireWorkspace();
		const generations = generationsFor(ws);
		const record = await generations.ensureGeneration({ config: currentConfig() });
		await generations.markGenerationQuarantined({ generationId: record.generationId, reason: 'unattributable-prepared' });
		await expect(
			generations.clearGenerationQuarantine({ generationId: record.generationId, confirm: false }),
		).rejects.toMatchObject({ code: 'confirmation-required' });
		expect((await generations.getGenerationByFingerprint(record.fingerprint))?.status).toBe('quarantined');
	});

	it('markGenerationQuarantined - 隔离原因随状态落盘 - 解除时被清空', async () => {
		const ws = requireWorkspace();
		const generations = generationsFor(ws);
		const record = await generations.ensureGeneration({ config: currentConfig() });

		await generations.markGenerationQuarantined({ generationId: record.generationId, reason: 'unattributable-prepared' });
		const quarantined = await generations.readControl();
		expect(quarantined.generations[record.generationId]?.quarantineReason).toBe('unattributable-prepared');

		await generations.clearGenerationQuarantine({ generationId: record.generationId, confirm: true });
		expect((await generations.readControl()).generations[record.generationId]?.quarantineReason).toBe(null);
	});

	it('publishActiveGeneration - upgrade 模式已有活动代际 - 拒绝把 building 代际登记为活动', async () => {
		const ws = requireWorkspace();
		const generations = generationsFor(ws);
		const active = await generations.ensureGeneration({ config: currentConfig() });
		await generations.publishActiveGeneration({ generationId: active.generationId, mode: 'upgrade' });
		const building = await generations.ensureGeneration({ config: currentConfig({ embeddingModelId: 'local:other-model' }) });
		expect(building.status).toBe('building');

		await expect(
			generations.publishActiveGeneration({ generationId: building.generationId, mode: 'upgrade' }),
		).rejects.toMatchObject({ code: 'switch-not-verified' });
		// 活动指针必须保持在原代际,新的 building 代际不得凭 upgrade 越过分级核对。
		expect((await generations.readControl()).activeGenerationId).toBe(active.generationId);
	});

	it('publishActiveGeneration - 目标代际已隔离或已失败 - 两种模式都拒绝', async () => {
		const ws = requireWorkspace();
		const generations = generationsFor(ws);
		const quarantined = await generations.ensureGeneration({ config: currentConfig() });
		await generations.markGenerationQuarantined({ generationId: quarantined.generationId, reason: 'unattributable-prepared' });

		await expect(
			generations.publishActiveGeneration({ generationId: quarantined.generationId, mode: 'upgrade' }),
		).rejects.toMatchObject({ code: 'switch-not-verified' });

		const failed = await generations.ensureGeneration({ config: currentConfig({ embeddingModelId: 'local:other-model' }) });
		const control = await generations.readControl();
		await generations.writeControl({
			...control,
			generations: {
				...control.generations,
				[failed.generationId]: { ...control.generations[failed.generationId]!, status: 'failed' },
			},
		});
		await expect(
			generations.publishActiveGeneration({ generationId: failed.generationId, mode: 'configured-switch' }),
		).rejects.toMatchObject({ code: 'switch-not-verified' });
		expect((await generations.readControl()).activeGenerationId).toBe(null);
	});

	it('publishActiveGeneration - 曾活动被降级的 migrated - 不能跳过本轮复核直接切回', async () => {
		const ws = requireWorkspace();
		const generations = generationsFor(ws);
		const first = await generations.ensureGeneration({ config: currentConfig() });
		await generations.publishActiveGeneration({ generationId: first.generationId, mode: 'upgrade' });
		const second = await generations.ensureGeneration({ config: currentConfig({ embeddingModelId: 'local:other-model' }) });
		await generations.markGenerationMigrated({ generationId: second.generationId });
		await generations.publishActiveGeneration({ generationId: second.generationId, mode: 'configured-switch' });

		// 降级保留 `migrated` 状态,但「本轮已验证」标记被清空。
		const demoted = await generations.readControl();
		expect(demoted.generations[first.generationId]?.status).toBe('migrated');
		expect(demoted.generations[first.generationId]?.verifiedAt).toBe(null);
		await expect(
			generations.publishActiveGeneration({ generationId: first.generationId, mode: 'configured-switch' }),
		).rejects.toMatchObject({ code: 'switch-not-verified' });
		expect((await generations.readControl()).activeGenerationId).toBe(second.generationId);

		// 重新核对后才能切回。
		await generations.markGenerationMigrated({ generationId: first.generationId });
		await generations.publishActiveGeneration({ generationId: first.generationId, mode: 'configured-switch' });
		const switched = await generations.readControl();
		expect(switched.activeGenerationId).toBe(first.generationId);
		expect(Object.values(switched.generations).filter((record) => record.status === 'active')).toHaveLength(1);
	});

	it('migrate - 已有活动代际时迁移 - 新代际成为唯一活动并降级旧 active', async () => {
		const ws = requireWorkspace();
		const generations = generationsFor(ws);
		const previous = await generations.ensureGeneration({ config: currentConfig() });
		await generations.publishActiveGeneration({ generationId: previous.generationId, mode: 'upgrade' });

		const files = [{ path: 'notes/m.md', content: '甲\n乙', commitId: 'commit-m' }];
		const migrated = currentConfig({ embeddingModelId: 'local:second-model' });
		const legacy = await createLegacyFixture(ws, files, { embedModelId: 'local:second-model' });
		const result = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, migrated),
			currentInputs: await inputHashes(files),
		});

		expect(result.published).toBe(true);
		expect(result.generationId).not.toBe(previous.generationId);
		const control = await generations.readControl();
		expect(control.activeGenerationId).toBe(result.generationId);
		// 关键路径:迁移发布必须复用同一处降级逻辑,control 里只能有一条 active。
		expect(control.generations[previous.generationId]?.status).toBe('migrated');
		expect(control.generations[previous.generationId]?.verifiedAt).toBe(null);
		expect(Object.values(control.generations).filter((record) => record.status === 'active')).toHaveLength(1);
	});

	it('probeGeneration - 只持取证事务目录的代际 - 探测为非零且回收判定保留', async () => {
		const ws = requireWorkspace();
		const generations = generationsFor(ws);
		const record = await generations.ensureGeneration({ config: currentConfig() });
		await generations.markGenerationMigrated({ generationId: record.generationId });
		const transactionDir = path.join(record.generationRoot, 'quarantine', 'transactions', 'tx-forensic-1');
		fs.mkdirSync(transactionDir, { recursive: true });
		fs.writeFileSync(path.join(transactionDir, 'prepared.json'), JSON.stringify({ schemaVersion: INDEX_RECORD_SCHEMA_VERSION }), 'utf8');

		const probe = await generations.probeGeneration(record.generationId);
		expect(probe.quarantinedTransactions).toBe(1);
		expect(probe.pendingPaths).toBe(0);

		const decision = await generations.reconcileForNewGeneration({
			probes: new Map([[record.generationId, probe]]),
			requestedFingerprint: 'f'.repeat(64),
		});
		expect(decision.reclaimed).toEqual([]);
		expect(decision.retained).toEqual([record.generationId]);
		expect(decision.canCreate).toBe(false);
		// 关键路径:取证依据必须仍然在磁盘上,不能被回收整代际一起带走。
		expect(fs.existsSync(path.join(transactionDir, 'prepared.json'))).toBe(true);
	});
});

// ==================== 6. 控制指针损坏 ====================

describe('IndexGenerations - 控制指针损坏', () => {
	it('readControl - control.json 损坏 - 报稳定错误码且不猜归属', async () => {
		const ws = requireWorkspace();
		const indexRoot = path.join(ws.root, '.index');
		const generations = new IndexGenerations({ indexRoot, owner: new TestWriteOwner() });
		fs.mkdirSync(indexRoot, { recursive: true });
		const controlPath = path.join(indexRoot, INDEX_GENERATION_CONTROL_FILENAME);
		fs.writeFileSync(controlPath, '{ 半截 JSON', 'utf8');
		const failure = await generations.readControl().catch((error: unknown) => error);
		// 抛出的必须是本模块的稳定错误,且错误码属于对外导出的码表。
		expect(failure).toBeInstanceOf(IndexGenerationError);
		expect(INDEX_GENERATION_ERROR_CODES).toContain((failure as IndexGenerationError).code);
		expect(failure).toMatchObject({ code: 'control-invalid' });
		// 损坏文件不得被改写,也不得因此创建任何代际目录(不猜归属、不静默降级)。
		expect(fs.readFileSync(controlPath, 'utf8')).toBe('{ 半截 JSON');
		expect(fs.existsSync(path.join(indexRoot, INDEX_GENERATIONS_DIRNAME))).toBe(false);
	});

	it('readControl - 缺失 control - 返回空状态且不创建文件', async () => {
		const ws = requireWorkspace();
		const indexRoot = path.join(ws.root, '.index');
		const generations = new IndexGenerations({ indexRoot, owner: new TestWriteOwner() });
		const state = await generations.readControl();
		expect(state).toEqual({ schemaVersion: INDEX_RECORD_SCHEMA_VERSION, activeGenerationId: null, generations: {} });
		expect(fs.existsSync(indexRoot)).toBe(false);
	});

	it('readControl - 活动指针指向未知代际 - 报 corrupt 而不是静默降级', async () => {
		const ws = requireWorkspace();
		const indexRoot = path.join(ws.root, '.index');
		const generations = new IndexGenerations({ indexRoot, owner: new TestWriteOwner() });
		fs.mkdirSync(indexRoot, { recursive: true });
		fs.writeFileSync(
			path.join(indexRoot, INDEX_GENERATION_CONTROL_FILENAME),
			JSON.stringify({
				schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
				activeGenerationId: 'gen-0123456789abcdef',
				generations: {},
			}),
			'utf8',
		);
		await expect(generations.readControl()).rejects.toMatchObject({ code: 'control-invalid' });
	});

	it('readControl - 代际记录内的目录与索引根不一致 - 报 corrupt', async () => {
		const ws = requireWorkspace();
		const indexRoot = path.join(ws.root, '.index');
		const generations = new IndexGenerations({ indexRoot, owner: new TestWriteOwner() });
		const record = await generations.ensureGeneration({ config: currentConfig() });
		const control = await generations.readControl();
		const tampered = {
			...control,
			generations: { ...control.generations, [record.generationId]: { ...control.generations[record.generationId]!, root: '/tmp/other' } },
		};
		await generations.writeControl(tampered);
		await expect(generations.readControl()).rejects.toMatchObject({ code: 'control-invalid' });
	});

	it('mapLegacyConfigIdentity - 旧清单配置身份 - 映射为可判定描述且修订为 null', () => {
		const mapped = mapLegacyConfigIdentity(
			legacyManifest([], { embedModelId: 'local:bge-small-zh-v1.5', chunkSize: CHUNK_SIZE, chunkOverlap: CHUNK_OVERLAP }),
			{ embeddingDimension: DIMENSIONS },
		);
		expect(mapped).toEqual({
			embeddingModelId: 'local:bge-small-zh-v1.5',
			embeddingModelRevision: null,
			embeddingDimension: DIMENSIONS,
			chunkerVersion: CURRENT_CHUNKER_VERSION,
			chunkSize: CHUNK_SIZE,
			chunkOverlap: CHUNK_OVERLAP,
			embeddingTextVersion: null,
		});
	});

	it('mapLegacyConfigIdentity - 缺分块字段的旧清单 - 返回 null 而不用当前值补造', () => {
		expect(
			mapLegacyConfigIdentity({ version: 1, entries: {} } as IndexManifestData, {
				embeddingDimension: DIMENSIONS,
			}),
		).toBe(null);
	});

	it('deriveGenerationId - 非法指纹 - 拒绝', async () => {
		const ws = requireWorkspace();
		const generations = generationsFor(ws);
		await expect(generations.ensureGeneration({ config: { ...currentConfig(), embeddingDimension: 0 } }))
			.rejects.toMatchObject({ code: 'config-invalid' });
		await expect(
			generations.publishActiveGeneration({ generationId: 'not-a-generation', mode: 'upgrade' }),
		).rejects.toMatchObject({ code: 'generation-id-invalid' });
	});

	it('readControl - 并存两条 active 记录 - 报 corrupt 而不是二义地选一个', async () => {
		const ws = requireWorkspace();
		const indexRoot = path.join(ws.root, '.index');
		const generations = new IndexGenerations({ indexRoot, owner: new TestWriteOwner() });
		const first = await generations.ensureGeneration({ config: currentConfig() });
		const second = await generations.ensureGeneration({ config: currentConfig({ embeddingModelId: 'local:other-model' }) });
		const control = await generations.readControl();
		await generations.writeControl({
			...control,
			activeGenerationId: first.generationId,
			generations: {
				...control.generations,
				[first.generationId]: { ...control.generations[first.generationId]!, status: 'active' },
				[second.generationId]: { ...control.generations[second.generationId]!, status: 'active' },
			},
		});

		await expect(generations.readControl()).rejects.toMatchObject({ code: 'control-invalid' });
	});

	it('IndexGenerations - 缺少 owner 门面或写所有权失效 - 构造与写盘都被拒绝', async () => {
		const ws = requireWorkspace();
		const indexRoot = path.join(ws.root, '.index');
		// 构造必填:没有 owner 门面就不允许创建实例(空壳对象不能通过)。
		expect(() => new IndexGenerations({ indexRoot } as unknown as IndexGenerationsOptions)).toThrow(IndexGenerationError);
		expect(() => new IndexGenerations({ indexRoot, owner: {} } as unknown as IndexGenerationsOptions)).toThrow(IndexGenerationError);

		const owner = new TestWriteOwner();
		const generations = new IndexGenerations({ indexRoot, owner });
		const record = await generations.ensureGeneration({ config: currentConfig() });
		const legacyDir = path.join(ws.root, 'legacy-owner');
		fs.mkdirSync(legacyDir, { recursive: true });
		fs.writeFileSync(path.join(legacyDir, 'index.json'), '{"items":[]}', 'utf8');
		owner.writable = false;

		// 「所有清理持 owner 锁」在 API 层强制:发布、删除代际、清理 legacy 文件都必须先复核可写。
		await expect(
			generations.publishActiveGeneration({ generationId: record.generationId, mode: 'upgrade' }),
		).rejects.toMatchObject({ code: 'owner-not-writable' });
		await expect(generations.dropSafeGeneration(record.generationRoot)).rejects.toMatchObject({ code: 'owner-not-writable' });
		await expect(generations.cleanupLegacyIndexFiles({ targetDir: legacyDir, verifiedFiles: ['index.json'] }))
			.rejects.toMatchObject({ code: 'owner-not-writable' });

		expect(fs.existsSync(record.generationRoot)).toBe(true);
		expect(fs.existsSync(path.join(legacyDir, 'index.json'))).toBe(true);
		expect((await generations.readControl()).activeGenerationId).toBe(null);
	});
});

// ==================== 公共类型面 ====================

describe('IndexGenerations - 公共类型面', () => {
	it('migrateLegacyIndex - 只提供 inspectFile 的旧索引源可用 - 枚举失败按缺块重算', async () => {
		const ws = requireWorkspace();
		const files = [{ path: 'notes/t.md', content: '甲', commitId: 'commit-t' }];
		const legacy = await createLegacyFixture(ws, files);
		// 静态入口 + `GenerationLegacySource` 最小形状:调用方只需 inspectFile。
		const source: GenerationLegacySource = {
			legacyIndexDir: legacy.legacyDir,
			manifestPath: legacy.manifestPath,
			store: { inspectFile: async (): Promise<PreparedBlock[]> => { throw new Error('枚举失败(测试注入)'); } },
		};

		const result = await IndexGenerations.migrateLegacyIndex({
			...migrationInput(ws, legacy, currentConfig()),
			legacy: source,
			currentInputs: await inputHashes(files),
		});

		expect(result.files).toEqual([expect.objectContaining({ path: 'notes/t.md', status: 'reindex', reason: 'legacy-block-missing' })]);
	});
});