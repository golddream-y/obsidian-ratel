/**
 * @file tests/core/index-manifest-recovery.test.ts
 * @description 派生清单恢复纯模块 — 全部通过的最小正例与每条拒绝原因的失败关闭验证
 * @module tests/core/index-manifest-recovery
 * @depends core/index-manifest-recovery
 *
 * 关键路径:
 * - 全部依赖都是内存替身,不触碰磁盘/日志实现;用例断言的是「核验结论」而不是写入副作用,
 *   因为本模块的契约就是「只产出纯数据清单,不写盘」。
 * - 负例逐条对应拒绝原因码:任何一项无法证明都必须拒绝,不允许猜、清库或退回全量重建。
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
	recoverDerivedManifest,
	type ManifestRecoveryDeps,
	type ManifestRecoveryRecord,
	type ManifestRecoveryRecordSource,
	type ManifestRecoveryResult,
	type ManifestRecoverySuccess,
	type ManifestRecoveryVaultInput,
} from '../../src/core/index-manifest-recovery';

// ==================== 夹具 ====================

/** 当前配置指纹与记录写入时的配置指纹 — 正例里两者必须相同。 */
const FINGERPRINT = 'a'.repeat(64);
/** 另一套配置的指纹 — 用于构造指纹不符。 */
const OTHER_FINGERPRINT = 'c'.repeat(64);
/** 固定构建规则,避免用例依赖真实设置。 */
const BUILD_STAMP = {
	chunkerVersion: 1,
	chunkSize: 500,
	chunkOverlap: 100,
	embedModelId: 'bge-small-zh-v1.5',
};
/** 固定时钟,断言清单里的 lastIndexTime。 */
const NOW = 1_700_000_000_000;

/** 与生产一致的 sha256(content) 占位:这里用路径派生,保证 64 位小写十六进制。 */
function hashOf(path: string): string {
	return createHash('sha256').update(path).digest('hex');
}

/** 构造一条合法完成记录。 */
function presentRecord(
	path: string,
	overrides: Partial<ManifestRecoveryRecord> = {},
): ManifestRecoveryRecord {
	return {
		path,
		state: 'present',
		revision: 1,
		inputHash: hashOf(path),
		chunkCount: 2,
		configFingerprint: FINGERPRINT,
		...overrides,
	};
}

/** 构造一条合法删除凭据。 */
function deletedRecord(
	path: string,
	overrides: Partial<ManifestRecoveryRecord> = {},
): ManifestRecoveryRecord {
	return {
		path,
		state: 'deleted',
		revision: 2,
		inputHash: null,
		chunkCount: 0,
		configFingerprint: FINGERPRINT,
		...overrides,
	};
}

/** 构造记录读取源替身。 */
function makeRecordSource(options: {
	receipts: ReadonlyArray<ManifestRecoveryRecord>;
	tombstones: ReadonlyArray<ManifestRecoveryRecord>;
	searchable: ReadonlyArray<ManifestRecoveryRecord>;
	pending?: boolean;
	pendingPaths?: ReadonlyArray<string>;
}): ManifestRecoveryRecordSource {
	return {
		listReceipts: async () => options.receipts,
		listTombstones: async () => options.tombstones,
		listSearchableReceipts: async () => options.searchable,
		hasPendingTransactions: async () => options.pending ?? false,
		listPendingPaths: async () => options.pendingPaths ?? [],
	};
}

/** 夹具覆盖项。 */
interface FixtureConfig {
	receipts?: ManifestRecoveryRecord[];
	tombstones?: ManifestRecoveryRecord[];
	searchable?: ManifestRecoveryRecord[];
	vault?: ManifestRecoveryVaultInput[];
	verifyBlockSet?: ManifestRecoveryDeps['verifyBlockSet'];
	pending?: boolean;
	pendingPaths?: string[];
	overrides?: Partial<ManifestRecoveryDeps>;
}

/** 构造默认全通过的依赖集合,按用例局部覆盖。 */
function makeDeps(config: FixtureConfig = {}): ManifestRecoveryDeps {
	const receipts = config.receipts ?? [presentRecord('notes/a.md'), presentRecord('notes/b.md')];
	const tombstones = config.tombstones ?? [];
	const searchable = config.searchable ?? [...receipts];
	const vault = config.vault ?? receipts.map(record => ({ path: record.path, hash: record.inputHash ?? '' }));
	const recordsByPath = new Map([...receipts, ...tombstones].map(record => [record.path, record]));
	const defaults: ManifestRecoveryDeps = {
		fileRecords: makeRecordSource({
			receipts,
			tombstones,
			searchable,
			pending: config.pending,
			pendingPaths: config.pendingPaths,
		}),
		verifyBlockSet: config.verifyBlockSet ?? (async (path) => {
			const record = recordsByPath.get(path);
			return record ? { matches: true, receipt: record } : null;
		}),
		fingerprint: () => FINGERPRINT,
		expectedFingerprint: FINGERPRINT,
		vaultInputs: async () => vault,
		readStoredStamp: async () => ({ ...BUILD_STAMP }),
		buildStamp: { ...BUILD_STAMP },
		inFlight: () => ({ active: 0, pendingTransactions: 0 }),
		now: () => NOW,
	};
	return { ...defaults, ...config.overrides };
}

/** 断言恢复成功并收窄类型。 */
function expectOk(result: ManifestRecoveryResult): ManifestRecoverySuccess {
	if (!result.ok) throw new Error(`期望恢复成功,实际拒绝:${result.reason}`);
	return result;
}

/** 断言恢复以指定原因码拒绝。 */
function expectRejected(result: ManifestRecoveryResult, reason: string): void {
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toBe(reason);
}

// ==================== 正例 ====================

describe('recoverDerivedManifest - 正例', () => {
	it('recoverDerivedManifest - 记录/删除/可检索一致且块与 vault 哈希匹配 - 返回纯数据清单与构建戳', async () => {
		const success = expectOk(await recoverDerivedManifest(makeDeps()));

		expect(success.firstBuild).toBe(false);
		expect(success.skipped).toBe(2);
		expect(success.buildStamp).toEqual(BUILD_STAMP);
		// 关键路径:mtime 固定为 0,强制下次启动用 hash 核实,不能借当前 stat 伪造。
		expect(success.manifest).toEqual({
			version: 1,
			...BUILD_STAMP,
			lastIndexTime: NOW,
			entries: {
				'notes/a.md': { path: 'notes/a.md', hash: hashOf('notes/a.md'), mtime: 0, chunkCount: 2 },
				'notes/b.md': { path: 'notes/b.md', hash: hashOf('notes/b.md'), mtime: 0, chunkCount: 2 },
			},
		});
	});

	it('recoverDerivedManifest - 只剩删除凭据且 vault 为空 - 返回空清单(全部文件已删除)', async () => {
		const success = expectOk(await recoverDerivedManifest(makeDeps({
			receipts: [],
			tombstones: [deletedRecord('notes/gone.md')],
			searchable: [],
			vault: [],
		})));

		expect(success.firstBuild).toBe(false);
		expect(success.skipped).toBe(0);
		expect(success.manifest.entries).toEqual({});
	});

	it('recoverDerivedManifest - 持久化构建戳缺失 - 不阻断恢复', async () => {
		const success = expectOk(await recoverDerivedManifest(makeDeps({
			overrides: { readStoredStamp: async () => null },
		})));

		expect(success.skipped).toBe(2);
	});
});

// ==================== 负例:空库与首次构建 ====================

describe('recoverDerivedManifest - 空库与首次构建', () => {
	it('recoverDerivedManifest - 三者皆空但未声明首次构建 - 拒绝 empty-index-not-first-build', async () => {
		const result = await recoverDerivedManifest(makeDeps({
			receipts: [],
			tombstones: [],
			searchable: [],
			vault: [],
		}));

		expectRejected(result, 'empty-index-not-first-build');
	});

	it('recoverDerivedManifest - 三者皆空且显式声明首次构建 - 允许空清单并标记 firstBuild', async () => {
		const success = expectOk(await recoverDerivedManifest(makeDeps({
			receipts: [],
			tombstones: [],
			searchable: [],
			vault: [],
			overrides: { allowFirstBuild: true },
		})));

		expect(success.firstBuild).toBe(true);
		expect(success.skipped).toBe(0);
		expect(success.manifest.entries).toEqual({});
	});
});

// ==================== 负例:配置指纹 ====================

describe('recoverDerivedManifest - 配置指纹', () => {
	it('recoverDerivedManifest - 当前指纹与期望指纹不一致 - 拒绝 fingerprint-mismatch', async () => {
		const result = await recoverDerivedManifest(makeDeps({
			overrides: { fingerprint: () => OTHER_FINGERPRINT },
		}));

		expectRejected(result, 'fingerprint-mismatch');
	});

	it('recoverDerivedManifest - 完成记录携带另一套配置指纹 - 拒绝 fingerprint-mismatch', async () => {
		const result = await recoverDerivedManifest(makeDeps({
			receipts: [presentRecord('notes/a.md', { configFingerprint: OTHER_FINGERPRINT })],
			searchable: [presentRecord('notes/a.md', { configFingerprint: OTHER_FINGERPRINT })],
		}));

		expectRejected(result, 'fingerprint-mismatch');
	});

	it('recoverDerivedManifest - 当前指纹不是 64 位小写十六进制 - 拒绝 fingerprint-invalid', async () => {
		const result = await recoverDerivedManifest(makeDeps({
			overrides: { fingerprint: () => 'NOT-A-FINGERPRINT' },
		}));

		expectRejected(result, 'fingerprint-invalid');
	});
});

// ==================== 负例:记录合法性、互斥与覆盖 ====================

describe('recoverDerivedManifest - 记录合法性、互斥与覆盖', () => {
	it('recoverDerivedManifest - 完成记录 revision 非法 - 拒绝 record-invalid', async () => {
		const result = await recoverDerivedManifest(makeDeps({
			receipts: [presentRecord('notes/a.md', { revision: 0 })],
			searchable: [presentRecord('notes/a.md', { revision: 0 })],
		}));

		expectRejected(result, 'record-invalid');
	});

	it('recoverDerivedManifest - 删除凭据残留 inputHash - 拒绝 record-invalid', async () => {
		const result = await recoverDerivedManifest(makeDeps({
			tombstones: [deletedRecord('notes/gone.md', { inputHash: hashOf('notes/gone.md') })],
		}));

		expectRejected(result, 'record-invalid');
	});

	it('recoverDerivedManifest - 同一路径同时出现在完成记录与删除记录 - 拒绝 record-conflict', async () => {
		const result = await recoverDerivedManifest(makeDeps({
			tombstones: [deletedRecord('notes/a.md')],
		}));

		expectRejected(result, 'record-conflict');
	});

	it('recoverDerivedManifest - 可检索集合漏掉一条完成记录 - 拒绝 searchable-coverage-mismatch', async () => {
		const result = await recoverDerivedManifest(makeDeps({
			searchable: [presentRecord('notes/a.md')],
		}));

		expectRejected(result, 'searchable-coverage-mismatch');
	});

	it('recoverDerivedManifest - 记录读取返回非数组 - 拒绝 records-unreadable', async () => {
		const deps = makeDeps();
		const brokenSource: ManifestRecoveryRecordSource = {
			...deps.fileRecords,
			listTombstones: async () => null as unknown as ReadonlyArray<ManifestRecoveryRecord>,
		};

		expectRejected(await recoverDerivedManifest({ ...deps, fileRecords: brokenSource }), 'records-unreadable');
	});
});

// ==================== 负例:未决事务与在途计数 ====================

describe('recoverDerivedManifest - 未决事务与在途计数', () => {
	it('recoverDerivedManifest - 存在未决事务目录 - 拒绝 pending-transaction', async () => {
		expectRejected(await recoverDerivedManifest(makeDeps({ pending: true })), 'pending-transaction');
	});

	it('recoverDerivedManifest - 存在未决事务路径 - 拒绝 pending-transaction', async () => {
		expectRejected(
			await recoverDerivedManifest(makeDeps({ pendingPaths: ['notes/a.md'] })),
			'pending-transaction',
		);
	});

	it('recoverDerivedManifest - 协调器仍有在途提交 - 拒绝 round-in-flight', async () => {
		expectRejected(await recoverDerivedManifest(makeDeps({
			overrides: { inFlight: () => ({ active: 1, pendingTransactions: 0 }) },
		})), 'round-in-flight');
	});

	it('recoverDerivedManifest - 在途计数非法 - 拒绝 round-state-invalid', async () => {
		expectRejected(await recoverDerivedManifest(makeDeps({
			overrides: { inFlight: () => ({ active: -1, pendingTransactions: 0 }) },
		})), 'round-state-invalid');
	});
});

// ==================== 负例:块核验、构建戳与 vault 输入 ====================

describe('recoverDerivedManifest - 块核验、构建戳与 vault 输入', () => {
	it('recoverDerivedManifest - 块集合核验无结论 - 拒绝 block-verification-failed', async () => {
		expectRejected(await recoverDerivedManifest(makeDeps({
			verifyBlockSet: async () => null,
		})), 'block-verification-failed');
	});

	it('recoverDerivedManifest - 块核验返回的记录版本漂移 - 拒绝 block-verification-failed', async () => {
		const result = await recoverDerivedManifest(makeDeps({
			verifyBlockSet: async (path) => {
				if (path === 'notes/a.md') {
					return { matches: true, receipt: { ...presentRecord('notes/a.md'), revision: 2 } };
				}
				return { matches: true, receipt: presentRecord('notes/b.md') };
			},
		}));

		expectRejected(result, 'block-verification-failed');
	});

	it('recoverDerivedManifest - 块核验抛错 - 拒绝 block-verification-failed', async () => {
		expectRejected(await recoverDerivedManifest(makeDeps({
			verifyBlockSet: async () => {
				throw new Error('block inspection failed');
			},
		})), 'block-verification-failed');
	});

	it('recoverDerivedManifest - 持久化构建戳与当前规则不一致 - 拒绝 build-stamp-mismatch', async () => {
		expectRejected(await recoverDerivedManifest(makeDeps({
			overrides: {
				readStoredStamp: async () => ({ ...BUILD_STAMP, chunkSize: BUILD_STAMP.chunkSize + 1 }),
			},
		})), 'build-stamp-mismatch');
	});

	it('recoverDerivedManifest - vault 内容哈希与完成记录不一致 - 拒绝 vault-input-mismatch', async () => {
		expectRejected(await recoverDerivedManifest(makeDeps({
			vault: [
				{ path: 'notes/a.md', hash: 'd'.repeat(64) },
				{ path: 'notes/b.md', hash: hashOf('notes/b.md') },
			],
		})), 'vault-input-mismatch');
	});

	it('recoverDerivedManifest - vault 多出未索引文件 - 拒绝 vault-input-mismatch', async () => {
		expectRejected(await recoverDerivedManifest(makeDeps({
			vault: [
				{ path: 'notes/a.md', hash: hashOf('notes/a.md') },
				{ path: 'notes/b.md', hash: hashOf('notes/b.md') },
				{ path: 'notes/c.md', hash: hashOf('notes/c.md') },
			],
		})), 'vault-input-mismatch');
	});

	it('recoverDerivedManifest - vault 输入哈希格式非法 - 拒绝 vault-input-invalid', async () => {
		expectRejected(await recoverDerivedManifest(makeDeps({
			vault: [
				{ path: 'notes/a.md', hash: 'NOT-A-HASH' },
				{ path: 'notes/b.md', hash: hashOf('notes/b.md') },
			],
		})), 'vault-input-invalid');
	});

	it('recoverDerivedManifest - vault 缺少已完成文件 - 拒绝 vault-input-mismatch', async () => {
		expectRejected(await recoverDerivedManifest(makeDeps({
			vault: [{ path: 'notes/a.md', hash: hashOf('notes/a.md') }],
		})), 'vault-input-mismatch');
	});

	it('recoverDerivedManifest - 缺少块核验依赖 - 拒绝 dependencies-missing', async () => {
		const deps = makeDeps();
		expectRejected(await recoverDerivedManifest({
			...deps,
			verifyBlockSet: undefined as unknown as ManifestRecoveryDeps['verifyBlockSet'],
		}), 'dependencies-missing');
	});
});
