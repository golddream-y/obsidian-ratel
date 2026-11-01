/**
 * @file tests/core/index-task-coordinator.test.ts
 * @description 流式扫描、变更队列与文件新鲜度 — 事件时序、提交语义、读失败与重启复用
 * @module tests/core/index-task-coordinator
 * @depends core/index-task-coordinator, core/index-file-journal, adapters/atomic-index-storage,
 *   adapters/vector-vectra, helpers/index-reliability-fixture
 *
 * 关键路径:
 * - 所有用例都在系统临时目录上跑**真实磁盘**:完成记录、prepared 事务与块集合都重新读盘核对,
 *   不用同一实例的内存状态冒充重启。
 * - 嵌入端口是可计数的:验收「再次启动仅修改一篇文件时只有该文件进入嵌入调用」直接断言调用路径,
 *   不只检查状态字符串。
 * - 收敛用例不依赖 `resume()`:瞬时读失败耗尽重试后,新事件与新一轮 `start()` 都必须让同一实例回到 ready;
 *   队列上界触发时终态不得是 ready,溢出路径必须被收敛循环回收。
 * - 日志只读信号(路径状态 / 代际隔离 / 删除凭据)在用例里以端口叠加方式注入,协调器口径必须 deny;
 *   记忆回收用同一个实例连续创建/删除临时文件来观测 `total` 不随历史路径数增长。
 * - 分块与向量是确定性的,不访问网络、不读写真实 Vault。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AtomicIndexStorage } from '../../src/adapters/atomic-index-storage';
import type { FileReplaceStore, PreparedBlock } from '../../src/adapters/vector-vectra';
import {
	IndexFileJournal,
	type JournalWriteOwner,
} from '../../src/core/index-file-journal';
import {
	IndexTaskCoordinator,
	canMarkReady,
	type CoordinatorBlock,
	type CoordinatorEventOp,
	type CoordinatorJournalPort,
	type CoordinatorProcessorPort,
	type CoordinatorVaultPort,
	type IndexTaskCoordinatorOptions,
} from '../../src/core/index-task-coordinator';
import { sha256 } from '../../src/utils/hash';
import { deterministicVector } from '../helpers/index-reliability-fixture';

// ==================== 夹具 ====================

const DIMENSIONS = 8;
const GENERATION_ID = 'gen-t4';
const CONFIG_FINGERPRINT = 'c'.repeat(64);
const temporaryRoots: string[] = [];

/** 确认性分块 — 空内容得到零块。 */
function chunk(content: string): string[] {
	return content.length === 0 ? [] : content.split('\n').filter((line) => line.length > 0);
}

/** 带 errno 的错误。 */
function errnoError(code: string, message: string): Error {
	const error = new Error(message) as Error & { code: string };
	error.code = code;
	return error;
}

/** 手动可释放的等待门。 */
function deferred(): { promise: Promise<void>; release: () => void } {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
}

/** 建一个临时根目录,测试结束统一清理。 */
async function makeTempRoot(): Promise<string> {
	const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ratel-t4-coordinator-'));
	temporaryRoots.push(root);
	return root;
}

afterEach(async () => {
	for (const root of temporaryRoots.splice(0)) {
		await fsp.rm(root, { recursive: true, force: true });
	}
});

/** 可控制读失败与读时序的合成 Vault — 不访问真实 Vault。 */
class MutableVault implements CoordinatorVaultPort {
	readonly files = new Map<string, string>();
	readonly mtimes = new Map<string, number>();
	readonly failures = new Map<string, Error>();
	/** 读取并发峰值观测。 */
	peakReads = 0;
	private activeReads = 0;
	private delay: ((path: string) => Promise<void>) | null = null;

	constructor(private readonly pathList: string[] = []) {}

	listMarkdownFiles(): string[] {
		const enumerated = this.pathList.length > 0 ? [...this.pathList] : [...this.files.keys()];
		return enumerated.filter((filePath) => this.files.has(filePath));
	}

	/** 替换「枚举清单」 — 用于多轮创建/删除后观察记忆回收与 total 口径。 */
	setPathList(pathList: string[]): void {
		this.pathList.length = 0;
		this.pathList.push(...pathList);
	}

	async readFile(filePath: string): Promise<string> {
		this.activeReads += 1;
		this.peakReads = Math.max(this.peakReads, this.activeReads);
		try {
			if (this.delay !== null) await this.delay(filePath);
			const failure = this.failures.get(filePath);
			if (failure !== undefined) throw failure;
			const content = this.files.get(filePath);
			if (content === undefined) throw errnoError('ENOENT', `文件不存在:${filePath}`);
			return content;
		}
		finally {
			this.activeReads -= 1;
		}
	}

	stat(filePath: string): { mtime: number; size: number } | null {
		const content = this.files.get(filePath);
		if (content === undefined) return null;
		return { mtime: this.mtimes.get(filePath) ?? 0, size: content.length };
	}

	/** 写入/覆盖内容;`touchMtime=false` 用于「mtime/size 不变但正文变化」。 */
	write(filePath: string, content: string, touchMtime = true): void {
		const previous = this.files.get(filePath);
		this.files.set(filePath, content);
		if (touchMtime || previous === undefined) this.mtimes.set(filePath, 1_000 + this.files.size);
	}

	/** 改内容但保持 mtime 与 size — 只凭时间戳无法发现的变化。 */
	modifyWithoutTouch(filePath: string, content: string): void {
		this.write(filePath, content, false);
	}

	remove(filePath: string): void {
		this.files.delete(filePath);
		this.mtimes.delete(filePath);
	}

	setDelay(delay: ((path: string) => Promise<void>) | null): void {
		this.delay = delay;
	}
}

/** 落盘的文件级替换存储替身 — 真实持久化,重启后 `inspectFile` 仍能看到旧块。 */
class DiskFileReplaceStore implements FileReplaceStore {
	/** 每次替换的目标路径,按调用顺序。 */
	readonly replacedPaths: string[] = [];

	constructor(private readonly root: string) {}

	async replaceFile(input: { path: string; commitId: string; blocks: PreparedBlock[] }): Promise<void> {
		await fsp.mkdir(this.root, { recursive: true });
		await fsp.writeFile(this.blocksPath(input.path), JSON.stringify(input.blocks), 'utf8');
		this.replacedPaths.push(input.path);
	}

	async inspectFile(filePath: string): Promise<PreparedBlock[]> {
		try {
			return JSON.parse(await fsp.readFile(this.blocksPath(filePath), 'utf8')) as PreparedBlock[];
		}
		catch {
			return [];
		}
	}

	async reload(): Promise<void> {
		// 落盘替身没有可丢弃的内存视图,重载是空操作。
	}

	/** 该路径当前块集合(直接读盘)。 */
	async blocksOf(filePath: string): Promise<PreparedBlock[]> {
		return this.inspectFile(filePath);
	}

	private blocksPath(filePath: string): string {
		return path.join(this.root, `${Buffer.from(filePath).toString('hex')}.json`);
	}
}

/** 可观测的写所有权门面替身 — 与 `IndexWriteOwner` 结构兼容。 */
class TestOwner implements JournalWriteOwner {
	epoch = 1;

	assertWritable(): void {
		if (this.epoch < 1) throw new Error('epoch 已被新实例接管(测试注入)');
	}

	beginCommit(): { settle(): void } {
		return { settle: () => undefined };
	}
}

/** 一次启动装配;对同一目录再次 `newCoordinator()` 即为进程重启。 */
interface Harness {
	readonly dir: string;
	readonly vault: MutableVault;
	readonly store: DiskFileReplaceStore;
	readonly journal: IndexFileJournal;
	/** 可复用的日志端口 — 用例可在其上叠加只读信号。 */
	readonly port: CoordinatorJournalPort;
	/** 嵌入端口调用过的路径,按调用顺序。 */
	readonly embeddedPaths: string[];
	/** 嵌入端口看到的 (路径, 内容),按调用顺序 — 用于断言提交内容不是过期快照。 */
	readonly embeddedInputs: Array<{ path: string; content: string }>;
	/** 准备/提交临界区观测:峰值深度与进入临界区时协调器报告的在途提交数。 */
	readonly critical: { peak: number; activeSamples: number[] };
	/** 已落 prepared 事务的 (path, operation)。 */
	readonly preparedOperations: Array<{ path: string; operation: 'replace' | 'delete' }>;
	/** 每次 commit 落定的 (path, inputHash)。 */
	readonly committedRecords: Array<{ path: string; inputHash: string | null }>;
	/** 每个协调器的装配顺序日志(第一个元素是 subscribe / enumerate 的顺序)。 */
	readonly orderLogs: string[][];
	/** 触发一次事件,模拟 vault → 监听器 → 协调器。 */
	emit(filePath: string, op?: CoordinatorEventOp): void;
	/** 设置嵌入阶段钩子(在 prepareBlocks 内、返回块之前)。 */
	setPrepareHook(hook: ((input: { path: string; content: string }) => Promise<void>) | null): void;
	/** 设置提交阶段钩子(在 journal.commit 之前,仍在提交窗口内)。 */
	setCommitHook(hook: (() => Promise<void>) | null): void;
	/** 清空嵌入/事务/提交探测计数,用于第二轮的「只有该文件进入嵌入调用」断言。 */
	resetProbes(): void;
	newCoordinator(options?: Partial<IndexTaskCoordinatorOptions>): IndexTaskCoordinator;
}

/** 构造一个真实磁盘上的完整装配。 */
async function createHarness(root: string, notePaths: string[]): Promise<Harness> {
	const dir = path.join(root, 'generation');
	const vault = new MutableVault(notePaths);
	const storage = new AtomicIndexStorage({ generationRoot: dir });
	const store = new DiskFileReplaceStore(path.join(root, 'blocks'));
	const journal = new IndexFileJournal({
		generationRoot: dir,
		generationId: GENERATION_ID,
		configFingerprint: CONFIG_FINGERPRINT,
		owner: new TestOwner(),
		store,
		storage,
		expectedDimension: DIMENSIONS,
	});
	const embeddedPaths: string[] = [];
	const embeddedInputs: Array<{ path: string; content: string }> = [];
	const preparedOperations: Array<{ path: string; operation: 'replace' | 'delete' }> = [];
	const committedRecords: Array<{ path: string; inputHash: string | null }> = [];
	const orderLogs: string[][] = [];
	const critical = { peak: 0, activeSamples: [] as number[] };
	const handlers: Array<(path: string, op: CoordinatorEventOp) => void> = [];
	let prepareHook: ((input: { path: string; content: string }) => Promise<void>) | null = null;
	let commitHook: (() => Promise<void>) | null = null;
	let criticalDepth = 0;
	let current: IndexTaskCoordinator | null = null;
	/** 进入准备/提交临界区 — 同路径串行的直接观测点。 */
	const enterCritical = (): void => {
		criticalDepth += 1;
		critical.peak = Math.max(critical.peak, criticalDepth);
		if (current !== null) critical.activeSamples.push(current.counters().active);
	};
	const exitCritical = (): void => { criticalDepth -= 1; };
	const port: CoordinatorJournalPort = {
		prepare: async (input) => {
			enterCritical();
			try {
				const result = await journal.prepare(input);
				preparedOperations.push({ path: input.path, operation: input.operation });
				return result;
			}
			finally {
				exitCritical();
			}
		},
		commit: async (transactionId) => {
			if (commitHook !== null) await commitHook();
			enterCritical();
			try {
				const result = await journal.commit(transactionId);
				committedRecords.push({ path: result.commit.path, inputHash: result.commit.inputHash });
				return result;
			}
			finally {
				exitCritical();
			}
		},
		cleanup: (transactionId) => journal.cleanup(transactionId),
		readReceipt: (filePath) => journal.readReceipt(filePath),
		listReceipts: () => journal.listReceipts(),
	};
	const processor: CoordinatorProcessorPort = {
		prepareBlocks: async (input) => {
			embeddedPaths.push(input.path);
			embeddedInputs.push({ path: input.path, content: input.content });
			if (prepareHook !== null) await prepareHook(input);
			return chunk(input.content).map((text, index) => ({
				id: `${input.path}#chunk-${index}`,
				vector: deterministicVector(text, DIMENSIONS),
				metadata: { index },
			}));
		},
	};
	return {
		dir,
		vault,
		store,
		journal,
		port,
		embeddedPaths,
		embeddedInputs,
		critical,
		preparedOperations,
		committedRecords,
		orderLogs,
		emit: (filePath, op = 'upsert') => {
			for (const handler of [...handlers]) handler(filePath, op);
		},
		setPrepareHook: (hook) => { prepareHook = hook; },
		setCommitHook: (hook) => { commitHook = hook; },
		resetProbes: () => {
			embeddedPaths.length = 0;
			embeddedInputs.length = 0;
			preparedOperations.length = 0;
			committedRecords.length = 0;
			critical.peak = 0;
			critical.activeSamples.length = 0;
		},
		newCoordinator: (options = {}) => {
			const subscribeOrder: string[] = [];
			orderLogs.push(subscribeOrder);
			const coordinator = new IndexTaskCoordinator({
				vault: {
					listMarkdownFiles: () => {
						subscribeOrder.push('enumerate');
						return vault.listMarkdownFiles();
					},
					readFile: (filePath) => vault.readFile(filePath),
					stat: (filePath) => vault.stat(filePath),
				},
				journal: port,
				processor,
				getConfigFingerprint: () => CONFIG_FINGERPRINT,
				subscribe: (notify) => {
					subscribeOrder.push('subscribe');
					handlers.push(notify);
					return () => {
						const index = handlers.indexOf(notify);
						if (index >= 0) handlers.splice(index, 1);
					};
				},
				scanConcurrency: 1,
				...options,
			});
			current = coordinator;
			return coordinator;
		},
	};
}

// ==================== 终态判据 ====================

describe('展示用唯一文件计数', () => {
	it('文件同时排队、执行与持有事务 - 剩余文件只计一次 - 不改变完成判据', async () => {
		const root = await makeTempRoot();
		const h = await createHarness(root, ['a.md', 'b.md', 'c.md']);
		for (const name of ['a.md', 'b.md', 'c.md']) h.vault.files.set(name, '正文');
		const entered = deferred();
		const gate = deferred();
		h.setCommitHook(async () => { entered.release(); await gate.promise; });
		const coordinator = h.newCoordinator();
		const running = coordinator.start();
		try {
			await entered.promise;
			const c = coordinator.counters();
			expect(c.active).toBe(1);
			expect(c.pendingTransactions).toBe(1);
			expect(c.pendingFiles).toBe(3);
			expect(c.committed + c.pendingFiles!).toBe(c.total);
			expect(coordinator.isReady()).toBe(false);
		} finally { gate.release(); await running; coordinator.destroy(); }
		expect(coordinator.counters().pendingFiles).toBe(0);
	});
});

describe('canMarkReady', () => {
	it('全部条件满足 - 返回 true', () => {
		expect(canMarkReady({ scanComplete: true, queued: 0, active: 0, pendingTransactions: 0, failures: 0 })).toBe(true);
	});

	it('扫描未结束 / 有队列 / 有在途 / 有未决事务 / 有失败 - 任一成立即 false', () => {
		const base = { scanComplete: true, queued: 0, active: 0, pendingTransactions: 0, failures: 0 };
		expect(canMarkReady({ ...base, scanComplete: false })).toBe(false);
		expect(canMarkReady({ ...base, queued: 1 })).toBe(false);
		expect(canMarkReady({ ...base, active: 1 })).toBe(false);
		expect(canMarkReady({ ...base, pendingTransactions: 1 })).toBe(false);
		expect(canMarkReady({ ...base, failures: 1 })).toBe(false);
	});
});

// ==================== 扫描与事件 ====================

describe('IndexTaskCoordinator 扫描与事件', () => {
	it('启动扫描 - 首次枚举之前装配监听 - 装配顺序为 subscribe 先于 enumerate', async () => {
		const root = await makeTempRoot();
		const harness = await createHarness(root, ['a.md']);
		harness.vault.write('a.md', 'alpha');
		const coordinator = harness.newCoordinator();
		await coordinator.start();
		expect(harness.orderLogs[0]).toEqual(['subscribe', 'enumerate']);
		coordinator.destroy();
	});

	it('初始扫描 - 只读轻量路径列表并逐文件读取 - 核对并发受有界上限约束', async () => {
		const root = await makeTempRoot();
		const notePaths = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md'];
		const harness = await createHarness(root, notePaths);
		for (const notePath of notePaths) harness.vault.write(notePath, `content-${notePath}`);
		const coordinator = harness.newCoordinator({ scanConcurrency: 2 });
		await coordinator.start();
		expect(harness.vault.peakReads).toBeLessThanOrEqual(2);
		expect(coordinator.counters().total).toBe(6);
		expect(coordinator.counters().phase).toBe('ready');
		coordinator.destroy();
	});

	it('扫描进行中 - 已核实文件立即解锁 - 未核实文件不阻止检索且不标记扫描完成', async () => {
		const root = await makeTempRoot();
		const harness = await createHarness(root, ['a.md', 'b.md']);
		harness.vault.write('a.md', 'alpha');
		harness.vault.write('b.md', 'beta');
		const first = harness.newCoordinator();
		await first.start();
		first.destroy();
		const gate = deferred();
		harness.vault.setDelay(async (filePath) => { if (filePath === 'b.md') await gate.promise; });
		const second = harness.newCoordinator();
		const scan = second.start();
		await vi.waitFor(() => expect(second.freshnessOf('a.md')).toBe('verified'));
		expect(second.counters().scanComplete).toBe(false);
		expect(second.counters().phase).toBe('scanning');
		gate.release();
		await scan;
		expect(second.counters().phase).toBe('ready');
		second.destroy();
	});

	it('枚举与监听之间的空隙 - 期间变更没有事件 - 扫描结束后按内容 hash 补齐', async () => {
		const root = await makeTempRoot();
		const harness = await createHarness(root, ['a.md', 'b.md']);
		harness.vault.write('a.md', 'alpha');
		harness.vault.write('b.md', 'beta');
		const first = harness.newCoordinator();
		await first.start();
		first.destroy();
		harness.resetProbes();
		// 关键路径:不触发任何事件,只改内容;核对必须靠 hash 而不是靠事件。
		harness.vault.write('b.md', 'BETA');
		const second = harness.newCoordinator();
		await second.start();
		expect(harness.embeddedPaths).toEqual(['b.md']);
		expect(second.counters().committed).toBe(2);
		second.destroy();
	});

	it('核对进行中收到事件 - 事件不丢失 - 收敛后按最新内容提交', async () => {
		const root = await makeTempRoot();
		const harness = await createHarness(root, ['a.md', 'b.md']);
		harness.vault.write('a.md', 'alpha');
		harness.vault.write('b.md', 'beta-1');
		const first = harness.newCoordinator();
		await first.start();
		first.destroy();
		harness.resetProbes();
		const readStarted = deferred();
		const releaseRead = deferred();
		let triggered = false;
		harness.vault.setDelay(async (filePath) => {
			if (filePath !== 'b.md' || triggered) return;
			triggered = true;
			readStarted.release();
			await releaseRead.promise;
		});
		const second = harness.newCoordinator();
		const scan = second.start();
		await readStarted.promise;
		// 关键路径:核对窗口内收到新事件并落盘新内容;事件不得因为「正在核对」而丢失。
		harness.vault.write('b.md', 'beta-2');
		harness.emit('b.md', 'upsert');
		releaseRead.release();
		await scan;
		expect(second.counters().queued).toBe(0);
		expect(second.freshnessOf('b.md')).toBe('verified');
		// 只有最新内容进入嵌入调用,核对期读到的过期快照没有被提交。
		expect(harness.embeddedInputs).toEqual([{ path: 'b.md', content: 'beta-2' }]);
		const receipt = await harness.journal.readReceipt('b.md');
		expect(receipt?.inputHash).toBe(await sha256('beta-2'));
		expect(second.counters().phase).toBe('ready');
		second.destroy();
	});

	it('mtime 与 size 不变但正文变化 - 仍重新入队嵌入', async () => {
		const root = await makeTempRoot();
		const harness = await createHarness(root, ['note.md']);
		harness.vault.write('note.md', 'AAAA');
		const first = harness.newCoordinator();
		await first.start();
		first.destroy();
		const before = harness.vault.stat('note.md');
		harness.resetProbes();
		harness.vault.modifyWithoutTouch('note.md', 'BBBB');
		expect(harness.vault.stat('note.md')).toEqual(before);
		const second = harness.newCoordinator();
		await second.start();
		expect(harness.embeddedPaths).toEqual(['note.md']);
		const receipt = await harness.journal.readReceipt('note.md');
		expect(receipt?.inputHash).toBe(await sha256('BBBB'));
		second.destroy();
	});

	it('同路径连续事件 - 队列按路径合并 - 只保留一项且序号持续增长', async () => {
		const root = await makeTempRoot();
		const harness = await createHarness(root, ['hot.md', 'cold.md']);
		harness.vault.write('hot.md', 'v0');
		harness.vault.write('cold.md', 'c0');
		const coordinator = harness.newCoordinator({ autoDrain: false });
		await coordinator.start();
		harness.resetProbes();
		for (let index = 0; index < 50; index += 1) {
			harness.vault.write('hot.md', `v${index + 1}`);
			harness.emit('hot.md', 'upsert');
		}
		expect(coordinator.counters().queued).toBe(1);
		await coordinator.drain();
		// 关键路径:50 次事件只产生一次嵌入;队列不随键入无限增长。
		expect(harness.embeddedPaths).toEqual(['hot.md']);
		const receipt = await harness.journal.readReceipt('hot.md');
		expect(receipt?.inputHash).toBe(await sha256('v50'));
		expect(coordinator.counters().phase).toBe('ready');
		coordinator.destroy();
	});

	it('连续编辑热点路径 - 其他文件不被饿死 - 队列按顺序交替推进', async () => {
		const root = await makeTempRoot();
		const harness = await createHarness(root, ['hot.md', 'b.md', 'c.md']);
		harness.vault.write('hot.md', 'hot-0');
		harness.vault.write('b.md', 'b0');
		harness.vault.write('c.md', 'c0');
		const processed: string[] = [];
		let selfEdits = 0;
		harness.setPrepareHook(async (input) => {
			processed.push(input.path);
			if (input.path !== 'hot.md' || selfEdits >= 2) return;
			selfEdits += 1;
			// 处理热点文件期间继续产生新事件,其他文件必须仍能推进。
			harness.vault.write('hot.md', `hot-${selfEdits}`);
			harness.emit('hot.md', 'upsert');
		});
		const coordinator = harness.newCoordinator({ autoDrain: false });
		await coordinator.start();
		await coordinator.drain();
		expect(processed.slice(0, 3)).toEqual(['hot.md', 'b.md', 'c.md']);
		expect(processed.filter((filePath) => filePath === 'b.md')).toHaveLength(1);
		expect(processed.filter((filePath) => filePath === 'c.md')).toHaveLength(1);
		expect(coordinator.counters().phase).toBe('ready');
		coordinator.destroy();
	});

	it('多文件与处理期新事件 - 同一时刻只有一个路径在准备/提交 - 临界区不重叠', async () => {
		const root = await makeTempRoot();
		const notePaths = ['a.md', 'b.md', 'c.md', 'd.md'];
		const harness = await createHarness(root, notePaths);
		for (const notePath of notePaths) harness.vault.write(notePath, `content-${notePath}`);
		const coordinator = harness.newCoordinator({ autoDrain: false, scanConcurrency: 4 });
		await coordinator.start();
		harness.resetProbes();
		// 处理期间继续制造事件,给出并发交错的机会(先播两条事件把处理循环推进起来)。
		let edits = 0;
		harness.setPrepareHook(async (input) => {
			if (edits >= 2) return;
			edits += 1;
			harness.vault.write(input.path, `${input.content}-edited-${edits}`);
			harness.emit(input.path, 'upsert');
		});
		harness.vault.write('a.md', 'content-a-seed');
		harness.emit('a.md', 'upsert');
		harness.vault.write('b.md', 'content-b-seed');
		harness.emit('b.md', 'upsert');
		await coordinator.drain();
		// 关键路径:准备与提交临界区的峰值深度恒为 1 —— 同路径串行,临界区不重叠。
		expect(harness.critical.peak).toBe(1);
		expect(harness.critical.activeSamples.length).toBeGreaterThan(0);
		expect(harness.critical.activeSamples.every((active) => active === 1)).toBe(true);
		expect(coordinator.counters().active).toBe(0);
		expect(coordinator.counters().queued).toBe(0);
		expect(coordinator.counters().phase).toBe('ready');
		coordinator.destroy();
	});

	it('事件路径越界 - 直接忽略 - 不猜测归属也不入队', async () => {
		const root = await makeTempRoot();
		const harness = await createHarness(root, ['a.md']);
		harness.vault.write('a.md', 'alpha');
		const coordinator = harness.newCoordinator({ autoDrain: false });
		await coordinator.start();
		await coordinator.drain();
		harness.emit('../escape.md', 'upsert');
		harness.emit('', 'delete');
		expect(coordinator.counters().queued).toBe(0);
		expect(coordinator.counters().total).toBe(1);
		coordinator.destroy();
	});

	it('队列达到上界 - 丢弃越界事件并计数 - 被丢弃路径不计为待处理却不被静默遗忘', async () => {
		const root = await makeTempRoot();
		const harness = await createHarness(root, ['a.md', 'b.md', 'c.md', 'd.md']);
		for (const notePath of ['a.md', 'b.md', 'c.md', 'd.md']) harness.vault.write(notePath, notePath);
		// 上界设为 4 与文件数相同:扫描本身不受影响,只有超出上界的事件被丢弃。
		const coordinator = harness.newCoordinator({ autoDrain: false, maxQueueEntries: 4 });
		await coordinator.start();
		await coordinator.drain();
		expect(coordinator.overflowedEvents()).toBe(0);
		harness.emit('a.md', 'upsert');
		harness.emit('b.md', 'upsert');
		harness.emit('c.md', 'upsert');
		harness.emit('d.md', 'upsert');
		expect(coordinator.counters().queued).toBe(4);
		harness.emit('e.md', 'upsert');
		// 关键路径:e.md 的入队动作被上界丢弃,但路径必须留在待处理口径里(4 个队列项 + 1 个待回收),
		// 否则 canMarkReady 会在「已知一个现存路径却既无完成记录也无失败」时成立。
		expect(coordinator.counters().queued).toBe(5);
		expect(coordinator.overflowedEvents()).toBe(1);
		expect(coordinator.freshnessOf('e.md')).toBe('known-stale');
		await coordinator.drain();
		// 收敛后空位出现,被丢弃的路径被回收:队列归零且阶段可达 ready。
		expect(coordinator.counters().queued).toBe(0);
		expect(coordinator.freshnessOf('e.md')).toBe('deleted');
		expect(coordinator.counters().phase).toBe('ready');
		coordinator.destroy();
	});

	it('队列上界小于文件数 - 收敛循环回收溢出路径 - 本轮仍处理全部已知路径并可达 ready', async () => {
		const root = await makeTempRoot();
		const notePaths = ['a.md', 'b.md', 'c.md', 'd.md'];
		const harness = await createHarness(root, notePaths);
		for (const notePath of notePaths) harness.vault.write(notePath, `content-${notePath}`);
		const coordinator = harness.newCoordinator({ autoDrain: false, maxQueueEntries: 2 });
		const counters = await coordinator.start();
		// 关键路径:核对阶段有 2 条被上界丢弃,但收敛循环把它们重新入队并处理完,没有文件被漏掉。
		expect(coordinator.overflowedEvents()).toBe(2);
		expect(counters.queued).toBe(0);
		expect(counters.total).toBe(4);
		expect(counters.committed).toBe(4);
		expect(harness.embeddedPaths).toEqual(notePaths);
		expect(counters.phase).toBe('ready');
		coordinator.destroy();
	});

	it('上界触发且队列没有空位 - 溢出路径无法回收 - 终态不是 ready', async () => {
		const root = await makeTempRoot();
		const harness = await createHarness(root, ['stuck.md', 'waiting.md']);
		harness.vault.write('stuck.md', 'stuck');
		harness.vault.write('waiting.md', 'waiting');
		const first = harness.newCoordinator();
		await first.start();
		first.destroy();
		harness.resetProbes();
		// stuck.md 永久不可读,占住唯一的队列槽;waiting.md 内容已变但入队动作被上界丢弃且没有空位回收。
		harness.vault.write('waiting.md', 'waiting-2');
		harness.vault.failures.set('stuck.md', errnoError('EACCES', '权限不足'));
		const second = harness.newCoordinator({ autoDrain: false, maxQueueEntries: 1 });
		await second.start();
		expect(second.overflowedEvents()).toBe(1);
		expect(second.counters().queued).toBe(2);
		expect(second.verifiedPaths().has('waiting.md')).toBe(false);
		// 关键路径:waiting.md 是现存文件、既没有被嵌入也没有失败记录 —— 这种局面绝不能报 ready。
		expect(second.isReady()).toBe(false);
		expect(second.counters().phase).toBe('partial-failure');
		second.destroy();
	});
});

// ==================== 新鲜度与提交语义 ====================

describe('IndexTaskCoordinator 新鲜度与提交语义', () => {
	it('普通修改未提交 - 先标记 known-stale - 检索立即过滤旧版本', async () => {
		const root = await makeTempRoot();
		const harness = await createHarness(root, ['a.md']);
		harness.vault.write('a.md', 'alpha');
		const coordinator = harness.newCoordinator({ autoDrain: false });
		await coordinator.start();
		expect(coordinator.freshnessOf('a.md')).toBe('verified');
		harness.vault.write('a.md', 'alpha-2');
		harness.emit('a.md', 'upsert');
		expect(coordinator.freshnessOf('a.md')).toBe('known-stale');
		await coordinator.drain();
		expect(coordinator.freshnessOf('a.md')).toBe('verified');
		coordinator.destroy();
	});

	it('删除事件 - 立即 deny - 不等提交也不进入嵌入', async () => {
		const root = await makeTempRoot();
		const harness = await createHarness(root, ['a.md', 'b.md']);
		harness.vault.write('a.md', 'alpha');
		harness.vault.write('b.md', 'beta');
		const first = harness.newCoordinator();
		await first.start();
		first.destroy();
		const second = harness.newCoordinator({ autoDrain: false });
		await second.start();
		harness.resetProbes();
		harness.vault.remove('b.md');
		harness.emit('b.md', 'delete');
		// 关键路径:删除事件立即 deny,不等 durable 事务落盘;也不产生任何嵌入。
		expect(second.freshnessOf('b.md')).toBe('deleted');
		expect(harness.embeddedPaths).toEqual([]);
		await second.drain();
		const tombstone = await harness.journal.readReceipt('b.md');
		expect(tombstone?.state).toBe('deleted');
		expect(tombstone?.inputHash).toBeNull();
		expect(tombstone?.chunkCount).toBe(0);
		expect(await harness.store.blocksOf('b.md')).toEqual([]);
		expect(harness.preparedOperations).toEqual([{ path: 'b.md', operation: 'delete' }]);
		expect(second.counters().phase).toBe('ready');
		second.destroy();
	});

	it('黑名单排除 - 立即 deny 并排队删除 - 不重新嵌入被排除内容', async () => {
		const root = await makeTempRoot();
		const harness = await createHarness(root, ['keep.md', 'drop.md']);
		harness.vault.write('keep.md', 'keep');
		harness.vault.write('drop.md', 'drop');
		const first = harness.newCoordinator();
		await first.start();
		first.destroy();
		harness.resetProbes();
		const second = harness.newCoordinator({ isExcluded: (filePath) => filePath === 'drop.md' });
		await second.start();
		expect(second.freshnessOf('drop.md')).toBe('excluded');
		expect(harness.embeddedPaths).toEqual([]);
		const tombstone = await harness.journal.readReceipt('drop.md');
		expect(tombstone?.state).toBe('deleted');
		expect(second.counters().phase).toBe('ready');
		second.destroy();
	});

	it('空文件 - 提交零块 present 完成记录 - 再次启动零嵌入复用', async () => {
		const root = await makeTempRoot();
		const harness = await createHarness(root, ['empty.md']);
		harness.vault.write('empty.md', '');
		const first = harness.newCoordinator();
		await first.start();
		const receipt = await harness.journal.readReceipt('empty.md');
		expect(receipt?.state).toBe('present');
		expect(receipt?.chunkCount).toBe(0);
		expect(receipt?.inputHash).toBe(await sha256(''));
		expect(harness.embeddedPaths).toEqual(['empty.md']);
		first.destroy();
		harness.resetProbes();
		const second = harness.newCoordinator();
		await second.start();
		expect(harness.embeddedPaths).toEqual([]);
		expect(second.counters().phase).toBe('ready');
		second.destroy();
	});

	it('提交期间再次修改 - 保留队列项 - 旧快照不标记为最新版且新内容继续提交', async () => {
		const root = await makeTempRoot();
		const harness = await createHarness(root, ['b.md']);
		harness.vault.write('b.md', 'beta-1');
		const first = harness.newCoordinator();
		await first.start();
		first.destroy();
		harness.resetProbes();
		harness.vault.write('b.md', 'beta-2');
		const second = harness.newCoordinator({ autoDrain: false });
		let firstCommitSeen = false;
		harness.setCommitHook(async () => {
			if (firstCommitSeen) return;
			firstCommitSeen = true;
			// 关键路径:提交窗口内再次修改 —— 已在途事务不得吞掉后续事件。
			expect(second.unresolvedPaths().has('b.md')).toBe(true);
			harness.vault.write('b.md', 'beta-3');
			harness.emit('b.md', 'upsert');
		});
		await second.start();
		await second.drain();
		expect(harness.committedRecords.map((record) => record.inputHash))
			.toEqual([await sha256('beta-2'), await sha256('beta-3')]);
		expect(harness.embeddedPaths).toEqual(['b.md', 'b.md']);
		const receipt = await harness.journal.readReceipt('b.md');
		expect(receipt?.inputHash).toBe(await sha256('beta-3'));
		expect(receipt?.revision).toBe(3);
		expect(second.counters().phase).toBe('ready');
		second.destroy();
	});

	it('推理期间删除 - 丢弃未提交结果 - 不落过期事务并按删除收尾', async () => {
		const root = await makeTempRoot();
		const harness = await createHarness(root, ['a.md']);
		harness.vault.write('a.md', 'alpha-1');
		const first = harness.newCoordinator();
		await first.start();
		first.destroy();
		harness.resetProbes();
		harness.vault.write('a.md', 'alpha-2');
		const second = harness.newCoordinator({ autoDrain: false });
		const embedStarted = deferred();
		const gate = deferred();
		harness.setPrepareHook(async (input) => {
			if (input.content !== 'alpha-2') return;
			embedStarted.release();
			await gate.promise;
		});
		const scan = second.start();
		await embedStarted.promise;
		harness.vault.remove('a.md');
		harness.emit('a.md', 'delete');
		gate.release();
		await scan;
		await second.drain();
		// 关键路径:过期输入没有落 replace 事务(只有最后收尾的 delete 事务),新快照没有被提交。
		const staleHash = await sha256('alpha-2');
		expect(harness.preparedOperations.filter((entry) => entry.operation === 'replace')).toEqual([]);
		expect(harness.committedRecords.filter((record) => record.inputHash === staleHash)).toEqual([]);
		expect(harness.embeddedPaths).toEqual(['a.md']);
		const receipt = await harness.journal.readReceipt('a.md');
		expect(receipt?.state).toBe('deleted');
		expect(second.counters().phase).toBe('ready');
		second.destroy();
	});

	it('读取失败 - 区分无法读取与已删除 - 不把读取错误当成空文件提交', async () => {
		const root = await makeTempRoot();
		const harness = await createHarness(root, ['a.md', 'b.md']);
		harness.vault.write('a.md', 'alpha');
		harness.vault.write('b.md', 'beta');
		const first = harness.newCoordinator();
		await first.start();
		first.destroy();
		harness.resetProbes();
		harness.vault.failures.set('b.md', errnoError('EACCES', '权限不足'));
		const second = harness.newCoordinator();
		await second.start();
		expect(harness.embeddedPaths).toEqual([]);
		expect(harness.preparedOperations).toEqual([]);
		const receipt = await harness.journal.readReceipt('b.md');
		expect(receipt?.inputHash).toBe(await sha256('beta'));
		expect(receipt?.chunkCount).toBeGreaterThan(0);
		expect(await harness.store.blocksOf('b.md')).not.toEqual([]);
		expect(second.counters().failures).toBeGreaterThan(0);
		expect(second.counters().queued).toBeGreaterThan(0);
		expect(second.counters().phase).not.toBe('ready');
		// 关键路径:失败项保留;故障消除后重试成功,该路径的失败随「真的成功」被清除。
		// 失败按路径记账,由成功处理清除;恢复调用本身不清除(见下一条用例)。
		harness.vault.failures.delete('b.md');
		second.resume();
		await vi.waitFor(() => expect(second.freshnessOf('b.md')).toBe('verified'));
		expect(second.counters().queued).toBe(0);
		expect(second.counters().failures).toBe(0);
		expect(second.counters().phase).toBe('ready');
		second.destroy();
		// 读取失败路径零嵌入复用:下一轮仍不重新嵌入。
		harness.resetProbes();
		const third = harness.newCoordinator();
		await third.start();
		expect(harness.embeddedPaths).toEqual([]);
		expect(third.counters().phase).toBe('ready');
		third.destroy();
	});

	it('瞬时读失败耗尽重试 - 故障消除后收到新事件 - 队列归零且无需显式恢复即达 ready', async () => {
		const root = await makeTempRoot();
		const harness = await createHarness(root, ['a.md']);
		harness.vault.write('a.md', 'alpha');
		const first = harness.newCoordinator();
		await first.start();
		first.destroy();
		harness.resetProbes();
		harness.vault.failures.set('a.md', errnoError('EBUSY', '资源忙'));
		const second = harness.newCoordinator({ autoDrain: false, maxReadAttempts: 3 });
		await second.start();
		// 关键路径:连续失败耗尽重试预算后路径仍留在队列里,本轮不得假装完成。
		expect(second.counters().failures).toBeGreaterThan(0);
		expect(second.counters().queued).toBe(1);
		expect(second.freshnessOf('a.md')).not.toBe('verified');
		expect(second.counters().phase).toBe('partial-failure');
		// 故障是瞬时的:文件仍在且内容未变;新事件必须给该路径新的重试预算。
		harness.vault.failures.delete('a.md');
		harness.emit('a.md', 'upsert');
		await second.drain();
		// 关键路径:不调用 resume() 也能收敛 —— 否则同一实例内 ready 永久不可达。
		expect(second.counters().queued).toBe(0);
		expect(second.counters().failures).toBe(0);
		expect(second.isReady()).toBe(true);
		expect(second.counters().phase).toBe('ready');
		expect(second.freshnessOf('a.md')).toBe('verified');
		expect(harness.embeddedPaths).toEqual([]);
		second.destroy();
	});

	it('瞬时读失败耗尽重试 - 同一实例重新开始一轮 - 重试预算重置且本轮内收敛到 ready', async () => {
		const root = await makeTempRoot();
		const harness = await createHarness(root, ['a.md']);
		harness.vault.write('a.md', 'alpha');
		const first = harness.newCoordinator();
		await first.start();
		first.destroy();
		harness.resetProbes();
		harness.vault.failures.set('a.md', errnoError('EBUSY', '资源忙'));
		const second = harness.newCoordinator({ autoDrain: false, maxReadAttempts: 3 });
		await second.start();
		expect(second.counters().queued).toBe(1);
		expect(second.counters().phase).toBe('partial-failure');
		harness.vault.failures.delete('a.md');
		// 关键路径:新一轮 start() 必须重置上一轮用尽的重试预算并把保留项重新排队。
		await second.start();
		expect(second.counters().queued).toBe(0);
		expect(second.counters().failures).toBe(0);
		expect(second.counters().phase).toBe('ready');
		expect(second.isReady()).toBe(true);
		expect(second.freshnessOf('a.md')).toBe('verified');
		expect(harness.embeddedPaths).toEqual([]);
		second.destroy();
	});

	it('显式恢复 - 故障未消除 - 失败与阶段不清零', async () => {
		const root = await makeTempRoot();
		const harness = await createHarness(root, ['a.md']);
		harness.vault.write('a.md', 'alpha');
		const first = harness.newCoordinator();
		await first.start();
		first.destroy();
		harness.vault.failures.set('a.md', errnoError('EACCES', '权限不足'));
		const second = harness.newCoordinator({ autoDrain: false });
		await second.start();
		const failuresBefore = second.counters().failures;
		expect(failuresBefore).toBeGreaterThan(0);
		second.resume();
		await second.drain();
		// 关键路径:恢复只重置重试预算,不假装成功 —— 故障仍在时失败与阶段保持不变。
		expect(second.counters().failures).toBe(failuresBefore);
		expect(second.counters().queued).toBe(1);
		expect(second.counters().phase).toBe('partial-failure');
		second.destroy();
	});

	it('日志路径状态隔离 - 协调器口径也是 deny - 即使内容 hash 一致也不复用为 verified', async () => {
		const root = await makeTempRoot();
		const harness = await createHarness(root, ['quarantined.md']);
		harness.vault.write('quarantined.md', 'content');
		const first = harness.newCoordinator();
		await first.start();
		first.destroy();
		harness.resetProbes();
		const second = harness.newCoordinator({
			autoDrain: false,
			journal: {
				...harness.port,
				listPathStates: async () => [
					{ path: 'quarantined.md', kind: 'quarantined' as const, reason: 'invalid-prepared' },
				],
			},
		});
		await second.start();
		// 关键路径:只消费 freshnessOf() 的调用方也必须看到 deny,不能在协调器口径里变成 verified。
		expect(second.freshnessOf('quarantined.md')).toBe('corrupt');
		expect(second.verifiedPaths().has('quarantined.md')).toBe(false);
		expect(second.isReady()).toBe(false);
		expect(second.counters().phase).toBe('partial-failure');
		expect(harness.embeddedPaths).toEqual([]);
		second.destroy();
	});

	it('代际隔离 - 全部路径在本模块口径下 deny - 阶段为 failed', async () => {
		const root = await makeTempRoot();
		const harness = await createHarness(root, ['a.md']);
		harness.vault.write('a.md', 'alpha');
		const first = harness.newCoordinator();
		await first.start();
		first.destroy();
		harness.resetProbes();
		const second = harness.newCoordinator({
			autoDrain: false,
			journal: { ...harness.port, isGenerationQuarantined: async () => true },
		});
		await second.start();
		expect(second.freshnessOf('a.md')).toBe('corrupt');
		expect(second.verifiedPaths().size).toBe(0);
		expect(second.isReady()).toBe(false);
		expect(second.counters().phase).toBe('failed');
		expect(harness.embeddedPaths).toEqual([]);
		second.destroy();
	});

	it('日志删除凭据 - 协调器口径为 deleted - 不报 unknown 也不报 verified', async () => {
		const root = await makeTempRoot();
		const harness = await createHarness(root, ['a.md']);
		harness.vault.write('a.md', 'alpha');
		const first = harness.newCoordinator();
		await first.start();
		first.destroy();
		harness.resetProbes();
		const second = harness.newCoordinator({
			autoDrain: false,
			journal: { ...harness.port, listTombstones: async () => [{ path: 'gone.md' }] },
		});
		await second.start();
		expect(second.freshnessOf('gone.md')).toBe('deleted');
		expect(second.freshnessOf('a.md')).toBe('verified');
		expect(second.counters().phase).toBe('ready');
		second.destroy();
	});

	it('读取期间到达事件 - 读取后检查点拦下过期输入 - 同一份内容只进入嵌入一次', async () => {
		const root = await makeTempRoot();
		const harness = await createHarness(root, ['b.md']);
		harness.vault.write('b.md', 'beta-1');
		const readStarted = deferred();
		const releaseRead = deferred();
		let triggered = false;
		harness.vault.setDelay(async (filePath) => {
			if (filePath !== 'b.md' || triggered) return;
			triggered = true;
			readStarted.release();
			await releaseRead.promise;
			// 关键路径:读取窗口内换成新内容并投递事件。
			harness.vault.write('b.md', 'beta-2');
			harness.emit('b.md', 'upsert');
		});
		const coordinator = harness.newCoordinator({ autoDrain: false });
		const scan = coordinator.start();
		await readStarted.promise;
		releaseRead.release();
		await scan;
		await coordinator.drain();
		// 第一次处理在读取后被检查点拦下(零嵌入),只有最新内容进入嵌入一次。
		expect(harness.embeddedInputs).toEqual([{ path: 'b.md', content: 'beta-2' }]);
		expect(harness.preparedOperations).toEqual([{ path: 'b.md', operation: 'replace' }]);
		const receipt = await harness.journal.readReceipt('b.md');
		expect(receipt?.inputHash).toBe(await sha256('beta-2'));
		expect(coordinator.counters().phase).toBe('ready');
		coordinator.destroy();
	});

	it('删除未提交过的路径 - 无完成记录可删除 - 不写事务也不计入嵌入', async () => {
		const root = await makeTempRoot();
		const harness = await createHarness(root, ['a.md']);
		harness.vault.write('a.md', 'alpha');
		const coordinator = harness.newCoordinator({ autoDrain: false });
		await coordinator.start();
		await coordinator.drain();
		harness.resetProbes();
		harness.emit('never.md', 'delete');
		await coordinator.drain();
		expect(harness.preparedOperations).toEqual([]);
		expect(harness.embeddedPaths).toEqual([]);
		expect(coordinator.freshnessOf('never.md')).toBe('deleted');
		coordinator.destroy();
	});
});

// ==================== 重启复用验收 ====================

describe('IndexTaskCoordinator 重启复用', () => {
	it('再次启动且只修改一篇文件 - 只有该文件进入嵌入调用', async () => {
		const root = await makeTempRoot();
		const notePaths = ['a.md', 'b.md', 'c.md', 'd.md'];
		const harness = await createHarness(root, notePaths);
		for (const notePath of notePaths) harness.vault.write(notePath, `content-${notePath}`);
		const first = harness.newCoordinator();
		await first.start();
		// 首次构建:4 篇各调用一次嵌入。
		expect(harness.embeddedPaths).toEqual(notePaths);
		expect(first.counters().phase).toBe('ready');
		first.destroy();
		harness.resetProbes();
		harness.vault.write('c.md', 'content-c changed');
		const second = harness.newCoordinator();
		await second.start();
		// 关键路径:只有被修改的 c.md 进入嵌入调用;其余三篇零嵌入复用。
		expect(harness.embeddedPaths).toEqual(['c.md']);
		expect(harness.preparedOperations).toEqual([{ path: 'c.md', operation: 'replace' }]);
		expect(second.counters().committed).toBe(4);
		expect(second.counters().phase).toBe('ready');
		const receipt = await harness.journal.readReceipt('c.md');
		expect(receipt?.inputHash).toBe(await sha256('content-c changed'));
		second.destroy();
	});

	it('再次启动且无任何变化 - 零嵌入调用且向量零重写', async () => {
		const root = await makeTempRoot();
		const notePaths = ['a.md', 'b.md', 'c.md'];
		const harness = await createHarness(root, notePaths);
		for (const notePath of notePaths) harness.vault.write(notePath, `content-${notePath}`);
		const first = harness.newCoordinator();
		await first.start();
		first.destroy();
		harness.resetProbes();
		harness.store.replacedPaths.length = 0;
		const second = harness.newCoordinator();
		await second.start();
		expect(harness.embeddedPaths).toEqual([]);
		expect(harness.preparedOperations).toEqual([]);
		expect(harness.store.replacedPaths).toEqual([]);
		expect(second.counters().committed).toBe(3);
		expect(second.counters().phase).toBe('ready');
		second.destroy();
	});

	it('多轮创建与删除 - 收敛后回收记忆 - total 只计本轮已知文件数', async () => {
		const root = await makeTempRoot();
		const harness = await createHarness(root, ['keep.md']);
		harness.vault.write('keep.md', 'keep');
		// 关键路径:同一个实例连续多轮创建/删除临时文件,记忆不得随历史路径数单调增长。
		const coordinator = harness.newCoordinator({ autoDrain: false });
		await coordinator.start();
		expect(coordinator.counters().total).toBe(1);
		for (let round = 1; round <= 3; round += 1) {
			const temporary = `temp-${round}.md`;
			harness.vault.write(temporary, `temp-${round}`);
			harness.vault.setPathList(['keep.md', temporary]);
			await coordinator.start();
			expect(coordinator.counters().total).toBe(2);
			expect(coordinator.counters().phase).toBe('ready');
			harness.vault.remove(temporary);
			harness.vault.setPathList(['keep.md']);
			await coordinator.start();
			// 关键路径:本轮枚举之外的已删除路径被回收,不再计入 total;deny 口径由日志删除凭据提供。
			expect(coordinator.counters().total).toBe(1);
			expect(coordinator.freshnessOf(temporary)).toBe('deleted');
			expect(coordinator.counters().phase).toBe('ready');
		}
		expect(coordinator.counters().total).toBe(1);
		coordinator.destroy();
	});

	it('删除已提交文件后再次启动 - 删除凭据持久 - 不重新嵌入', async () => {
		const root = await makeTempRoot();
		const harness = await createHarness(root, ['a.md', 'b.md']);
		harness.vault.write('a.md', 'alpha');
		harness.vault.write('b.md', 'beta');
		const first = harness.newCoordinator();
		await first.start();
		first.destroy();
		harness.resetProbes();
		harness.vault.remove('b.md');
		const second = harness.newCoordinator();
		await second.start();
		expect(harness.embeddedPaths).toEqual([]);
		const tombstone = await harness.journal.readReceipt('b.md');
		expect(tombstone?.state).toBe('deleted');
		expect(second.counters().committed).toBe(1);
		expect(second.counters().phase).toBe('ready');
		second.destroy();
		harness.resetProbes();
		const third = harness.newCoordinator();
		await third.start();
		// 删除凭据已持久:第三轮既不嵌入也不重写删除事务。
		expect(harness.embeddedPaths).toEqual([]);
		expect(harness.preparedOperations).toEqual([]);
		expect(third.counters().phase).toBe('ready');
		third.destroy();
	});
});