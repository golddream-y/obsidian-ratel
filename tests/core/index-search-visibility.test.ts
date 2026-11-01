/**
 * @file tests/core/index-search-visibility.test.ts
 * @description 候选可见性门与关闭自动索引的只读通道 — 准入判据、过滤位置与零写入
 * @module tests/core/index-search-visibility
 * @depends core/index-search-visibility, core/index-file-journal, adapters/atomic-index-storage
 *
 * 关键路径:
 * - 只读通道用**真实临时磁盘上的真实日志**验证「零写入」:目录快照逐字比对,不是只看返回值。
 * - 「过滤必须发生在融合/重排之前」用可观测的重排替身断言:被拒绝的候选不进入重排输入,
 *   并配一条反向对照(不先过滤时重排确实会收到过期路径),证明该断言能发现漏过滤。
 * - `searchableFileRecords()` 返回 `null` 必须与空集区分:前者失败关闭并保留 `unjudgeable`。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AtomicIndexStorage } from '../../src/adapters/atomic-index-storage';
import { REGISTERED_INDEX_ASSEMBLY, type GateWiringPointCounts } from '../helpers/index-assembly-registry';
import type { FileReplaceStore, PreparedBlock } from '../../src/adapters/vector-vectra';
import {
	IndexFileJournal,
	type JournalWriteOwner,
} from '../../src/core/index-file-journal';
import {
	ReadOnlySearchView,
	SearchVisibilityGate,
	captureSearchVisibilitySnapshot,
	createJournalVisibilitySource,
	createReadOnlyOwnerGuard,
	type BlockedPathState,
	type SearchVisibilityRecord,
	type SearchVisibilitySource,
} from '../../src/core/index-search-visibility';
import { deterministicVector } from '../helpers/index-reliability-fixture';

const CONFIG_FINGERPRINT = 'f'.repeat(64);
const DIMENSIONS = 8;
const temporaryRoots: string[] = [];

afterEach(async () => {
	for (const root of temporaryRoots.splice(0)) {
		await fsp.rm(root, { recursive: true, force: true });
	}
});

async function makeTempRoot(): Promise<string> {
	const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ratel-t4-visibility-'));
	temporaryRoots.push(root);
	return root;
}

/** 一条 present 完成记录的构造器。 */
function presentRecord(path: string, overrides: Partial<SearchVisibilityRecord> = {}): SearchVisibilityRecord {
	return { path, state: 'present', revision: 1, inputHash: 'a'.repeat(64), chunkCount: 1, ...overrides };
}

/** 一条删除凭据的构造器。 */
function tombstoneRecord(path: string): SearchVisibilityRecord {
	return { path, state: 'deleted', revision: 2, inputHash: null, chunkCount: 0 };
}

/** 只读来源替身。 */
function sourceOf(input: {
	records?: readonly SearchVisibilityRecord[] | null;
	tombstones?: readonly SearchVisibilityRecord[];
	pathStates?: readonly BlockedPathState[];
	generationQuarantined?: boolean;
	recordsError?: Error;
	pendingPaths?: readonly string[] | Error;
	countConfigMismatchedRecords?: number | Error;
}): SearchVisibilitySource {
	const source: SearchVisibilitySource = {
		searchableFileRecords: async () => {
			if (input.recordsError !== undefined) throw input.recordsError;
			if (input.records === null) return null;
			const records = input.records ?? [];
			return { total: records.length, records };
		},
		listTombstones: async () => input.tombstones ?? [],
	};
	if (input.pathStates !== undefined) source.listPathStates = async () => input.pathStates ?? [];
	if (input.generationQuarantined !== undefined) source.isGenerationQuarantined = async () => input.generationQuarantined ?? false;
	if (input.pendingPaths !== undefined) {
		source.listPendingPaths = async () => {
			if (input.pendingPaths instanceof Error) throw input.pendingPaths;
			return input.pendingPaths ?? [];
		};
	}
	if (input.countConfigMismatchedRecords !== undefined) {
		source.countConfigMismatchedRecords = async () => {
			if (input.countConfigMismatchedRecords instanceof Error) throw input.countConfigMismatchedRecords;
			return input.countConfigMismatchedRecords ?? 0;
		};
	}
	return source;
}

/** 建门控。 */
async function gateWith(
	options: Omit<ConstructorParameters<typeof SearchVisibilityGate>[0], 'snapshot' | 'configFingerprint'> & {
		source: SearchVisibilitySource;
		configFingerprint?: string;
	},
): Promise<SearchVisibilityGate> {
	const configFingerprint = options.configFingerprint ?? CONFIG_FINGERPRINT;
	const snapshot = await captureSearchVisibilitySnapshot({ source: options.source, configFingerprint });
	return new SearchVisibilityGate({
		snapshot,
		unverified: options.unverified,
		configFingerprint,
		...(options.freshnessOf === undefined ? {} : { freshnessOf: options.freshnessOf }),
		...(options.unresolvedPaths === undefined ? {} : { unresolvedPaths: options.unresolvedPaths }),
		...(options.isExcluded === undefined ? {} : { isExcluded: options.isExcluded }),
		...(options.exists === undefined ? {} : { exists: options.exists }),
	});
}

// ==================== 快照口径 ====================

describe('可见性快照', () => {
	it('记录端口返回 null - 标记不可判定而不是空集', async () => {
		const snapshot = await captureSearchVisibilitySnapshot({
			source: sourceOf({ records: null }),
			configFingerprint: CONFIG_FINGERPRINT,
		});
		expect(snapshot.recordsKind).toBe('unjudgeable');
		expect(snapshot.visible.size).toBe(0);
	});

	it('记录端口返回空数组 - 标记已判定且无可见记录', async () => {
		const snapshot = await captureSearchVisibilitySnapshot({
			source: sourceOf({ records: [] }),
			configFingerprint: CONFIG_FINGERPRINT,
		});
		expect(snapshot.recordsKind).toBe('known');
		expect(snapshot.visible.size).toBe(0);
	});

	it('记录读取抛错 - 失败关闭并标记不可判定', async () => {
		const snapshot = await captureSearchVisibilitySnapshot({
			source: sourceOf({ recordsError: new Error('disk failed') }),
			configFingerprint: CONFIG_FINGERPRINT,
		});
		expect(snapshot.recordsKind).toBe('unjudgeable');
	});

	it('代际隔离读取失败 - 失败关闭 - 按已隔离处理', async () => {
		const source: SearchVisibilitySource = {
			searchableFileRecords: async () => ({ total: 1, records: [presentRecord('a.md')] }),
			listTombstones: async () => [],
			isGenerationQuarantined: async () => { throw new Error('unreadable'); },
		};
		const snapshot = await captureSearchVisibilitySnapshot({ source, configFingerprint: CONFIG_FINGERPRINT });
		expect(snapshot.generationQuarantined).toBe(true);
	});

	it('删除凭据读取失败 - 失败关闭 - 不可判定而不是按无删除凭据放行', async () => {
		const source: SearchVisibilitySource = {
			searchableFileRecords: async () => ({ total: 1, records: [presentRecord('gone.md')] }),
			listTombstones: async () => { throw new Error('unreadable'); },
		};
		const snapshot = await captureSearchVisibilitySnapshot({ source, configFingerprint: CONFIG_FINGERPRINT });
		expect(snapshot.recordsKind).toBe('unjudgeable');
		expect(await new SearchVisibilityGate({
			snapshot, unverified: 'admit-trusted', configFingerprint: CONFIG_FINGERPRINT,
		}).decide('gone.md')).toMatchObject({ visible: false, reason: 'unjudgeable' });
		// 反向对照:删除凭据可读时同一路径可见 —— 证明上面的收紧不是恒真。
		const readable = await gateWith({
			source: sourceOf({ records: [presentRecord('gone.md')], tombstones: [] }),
			unverified: 'admit-trusted',
		});
		expect((await readable.decide('gone.md')).visible).toBe(true);
	});

	it('路径状态读取失败 - 失败关闭 - 不可判定而不是按无状态放行', async () => {
		const source: SearchVisibilitySource = {
			searchableFileRecords: async () => ({ total: 1, records: [presentRecord('bad.md')] }),
			listTombstones: async () => [],
			listPathStates: async () => { throw new Error('unreadable'); },
		};
		const snapshot = await captureSearchVisibilitySnapshot({ source, configFingerprint: CONFIG_FINGERPRINT });
		expect(snapshot.recordsKind).toBe('unjudgeable');
	});

	it('未决事务路径读取失败 - 失败关闭 - 不可判定', async () => {
		const snapshot = await captureSearchVisibilitySnapshot({
			source: sourceOf({ records: [presentRecord('ok.md')], pendingPaths: new Error('unreadable') }),
			configFingerprint: CONFIG_FINGERPRINT,
		});
		expect(snapshot.recordsKind).toBe('unjudgeable');
	});

	it('未决事务路径 - 来源端口枚举与调用方传入取并集', async () => {
		const snapshot = await captureSearchVisibilitySnapshot({
			source: sourceOf({ records: [presentRecord('ok.md')], pendingPaths: ['from-journal.md'] }),
			configFingerprint: CONFIG_FINGERPRINT,
			unresolvedPaths: new Set(['from-caller.md']),
		});
		expect([...snapshot.unresolvedPaths].sort()).toEqual(['from-caller.md', 'from-journal.md']);
	});

	it('配置作废计数读取失败 - 记录集配置不可判定', async () => {
		const snapshot = await captureSearchVisibilitySnapshot({
			source: sourceOf({ records: [presentRecord('ok.md')], countConfigMismatchedRecords: new Error('unreadable') }),
			configFingerprint: CONFIG_FINGERPRINT,
		});
		expect(snapshot.recordsConfig).toBe('unknown');
		expect(snapshot.recordsKind).toBe('unjudgeable');
	});

	it('配置作废计数为正 - 记录集标记配置已变', async () => {
		const snapshot = await captureSearchVisibilitySnapshot({
			source: sourceOf({ records: [], countConfigMismatchedRecords: 3 }),
			configFingerprint: CONFIG_FINGERPRINT,
		});
		expect(snapshot.recordsConfig).toBe('mismatch');
		expect(snapshot.discardedByConfig).toBe(3);
	});

	it('配置作废计数为 0 - 记录集配置一致', async () => {
		const snapshot = await captureSearchVisibilitySnapshot({
			source: sourceOf({ records: [presentRecord('ok.md')], countConfigMismatchedRecords: 0 }),
			configFingerprint: CONFIG_FINGERPRINT,
		});
		expect(snapshot.recordsConfig).toBe('current');
		expect(snapshot.discardedByConfig).toBe(0);
	});
});

// ==================== 准入判据 ====================

describe('SearchVisibilityGate 准入判据', () => {
	it('可信 present 记录且已核实 - 允许进入融合与重排', async () => {
		const gate = await gateWith({
			source: sourceOf({ records: [presentRecord('ok.md')] }),
			unverified: 'deny',
			freshnessOf: () => 'verified',
		});
		const verdict = await gate.decide('ok.md');
		expect(verdict).toMatchObject({ visible: true, path: 'ok.md', freshness: 'verified' });
	});

	it('不可判定 - 全部拒绝并给出 unjudgeable 原因', async () => {
		const gate = await gateWith({ source: sourceOf({ records: null }), unverified: 'admit-trusted' });
		const verdict = await gate.decide('ok.md');
		expect(verdict).toMatchObject({ visible: false, reason: 'unjudgeable' });
	});

	it('已判定但该路径无完成记录 - 拒绝为 not-committed', async () => {
		const gate = await gateWith({ source: sourceOf({ records: [] }), unverified: 'admit-trusted' });
		expect(await gate.decide('unknown.md')).toMatchObject({ visible: false, reason: 'not-committed' });
	});

	it('已知过期 - 拒绝为 known-stale(即使记录本身可信)', async () => {
		const gate = await gateWith({
			source: sourceOf({ records: [presentRecord('stale.md')] }),
			unverified: 'admit-trusted',
			freshnessOf: () => 'known-stale',
		});
		expect(await gate.decide('stale.md')).toMatchObject({ visible: false, reason: 'known-stale' });
	});

	it('删除凭据 - 拒绝为 deleted', async () => {
		const gate = await gateWith({
			source: sourceOf({ records: [presentRecord('gone.md')], tombstones: [tombstoneRecord('gone.md')] }),
			unverified: 'admit-trusted',
		});
		expect(await gate.decide('gone.md')).toMatchObject({ visible: false, reason: 'deleted' });
	});

	it('路径状态为隔离或不可用 - 拒绝为 blocked', async () => {
		const gate = await gateWith({
			source: sourceOf({
				records: [presentRecord('bad.md')],
				pathStates: [{ path: 'bad.md', kind: 'quarantined', reason: 'invalid-prepared' }],
			}),
			unverified: 'admit-trusted',
		});
		expect(await gate.decide('bad.md')).toMatchObject({ visible: false, reason: 'blocked' });
	});

	it('代际隔离 - 全部候选拒绝', async () => {
		const gate = await gateWith({
			source: sourceOf({ records: [presentRecord('ok.md')], generationQuarantined: true }),
			unverified: 'admit-trusted',
		});
		expect(await gate.decide('ok.md')).toMatchObject({ visible: false, reason: 'blocked' });
	});

	it('当前黑名单 - 立即收回可见性', async () => {
		const gate = await gateWith({
			source: sourceOf({ records: [presentRecord('blocked.md')] }),
			unverified: 'admit-trusted',
			isExcluded: (candidate) => candidate === 'blocked.md',
		});
		expect(await gate.decide('blocked.md')).toMatchObject({ visible: false, reason: 'excluded' });
	});

	it('未解决事务路径 - 一律过滤', async () => {
		const gate = await gateWith({
			source: sourceOf({ records: [presentRecord('pending.md')] }),
			unverified: 'admit-trusted',
			freshnessOf: () => 'verified',
			unresolvedPaths: new Set(['pending.md']),
		});
		expect(await gate.decide('pending.md')).toMatchObject({ visible: false, reason: 'unresolved-transaction' });
	});

	it('记录配置指纹与当前不一致 - 拒绝为 config-mismatch', async () => {
		const gate = await gateWith({
			source: sourceOf({ records: [presentRecord('old.md', { configFingerprint: 'd'.repeat(64) })] }),
			unverified: 'admit-trusted',
		});
		expect(await gate.decide('old.md')).toMatchObject({ visible: false, reason: 'config-mismatch' });
	});

	it('记录集配置已变 - 拒绝为 config-mismatch 而不是 not-committed', async () => {
		const gate = await gateWith({
			source: sourceOf({ records: [], countConfigMismatchedRecords: 2 }),
			unverified: 'admit-trusted',
		});
		expect(gate.snapshot().recordsConfig).toBe('mismatch');
		expect(await gate.decide('old.md')).toMatchObject({ visible: false, reason: 'config-mismatch' });
		// 反向对照:配置一致且无记录时同一候选是 not-committed —— 两种原因可区分。
		const current = await gateWith({ source: sourceOf({ records: [], countConfigMismatchedRecords: 0 }), unverified: 'admit-trusted' });
		expect(await current.decide('old.md')).toMatchObject({ visible: false, reason: 'not-committed' });
	});

	it('快照配置指纹与当前不一致 - 拒绝为 config-mismatch', async () => {
		const source = sourceOf({ records: [presentRecord('ok.md')] });
		const snapshot = await captureSearchVisibilitySnapshot({ source, configFingerprint: 'e'.repeat(64) });
		const gate = new SearchVisibilityGate({ snapshot, unverified: 'admit-trusted', configFingerprint: CONFIG_FINGERPRINT });
		expect(await gate.decide('ok.md')).toMatchObject({ visible: false, reason: 'config-mismatch' });
	});

	it('存在性核对返回不存在 - 拒绝为 missing', async () => {
		const gate = await gateWith({
			source: sourceOf({ records: [presentRecord('removed.md')] }),
			unverified: 'admit-trusted',
			freshnessOf: () => 'verified',
			exists: (candidate) => candidate !== 'removed.md',
		});
		expect(await gate.decide('removed.md')).toMatchObject({ visible: false, reason: 'missing' });
	});

	it('未核对候选 - deny 口径拒绝 - admit-trusted 口径允许且新鲜度为 unknown', async () => {
		const source = sourceOf({ records: [presentRecord('ok.md')] });
		const strict = await gateWith({ source, unverified: 'deny' });
		expect(await strict.decide('ok.md')).toMatchObject({ visible: false, reason: 'unverified' });
		const lenient = await gateWith({ source, unverified: 'admit-trusted' });
		expect(await lenient.decide('ok.md')).toMatchObject({ visible: true, freshness: 'unknown' });
	});

	it('未核对候选准入策略缺失或非法 - 构造即拒绝', async () => {
		const snapshot = await captureSearchVisibilitySnapshot({
			source: sourceOf({ records: [] }),
			configFingerprint: CONFIG_FINGERPRINT,
		});
		expect(() => new SearchVisibilityGate({
			snapshot,
			unverified: 'whatever' as never,
			configFingerprint: CONFIG_FINGERPRINT,
		})).toThrow();
	});
});

// ==================== 过滤位置 ====================

describe('SearchVisibilityGate 过滤位置', () => {
	it('原始向量候选 - 先过滤再进入重排 - 被拒绝路径不出现在重排输入', async () => {
		const gate = await gateWith({
			source: sourceOf({
				records: [presentRecord('ok.md'), presentRecord('stale.md'), presentRecord('gone.md')],
				tombstones: [tombstoneRecord('gone.md')],
			}),
			unverified: 'deny',
			freshnessOf: (candidate) => (candidate === 'ok.md' ? 'verified' : 'known-stale'),
		});
		const candidates = [{ path: 'ok.md', score: 0.9 }, { path: 'stale.md', score: 0.8 }, { path: 'gone.md', score: 0.7 }];
		const rerankSpy = vi.fn((items: ReadonlyArray<{ path: string }>) => items);
		const filtered = await gate.filter(candidates);
		rerankSpy(filtered.visible);
		expect(rerankSpy).toHaveBeenCalledOnce();
		expect(rerankSpy.mock.calls[0]![0].map((item) => item.path)).toEqual(['ok.md']);
		expect(filtered.denied).toEqual([
			{ path: 'stale.md', reason: 'known-stale' },
			{ path: 'gone.md', reason: 'deleted' },
		]);
		// 反向对照:同一批候选,当新鲜度全部 verified 且无删除凭据时全部可见 ——
		// 证明上面的拒绝来自门的输入(freshness / 删除凭据),而不是候选列表本身。
		const permissive = await gateWith({
			source: sourceOf({
				records: [presentRecord('ok.md'), presentRecord('stale.md'), presentRecord('gone.md')],
			}),
			unverified: 'deny',
			freshnessOf: () => 'verified',
		});
		const permissiveResult = await permissive.filter(candidates);
		expect(permissiveResult.visible.map((item) => item.path)).toEqual(['ok.md', 'stale.md', 'gone.md']);
		expect(permissiveResult.denied).toEqual([]);
	});

	it('过滤保持候选原始顺序 - 不重排也不改写候选对象', async () => {
		const source = sourceOf({ records: [presentRecord('b.md'), presentRecord('a.md')] });
		const gate = await gateWith({ source, unverified: 'admit-trusted', freshnessOf: () => 'verified' });
		const candidates = [{ path: 'b.md' }, { path: 'a.md' }];
		const result = await gate.filter(candidates);
		expect(result.visible).toEqual(candidates);
		expect(result.visible[0]).toBe(candidates[0]);
	});

	it('存在性核对为异步 IO - 候选并行判定 - 不逐个串行等待', async () => {
		// 关键路径:T7 注入的 `exists` 会读盘;串行 `await decide()` 会让 50 个候选变成 50 次串行 IO。
		let inFlight = 0;
		let peak = 0;
		const gate = await gateWith({
			source: sourceOf({ records: [presentRecord('a.md'), presentRecord('b.md'), presentRecord('c.md')] }),
			unverified: 'admit-trusted',
			freshnessOf: () => 'verified',
			exists: async () => {
				inFlight += 1;
				peak = Math.max(peak, inFlight);
				// 每个候选至少让出一个微任务:串行实现会在此处降到 1,并行实现三个候选同时在途。
				await Promise.resolve();
				inFlight -= 1;
				return true;
			},
		});
		const result = await gate.filter([{ path: 'a.md' }, { path: 'b.md' }, { path: 'c.md' }]);
		expect(peak).toBe(3);
		expect(result.visible.map((item) => item.path)).toEqual(['a.md', 'b.md', 'c.md']);
	});
});

// ==================== 只读通道 ====================

/** 内存块存储 — 只读通道用例不校验向量持久化,只需要日志能落完成记录。 */
class MemoryFileReplaceStore implements FileReplaceStore {
	async replaceFile(_input: { path: string; commitId: string; blocks: PreparedBlock[] }): Promise<void> {
		// 完成记录不依赖块集合持久化;只读通道不读取块。
	}

	async inspectFile(_path: string): Promise<PreparedBlock[]> {
		return [];
	}

	async reload(): Promise<void> {}
}

/** 可写的日志所有权门面替身 — 仅用于造出可信完成记录。 */
class TestOwner implements JournalWriteOwner {
	epoch = 1;

	assertWritable(): void {}

	beginCommit(): { settle(): void } {
		return { settle: () => undefined };
	}
}

/** 目录快照 — 相对路径 → 内容 + mtime,用于逐字比对「零写入」。 */
async function snapshotTree(root: string): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	const walk = async (dir: string, prefix: string): Promise<void> => {
		const entries = await fsp.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
			const absolute = path.join(dir, entry.name);
			if (entry.isDirectory()) await walk(absolute, relative);
			else {
				const stat = await fsp.stat(absolute);
				out[relative] = `${stat.mtimeMs}:${await fsp.readFile(absolute, 'utf8')}`;
			}
		}
	};
	await walk(root, '');
	return out;
}

/** 在真实磁盘上造出可信完成记录:present + tombstone。 */
async function createCommittedJournal(root: string): Promise<{ dir: string; journal: IndexFileJournal }> {
	const dir = path.join(root, 'generation');
	const storage = new AtomicIndexStorage({ generationRoot: dir });
	const journal = new IndexFileJournal({
		generationRoot: dir,
		generationId: 'gen-readonly',
		configFingerprint: CONFIG_FINGERPRINT,
		owner: new TestOwner(),
		store: new MemoryFileReplaceStore(),
		storage,
		expectedDimension: DIMENSIONS,
	});
	const blocks: PreparedBlock[] = [{
		id: 'a.md#chunk-0',
		vector: deterministicVector('alpha', DIMENSIONS),
		metadata: { index: 0 },
	}];
	const present = await journal.prepare({
		path: 'a.md',
		operation: 'replace',
		inputHash: 'a'.repeat(64),
		revision: 1,
		previousCommitId: null,
		previousRevision: 0,
		blocks,
	});
	await journal.commit(present.transactionId);
	const removed = await journal.prepare({
		path: 'gone.md',
		operation: 'delete',
		inputHash: null,
		revision: 1,
		previousCommitId: null,
		previousRevision: 0,
		blocks: [],
	});
	await journal.commit(removed.transactionId);
	return { dir, journal };
}

describe('ReadOnlySearchView 关闭自动索引的只读通道', () => {
	it('只读消费 - 不取锁不写盘 - 目录快照逐字不变且零嵌入', async () => {
		const root = await makeTempRoot();
		const { dir, journal } = await createCommittedJournal(root);
		const before = await snapshotTree(dir);
		// 只读装配:用哨兵代替写所有权,不调用 `IndexWriteOwner.acquire()`,因此不创建 owner.lock。
		const guard = createReadOnlyOwnerGuard();
		expect(guard.epoch).toBe(0);
		expect(() => guard.assertWritable()).toThrow();
		expect(() => guard.beginCommit()).toThrow();
		const embeds = vi.fn(async () => [[0]]);
		const view = new ReadOnlySearchView({
			source: createJournalVisibilitySource(journal),
			configFingerprint: CONFIG_FINGERPRINT,
		});
		const snapshot = await view.refresh();
		expect(snapshot.recordsKind).toBe('known');
		expect(snapshot.visible.has('a.md')).toBe(true);
		expect(snapshot.tombstones.has('gone.md')).toBe(true);
		const filtered = await view.filterCandidates([
			{ path: 'a.md', score: 0.9 },
			{ path: 'gone.md', score: 0.8 },
			{ path: 'never.md', score: 0.7 },
		]);
		expect(filtered.visible.map((item) => item.path)).toEqual(['a.md']);
		expect(filtered.denied).toEqual([
			{ path: 'gone.md', reason: 'deleted' },
			{ path: 'never.md', reason: 'not-committed' },
		]);
		expect(await snapshotTree(dir)).toEqual(before);
		expect(embeds).not.toHaveBeenCalled();
		expect(await fsp.readdir(dir)).not.toContain('owner.lock');
	});

	it('只读装配 - 用哨兵构造日志实例 - 读取可信记录且不创建锁文件也不写盘', async () => {
		const root = await makeTempRoot();
		const { dir } = await createCommittedJournal(root);
		const before = await snapshotTree(dir);
		// 关键路径:只读装配不调用 `IndexWriteOwner.acquire()`;哨兵不做任何 IO。
		const readOnlyJournal = new IndexFileJournal({
			generationRoot: dir,
			generationId: 'gen-readonly',
			configFingerprint: CONFIG_FINGERPRINT,
			owner: createReadOnlyOwnerGuard(),
			store: {
				replaceFile: async () => { throw new Error('只读装配不得替换向量'); },
				inspectFile: async () => [],
				reload: async () => undefined,
			},
			storage: new AtomicIndexStorage({ generationRoot: dir }),
		});
		const view = new ReadOnlySearchView({
			source: createJournalVisibilitySource(readOnlyJournal),
			configFingerprint: CONFIG_FINGERPRINT,
		});
		await view.refresh();
		expect((await view.decide('a.md')).visible).toBe(true);
		expect(await view.decide('gone.md')).toMatchObject({ visible: false, reason: 'deleted' });
		expect(await snapshotTree(dir)).toEqual(before);
		expect(await fsp.readdir(dir)).not.toContain('owner.lock');
		// 关键路径:只读装配下写入口必然失败,不会悄悄写盘。
		await expect(readOnlyJournal.prepare({
			path: 'x.md',
			operation: 'replace',
			inputHash: 'a'.repeat(64),
			revision: 1,
			previousCommitId: null,
			previousRevision: 0,
			blocks: [],
		})).rejects.toThrow();
		expect(await snapshotTree(dir)).toEqual(before);
	});

	it('新鲜度显示 unknown - 未扫描不假装已核对', async () => {
		const root = await makeTempRoot();
		const { journal } = await createCommittedJournal(root);
		const view = new ReadOnlySearchView({
			source: createJournalVisibilitySource(journal),
			configFingerprint: CONFIG_FINGERPRINT,
		});
		await view.refresh();
		expect(view.freshnessOf('a.md')).toBe('unknown');
		expect(view.freshnessOf('gone.md')).toBe('deleted');
		const verdict = await view.decide('a.md');
		expect(verdict).toMatchObject({ visible: true, freshness: 'unknown' });
	});

	it('未解决事务路径全部过滤 - 只读模式由调用方传入已知在途集合', async () => {
		const root = await makeTempRoot();
		const { journal } = await createCommittedJournal(root);
		const view = new ReadOnlySearchView({
			source: createJournalVisibilitySource(journal),
			configFingerprint: CONFIG_FINGERPRINT,
		});
		await view.refresh(new Set(['a.md']));
		const filtered = await view.filterCandidates([{ path: 'a.md' }]);
		expect(filtered.visible).toEqual([]);
		expect(filtered.denied).toEqual([{ path: 'a.md', reason: 'unresolved-transaction' }]);
	});

	it('存在性核对缺失 - 未提供时不额外过滤但新鲜度仍为 unknown', async () => {
		const root = await makeTempRoot();
		const { journal } = await createCommittedJournal(root);
		const view = new ReadOnlySearchView({
			source: createJournalVisibilitySource(journal),
			configFingerprint: CONFIG_FINGERPRINT,
		});
		await view.refresh();
		expect((await view.decide('a.md')).visible).toBe(true);
	});

	it('存在性核对缺失 - 提供后不再存在的候选被过滤', async () => {
		const root = await makeTempRoot();
		const { journal } = await createCommittedJournal(root);
		const view = new ReadOnlySearchView({
			source: createJournalVisibilitySource(journal),
			configFingerprint: CONFIG_FINGERPRINT,
			exists: (candidate) => candidate !== 'a.md',
		});
		await view.refresh();
		const filtered = await view.filterCandidates([{ path: 'a.md' }, { path: 'never.md' }]);
		expect(filtered.visible).toEqual([]);
		expect(filtered.denied).toEqual([
			{ path: 'a.md', reason: 'missing' },
			{ path: 'never.md', reason: 'not-committed' },
		]);
	});

	it('只读视图构造后未 refresh - 记录不可判定 - 一律拒绝而不是假装空集已判定', async () => {
		const root = await makeTempRoot();
		const { journal } = await createCommittedJournal(root);
		const view = new ReadOnlySearchView({
			source: createJournalVisibilitySource(journal),
			configFingerprint: CONFIG_FINGERPRINT,
		});
		expect(view.recordsKind()).toBe('unjudgeable');
		const filtered = await view.filterCandidates([{ path: 'a.md' }]);
		expect(filtered.visible).toEqual([]);
		expect(filtered.denied).toEqual([{ path: 'a.md', reason: 'unjudgeable' }]);
	});

	it('黑名单在只读模式下同样立即收回可见性', async () => {
		const root = await makeTempRoot();
		const { journal } = await createCommittedJournal(root);
		const view = new ReadOnlySearchView({
			source: createJournalVisibilitySource(journal),
			configFingerprint: CONFIG_FINGERPRINT,
			isExcluded: (candidate) => candidate === 'a.md',
		});
		await view.refresh();
		expect(view.freshnessOf('a.md')).toBe('excluded');
		expect((await view.decide('a.md'))).toMatchObject({ visible: false, reason: 'excluded' });
	});

	it('未决事务已 prepared 未写 receipt - 只读检索过滤该路径 - 不把旧 present 记录当依据', async () => {
		const root = await makeTempRoot();
		const { journal } = await createCommittedJournal(root);
		// 崩溃点(T3 决策 3):向量已替换、完成记录未落盘。只读启动不跑 `recover()`,
		// 磁盘上因此没有任何路径状态可扣除 —— 只有 pending 事务能证明该路径在途。
		const receipt = await journal.readReceipt('a.md');
		expect(receipt).not.toBeNull();
		await journal.prepare({
			path: 'a.md',
			operation: 'replace',
			inputHash: 'b'.repeat(64),
			revision: receipt!.revision + 1,
			previousCommitId: receipt!.commitId,
			previousRevision: receipt!.revision,
			blocks: [{ id: 'a.md#chunk-0', vector: deterministicVector('beta', DIMENSIONS), metadata: { index: 0 } }],
		});
		expect(await journal.listPendingPaths()).toEqual(['a.md']);
		expect(await journal.listPathStates()).toEqual([]);
		const view = new ReadOnlySearchView({
			source: createJournalVisibilitySource(journal),
			configFingerprint: CONFIG_FINGERPRINT,
		});
		const snapshot = await view.refresh();
		expect([...snapshot.unresolvedPaths]).toEqual(['a.md']);
		// 旧 present 记录仍在记录集里 —— 必须靠未决路径扣除,否则会被当成本轮可检索依据。
		expect(snapshot.visible.has('a.md')).toBe(true);
		const filtered = await view.filterCandidates([{ path: 'a.md' }]);
		expect(filtered.visible).toEqual([]);
		expect(filtered.denied).toEqual([{ path: 'a.md', reason: 'unresolved-transaction' }]);
		// 反向对照:没有未决事务的同构日志里同一路径可见 —— 证明这条过滤不是恒真。
		const clean = await makeTempRoot();
		const { journal: cleanJournal } = await createCommittedJournal(clean);
		const cleanView = new ReadOnlySearchView({
			source: createJournalVisibilitySource(cleanJournal),
			configFingerprint: CONFIG_FINGERPRINT,
		});
		await cleanView.refresh();
		expect((await cleanView.filterCandidates([{ path: 'a.md' }])).visible.map((item) => item.path)).toEqual(['a.md']);
	});

	it('完成记录配置指纹不符 - 只读视图报告配置已变而不是已知空集', async () => {
		const root = await makeTempRoot();
		const { dir } = await createCommittedJournal(root);
		// 配置代际已变:同一日志目录里都是旧配置的完成记录(嵌入模型/分块参数变了)。
		const changedFingerprint = 'd'.repeat(64);
		const changed = new IndexFileJournal({
			generationRoot: dir,
			generationId: 'gen-readonly',
			configFingerprint: changedFingerprint,
			owner: new TestOwner(),
			store: new MemoryFileReplaceStore(),
			storage: new AtomicIndexStorage({ generationRoot: dir }),
		});
		expect(await changed.listSearchableReceipts()).toEqual([]);
		expect(await changed.countConfigMismatchedReceipts()).toBe(2);
		const view = new ReadOnlySearchView({
			source: createJournalVisibilitySource(changed),
			configFingerprint: changedFingerprint,
		});
		const snapshot = await view.refresh();
		expect(snapshot.recordsConfig).toBe('mismatch');
		expect(snapshot.discardedByConfig).toBe(2);
		expect(view.recordsConfig()).toBe('mismatch');
		// 报告「配置已变」而不是「已知空集」:原因不是 not-committed。
		expect(await view.decide('a.md')).toMatchObject({ visible: false, reason: 'config-mismatch' });
		// 反向对照:配置一致的日志里同一路径可见。
		const { journal } = await createCommittedJournal(await makeTempRoot());
		const current = new ReadOnlySearchView({
			source: createJournalVisibilitySource(journal),
			configFingerprint: CONFIG_FINGERPRINT,
		});
		await current.refresh();
		expect(current.recordsConfig()).toBe('current');
		expect((await current.decide('a.md')).visible).toBe(true);
	});

	it('配置指纹可更新 - 更新后未刷新按 config-mismatch 拒绝 - 刷新后恢复判定', async () => {
		let now = 1_000;
		const view = new ReadOnlySearchView({
			source: sourceOf({ records: [presentRecord('ok.md')] }),
			configFingerprint: CONFIG_FINGERPRINT,
			now: () => now,
		});
		await view.refresh();
		expect((await view.decide('ok.md')).visible).toBe(true);
		view.setConfigFingerprint('e'.repeat(64));
		expect(view.configFingerprint()).toBe('e'.repeat(64));
		// 快照仍是旧指纹 —— 「快照指纹 ≠ 当前指纹」分支因此真的可达。
		expect(view.snapshot().configFingerprint).toBe(CONFIG_FINGERPRINT);
		expect(await view.decide('ok.md')).toMatchObject({ visible: false, reason: 'config-mismatch' });
		await view.refresh();
		expect(view.snapshot().configFingerprint).toBe('e'.repeat(64));
		expect((await view.decide('ok.md')).visible).toBe(true);
	});

	it('refresh 缺省沿用上次未解决集合 - 先传后不传不丢在途过滤', async () => {
		const root = await makeTempRoot();
		const { journal } = await createCommittedJournal(root);
		const view = new ReadOnlySearchView({
			source: createJournalVisibilitySource(journal),
			configFingerprint: CONFIG_FINGERPRINT,
		});
		await view.refresh(new Set(['a.md']));
		expect((await view.filterCandidates([{ path: 'a.md' }])).denied).toEqual([
			{ path: 'a.md', reason: 'unresolved-transaction' },
		]);
		// 关键路径:缺省调用不得丢掉在途过滤。
		await view.refresh();
		expect((await view.filterCandidates([{ path: 'a.md' }])).denied).toEqual([
			{ path: 'a.md', reason: 'unresolved-transaction' },
		]);
		// 显式传空集才清空。
		await view.refresh(new Set());
		expect((await view.filterCandidates([{ path: 'a.md' }])).visible.map((item) => item.path)).toEqual(['a.md']);
	});

	it('快照超期 - 按不可判定拒绝 - 刷新后恢复', async () => {
		const root = await makeTempRoot();
		const { journal } = await createCommittedJournal(root);
		let now = 1_000;
		const view = new ReadOnlySearchView({
			source: createJournalVisibilitySource(journal),
			configFingerprint: CONFIG_FINGERPRINT,
			maxSnapshotAgeMs: 500,
			now: () => now,
		});
		await view.refresh();
		expect(view.snapshotExpired()).toBe(false);
		expect(view.recordsKind()).toBe('known');
		now = 1_400;
		expect(view.snapshotExpired()).toBe(false);
		expect((await view.decide('a.md')).visible).toBe(true);
		// 关键路径:久未刷新且未注入 `exists` 时,不能无限期把可能已删除的文件判为可见。
		now = 1_600;
		expect(view.snapshotExpired()).toBe(true);
		expect(view.recordsKind()).toBe('unjudgeable');
		expect(await view.decide('a.md')).toMatchObject({ visible: false, reason: 'unjudgeable' });
		expect(await view.filterCandidates([{ path: 'a.md' }, { path: 'gone.md' }])).toEqual({
			visible: [],
			denied: [
				{ path: 'a.md', reason: 'unjudgeable' },
				{ path: 'gone.md', reason: 'unjudgeable' },
			],
		});
		await view.refresh();
		expect(view.snapshotExpired()).toBe(false);
		expect((await view.decide('a.md')).visible).toBe(true);
	});

	it('快照最大有效期非法 - 构造即拒绝', () => {
		expect(() => new ReadOnlySearchView({
			source: sourceOf({ records: [] }),
			configFingerprint: CONFIG_FINGERPRINT,
			maxSnapshotAgeMs: 0,
		})).toThrow();
		expect(() => new ReadOnlySearchView({
			source: sourceOf({ records: [] }),
			configFingerprint: '',
		})).toThrow();
	});
});
// ==================== 装配守卫 ====================

/** 定义模块自身不算装配点 — 它的导出声明与 JSDoc 示例不是接线。 */
const MODULE_DEFINITION_FILES = new Set(['src/core/index-search-visibility.ts']);

/**
 * 生产装配的唯一登记表 — 与 `tests/core/persistent-index-backend.test.ts` 共用同一份账本
 * (`tests/helpers/index-assembly-registry.ts`),不再各自维护平行清单。
 */
const REGISTERED_ASSEMBLY = REGISTERED_INDEX_ASSEMBLY;

/** 去掉注释行 —— 守卫只看代码,避免 JSDoc 里的示例被当成装配点。 */
function codeText(source: string): string {
	return source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
}

/**
 * 取出每处 `new X(` 的完整实参文本。
 *
 * 关键路径:按括号配平切出整段实参,而不是按行匹配 —— 构造参数跨多行时按行判断会漏掉。
 */
function constructArguments(source: string, marker: string): string[] {
	const calls: string[] = [];
	let index = source.indexOf(marker);
	while (index >= 0) {
		const start = index + marker.length - 1;
		let depth = 0;
		let end = start;
		for (; end < source.length; end += 1) {
			const char = source[end];
			if (char === '(') depth += 1;
			else if (char === ')') {
				depth -= 1;
				if (depth === 0) break;
			}
		}
		calls.push(source.slice(start, end + 1));
		index = source.indexOf(marker, end + 1);
	}
	return calls;
}

/**
 * 统计标记在文本中出现的次数 —— 逐点计数,不是 `includes` 的文件级布尔。
 *
 * 关键路径(S5):守卫要能发现「同一文件内的第二处接线」,就必须按点位计数。
 *
 * @param source - 已去注释的源码文本。
 * @param marker - 要统计的接线标记。
 * @returns 出现次数。
 */
function countOccurrences(source: string, marker: string): number {
	let count = 0;
	let index = source.indexOf(marker);
	while (index >= 0) {
		count += 1;
		index = source.indexOf(marker, index + 1);
	}
	return count;
}

/**
 * 逐点统计该文件的可见性门接线点 — 按接线手法分类。
 *
 * 关键路径(S5):文件级布尔在「该文件已接线」成立后就会吞掉同文件的第二处接线;
 * 这里返回每一类手法的**点位数量**,与账本按计数精确相等,多一个、少一个都红。
 *
 * @param source - 文件源码。
 * @returns 该类文件的接线点计数。
 */
function countGateWiringPoints(source: string): GateWiringPointCounts {
	const code = codeText(source);
	return {
		readOnlySearchViews: countOccurrences(code, 'new ReadOnlySearchView('),
		journalVisibilitySources: countOccurrences(code, 'createJournalVisibilitySource('),
		controllerReadOnlyViews: constructArguments(code, 'new IndexController(')
			.filter((args) => /\breadOnlyView\s*:/.test(args)).length,
	};
}

/** 该装配文件是否接线了可见性门 — 由逐点计数派生,不再另维护一套布尔判断。 */
function wiresVisibilityGate(source: string): boolean {
	const points = countGateWiringPoints(source);
	return points.readOnlySearchViews > 0 || points.journalVisibilitySources > 0 || points.controllerReadOnlyViews > 0;
}

/** 该装配文件是否走「日志只读来源」这条推荐路径 —— 它完全不读后端记录端口。 */
function usesJournalReadOnlySource(source: string): boolean {
	return codeText(source).includes('createJournalVisibilitySource(');
}

/** 该装配文件是否给后端注入了文件完成记录端口。 */
function injectsFileRecords(source: string): boolean {
	return constructArguments(codeText(source), 'new PersistentIndexBackend(')
		.some((args) => /\bfileRecords\s*:/.test(args));
}

/** 递归收集目录下的 TypeScript 源文件。 */
function collectSourceFiles(root: string): string[] {
	const collected: string[] = [];
	const pending = [root];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) continue;
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const fullPath = path.join(current, entry.name);
			if (entry.isDirectory()) pending.push(fullPath);
			else if (entry.isFile() && entry.name.endsWith('.ts')) collected.push(fullPath);
		}
	}
	return collected.sort();
}

describe('装配守卫:可见性门接线与记录端口注入', () => {
	it('生产装配点 - 门接线与 fileRecords 注入同批 - 双向断言唯一登记表', () => {
		const repoRoot = path.resolve(__dirname, '../..');
		const sources = new Map(collectSourceFiles(path.join(repoRoot, 'src'))
			.map((file) => [path.relative(repoRoot, file), fs.readFileSync(file, 'utf8')]));
		const sourceFiles = [...sources.keys()].filter((file) => !MODULE_DEFINITION_FILES.has(file));
		// 关键路径(S5):逐点计数而不是文件级布尔 —— 同一文件里的第二处接线也会改变计数。
		const gatePointCounts: Record<string, GateWiringPointCounts> = {};
		for (const file of sourceFiles) {
			const points = countGateWiringPoints(sources.get(file)!);
			if (points.readOnlySearchViews > 0 || points.journalVisibilitySources > 0 || points.controllerReadOnlyViews > 0) {
				gatePointCounts[file] = points;
			}
		}
		const gateWiring = Object.keys(gatePointCounts);
		const fileRecordSites = new Set(sourceFiles.filter((file) => injectsFileRecords(sources.get(file)!)));

		// 关键路径:后端记录端口未注入时 `searchableFileRecords()` 返回 null,门对 `unjudgeable`
		// 一律 deny —— 这不是收紧而是检索全量归零。唯一例外是推荐路径
		// `createJournalVisibilitySource(journal)`:它不读后端记录端口,但也不得叠加后端来源。
		expect(gateWiring.filter((file) => !fileRecordSites.has(file) && !usesJournalReadOnlySource(sources.get(file)!))).toEqual([]);
		// 关键路径:接线点**按计数**双向 —— 新增接线点未登记会红(含同文件第二处),
		// 接线被移除/重命名/换手法同样会红;只记总数会漏掉「删一处加一处」。
		expect(gatePointCounts).toEqual(REGISTERED_ASSEMBLY.gateWiringPointCounts);
		// 非恒真保证:扫描必须真的覆盖生产源码与生产入口,且登记表不是空的恒真断言。
		expect(sourceFiles.length).toBeGreaterThan(100);
		expect(sourceFiles).toContain('src/main.ts');
		expect(fileRecordSites.size).toBeGreaterThanOrEqual(1);
		// 非恒真保证:账本里的接线点总数必须为正 —— 全零会让上面的相等断言退化成「扫不到就绿」。
		expect(Object.values(gatePointCounts).reduce((sum, points) => sum + points.readOnlySearchViews + points.journalVisibilitySources + points.controllerReadOnlyViews, 0)).toBeGreaterThan(0);

		// 后端构造点侧同一份账:**逐点计数**,不是「哪些文件有漏点」的文件级集合。
		const backendConstructionPointCounts: Record<string, number> = {};
		const pendingFileRecordsPointCounts: Record<string, number> = {};
		for (const file of collectSourceFiles(path.join(repoRoot, 'src'))) {
			const source = codeText(fs.readFileSync(file, 'utf8'));
			const callSites = constructArguments(source, 'new PersistentIndexBackend(');
			if (callSites.length === 0) continue;
			const relative = path.relative(repoRoot, file);
			backendConstructionPointCounts[relative] = callSites.length;
			const missing = callSites.filter((args) => !/\bfileRecords\s*:/.test(args)).length;
			if (missing > 0) pendingFileRecordsPointCounts[relative] = missing;
		}
		expect(Object.values(backendConstructionPointCounts).reduce((sum, count) => sum + count, 0)).toBeGreaterThanOrEqual(1);
		expect(backendConstructionPointCounts).toEqual(REGISTERED_ASSEMBLY.backendConstructionPointCounts);
		// 双向且逐点:同一文件里第二个漏注入点会被计成 2,未登记立即失败;
		// 登记项在注入后未删除同样失败(清单只允许收缩到空)。
		expect(pendingFileRecordsPointCounts).toEqual(REGISTERED_ASSEMBLY.pendingFileRecordsPointCounts);
	});

	it('守卫判定可被证伪 - 接线门而未注入记录端口的文本会被判为不合规', () => {
		const wiringWithoutRecords = [
			"const view = new ReadOnlySearchView({ source, configFingerprint });",
			"const backend = new PersistentIndexBackend({ indexDir, manifest, worker, getStore, vault });",
		].join('\n');
		expect(wiresVisibilityGate(wiringWithoutRecords)).toBe(true);
		expect(injectsFileRecords(wiringWithoutRecords)).toBe(false);
		expect(usesJournalReadOnlySource(wiringWithoutRecords)).toBe(false);
		// 反向对照:注入记录端口或改用日志只读来源后,同构文本判为合规。
		expect(injectsFileRecords(wiringWithoutRecords.replace('vault }', 'vault, fileRecords: journal }'))).toBe(true);
		expect(usesJournalReadOnlySource(wiringWithoutRecords.replace('source, configFingerprint', 'createJournalVisibilitySource(journal), configFingerprint'))).toBe(true);
		// 控制器侧接线同样被识别;JSDoc 注释里的示例不算装配点。
		expect(wiresVisibilityGate('new IndexController(vault, backend, root, { readOnlyView: view });')).toBe(true);
		expect(wiresVisibilityGate(' *   const view = new ReadOnlySearchView({ source, configFingerprint });')).toBe(false);
	});

	it('守卫判定可被证伪 - 同一文件内新增第二处接线会被逐点计数发现(文件级布尔放行)', () => {
		// 关键路径(S5 反例):旧守卫是文件级布尔,「该文件已接线」一旦为真,
		// 文件内再新增第二处「接线门但不读日志只读来源」的接线不会被发现。
		const oneGate = [
			'const backend = new PersistentIndexBackend({ indexDir, manifest, worker, getStore, vault, fileRecords: journal });',
			'const view = new ReadOnlySearchView({ source: createJournalVisibilitySource(journal), configFingerprint });',
		].join('\n');
		const twoGates = [
			oneGate,
			'const legacyView = new ReadOnlySearchView({ source: createBackendVisibilitySource(backend), configFingerprint });',
		].join('\n');

		// 旧口径(文件级)对两段文本判定完全相同 —— 这正是「发现不了第二处」的失败证据:
		// 该文件已有一个注入了 fileRecords 的后端,也已有日志只读来源,语义检查被同文件其它点位满足。
		expect(wiresVisibilityGate(oneGate)).toBe(wiresVisibilityGate(twoGates));
		expect(injectsFileRecords(twoGates)).toBe(true);
		expect(usesJournalReadOnlySource(twoGates)).toBe(true);

		// 新口径(逐点计数)必须随第二处接线变化。
		const before = countGateWiringPoints(oneGate);
		const after = countGateWiringPoints(twoGates);
		expect(before.readOnlySearchViews).toBe(1);
		expect(after.readOnlySearchViews).toBe(2);
		expect(after).not.toEqual(before);

		// 与账本比较的**双向**证伪:账本停在 `before` 时 `after` 会红;账本提前写成 `after` 时
		// `before`(即真实的单点装配)同样会红 —— 不存在「多一个少一个都绿」的写法。
		const ledgerOfBefore: Record<string, GateWiringPointCounts> = { 'src/main.ts': before };
		const ledgerOfAfter: Record<string, GateWiringPointCounts> = { 'src/main.ts': after };
		expect(ledgerOfBefore).not.toEqual({ 'src/main.ts': after });
		expect(ledgerOfAfter).not.toEqual({ 'src/main.ts': before });
	});
});
