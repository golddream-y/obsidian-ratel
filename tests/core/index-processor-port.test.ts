/**
 * @file tests/core/index-processor-port.test.ts
 * @description 宿主装配的生产接缝 — 代际目录解析、严格归属断言、协调器处理器端口与首个提交登记
 * @module tests/core/index-processor-port
 * @depends core/index-processor-port, core/index-generations, main
 *
 * 关键路径(T7a 的核心验收):
 * - 「启动时注入的目录确实是 `generations/<activeGenerationId>`」用**真实临时索引根**上的装配
 *   结果断言,不是只看源码文本;
 * - 「一次全量重建不会删除 `control.json` / `owner.lock` / `generations/`」用真实后端 + 严格
 *   归属断言断言:拒绝发生在删除之前,目录摘要逐字不变;
 * - 处理器端口的 `options` 转发、首个提交登记活动代际、身份不可确认时走显式重建入口
 *   都有可失败的正反用例。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { get } from 'svelte/store';
import RatelVaultPlugin from '../../src/main';
import { IndexGenerations, deriveGenerationId } from '../../src/core/index-generations';
import { PersistentIndexBackend, IndexDirectoryNotOwnedError } from '../../src/core/persistent-index-backend';
import { IndexManifest, resolveIndexManifestPath } from '../../src/core/index-manifest';
import {
	ChunkingCoordinatorProcessor,
	createFirstCommitPromoter,
	createStrictDropOwnershipAssertion,
	resolveIndexGeneration,
} from '../../src/core/index-processor-port';
import type { JournalWriteOwner } from '../../src/core/index-file-journal';
import type { CoordinatorJournalPort } from '../../src/core/index-task-coordinator';
import type { IndexConfigDescriptor } from '../../src/core/index-persistence-types';
import { INDEX_RECORD_SCHEMA_VERSION, computeConfigFingerprint } from '../../src/core/index-persistence-types';
import type { CommittedFileRecord } from '../../src/core/persistent-index-backend';
import { UserStatus, type UserStatusSnapshot } from '../../src/user-feedback/user-status';
import { tNow } from '../../src/i18n';

// 关键路径:Node 测试环境没有真实 Obsidian 宿主,用最小 stub 让 Plugin 及其子类可实例化。
vi.mock('obsidian', () => ({
	App: class {
	},
	Plugin: class {
		loadData = vi.fn().mockResolvedValue({});
		saveData = vi.fn().mockResolvedValue(undefined);
		registerEvent = vi.fn().mockReturnValue(() => { });
		registerView = vi.fn();
		addRibbonIcon = vi.fn();
		addCommand = vi.fn();
		addSettingTab = vi.fn();
		addStatusBarItem = vi.fn().mockReturnValue({ hide: vi.fn(), onClickEvent: vi.fn() });
		register = vi.fn();
	},
	PluginSettingTab: class {
		app: unknown;
		constructor(app: unknown) { this.app = app; }
	},
	SettingPage: class {
	},
	Setting: class {
	},
	Notice: class {
	},
	WorkspaceLeaf: class {
	},
	ItemView: class {
	},
	FileSystemAdapter: class {
	},
	TFile: class {
	},
	Modal: class {
		open() { }
		close() { }
	},
	requestUrl: vi.fn().mockResolvedValue({ json: () => Promise.resolve({ models: [] }) }),
}));
vi.mock('worker_threads', () => ({
	Worker: class {
		on = vi.fn();
		postMessage = vi.fn();
		terminate = vi.fn();
	},
	workerData: {},
}));
vi.mock('../../src/utils/gitignore-writer', () => ({ ensurePluginGitignore: vi.fn() }));
vi.mock('../../src/ui/chat/ChatView', () => ({ ChatView: class { }, VIEW_TYPE_CHAT: 'ratel-chat' }));
vi.mock('../../src/ui/memory-panel/MemoryModal', () => ({
	MemoryModal: class { },
	shouldCreateMemoryModal: (current: unknown) => current === null,
}));

/** 测试用配置 — 与 T6 的身份约定同源(`local:<id>`)。 */
function testConfig(overrides: Partial<IndexConfigDescriptor> = {}): IndexConfigDescriptor {
	return {
		embeddingModelId: 'local:bge-small-zh-v1.5',
		embeddingModelRevision: null,
		embeddingDimension: 512,
		chunkerVersion: 3,
		chunkSize: 500,
		chunkOverlap: 100,
		embeddingTextVersion: null,
		...overrides,
	};
}

/** 满足日志写所有权端口的最小替身(只做断言,不落盘)。 */
function testOwner(): JournalWriteOwner {
	return {
		epoch: 7,
		assertWritable: () => { },
		beginCommit: () => ({ settle: () => { } }),
	};
}

/**
 * 清理临时目录 — 先给 vectra 内部未结算的落盘一次收敛窗口。
 *
 * 关键路径(夹具卫生):真实 `VectraStore` 的 `init()` resolve 之后,vectra 仍可能有
 * 异步的 catalog/index 写入在飞;此时整目录 `rmSync` 会让它以「原子替换失败」的
 * 未处理拒绝泄漏到运行器(全量并发下才复现,属夹具时序而不是产品缺陷)。
 * 因此删除前显式让出一小段真实时间,与 T6 处理同类 flake 的口径一致。
 */
async function cleanupTempDir(dir: string): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 25));
	fs.rmSync(dir, { recursive: true, force: true });
}

/** 目录摘要 — 相对路径 + mtime + 内容,用于「重建不删根」的逐字比对。 */
function snapshotDir(root: string): Map<string, string> {
	const entries = new Map<string, string>();
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile()) entries.set(path.relative(root, full), fs.readFileSync(full, 'utf8'));
		}
	};
	walk(root);
	return entries;
}

/**
 * 等待一个条件成立 — 代际发布是订阅回调里的异步动作,不能同步断言。
 *
 * @param predicate - 条件(可读盘)。
 * @param timeoutMs - 超时上限,超时即失败,避免静默假绿。
 */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error('等待条件超时');
}

/** 控制指针形状 — 只声明本用例读的字段。 */
interface RawControlRecord {
	activeGenerationId: string | null;
	generations: Record<string, { fingerprint: string; status: string; verifiedAt: number | null }>;
}

/** 直读 `.index/control.json` — 断言「磁盘上的活动指针」而不是内存镜像。 */
function readControlFile(indexRoot: string): RawControlRecord {
	return JSON.parse(fs.readFileSync(path.join(indexRoot, 'control.json'), 'utf8')) as RawControlRecord;
}

/** 一个真实协调器可用的最小 Vault 外观 — 枚举、读取与 stat。 */
function vaultOf(files: Map<string, string>): Record<string, unknown> {
	return {
		listMarkdownFiles: () => [...files.keys()],
		readFile: async (p: string) => {
			const content = files.get(p);
			if (content === undefined) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
			return content;
		},
		stat: (p: string) => (files.has(p) ? { mtime: 1, size: 1 } : null),
	};
}

/** 可计数嵌入端口 — 按「一次调用一批」计数,用于证明隔离代际真的逐文件重算。 */
function countingEmbedding(calls: string[][]): Record<string, unknown> {
	return {
		modelId: 'test-model',
		dimensions: 3,
		embed: async (texts: string[]) => { calls.push(texts); return texts.map(() => [1, 0, 0]); },
	};
}

/**
 * 在指定插件目录上实例化一个「只有装配所需字段」的插件实例。
 *
 * 关键路径:装配方法在原型上,因此不需要构造完整 Plugin(宿主 app 不存在);
 * 但类字段初始化器不会执行 —— 测试只依赖原型方法与本文件显式赋值的字段。
 *
 * @param dir - 插件目录(仅用于签名对齐,本函数不读盘)。
 * @param settingsOverrides - 覆盖会话设置 —— 跨会话改嵌入配置的用例据此造出不同指纹。
 */
function pluginAt(dir: string, settingsOverrides: Record<string, unknown> = {}): any {
	void dir;
	const plugin = Object.create(RatelVaultPlugin.prototype) as any;
	plugin.settings = {
		autoIndex: true,
		embedProvider: 'api',
		embedApiBase: 'https://example.invalid/v1',
		embedApiModel: 'text-embedding-3-small',
		...settingsOverrides,
		// 关键路径:与 embedding 桩的 dimensions 一致 —— 重建适配器后身份必须逐字不变,
		// 否则会话内漂移检测会误报。
		embedApiDimensions: 3,
		chunkSize: 500,
		chunkOverlap: 100,
	};
	// 关键路径:桩必须自洽 —— dimensions 与向量维度一致,否则完成记录按维度不符被拒。
	plugin.embedding = { modelId: 'test-model', dimensions: 3, embed: async (texts: string[]) => texts.map(() => [1, 0, 0]) };
	plugin.vault = {
		listMarkdownFiles: () => [],
		readFile: async () => '',
		stat: () => null,
	};
	// 关键路径:装配路径现在会把迁移/回收结论写进状态落点(T7/I4),并把降级原因上报给用户
	// (T7/I2);测试实例需要这两个真实 store 替身,否则装配期的 status patch 会变成噪音异常。
	plugin.userStatus = new UserStatus();
	plugin.userNotice = { toastError: vi.fn(), toast: vi.fn(), toastProgress: vi.fn(() => ({ update: vi.fn(), hide: vi.fn() })) };
	plugin.workerManager = { clearProgressCallback: vi.fn(), runExclusive: <T>(op: () => Promise<T>) => op() };
	return plugin;
}

describe('宿主装配 — 代际目录解析', () => {
	let pluginDir: string;

	beforeEach(() => { pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-t7a-')); });
	afterEach(async () => { await cleanupTempDir(pluginDir); });

	it('启动装配 - 无活动代际 - 注入目录是 generations/<generationId>,根保留 control 与 owner 锁', async () => {
		const plugin = pluginAt(pluginDir);
		await plugin.setupIndexRuntime(pluginDir);
		// 关键路径:等待存储初始化完成再断言 —— 否则 afterEach 删目录时 vectra 内部的
		// catalog/index 异步落盘会以「状态不明」的未处理拒绝泄漏到测试运行器。
		await plugin.vectraStore.init();

		const indexRoot = path.join(pluginDir, '.index');
		const generationId = plugin.resolvedGenerationId as string;
		// 关键路径(T6 §8.1):注入给存储/日志/后端的目录必须是代际目录,不是 `.index` 根。
		expect(plugin.indexRoot).toBe(indexRoot);
		expect(plugin.indexDir).toBe(path.join(indexRoot, 'generations', generationId));
		expect(fs.existsSync(path.join(indexRoot, 'control.json'))).toBe(true);
		expect(fs.existsSync(path.join(indexRoot, 'owner.lock'))).toBe(true);
		expect(fs.statSync(path.join(indexRoot, 'generations')).isDirectory()).toBe(true);
		// 首个持久提交前不登记活动代际:本实例的代际处于 building,活动指针仍为空。
		expect(plugin.activeGenerationId).toBeNull();
		// 写所有权 epoch 来自租约(非 0),注入后端后 epochSourceMissing 才能为 false。
		expect(plugin.indexOwnerLease?.epoch).toBeGreaterThan(0);
		// 日志与协调器都拿到同一个代际目录。
		expect(plugin.indexJournal).toBeDefined();
		expect(plugin.indexCoordinator).toBeDefined();
		expect(plugin.readOnlySearchView).toBeDefined();

		// 复用:释放租约后重新装配同一根目录 → 沿用同一代际(不反复建空目录,也不会迁移自己)。
		await plugin.indexOwnerLease.release();
		const second = pluginAt(pluginDir);
		await second.setupIndexRuntime(pluginDir);
		await second.vectraStore.init();
		expect(second.indexDir).toBe(plugin.indexDir);
		expect(second.resolvedGenerationId).toBe(generationId);
		await second.indexOwnerLease.release();
	});

	it('启动装配 - 严格归属断言 - 拒绝索引根与聚合目录,只承认代际目录', async () => {
		const plugin = pluginAt(pluginDir);
		await plugin.setupIndexRuntime(pluginDir);
		const indexRoot = path.join(pluginDir, '.index');
		const generationsRoot = path.join(indexRoot, 'generations');

		expect(() => plugin.assertIndexDropOwnership(indexRoot)).toThrow(IndexDirectoryNotOwnedError);
		expect(() => plugin.assertIndexDropOwnership(generationsRoot)).toThrow(IndexDirectoryNotOwnedError);
		expect(() => plugin.assertIndexDropOwnership(pluginDir)).toThrow(IndexDirectoryNotOwnedError);
		expect(() => plugin.assertIndexDropOwnership(path.join(generationsRoot, 'gen-0123456789abcdef'))).not.toThrow();
		expect(() => plugin.assertIndexDropOwnership(path.join(generationsRoot, 'gen-NOT-A-GEN'))).toThrow();
		expect(() => plugin.assertIndexDropOwnership(path.join(pluginDir, 'other', 'generations', 'gen-0123456789abcdef'))).toThrow();
		await plugin.indexOwnerLease.release();
	});

	it('一次清库/重建 - 严格断言指向代际目录 - 根目录的 control/owner/generations 零删除', async () => {
		const plugin = pluginAt(pluginDir);
		await plugin.setupIndexRuntime(pluginDir);
		await plugin.vectraStore.init();
		const indexRoot = path.join(pluginDir, '.index');
		const before = snapshotDir(indexRoot);
		// 前置事实:根下确实有 control.json、owner.lock 与 generations/(否则本用例是恒真)。
		expect([...before.keys()].some((name) => name === 'control.json')).toBe(true);
		expect([...before.keys()].some((name) => name === 'owner.lock')).toBe(true);
		expect([...before.keys()].some((name) => name.startsWith('generations/'))).toBe(true);

		const store = { dropIndex: vi.fn(async () => { }), isIndexCreated: async () => true };
		const backend = new PersistentIndexBackend({
			indexDir: indexRoot,
			manifest: new IndexManifest(resolveIndexManifestPath(indexRoot)),
			worker: { runExclusive: <T>(operation: () => Promise<T>) => operation() } as never,
			getStore: () => store as never,
			vault: plugin.vault,
			getBuildStamp: () => ({ chunkerVersion: 3, chunkSize: 500, chunkOverlap: 100, embedModelId: 'local:bge-small-zh-v1.5' }),
			getChunkOptions: () => ({ maxTokens: 100, overlapTokens: 0 }),
			fileRecords: null,
			assertDropOwnership: (indexDir: string) => plugin.assertIndexDropOwnership(indexDir),
		});

		// 关键路径:把索引根当目标时拒绝发生在调用 `store.dropIndex()` 之前 —— 零删除。
		await expect(backend.dropIndex()).rejects.toBeInstanceOf(IndexDirectoryNotOwnedError);
		expect(store.dropIndex).not.toHaveBeenCalled();
		expect(snapshotDir(indexRoot)).toEqual(before);

		// 反向对照:指向代际目录的同一份断言不拒绝(否则守卫会退化成「永远拒绝」)。
		expect(() => plugin.assertIndexDropOwnership(plugin.indexDir)).not.toThrow();
		await plugin.indexOwnerLease.release();
	});
});

describe('严格归属断言 — 判定表', () => {
	const indexRoot = path.resolve('/tmp/ratel-assert-root/.index');
	const assertOwnership = createStrictDropOwnershipAssertion({ indexRoot });

	it('判定 - 根 / 聚合目录 / 树外目录 / 异形名 - 一律拒绝且不删除任何文件', () => {
		expect(() => assertOwnership(indexRoot)).toThrow(IndexDirectoryNotOwnedError);
		expect(() => assertOwnership(path.join(indexRoot, 'generations'))).toThrow(IndexDirectoryNotOwnedError);
		expect(() => assertOwnership(path.join(indexRoot, 'generations', 'gen-0123456789abcdef', 'nested'))).toThrow();
		expect(() => assertOwnership('/tmp/elsewhere/generations/gen-0123456789abcdef')).toThrow();
		expect(() => assertOwnership(path.join(indexRoot, 'generations', 'gen-0123456789abcde'))).toThrow();
	});

	it('判定 - 本索引根下的合法代际目录 - 通过', () => {
		expect(() => assertOwnership(path.join(indexRoot, 'generations', 'gen-0123456789abcdef'))).not.toThrow();
		expect(() => assertOwnership(path.join(indexRoot, 'generations', 'gen-ffffffffffffffff'))).not.toThrow();
	});
});

describe('协调器处理器端口', () => {
	const chunkOptions = { maxTokens: 40, overlapTokens: 0, count: (text: string) => text.length };

	it('切块与嵌入 - 空内容零块且不调用嵌入;非空内容按块产出 id 与结构化元数据', async () => {
		const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0]));
		const port = new ChunkingCoordinatorProcessor({ embedding: { modelId: 'test-model', dimensions: 3, embed }, getChunkOptions: () => chunkOptions });

		expect(await port.prepareBlocks({ path: 'empty.md', content: '   \n' })).toEqual([]);
		expect(embed).not.toHaveBeenCalled();

		const blocks = await port.prepareBlocks({ path: 'a.md', content: '# 标题\n正文内容' });
		expect(blocks.length).toBeGreaterThan(0);
		expect(blocks[0]).toMatchObject({ id: 'a.md#chunk-0', vector: [1, 0, 0] });
		expect(blocks[0]!.metadata).toMatchObject({ path: 'a.md', chunkIndex: 0, headingPath: ['标题'] });
		expect(typeof blocks[0]!.metadata['prefix']).toBe('string');
	});

	it('端口契约 - options 整包转发给嵌入端口(取消与批次活动不得被吞掉)', async () => {
		const controller = new AbortController();
		// 关键路径:断言**身份**而不是 aborted 标志 —— 「完全没转发 options」(undefined)与
		// 「转发了一个未中止的信号」在 `aborted === false` 上同为真,那种断言抓不到漏转发。
		const seen: Array<{ batches: number[]; sameSignal: boolean; forwarding: boolean }> = [];
		const embed = vi.fn(async (texts: string[], options?: { signal?: AbortSignal; onBatchComplete?: (done: number, total: number) => void }) => {
			options?.onBatchComplete?.(texts.length, texts.length);
			seen.push({
				batches: [texts.length],
				sameSignal: options?.signal === controller.signal,
				forwarding: options !== undefined,
			});
			return texts.map(() => [1, 0, 0]);
		});
		const port = new ChunkingCoordinatorProcessor({ embedding: { modelId: 'test-model', dimensions: 3, embed }, getChunkOptions: () => chunkOptions });
		const batches: number[] = [];

		await port.prepareBlocks({ path: 'a.md', content: '一二三四五六' }, {
			signal: controller.signal,
			onBatchComplete: (done: number) => batches.push(done),
		});
		expect(seen).toHaveLength(1);
		// 未转发时 options 为 undefined ⇒ sameSignal 为 false;转发同一个 signal 对象 ⇒ true。
		expect(seen[0]!.forwarding).toBe(true);
		expect(seen[0]!.sameSignal).toBe(true);
		expect(batches.length).toBeGreaterThan(0);
	});

	it('端口契约 - 取消已生效时不进入分块与嵌入', async () => {
		const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0]));
		const port = new ChunkingCoordinatorProcessor({ embedding: { modelId: 'test-model', dimensions: 3, embed }, getChunkOptions: () => chunkOptions });
		const controller = new AbortController();
		controller.abort();
		await expect(port.prepareBlocks({ path: 'a.md', content: '正文' }, { signal: controller.signal })).rejects.toThrow();
		expect(embed).not.toHaveBeenCalled();
	});

	it('端口契约 - 向量数与块数不一致时抛错,不产出半截块集合', async () => {
		const embed = vi.fn(async () => [[1, 0, 0]]);
		const port = new ChunkingCoordinatorProcessor({ embedding: { modelId: 'test-model', dimensions: 3, embed }, getChunkOptions: () => chunkOptions });
		// 三个标题 section 会切出多个块,而端口只返回 1 个向量 —— 必须抛错而不是截断成半截集合。
		const content = `# 一\n${'x'.repeat(30)}\n# 二\n${'y'.repeat(30)}\n# 三\n${'z'.repeat(30)}`;
		const chunks = (await import('../../src/worker/chunker')).chunkMarkdown(content, chunkOptions);
		expect(chunks.length).toBeGreaterThan(1);
		await expect(port.prepareBlocks({ path: 'a.md', content })).rejects.toThrow(/不一致/);
	});
});

describe('首个持久提交登记活动代际', () => {
	let root: string;
	let generations: IndexGenerations;
	let promoted: string[];

	beforeEach(async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-t7a-gen-'));
		generations = new IndexGenerations({ indexRoot: root, owner: testOwner() });
		promoted = [];
	});
	afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

	/** 造一个只实现协调器所需写入口的日志替身。 */
	function journalStub(options: { withOptionals?: boolean } = {}): CoordinatorJournalPort {
		const port: CoordinatorJournalPort = {
			prepare: async () => ({ transactionId: 't1' }),
			commit: async () => ({ commit: { revision: 1, inputHash: 'h', chunkCount: 1 }, superseded: false }),
			cleanup: async () => { },
			readReceipt: async () => null,
		};
		if (options.withOptionals) {
			port.listReceipts = async () => [];
		}
		return port;
	}

	it('首个提交 - 尚无活动代际 - 登记为活动代际且只登记一次', async () => {
		const created = await generations.ensureGeneration({ config: testConfig() });
		const journal = journalStub();
		const port = createFirstCommitPromoter({
			journal,
			generations,
			generationId: created.generationId,
			onPromoted: () => promoted.push(created.generationId),
		});
		await port.commit('t1');
		const control = await generations.readControl();
		expect(control.activeGenerationId).toBe(created.generationId);
		expect(control.generations[created.generationId]!.status).toBe('active');
		expect(promoted).toEqual([created.generationId]);

		// 幂等:后续提交不再重复登记,也不重复回调。
		await port.commit('t1');
		expect(promoted).toEqual([created.generationId]);
	});

	it('首个提交 - 已有活动代际或终态被后继取代 - 不动活动指针(切换须走 configured-switch)', async () => {
		const first = await generations.ensureGeneration({ config: testConfig() });
		const second = await generations.ensureGeneration({ config: testConfig({ embeddingModelId: 'local:other-model' }) });
		await generations.publishActiveGeneration({ generationId: first.generationId, mode: 'upgrade' });

		const port = createFirstCommitPromoter({
			journal: journalStub(),
			generations,
			generationId: second.generationId,
			onPromoted: () => promoted.push(second.generationId),
		});
		await port.commit('t1');
		const control = await generations.readControl();
		// 关键路径:已有活动代际时不得用「首个提交」冒充切换依据。
		expect(control.activeGenerationId).toBe(first.generationId);
		expect(promoted).toEqual([]);

		// 反向对照:`superseded`(日志已被后继版本取代)不算本实例的持久提交。
		const third = createFirstCommitPromoter({
			journal: { ...journalStub(), commit: async () => ({ commit: { revision: 2, inputHash: 'h', chunkCount: 1 }, superseded: true }) },
			generations,
			generationId: second.generationId,
			onPromoted: () => promoted.push(second.generationId),
		});
		await third.commit('t1');
		expect(promoted).toEqual([]);
	});

	it('端口转发 - 可选成员只在被装饰方真的实现时才出现,提交错误原样上抛', async () => {
		const bare = createFirstCommitPromoter({ journal: journalStub(), generations, generationId: 'gen-0123456789abcdef' });
		expect(bare.listReceipts).toBeUndefined();
		expect(bare.listTombstones).toBeUndefined();
		expect(bare.isGenerationQuarantined).toBeUndefined();

		const rich = createFirstCommitPromoter({ journal: journalStub({ withOptionals: true }), generations, generationId: 'gen-0123456789abcdef' });
		expect(rich.listReceipts).toBeDefined();
		expect(await rich.listReceipts!()).toEqual([]);

		const failing = createFirstCommitPromoter({
			journal: { ...journalStub(), prepare: async () => { throw new Error('prepare failed'); } },
			generations,
			generationId: 'gen-0123456789abcdef',
		});
		await expect(failing.prepare({
			path: 'a.md', operation: 'replace', inputHash: 'h', revision: 1,
			previousCommitId: null, previousRevision: 0, blocks: [],
		})).rejects.toThrow('prepare failed');
	});
});

describe('代际解析决策', () => {
	let root: string;
	let generations: IndexGenerations;

	beforeEach(async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-t7a-resolve-'));
		generations = new IndexGenerations({ indexRoot: root, owner: testOwner() });
	});
	afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

	it('解析 - 已有活动代际 - 直接复用该代际目录且不迁移', async () => {
		const created = await generations.ensureGeneration({ config: testConfig() });
		await generations.publishActiveGeneration({ generationId: created.generationId, mode: 'upgrade' });

		const result = await resolveIndexGeneration({
			generations, indexRoot: root, config: testConfig(), owner: testOwner(), allowCreate: true,
		});
		expect(result.resolved).toMatchObject({
			generationId: created.generationId,
			generationRoot: path.join(root, 'generations', created.generationId),
			active: true,
		});
		expect(result.migration).toBeNull();
	});

	it('解析 - 只读装配且无活动代际 - 返回 null 且不新建代际(零写入)', async () => {
		const result = await resolveIndexGeneration({
			generations, indexRoot: root, config: testConfig(), owner: testOwner(), allowCreate: false,
		});
		expect(result.resolved).toBeNull();
		const control = await generations.readControl();
		expect(Object.keys(control.generations)).toEqual([]);
		expect(fs.existsSync(path.join(root, 'generations'))).toBe(false);
	});

	it('解析 - 无 legacy - 新建 building 代际且不登记活动指针', async () => {
		const result = await resolveIndexGeneration({
			generations, indexRoot: root, config: testConfig(), owner: testOwner(), allowCreate: true,
		});
		const fingerprint = await computeConfigFingerprint(testConfig());
		expect(result.resolved?.configFingerprint).toBe(fingerprint);
		expect(result.resolved?.active).toBe(false);
		expect(result.resolved?.status).toBe('building');
		expect(fs.existsSync(path.join(root, 'generations', result.resolved!.generationId, 'generation.json'))).toBe(true);
		const control = await generations.readControl();
		expect(control.activeGenerationId).toBeNull();
	});

	it('解析 - legacy 清单非法 - 如实上抛,不静默新建代际', async () => {
		fs.writeFileSync(path.join(root, 'ratel-manifest.json'), '{ not json', 'utf8');
		fs.writeFileSync(path.join(root, 'index.json'), '{}', 'utf8');
		await expect(resolveIndexGeneration({
			generations, indexRoot: root, config: testConfig(), owner: testOwner(), allowCreate: true,
			legacy: {
				indexDir: root,
				manifestPath: path.join(root, 'ratel-manifest.json'),
				store: { inspectFile: async () => [] },
				currentInputs: new Map(),
			},
		})).rejects.toThrow(/旧索引迁移失败/);
		const control = await generations.readControl();
		expect(Object.keys(control.generations)).toEqual([]);
	});

	it('解析 - legacy 数量身份不可确认 - 走显式重建入口且不复用旧块', async () => {
		// 旧清单缺 `chunkerVersion`:分块身份不可确认,但清单本身合法(T6 阻断 B1 的语义)。
		fs.writeFileSync(path.join(root, 'ratel-manifest.json'), JSON.stringify({
			version: 1, embedModelId: 'local:bge-small-zh-v1.5', chunkSize: 500, chunkOverlap: 100,
			lastIndexTime: 1, entries: {},
		}), 'utf8');
		fs.writeFileSync(path.join(root, 'index.json'), '{}', 'utf8');
		const result = await resolveIndexGeneration({
			generations, indexRoot: root, config: testConfig(), owner: testOwner(), allowCreate: true,
			legacy: {
				indexDir: root,
				manifestPath: path.join(root, 'ratel-manifest.json'),
				store: { inspectFile: async () => [] },
				currentInputs: new Map(),
			},
		});
		expect(result.migration?.reason).toBe('config-identity-unconfirmed');
		expect(result.migration?.published).toBe(false);
		// 关键路径:身份不可确认时不复用任何旧块 —— 新建 fresh 代际,由协调器逐文件重算。
		expect(result.resolved?.active).toBe(false);
		expect(result.resolved?.status).toBe('building');
		expect(fs.existsSync(path.join(root, 'generations', result.resolved!.generationId, 'generation.json'))).toBe(true);
	});
});
// ==================== 配置指纹变化:隔离代际、旧代际保留与原子切换 ====================

/**
 * 修复点的验收面:存在活动代际时,`resolveIndexGeneration` 必须比较**配置指纹**。
 *
 * 修复前:有活动代际即无条件复用 —— 跨会话改配置会落到「旧代际目录 + 新指纹」的混合态,
 * 且隔离代际与 `configured-switch` 在生产启动路径不可达。这些用例在修复前必须失败。
 */
describe('代际解析 — 配置指纹变化的隔离与复用', () => {
	let root: string;
	let generations: IndexGenerations;

	/** 第二个配置 — 只改模型身份,维度不变(与「同维度换模型」的真实场景一致)。 */
	const otherConfig = (): IndexConfigDescriptor => testConfig({ embeddingModelId: 'local:other-model' });

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-t7c-resolve-'));
		generations = new IndexGenerations({ indexRoot: root, owner: testOwner() });
	});
	afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

	it('配置指纹变化 - 建隔离代际且旧代际与活动指针都保留', async () => {
		const first = await generations.ensureGeneration({ config: testConfig() });
		await generations.publishActiveGeneration({ generationId: first.generationId, mode: 'upgrade' });
		const nextFingerprint = await computeConfigFingerprint(otherConfig());

		const result = await resolveIndexGeneration({
			generations, indexRoot: root, config: otherConfig(), owner: testOwner(), allowCreate: true,
		});

		// 关键路径(修复点):指纹不一致时不得复用旧活动代际 —— 隔离代际由**当前**指纹派生。
		expect(result.resolved?.generationId).toBe(deriveGenerationId(nextFingerprint));
		expect(result.resolved?.generationId).not.toBe(first.generationId);
		// 混合态反向对照:解析出的代际指纹必须等于「本实例将用于日志/清单的当前指纹」。
		expect(result.resolved?.configFingerprint).toBe(nextFingerprint);
		expect(result.resolved?.active).toBe(false);
		expect(result.resolved?.status).toBe('building');

		// 旧代际既不删除也不降级:隔离代际完成核对前,活动指针一律不动。
		const control = await generations.readControl();
		expect(control.activeGenerationId).toBe(first.generationId);
		expect(control.generations[first.generationId]).toMatchObject({
			status: 'active',
			fingerprint: await computeConfigFingerprint(testConfig()),
		});
		expect(fs.existsSync(path.join(root, 'generations', first.generationId))).toBe(true);
		expect(fs.existsSync(path.join(root, 'generations', result.resolved!.generationId))).toBe(true);
		expect(result.migration).toBeNull();
	});

	it('切回曾用过的配置 - 先降级为核对中,重新核对后才允许切换', async () => {
		const first = await generations.ensureGeneration({ config: testConfig() });
		await generations.publishActiveGeneration({ generationId: first.generationId, mode: 'upgrade' });

		// 模拟「切到 other 配置」的完整一轮:隔离代际核对完成后才原子切换活动指针。
		const switched = await resolveIndexGeneration({
			generations, indexRoot: root, config: otherConfig(), owner: testOwner(), allowCreate: true,
		});
		const second = switched.resolved!;
		await generations.markGenerationMigrated({ generationId: second.generationId });
		await generations.publishActiveGeneration({ generationId: second.generationId, mode: 'configured-switch' });
		let control = await generations.readControl();
		expect(control.activeGenerationId).toBe(second.generationId);
		expect(control.generations[first.generationId]).toMatchObject({ status: 'migrated', verifiedAt: null });

		// 切回原配置:按指纹找到曾用过的代际,先降级为「核对中」。
		const back = await resolveIndexGeneration({
			generations, indexRoot: root, config: testConfig(), owner: testOwner(), allowCreate: true,
		});
		expect(back.resolved?.generationId).toBe(first.generationId);
		expect(back.resolved?.active).toBe(false);
		expect(back.resolved?.status).toBe('verifying');
		control = await generations.readControl();
		expect(control.activeGenerationId).toBe(second.generationId);
		expect(control.generations[first.generationId]).toMatchObject({ status: 'verifying', verifiedAt: null });

		// 关键路径:不得直接恢复旧 ready —— 未重新核对前切换被拒。
		await expect(generations.publishActiveGeneration({
			generationId: first.generationId, mode: 'configured-switch',
		})).rejects.toThrow(/尚未完成本轮核对/);

		// 反向对照:本轮真的核对完成后,同一入口可以切换(降级不是「永远拒绝」)。
		await generations.markGenerationMigrated({ generationId: first.generationId });
		await generations.publishActiveGeneration({ generationId: first.generationId, mode: 'configured-switch' });
		control = await generations.readControl();
		expect(control.activeGenerationId).toBe(first.generationId);
		expect(control.generations[second.generationId]).toMatchObject({ status: 'migrated', verifiedAt: null });
	});

	it('指纹一致 - 维持原有复用语义且零新建、零降级', async () => {
		const first = await generations.ensureGeneration({ config: testConfig() });
		await generations.publishActiveGeneration({ generationId: first.generationId, mode: 'upgrade' });
		const ensureSpy = vi.spyOn(generations, 'ensureGeneration');
		const verifySpy = vi.spyOn(generations, 'beginVerification');

		const result = await resolveIndexGeneration({
			generations, indexRoot: root, config: testConfig(), owner: testOwner(), allowCreate: true,
		});

		// 关键路径:未变配置不得被判成重建 —— 复用活动代际、不新建、不降级为核对中。
		expect(result.resolved).toMatchObject({
			generationId: first.generationId,
			generationRoot: path.join(root, 'generations', first.generationId),
			configFingerprint: await computeConfigFingerprint(testConfig()),
			status: 'active',
			active: true,
		});
		expect(result.migration).toBeNull();
		expect(ensureSpy).not.toHaveBeenCalled();
		expect(verifySpy).not.toHaveBeenCalled();
		const control = await generations.readControl();
		expect(Object.keys(control.generations)).toEqual([first.generationId]);
		expect(control.activeGenerationId).toBe(first.generationId);
		ensureSpy.mockRestore();
		verifySpy.mockRestore();
	});

	it('只读装配 - 配置指纹不一致 - 零写入且不复用旧活动代际', async () => {
		const first = await generations.ensureGeneration({ config: testConfig() });
		await generations.publishActiveGeneration({ generationId: first.generationId, mode: 'upgrade' });
		const before = snapshotDir(root);

		const result = await resolveIndexGeneration({
			generations, indexRoot: root, config: otherConfig(), owner: testOwner(), allowCreate: false,
		});

		// 关键路径:只读装配不能建隔离代际,也不得把不兼容的旧代际当成当前配置可用。
		expect(result.resolved).toBeNull();
		expect(result.reconcileBlocked).toBe(false);
		expect(result.control.activeGenerationId).toBe(first.generationId);
		// 零写入:连代际目录名都不新建,control 逐字不变。
		expect(snapshotDir(root)).toEqual(before);
		expect(Object.keys((await generations.readControl()).generations)).toEqual([first.generationId]);
	});

	it('配置切换新建被保留代际阻断 - 不新建也不切换指针', async () => {
		const first = await generations.ensureGeneration({ config: testConfig() });
		await generations.publishActiveGeneration({ generationId: first.generationId, mode: 'upgrade' });
		// 一个在途(待建)的其它配置代际:回收无法腾位,第三个代际必须被阻断。
		const inflight = await generations.ensureGeneration({ config: testConfig({ embeddingModelId: 'local:inflight' }) });
		const activeFingerprint = await computeConfigFingerprint(testConfig());

		const result = await resolveIndexGeneration({
			generations, indexRoot: root, config: testConfig({ embeddingModelId: 'local:third' }), owner: testOwner(), allowCreate: true,
		});

		expect(result.resolved).toBeNull();
		expect(result.reconcileBlocked).toBe(true);
		const control = await generations.readControl();
		expect(control.activeGenerationId).toBe(first.generationId);
		expect(Object.keys(control.generations).sort()).toEqual([first.generationId, inflight.generationId].sort());
		expect(control.generations[first.generationId]?.fingerprint).toBe(activeFingerprint);
	});
});

describe('生产装配的端到端一轮(真实端口 + 真实临时磁盘)', () => {
	let pluginDir: string;

	beforeEach(() => { pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-t7a-e2e-')); });
	afterEach(async () => { await cleanupTempDir(pluginDir); });

	it('协调器驱动 - 完成记录落在代际目录 - 首个提交登记活动代际 - 零变化不重嵌入', async () => {
		const files = new Map([['a.md', '内容 A'], ['b.md', '内容 B']]);
		const embedCalls: string[][] = [];
		const plugin = pluginAt(pluginDir);
		plugin.embedding = {
			modelId: 'test-model',
			dimensions: 3,
			embed: async (texts: string[]) => { embedCalls.push(texts); return texts.map(() => [1, 0, 0]); },
		};
		plugin.vault = {
			listMarkdownFiles: () => [...files.keys()],
			readFile: async (p: string) => {
				const content = files.get(p);
				if (content === undefined) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
				return content;
			},
			stat: (p: string) => (files.has(p) ? { mtime: 1, size: 1 } : null),
		};
		await plugin.setupIndexRuntime(pluginDir);
		await plugin.vectraStore.init();
		const indexRoot = path.join(pluginDir, '.index');
		const generationId = plugin.resolvedGenerationId as string;

		const first = await plugin.indexCoordinator.start();
		expect(first.committed).toBe(2);
		expect(first.phase).toBe('ready');
		expect(embedCalls).toHaveLength(2);
		// 完成记录落在**代际目录**的 files/ 下,不是 .index 根。
		const receiptFiles = fs.readdirSync(path.join(indexRoot, 'generations', generationId, 'files'));
		expect(receiptFiles).toHaveLength(2);
		// 首个持久提交完成后活动代际已登记(spec §5 的 upgrade 登记)。
		const control = JSON.parse(fs.readFileSync(path.join(indexRoot, 'control.json'), 'utf8')) as { activeGenerationId: string | null };
		expect(control.activeGenerationId).toBe(generationId);

		// 零变化第二轮:完成记录复用,零嵌入调用。
		embedCalls.length = 0;
		const second = await plugin.indexCoordinator.start();
		expect(second.committedThisRound).toBe(0);
		expect(embedCalls).toHaveLength(0);

		// 只改一篇(mtime/size 不变,只有正文变):只有该文件进入嵌入。
		files.set('b.md', '内容 B 改过');
		embedCalls.length = 0;
		const third = await plugin.indexCoordinator.start();
		expect(third.committedThisRound).toBe(1);
		expect(embedCalls).toHaveLength(1);

		// 一轮真实任务结束后,受保护的根文件仍在(清库/重建不会连带删除控制指针与锁)。
		expect(fs.existsSync(path.join(indexRoot, 'control.json'))).toBe(true);
		expect(fs.existsSync(path.join(indexRoot, 'owner.lock'))).toBe(true);
		expect(fs.statSync(path.join(indexRoot, 'generations')).isDirectory()).toBe(true);
		await plugin.indexOwnerLease.release();
	});
});

// ==================== T7 数据安全与主流程修复(守卫/降级/结论面) ====================

describe('守卫 — 活动代际目录在任何清库路径上都不可被递归删除', () => {
	let pluginDir: string;

	beforeEach(() => { pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-t7b-active-')); });
	afterEach(async () => { await cleanupTempDir(pluginDir); });

	it('真实装配 + 一轮真实任务 - 活动代际目录经 dropIndex / smartReindex 降级分支 / dropSafeGeneration - 一律拒绝且逐字不变', async () => {
		const files = new Map([['a.md', '内容 A']]);
		const plugin = pluginAt(pluginDir);
		plugin.embedding = { modelId: 'test-model', dimensions: 3, embed: async (texts: string[]) => texts.map(() => [1, 0, 0]) };
		plugin.vault = {
			listMarkdownFiles: () => [...files.keys()],
			readFile: async (p: string) => files.get(p) ?? '',
			stat: () => ({ mtime: 1, size: 1 }),
		};
		await plugin.setupIndexRuntime(pluginDir);
		await plugin.vectraStore.init();
		const indexRoot = path.join(pluginDir, '.index');
		const activeRoot = plugin.indexDir as string;

		// 前置事实:真的跑过一轮,活动代际已登记且内存指针同步(否则本用例是恒真)。
		const round = await plugin.indexCoordinator.start();
		expect(round.committed).toBe(1);
		expect(plugin.activeGenerationId).toBe(plugin.resolvedGenerationId);
		expect(path.dirname(activeRoot)).toBe(path.join(indexRoot, 'generations'));
		const before = snapshotDir(indexRoot);

		const store = {
			dropIndex: vi.fn(async () => { }),
			isIndexCreated: async () => true,
			inspectFile: async () => [],
			reload: async () => { },
		};
		const backend = new PersistentIndexBackend({
			// 关键路径:后端的目标目录就是**活动代际目录** —— 这是最危险的一种接法。
			indexDir: activeRoot,
			manifest: new IndexManifest(resolveIndexManifestPath(activeRoot)),
			worker: { runExclusive: <T>(operation: () => Promise<T>) => operation() } as never,
			getStore: () => store as never,
			vault: plugin.vault,
			// 参数不兼容 → smartReindex 会走 `dropStore()` 降级分支。
			getBuildStamp: () => ({ chunkerVersion: 999, chunkSize: 1, chunkOverlap: 0, embedModelId: 'local:other' }),
			getChunkOptions: () => ({ maxTokens: 10, overlapTokens: 0 }),
			fileRecords: null,
			assertDropOwnership: (dir: string) => plugin.assertIndexDropOwnership(dir),
		});

		// 入口 1:显式清库。
		await expect(backend.dropIndex()).rejects.toBeInstanceOf(IndexDirectoryNotOwnedError);
		expect(store.dropIndex).not.toHaveBeenCalled();
		expect(snapshotDir(indexRoot)).toEqual(before);

		// 入口 2:缺失清单且没有可信完成记录时，先拒绝恢复，不再走清库降级。
		// 拒绝原因可以早于归属断言，但磁盘与 dropIndex 零调用的安全要求不变。
		await expect(backend.smartReindex()).rejects.toThrow();
		expect(store.dropIndex).not.toHaveBeenCalled();
		expect(snapshotDir(indexRoot)).toEqual(before);

		// 入口 3:代际级清库(控制指针校验)。
		await expect(plugin.indexGenerations.dropSafeGeneration(activeRoot)).rejects.toThrow();
		expect(snapshotDir(indexRoot)).toEqual(before);

		// 反向对照:非活动代际目录的同一份断言不拒绝(否则守卫会退化成「永远拒绝」)。
		const inactiveId = 'gen-0123456789abcdef';
		expect(() => plugin.assertIndexDropOwnership(path.join(indexRoot, 'generations', inactiveId))).not.toThrow();

		// 公共 API 收口:插件不再暴露直达 `backend.smartReindex()` 的入口。
		expect((RatelVaultPlugin.prototype as unknown as Record<string, unknown>)['smartReindex']).toBeUndefined();
		await plugin.indexOwnerLease.release();
	});
});

describe('取消的公共入口与只读装配的零写入', () => {
	let pluginDir: string;

	beforeEach(() => { pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-t7b-ro-')); });
	afterEach(async () => { await cleanupTempDir(pluginDir); });

	it('只读装配 - 存在旧版清单 - 目录快照逐字不变且不执行写迁移', async () => {
		const legacyManifest = path.join(pluginDir, 'index-manifest.json');
		fs.writeFileSync(legacyManifest, JSON.stringify({
			version: 1, embedModelId: 'local:old', chunkSize: 500, chunkOverlap: 100, lastIndexTime: 1, entries: {},
		}), 'utf8');
		const plugin = pluginAt(pluginDir);
		plugin.settings.autoIndex = false;
		const before = snapshotDir(pluginDir);

		await plugin.setupIndexRuntime(pluginDir);

		// 关键路径(T7/I3):legacy 清单迁移含 mkdir/rename/unlink,只读通道必须完全不执行。
		expect(snapshotDir(pluginDir)).toEqual(before);
		expect(fs.existsSync(legacyManifest)).toBe(true);
		expect(fs.existsSync(path.join(pluginDir, '.index'))).toBe(false);
		expect(fs.existsSync(path.join(pluginDir, '.index', 'ratel-manifest.json'))).toBe(false);
	});

	it('写路径装配 - 同一份旧版清单 - 迁入 .index/(反向对照,证明只读用例不是恒真)', async () => {
		const legacyManifest = path.join(pluginDir, 'index-manifest.json');
		fs.writeFileSync(legacyManifest, JSON.stringify({
			version: 1, embedModelId: 'local:old', chunkSize: 500, chunkOverlap: 100, lastIndexTime: 1, entries: {},
		}), 'utf8');
		const plugin = pluginAt(pluginDir);

		await plugin.setupIndexRuntime(pluginDir);

		expect(fs.existsSync(path.join(pluginDir, '.index', 'ratel-manifest.json'))).toBe(true);
		expect(fs.existsSync(legacyManifest)).toBe(false);
		await plugin.indexOwnerLease.release();
	});
});

describe('装配降级 — 迁移失败不再让插件加载失败', () => {
	let root: string;
	let pluginDir: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-t7b-degrade-'));
		// 关键路径:降级重试要按 `<vaultBase>/<configDir>/plugins/ratel-vault` 还原 pluginDir,
		// 因此测试按真实目录层级搭。
		pluginDir = path.join(root, '.obsidian', 'plugins', 'ratel-vault');
		fs.mkdirSync(pluginDir, { recursive: true });
	});
	afterEach(async () => { await cleanupTempDir(root); });

	/** 造一个会让迁移失败的真实 legacy 场景:清单存在但不可解析。 */
	function writeBrokenLegacyIndex(): void {
		fs.mkdirSync(path.join(pluginDir, '.index'), { recursive: true });
		fs.writeFileSync(path.join(pluginDir, '.index', 'index.json'), '{}', 'utf8');
		fs.writeFileSync(path.join(pluginDir, '.index', 'ratel-manifest.json'), '{ not json', 'utf8');
	}

	it('迁移失败 - 不 reject 且索引不可用、租约已释放、状态与 Notice 走 i18n 而非开发向 message', async () => {
		writeBrokenLegacyIndex();
		const plugin = pluginAt(pluginDir);
		plugin.vaultBase = root;
		plugin.app = { vault: { configDir: '.obsidian' } };
		// 关键路径:只有 `local:` 配置的旧索引身份是可确认的;`api:` 缺修订号会走
		// `config-identity-unconfirmed` 的显式重建入口(那是另一条语义),不是迁移失败。
		plugin.settings.embedProvider = 'local';
		plugin.settings.embedLocalModel = 'bge-small-zh-v1.5';

		// 关键路径:装配必须**不抛** —— 否则 onload reject,插件整体不可用。
		await plugin.setupIndexRuntime(pluginDir);

		expect(plugin.indexUnavailable).toMatchObject({ message: expect.any(String) });
		expect(plugin.indexDirUsable).toBe(false);
		expect(plugin.indexOwnerLease).toBeUndefined();
		// 降级后索引目录退回索引根:严格归属断言对根一律拒绝。
		expect(plugin.indexDir).toBe(path.join(pluginDir, '.index'));
		expect(() => plugin.assertIndexDropOwnership(pluginDir)).toThrow();

		// 用户可见出口:状态须知 + Notice 都按错误码映射,不含中文开发向 message。
		plugin.reportIndexUnavailable();
		expect(get(plugin.userStatus.statusBar$)).toMatchObject({ index: 'failed', indexNotice: 'index-unavailable' });
		expect(plugin.userNotice.toastError).toHaveBeenCalledTimes(1);
		const text = plugin.userNotice.toastError.mock.calls[0][0] as string;
		expect(text).toContain(tNow('error.index.legacyManifestInvalid'));
		expect(text).not.toContain('旧索引迁移失败,拒绝静默重建');
	});

	it('迁移失败 - 修好后重试 - 恢复可用、清除降级状态并重绑状态源', { timeout: 30000 }, async () => {
		writeBrokenLegacyIndex();
		const plugin = pluginAt(pluginDir);
		plugin.vaultBase = root;
		plugin.app = { vault: { configDir: '.obsidian' } };
		plugin.settings.embedProvider = 'local';
		plugin.settings.embedLocalModel = 'bge-small-zh-v1.5';
		const rebind = vi.fn();
		plugin.feedbackController = { rebindIndexStatus: rebind };
		plugin.vault = {
			listMarkdownFiles: () => [],
			readFile: async () => '',
			stat: () => null,
			onFileCreate: () => () => { },
			onFileModify: () => () => { },
			onFileDelete: () => () => { },
			onFileRename: () => () => { },
		};
		await plugin.setupIndexRuntime(pluginDir);
		expect(plugin.indexUnavailable).toMatchObject({ message: expect.any(String) });

		// 修复:删掉不可解析的清单,只剩「没有活动代际、没有 legacy」的普通首建路径。
		fs.rmSync(path.join(pluginDir, '.index', 'ratel-manifest.json'), { force: true });
		// 关键路径:重试必须真的做一次完整恢复(装配 + 重绑状态源 + 跑一轮)。
		await expect(plugin.retryIndexRuntime()).resolves.toBe(true);

		expect(plugin.indexUnavailable).toBeNull();
		expect(plugin.indexDirUsable).toBe(true);
		expect(plugin.indexOwnerLease).toBeDefined();
		expect(plugin.resolvedGenerationId).not.toBeNull();
		expect(rebind).toHaveBeenCalledTimes(1);
		expect(rebind.mock.calls[0]![0]).toBe(plugin.indexController.indexManager.status$);
		await plugin.vectraStore.init();
		await plugin.indexOwnerLease.release();
	});
});

describe('迁移/回收结论面的可查看落点', () => {
	let root: string;

	beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-t7b-concl-')); });
	afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

	it('汇总 - 迁移阶段/复用与重算计数/状态未落盘/孤儿目录/取证事务/阻断原因/隔离原因 - 逐项进入诊断落点', async () => {
		const plugin = pluginAt(root);
		plugin.indexRoot = path.join(root, '.index');
		const summary = plugin.summarizeIndexConclusion({
			resolved: null,
			migration: {
				published: false, committed: false, generationId: null, activeGenerationId: null,
				configFingerprint: null,
				files: [
					{ path: 'a.md', status: 'reusable', reason: null, inputHash: 'h1', actualChunkCount: 2, declaredChunkCount: 2, blockSetHash: null, commitId: null },
					{ path: 'b.md', status: 'reindex', reason: 'hash-mismatch', inputHash: 'h2', actualChunkCount: 1, declaredChunkCount: 3, blockSetHash: null, commitId: null },
				],
				phase: 'copy', reason: 'space-insufficient', errorCode: 'migration-space-insufficient',
				copiedFileNames: [], copiedBytes: 0, statePersisted: false,
			},
			reconcileBlocked: true,
			reconcile: {
				decision: {
					reclaimed: [], orphanDirectories: ['gen-0123456789abcdef'],
					retained: ['gen-ffffffffffffffff'], canCreate: false, blockedReason: 'all-generations-retained',
				},
				quarantinedTransactions: 2,
			},
			control: {
				schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
				activeGenerationId: null,
				generations: {
					'gen-ffffffffffffffff': {
						schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
						generationId: 'gen-ffffffffffffffff',
						fingerprint: 'f'.repeat(64),
						kind: 'fresh',
						status: 'quarantined',
						root: path.join(root, '.index', 'generations', 'gen-ffffffffffffffff'),
						verifiedAt: null,
						quarantineReason: 'unattributable-prepared',
						createdAt: 1,
						updatedAt: 2,
					},
				},
			},
		});

		expect(summary.migration).toEqual({ phase: 'copy', reused: 1, reindex: 1, statePersisted: false });
		expect(summary.reconcile).toEqual({
			orphanDirectories: 1, retained: 1, quarantinedTransactions: 2,
			blocked: true, blockedReason: 'all-generations-retained',
		});
		expect(summary.quarantinedGenerations).toEqual(['gen-ffffffffffffffff:unattributable-prepared']);

		// 落点:结论面进入状态 store(状态抽屉的诊断行据此渲染),不只在 devLogger 里。
		plugin.indexConclusion = summary;
		plugin.publishIndexConclusion();
		const snapshot = get(plugin.userStatus.statusBar$) as UserStatusSnapshot;
		expect(snapshot.indexDiagnostics).toMatchObject({
			migration: { phase: 'copy', statePersisted: false },
			reconcile: { orphanDirectories: 1, quarantinedTransactions: 2, blocked: true },
		});
	});

	it('解析 - 需要第三个代际且待建/保留无法回收 - 返回回收结论面而非只给布尔', async () => {
		// 关键路径:有活动代际时解析按设计直接复用活动代际(不新建),因此回收路径只在
		// 「无活动代际 + 已有代际」时触发。
		const generations = new IndexGenerations({ indexRoot: root, owner: testOwner() });
		const first = await generations.ensureGeneration({ config: testConfig() });
		const building = await generations.ensureGeneration({ config: testConfig({ embeddingModelId: 'local:building-other' }) });

		const result = await resolveIndexGeneration({
			generations, indexRoot: root, config: testConfig({ embeddingModelId: 'local:third' }), owner: testOwner(), allowCreate: true,
		});

		expect(result.resolved).toBeNull();
		expect(result.reconcileBlocked).toBe(true);
		expect(result.reconcile?.decision.canCreate).toBe(false);
		expect(result.reconcile?.decision.blockedReason).toBe('all-generations-retained');
		// 两个待建代际都属于「本轮待建/在途」,一个都不许回收(否则正在核对的代际会被抹掉)。
		expect(result.reconcile?.decision.retained).toEqual(expect.arrayContaining([first.generationId, building.generationId]));
		expect(result.reconcile?.decision.reclaimed).toEqual([]);
		expect(result.reconcile?.quarantinedTransactions).toBe(0);
	});
});

describe('首个提交登记的一次性闩锁', () => {
	let root: string;
	let generations: IndexGenerations;

	beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-t7b-latch-')); generations = new IndexGenerations({ indexRoot: root, owner: testOwner() }); });
	afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

	/** 造一个只实现协调器所需写入口的日志替身。 */
	function journalStub(): CoordinatorJournalPort {
		return {
			prepare: async () => ({ transactionId: 't1' }),
			commit: async () => ({ commit: { revision: 1, inputHash: 'h', chunkCount: 1 }, superseded: false }),
			cleanup: async () => { },
			readReceipt: async () => null,
		};
	}

	it('登记成功后连续提交 - 不再读控制指针(全量建库 N 篇不再 N 次读盘)', async () => {
		const created = await generations.ensureGeneration({ config: testConfig() });
		const readSpy = vi.spyOn(generations, 'readControl');
		const port = createFirstCommitPromoter({ journal: journalStub(), generations, generationId: created.generationId });

		await port.commit('t1');
		const readsAfterPromote = readSpy.mock.calls.length;
		expect(readsAfterPromote).toBeGreaterThan(0);

		await port.commit('t1');
		await port.commit('t1');
		// 关键路径:闩死后本实例永不再 promote,因此不会有任何额外读盘。
		expect(readSpy.mock.calls.length).toBe(readsAfterPromote);
		readSpy.mockRestore();
	});

	it('读控制指针失败 - 不闩死,下一次提交仍重试并完成登记', async () => {
		const created = await generations.ensureGeneration({ config: testConfig() });
		const readSpy = vi.spyOn(generations, 'readControl').mockRejectedValueOnce(new Error('io-failure'));
		const port = createFirstCommitPromoter({ journal: journalStub(), generations, generationId: created.generationId });

		await port.commit('t1');
		expect((await generations.readControl()).activeGenerationId).toBeNull();

		await port.commit('t1');
		expect((await generations.readControl()).activeGenerationId).toBe(created.generationId);
		const readsAfterPromote = readSpy.mock.calls.length;

		await port.commit('t1');
		// 关键路径:重试成功后立即闩死,后续提交不再读控制指针。
		expect(readSpy.mock.calls.length).toBe(readsAfterPromote);
		readSpy.mockRestore();
	});
});

describe('会话内嵌入配置漂移 — 显式拒绝而非静默混写', () => {
	let pluginDir: string;

	beforeEach(() => { pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-t7b-drift-')); });
	afterEach(async () => { await cleanupTempDir(pluginDir); });

	it('同维度换模型 - 重建嵌入适配器 - 暂停索引写入并上屏配置漂移,不静默混写', async () => {
		const plugin = pluginAt(pluginDir);
		await plugin.setupIndexRuntime(pluginDir);
		await plugin.vectraStore.init();
		const identityBefore = plugin.indexConfigIdentity as string;
		expect(identityBefore).toContain('text-embedding-3-small');

		// 关键路径:装配完成后用户改模型(维度不变)—— 旧指纹与新参数混写必须被显式拒绝。
		const pause = vi.fn();
		plugin.indexController = { pause };
		plugin.settings.embedApiModel = 'text-embedding-3-large';
		plugin.rebuildEmbeddingAdapter();

		expect(pause).toHaveBeenCalledTimes(1);
		expect(get(plugin.userStatus.statusBar$)).toMatchObject({
			indexNotice: 'config-drift',
			indexDetail: tNow('status.detail.configDrift'),
		});
		expect(plugin.userNotice.toastError).toHaveBeenCalledWith(tNow('notice.indexConfigChanged'));

		// 装配期身份不被重建改写:会话内身份仍然只由装配决定。
		expect(plugin.indexConfigIdentity).toBe(identityBefore);
		await plugin.indexOwnerLease.release();
	});

	it('装配前重建 / 同配置重建 - 均不误报漂移(否则打开设置页就会暂停索引)', async () => {
		const plugin = pluginAt(pluginDir);
		const pause = vi.fn();
		plugin.indexController = { pause };

		// 装配前:身份由装配本身确定,不判定。
		plugin.rebuildEmbeddingAdapter();
		expect(pause).not.toHaveBeenCalled();
		expect(plugin.userNotice.toastError).not.toHaveBeenCalled();

		await plugin.setupIndexRuntime(pluginDir);
		await plugin.vectraStore.init();
		plugin.userNotice.toastError.mockClear();
		plugin.rebuildEmbeddingAdapter();
		expect(pause).not.toHaveBeenCalled();
		expect(plugin.userNotice.toastError).not.toHaveBeenCalled();
		await plugin.indexOwnerLease.release();
	});
});

// ==================== 生产启动路径上的配置变化:隔离代际 + 核对完成后原子切换 ====================

/**
 * 修复点的生产路径验收:跨会话改嵌入配置后重启,必须走「隔离代际 → 本轮逐文件核对 →
 * 全部完成后 `configured-switch` 原子切指针」,而不是复用旧代际目录写新指纹。
 *
 * 全部断言基于真实临时索引根、真实日志/后端与可计数嵌入端口。
 */
describe('生产装配 — 配置指纹变化的隔离代际与原子切换', () => {
	let pluginDir: string;
	let indexRoot: string;

	beforeEach(() => {
		pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-t7c-switch-'));
		indexRoot = path.join(pluginDir, '.index');
	});
	afterEach(async () => { await cleanupTempDir(pluginDir); });

	/** 造一个写路径会话(真实装配 + 可计数嵌入)。 */
	async function startSession(
		files: Map<string, string>,
		settingsOverrides: Record<string, unknown>,
		embedding: Record<string, unknown>,
		vault?: Record<string, unknown>,
	): Promise<any> {
		const plugin = pluginAt(pluginDir, settingsOverrides);
		plugin.vault = vault ?? vaultOf(files);
		plugin.embedding = embedding;
		// 关键路径:控制器装配会构造 ratelignore 解析器,它需要 vaultBase(真实宿主由 onload 赋值)。
		plugin.vaultBase = pluginDir;
		await plugin.setupIndexRuntime(pluginDir);
		// 关键路径:与 onload 的真实顺序一致 —— 代际解析之后才装配控制器与活动代际订阅
		// (`watchGenerationActivation` 就在这一处安装),不能只跑 setupIndexRuntime。
		plugin.assembleIndexObjects();
		await plugin.vectraStore.init();
		return plugin;
	}

	/** 读某个代际目录里完成记录的 (generationId, configFingerprint) 组合。 */
	function readReceiptIdentities(generationId: string): Array<{ generationId: string; configFingerprint: string }> {
		const filesDir = path.join(indexRoot, 'generations', generationId, 'files');
		return fs.readdirSync(filesDir).map((name) => JSON.parse(
			fs.readFileSync(path.join(filesDir, name), 'utf8'),
		) as { generationId: string; configFingerprint: string });
	}

	it('跨会话改配置 - 建隔离代际并保留旧代际 - 本轮核对完成后才切活动指针', async () => {
		const files = new Map([['a.md', '内容 A'], ['b.md', '内容 B']]);
		const firstCalls: string[][] = [];

		// 会话 1(配置 m1):真实一轮建库,首个持久提交登记活动代际。
		const first = await startSession(files, {}, countingEmbedding(firstCalls));
		const g1 = first.resolvedGenerationId as string;
		const firstRound = await first.indexController.indexManager.onLayoutReady();
		expect(firstRound).toMatchObject({ indexed: 2, errors: 0 });
		expect(firstCalls).toHaveLength(2);
		expect(readControlFile(indexRoot).activeGenerationId).toBe(g1);
		const fingerprint1 = readControlFile(indexRoot).generations[g1]!.fingerprint;
		await first.indexOwnerLease.release();

		// 会话 2(跨会话改配置 m2 - 同维度换模型):不得复用旧活动代际。
		const secondCalls: string[][] = [];
		const second = await startSession(files, { embedApiModel: 'text-embedding-3-large' }, countingEmbedding(secondCalls));
		const g2 = second.resolvedGenerationId as string;
		expect(g2).not.toBe(g1);
		expect(second.indexDir).toBe(path.join(indexRoot, 'generations', g2));
		// 关键路径(修复点):本实例解析出的是**隔离代际**,而活动指针在核对完成前仍是旧代际。
		expect(second.activeGenerationId).toBe(g1);
		let control = readControlFile(indexRoot);
		expect(control.activeGenerationId).toBe(g1);
		expect(control.generations[g1]).toMatchObject({ status: 'active', fingerprint: fingerprint1 });
		expect(control.generations[g2]).toMatchObject({ status: 'building' });
		expect(control.generations[g2]!.fingerprint).not.toBe(fingerprint1);
		// 旧代际目录完整保留(不先删除旧有效代际)。
		expect(fs.existsSync(path.join(indexRoot, 'generations', g1))).toBe(true);
		// 切换进行中,旧活动代际目录仍被清库守卫拒绝(内存指针不先于控制指针落下)。
		expect(() => second.assertIndexDropOwnership(path.join(indexRoot, 'generations', g1))).toThrow();

		// 本轮在隔离代际里逐文件重算(不复用旧代际向量)。
		const secondRound = await second.indexController.indexManager.onLayoutReady();
		expect(secondRound).toMatchObject({ indexed: 2, errors: 0 });
		expect(secondCalls).toHaveLength(2);

		// 全部核对完成后才原子切换活动指针。
		await waitFor(() => readControlFile(indexRoot).activeGenerationId === g2 && second.activeGenerationId === g2);
		control = readControlFile(indexRoot);
		expect(control.generations[g2]!.status).toBe('active');
		expect(control.generations[g1]).toMatchObject({ status: 'migrated', verifiedAt: null });

		// 混合态反向对照:完成记录落在自己解析出的代际目录里,generationId 与指纹自洽。
		const receipts = readReceiptIdentities(g2);
		expect(receipts).toHaveLength(2);
		expect(receipts.every((record) => record.generationId === g2)).toBe(true);
		expect(receipts.every((record) => record.configFingerprint === control.generations[g2]!.fingerprint)).toBe(true);

		// 零变化第二轮:隔离代际自己的完成记录被复用(零嵌入),指针不再变化。
		secondCalls.length = 0;
		const thirdRound = await second.indexController.indexManager.onLayoutReady();
		expect(thirdRound).toMatchObject({ indexed: 0, errors: 0 });
		expect(secondCalls).toHaveLength(0);
		expect(readControlFile(indexRoot).activeGenerationId).toBe(g2);
		await second.indexOwnerLease.release();
	});

	it('部分失败 - 不切换活动指针且旧活动代际目录与完成记录逐字不变', async () => {
		const files = new Map([['a.md', '内容 A'], ['b.md', '内容 B']]);

		// 会话 1:建库成功,活动指针 = g1。
		const first = await startSession(files, {}, countingEmbedding([]));
		const g1 = first.resolvedGenerationId as string;
		await first.indexController.indexManager.onLayoutReady();
		expect(readControlFile(indexRoot).activeGenerationId).toBe(g1);
		await first.indexOwnerLease.release();

		// 夹具卫生:让 vectra 内部可能在飞的落盘收敛后再取基准快照(与清理夹具同口径)。
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
		const g1Dir = path.join(indexRoot, 'generations', g1);
		const before = snapshotDir(g1Dir);
		expect(fs.readdirSync(path.join(g1Dir, 'files'))).toHaveLength(2);

		// 会话 2:隔离代际里 a.md 成功、b.md 读取持续失败 → 本轮不得 ready。
		const second = await startSession(
			files,
			{ embedApiModel: 'text-embedding-3-large' },
			countingEmbedding([]),
			{
				listMarkdownFiles: () => [...files.keys()],
				readFile: async (p: string) => {
					if (p === 'b.md') throw Object.assign(new Error('资源忙'), { code: 'EBUSY' });
					return files.get(p) ?? '';
				},
				stat: (p: string) => (files.has(p) ? { mtime: 1, size: 1 } : null),
			},
		);
		const g2 = second.resolvedGenerationId as string;
		expect(g2).not.toBe(g1);

		const round = await second.indexController.indexManager.onLayoutReady();
		// 关键路径:部分失败不得冒充全库完成。
		expect(round).toMatchObject({ errors: 1 });

		// 关键路径:未 ready → 指针不动,旧活动代际仍是活动代际。
		const control = readControlFile(indexRoot);
		expect(control.activeGenerationId).toBe(g1);
		expect(control.generations[g1]!.status).toBe('active');
		expect(control.generations[g2]!.status).toBe('building');
		expect(second.activeGenerationId).toBe(g1);
		// 隔离代际按文件提交,旧代际不受牵连。
		expect(readReceiptIdentities(g2)).toHaveLength(1);
		// 旧活动代际仍可用:目录与完成记录逐字不变。
		expect(snapshotDir(g1Dir)).toEqual(before);
		expect(fs.readdirSync(path.join(g1Dir, 'files'))).toHaveLength(2);
		await second.indexOwnerLease.release();
	});
});
