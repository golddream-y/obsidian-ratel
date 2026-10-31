/**
 * @file tests/core/index-write-owner.test.ts
 * @description 写所有权 — renderer 内共享协调器(epoch 交接)与索引根目录 owner 锁(跨进程排他)
 * @module tests/core/index-write-owner
 * @depends core/index-write-owner
 *
 * 关键路径:
 * - 前两组用例先证明「实例内排队」不能保护重载后的新实例,再证明共享协调器能;
 *   缺陷证据与修复证据并列保留,便于审查者复核 T2 的动机。
 * - 锁相关用例全部使用系统临时目录,不触碰真实 Vault;子进程只用于制造
 *   「PID 存活」「PID 已退出」两种真实进程状态,以及真实第二进程的 acquire。
 * - 不得按过期时间抢锁:所有占用用例都断言「拒绝」而不是「超时后接管」。
 * - 跨进程用例必须是真实第二进程:子进程用 `node --experimental-strip-types` 执行
 *   tests 临时目录里的脚本,按源码路径 import 同一份实现,不使用伪造的锁记录代替。
 * - 原子写入与排他性:并发竞争用例断言「只有一个进程成功」且失败码绝不是
 *   `owner-lock-corrupt`(那正是 `wx` 建空文件窗口下别人读到 0 字节锁的表现)。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
	INDEX_OWNER_LOCK_FILE,
	INDEX_OWNER_RECOVERY_GATE_FILE,
	INDEX_WRITE_OWNER_COORDINATOR_VERSION,
	INDEX_WRITE_OWNER_ERROR_CODES,
	INDEX_WRITE_OWNER_SYMBOL,
	INDEX_WRITE_OWNER_SYMBOL_KEY,
	IndexWriteOwner,
	IndexWriteOwnerError,
	OWNER_IO_ERROR_CODE_BY_ERRNO,
	acquireOwnerLock,
	enterOwnerRecoveryGate,
	getWriteOwnerCoordinator,
	inspectOwnerLock,
	normalizeIndexRoot,
	normalizeIndexRootKey,
	quarantineCorruptOwnerLock,
	quarantineCorruptRecoveryGate,
	recoverOwnerLock,
	toOwnerIoError,
	type IndexWriteOwnerErrorCode,
	type OwnerClock,
	type OwnerLockHandle,
	type OwnerLockOptions,
	type OwnerLockRecord,
	type ProcessProbe,
	type WriteOwnerLease,
} from '../../src/core/index-write-owner';

// ---------------------------------------------------------------------------
// 公共测试辅助
// ---------------------------------------------------------------------------

const workspaces: string[] = [];
const children: Array<{ kill: () => void }> = [];

/**
 * 能否用权限位制造真实 fs 失败。
 *
 * 关键路径:门内释放失败(I4)只能靠真实 EACCES 触发 —— chmod 000 对 root 无效,
 * Windows 的权限语义也不一样,这两种环境下跳过而不是用伪造手段代替。
 */
const canDenyRead =
	process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0);

/** 系统临时目录下的独立根目录,用例结束递归删除。 */
function tempRoot(prefix = 'ratel-owner-'): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	workspaces.push(root);
	return root;
}

afterEach(() => {
	while (children.length > 0) children.pop()?.kill();
	while (workspaces.length > 0) {
		const root = workspaces.pop();
		if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
	}
});

/** 锁文件绝对路径。 */
function lockPath(root: string): string {
	return path.join(root, INDEX_OWNER_LOCK_FILE);
}

/** 恢复门文件绝对路径。 */
function gatePath(root: string): string {
	return path.join(root, INDEX_OWNER_RECOVERY_GATE_FILE);
}

/** 读取锁文件原文;不存在时返回 null。 */
function readLockRaw(root: string): string | null {
	try {
		return fs.readFileSync(lockPath(root), 'utf8');
	} catch {
		return null;
	}
}

/**
 * 构造一条锁记录。
 *
 * 关键路径:默认使用本进程身份,用例按需覆盖 pid / hostname / token,
 * 以模拟「外机锁」「PID 存活但身份不明」「PID 已退出」等场景。
 */
function lockRecord(overrides: {
	root: string;
	instanceToken: string;
	pid?: number;
	hostname?: string;
	epoch?: number;
}): OwnerLockRecord {
	return {
		schemaVersion: 2,
		coordinatorVersion: INDEX_WRITE_OWNER_COORDINATOR_VERSION,
		root: normalizeIndexRootKey(overrides.root),
		instanceToken: overrides.instanceToken,
		epoch: overrides.epoch ?? 1,
		process: {
			pid: overrides.pid ?? process.pid,
			hostname: overrides.hostname ?? os.hostname(),
			startTimeMs: null,
		},
		acquiredAt: Date.now(),
	};
}

/** 直接写入一条锁记录(模拟其他进程/历史实例留下的锁)。 */
function writeLockRecord(root: string, record: OwnerLockRecord): string {
	const raw = JSON.stringify(record);
	fs.writeFileSync(lockPath(root), raw, 'utf8');
	return raw;
}

/** 直接写入任意锁文件原文(模拟旧版本/外部损坏/字段被改的记录)。 */
function writeRawLock(root: string, raw: string): string {
	fs.writeFileSync(lockPath(root), raw, 'utf8');
	return raw;
}

/** 写入一条字段被改写的锁记录 JSON。 */
function writeLockJson(root: string, overrides: Record<string, unknown>): string {
	return writeRawLock(
		root,
		JSON.stringify({ ...lockRecord({ root, instanceToken: 'json-owner' }), ...overrides }),
	);
}

/** 取一个「已经退出」的真实进程 pid — 带超时,探测脚本挂起时不让用例永久卡住。 */
function exitedPid(): number {
	const result = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
		stdio: 'ignore',
		timeout: CHILD_TIMEOUT_MS,
	});
	if (result.error !== undefined) throw new Error(`探测子进程失败:${result.error.message}`);
	if (result.status !== 0) throw new Error(`探测子进程异常退出(status=${result.status})`);
	const pid = result.pid;
	if (typeof pid !== 'number') throw new Error('无法取得已退出子进程的 pid');
	return pid;
}

/** 启动一个保持存活的真实子进程,返回其 pid。 */
function livePid(): number {
	const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
	const pid = child.pid;
	if (typeof pid !== 'number') throw new Error('无法启动存活子进程');
	children.push({ kill: () => child.kill('SIGKILL') });
	return pid;
}

/** 断言同步调用抛出指定错误码。 */
function expectThrow(fn: () => void, code: IndexWriteOwnerErrorCode): void {
	let caught: unknown;
	try {
		fn();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(IndexWriteOwnerError);
	expect((caught as IndexWriteOwnerError).code).toBe(code);
}

/** 断言异步调用以指定错误码拒绝。 */
async function expectRejection(promise: Promise<unknown>, code: IndexWriteOwnerErrorCode): Promise<void> {
	await promise.then(
		() => {
			throw new Error(`期望拒绝(${code}),实际成功`);
		},
		(error: unknown) => {
			expect(error).toBeInstanceOf(IndexWriteOwnerError);
			expect((error as IndexWriteOwnerError).code).toBe(code);
		},
	);
}

/** 捕获异步调用的错误,便于断言错误码之外的 detail 与 cause。 */
async function catchError(promise: Promise<unknown>): Promise<IndexWriteOwnerError> {
	try {
		await promise;
	} catch (error) {
		return error as IndexWriteOwnerError;
	}
	throw new Error('期望拒绝,实际成功');
}

/** 根目录里残留的临时文件 — 原子写入必须清理干净。 */
function tempArtifacts(root: string): string[] {
	return fs.readdirSync(root).filter((name) => name.includes('.tmp'));
}

/** 单实例内排队 — 模拟现有实现「同一 IndexProcessor 串行」的写法。 */
class InInstanceQueue {
	private tail: Promise<unknown> = Promise.resolve();

	run<T>(task: () => Promise<T>): Promise<T> {
		const next = this.tail.then(task, task);
		this.tail = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}
}

/** 等待一个微任务轮次,让并发任务真实交错。 */
function nextTick(): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, 5));
}

// ---------------------------------------------------------------------------
// 真实跨进程辅助:用 `node --experimental-strip-types` 跑临时目录里的子进程脚本
// ---------------------------------------------------------------------------

/** 子进程允许的最长寿命;超时即 SIGKILL,失败清理不留悬挂进程。 */
const CHILD_TIMEOUT_MS = 20_000;

/** 测试文件所在目录。 */
function testFileDir(): string {
	return path.dirname(fileURLToPath(import.meta.url));
}

/** 被测源码路径与 file URL — 子进程 import 同一份实现,不复制源码、不用伪造锁记录。 */
const OWNER_MODULE_PATH = path.resolve(testFileDir(), '../../src/core/index-write-owner.ts');
const OWNER_MODULE_URL = pathToFileURL(OWNER_MODULE_PATH).href;

/**
 * 子进程脚本源码 — 写进 tests 临时目录后由真实 node 进程执行。
 *
 * 关键路径:mode=contest 时子进程取得锁后写 `.child-holding` 并等 `.child-release`,
 * 让父进程能在「赢家进程仍持锁」的时刻断言别人被拒,而不是靠伪造锁记录。
 */
const CHILD_SCRIPT_SOURCE = `
import fs from 'node:fs';

interface ChildHandle {
	release(): Promise<unknown>;
}

const args = process.argv.slice(2);
const moduleUrl = args[0] ?? '';
const root = args[1] ?? '';
const token = args[2] ?? '';
const mode = args[3] ?? 'try';
const delayMs = Number(args[4] ?? '0');

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const writeResult = (payload: Record<string, unknown>): void => {
	process.stdout.write(JSON.stringify({ pid: process.pid, ...payload }));
};

await sleep(delayMs);

try {
	const mod = (await import(moduleUrl)) as {
		acquireOwnerLock: (options: { root: string; instanceToken: string }) => Promise<ChildHandle>;
	};
	const handle = await mod.acquireOwnerLock({ root, instanceToken: token });
	if (mode === 'contest') {
		fs.writeFileSync(root + '/.child-holding', String(process.pid));
		const deadline = Date.now() + 10000;
		while (!fs.existsSync(root + '/.child-release') && Date.now() < deadline) await sleep(20);
	}
	await handle.release();
	writeResult({ ok: true, mode });
} catch (error) {
	const code = (error as { code?: string } | null)?.code ?? null;
	writeResult({ ok: false, mode, code });
}
`;

/** 子进程输出解析结果。 */
interface ChildRunResult {
	readonly ok: boolean;
	readonly pid: number;
	readonly code: string | null;
	readonly mode: string;
	readonly stdout: string;
	readonly stderr: string;
	readonly killedBySignal: boolean;
}

/** 把子进程脚本写进独立临时目录,返回脚本路径。 */
function writeChildScript(): string {
	const dir = tempRoot('ratel-child-');
	const scriptPath = path.join(dir, 'owner-lock-child.ts');
	fs.writeFileSync(scriptPath, CHILD_SCRIPT_SOURCE, 'utf8');
	return scriptPath;
}

/** 子进程命令行 — 真实第二进程;type stripping 让它能 import 项目的 .ts 源码。 */
function childArgs(
	scriptPath: string,
	root: string,
	token: string,
	mode: string,
	delayMs: number,
): string[] {
	return ['--experimental-strip-types', scriptPath, OWNER_MODULE_URL, root, token, mode, String(delayMs)];
}

/** 解析子进程输出;没有结果行时抛出带 stderr 的错误。 */
function parseChildOutput(
	stdout: string,
	stderr: string,
	status: number | null,
	signal: string | null,
): ChildRunResult {
	const text = stdout.trim();
	if (text.length === 0) {
		throw new Error(`子进程未输出结果(status=${status}, signal=${signal}):${stderr.slice(0, 400)}`);
	}
	const payload = JSON.parse(text) as { ok: boolean; pid: number; code: string | null; mode: string };
	return {
		ok: payload.ok,
		pid: payload.pid,
		code: payload.code ?? null,
		mode: payload.mode,
		stdout: text,
		stderr,
		killedBySignal: signal !== null,
	};
}

/** 同步跑一次真实子进程;超时或异常退出都显式失败。 */
function runChildSync(root: string, token: string, mode = 'try', delayMs = 0): ChildRunResult {
	const result = spawnSync(process.execPath, childArgs(writeChildScript(), root, token, mode, delayMs), {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: CHILD_TIMEOUT_MS,
	});
	if (result.error !== undefined) throw new Error(`子进程失败:${result.error.message}`);
	return parseChildOutput(result.stdout ?? '', result.stderr ?? '', result.status, result.signal);
}

/** 异步启动的真实子进程句柄。 */
interface SpawnedChild {
	readonly pid: number;
	readonly result: Promise<ChildRunResult>;
	hasExited(): boolean;
}

/** 异步启动一个真实子进程(用于需要在「赢家持锁期间」观察的用例)。 */
function spawnChild(root: string, token: string, mode: string, delayMs: number): SpawnedChild {
	const child = spawn(process.execPath, childArgs(writeChildScript(), root, token, mode, delayMs), {
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let stdout = '';
	let stderr = '';
	let exited = false;
	child.stdout?.on('data', (chunk) => {
		stdout += String(chunk);
	});
	child.stderr?.on('data', (chunk) => {
		stderr += String(chunk);
	});
	const killer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS);
	children.push({ kill: () => child.kill('SIGKILL') });
	const result = new Promise<ChildRunResult>((resolve, reject) => {
		child.on('exit', (status, signal) => {
			exited = true;
			clearTimeout(killer);
			try {
				resolve(parseChildOutput(stdout, stderr, status, signal));
			} catch (error) {
				reject(error);
			}
		});
	});
	return { pid: child.pid ?? -1, result, hasExited: () => exited };
}

/** 轮询等待条件成立;超时抛出便于定位的失败。 */
async function waitUntil(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`等待超时:${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

// ---------------------------------------------------------------------------
// 1. 缺陷证据:实例内排队不能保护重载后的新实例
// ---------------------------------------------------------------------------

describe('现有实现缺陷 - 实例内排队不能保护重载后的新实例', () => {
	it('实例内队列 - 两个实例各自排队 - 提交仍真实交错', async () => {
		// 关键路径:现有实现只有「单实例内串行」(IndexProcessor 内部顺序 await),
		// 插件重载后新旧实例各持一个队列,彼此不知道对方存在。
		const log: string[] = [];
		const queueA = new InInstanceQueue();
		const queueB = new InInstanceQueue();
		const commit = (name: string) => async (): Promise<void> => {
			log.push(`${name}:enter`);
			await nextTick();
			log.push(`${name}:exit`);
		};

		await Promise.all([queueA.run(commit('A')), queueB.run(commit('B'))]);

		// 关键路径:进入/退出交错 = 两个实例同时写同一个索引根,正是重载后数据损坏的来源。
		expect(log).toEqual(['A:enter', 'B:enter', 'A:exit', 'B:exit']);
	});

	it('共享协调器 - 同一根目录第二个实例 - 前任未关闭前不能开始提交', async () => {
		const root = tempRoot();
		const coordinator = getWriteOwnerCoordinator(root);
		const first = await coordinator.acquire({ instanceToken: 'instance-a' });

		// 关键路径:新实例必须等待旧实例的 closing Promise,不能凭「旧实例看起来没在写」自行开始。
		await expectRejection(
			coordinator.acquire({ instanceToken: 'instance-b', closeTimeoutMs: 10 }),
			'predecessor-not-closed',
		);
		expect(coordinator.snapshot()).toMatchObject({ instanceToken: 'instance-a', epoch: first.epoch });

		await first.release();
		const second = await coordinator.acquire({ instanceToken: 'instance-b' });
		expect(second.epoch).toBe(first.epoch + 1);
		await second.release();
	});
});

// ---------------------------------------------------------------------------
// 2. renderer 内实例交接
// ---------------------------------------------------------------------------

describe('共享协调器 - renderer 内实例交接', () => {
	it('两次实例交接 - 旧实例释放后 - 新实例取得新 epoch 且旧 lease 失效', async () => {
		const root = tempRoot();
		const coordinator = getWriteOwnerCoordinator(root);
		const first = await coordinator.acquire({ instanceToken: 'instance-a' });
		expect(first.epoch).toBe(1);

		await first.release();
		expect(first.isActive()).toBe(false);

		const second = await coordinator.acquire({ instanceToken: 'instance-b' });
		expect(second.epoch).toBe(2);
		expect(second.isActive()).toBe(true);

		// 关键路径:旧实例的 lease 不能因为「已经释放」而变成可写。
		expectThrow(() => first.assertWritable(), 'lease-released');
		expectThrow(() => first.assertWritable(), 'lease-released');
		second.assertWritable();
		await second.release();
	});

	it('旧实例推理迟到 - 新实例已接管 - 旧 epoch 提交被拒绝且新实例数据完整', async () => {
		const root = tempRoot();
		const coordinator = getWriteOwnerCoordinator(root);
		const committed: string[] = [];

		// A 持有写所有权并开始一次推理;推理期间插件被卸载 → A 释放 closing。
		const leaseA = await coordinator.acquire({ instanceToken: 'instance-a' });
		await leaseA.release();

		// B 接管并完成提交。
		const leaseB = await coordinator.acquire({ instanceToken: 'instance-b' });
		leaseB.assertWritable();
		committed.push('b-commit');

		// A 的推理此刻才返回,尝试提交 —— 必须被拒绝,且不得写入任何数据。
		await expectRejection(
			(async () => {
				leaseA.assertWritable();
				committed.push('a-commit');
			})(),
			'lease-released',
		);

		expect(committed).toEqual(['b-commit']);
		await leaseB.release();
	});

	it('前任永久挂起 - 等待超时 - 只报占用且旧 epoch 同时被撤销', async () => {
		const root = tempRoot();
		const coordinator = getWriteOwnerCoordinator(root);
		const hung = await coordinator.acquire({ instanceToken: 'instance-hung' });

		// 关键路径:旧实例永久挂起时新实例只显示占用,不抢写、不发放新 epoch。
		await expectRejection(
			coordinator.acquire({ instanceToken: 'instance-new', closeTimeoutMs: 10 }),
			'predecessor-not-closed',
		);

		// 关键路径:接管请求已经撤销旧 epoch,挂起的旧实例即便恢复也不能开始提交。
		expectThrow(() => hung.assertWritable(), 'epoch-revoked');
		expect(coordinator.snapshot()).toMatchObject({ epoch: hung.epoch, instanceToken: 'instance-hung' });

		await hung.release();
		const recovered = await coordinator.acquire({ instanceToken: 'instance-new' });
		expect(recovered.epoch).toBe(hung.epoch + 1);
		await recovered.release();
	});

	it('并发接管 - 两个实例同时等待前任关闭 - 只有一个取得新 epoch', async () => {
		const root = tempRoot();
		const coordinator = getWriteOwnerCoordinator(root);
		const predecessor = await coordinator.acquire({ instanceToken: 'instance-p' });

		// 两个接管请求同时挂在前任的 closing Promise 上。
		const first = coordinator.acquire({ instanceToken: 'instance-x', closeTimeoutMs: 1_000 });
		const second = coordinator.acquire({ instanceToken: 'instance-y', closeTimeoutMs: 1_000 });
		await nextTick();
		await predecessor.release();

		const settled = await Promise.allSettled([first, second]);
		const fulfilled = settled.filter(
			(entry): entry is PromiseFulfilledResult<WriteOwnerLease> => entry.status === 'fulfilled',
		);
		const rejected = settled.filter(
			(entry): entry is PromiseRejectedResult => entry.status === 'rejected',
		);
		// 关键路径:同一根目录只能有一个可写 owner,后来的接管不得覆盖先到的。
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect((rejected[0]?.reason as IndexWriteOwnerError).code).toBe('concurrent-takeover');
		const winner = fulfilled[0]?.value;
		expect(winner).toBeDefined();
		winner?.assertWritable();
		expect(coordinator.snapshot().instanceToken).toBe(winner?.instanceToken);
		await winner?.release();
	});

	it('同一实例令牌 - 重复获取 - 拒绝重复注册', async () => {
		const root = tempRoot();
		const coordinator = getWriteOwnerCoordinator(root);
		const lease = await coordinator.acquire({ instanceToken: 'duplicate-token' });
		await expectRejection(coordinator.acquire({ instanceToken: 'duplicate-token' }), 'instance-token-duplicate');
		lease.assertWritable();
		await lease.release();
	});

	it('根目录规范化 - 结尾分隔符不同 - 命中同一协调器', () => {
		const root = tempRoot();
		const withSeparator = `${root}${path.sep}`;
		expect(normalizeIndexRoot(withSeparator)).toBe(normalizeIndexRoot(root));
		expect(getWriteOwnerCoordinator(withSeparator)).toBe(getWriteOwnerCoordinator(root));
	});

	it('协调器版本不符 - 注册表版本不一致 - 拒绝接管旧注册表', () => {
		const root = tempRoot();
		const globalRecord = globalThis as unknown as { [INDEX_WRITE_OWNER_SYMBOL]?: unknown };
		const saved = globalRecord[INDEX_WRITE_OWNER_SYMBOL];
		try {
			globalRecord[INDEX_WRITE_OWNER_SYMBOL] = { version: 1, roots: new Map() };
			expectThrow(() => getWriteOwnerCoordinator(root), 'coordinator-version-mismatch');
		} finally {
			globalRecord[INDEX_WRITE_OWNER_SYMBOL] = saved;
		}
	});
});

// ---------------------------------------------------------------------------
// 3. owner 锁:排他创建、占用与恢复
// ---------------------------------------------------------------------------

describe('owner 锁 - 排他创建与占用', () => {
	it('无锁 - 排他创建 - 记录进程身份、实例令牌与协调器版本', async () => {
		const root = tempRoot();
		const handle = await acquireOwnerLock({ root, instanceToken: 'owner-1' });

		const raw = readLockRaw(root);
		expect(raw).not.toBeNull();
		const record = JSON.parse(raw ?? '{}') as OwnerLockRecord;
		expect(record.schemaVersion).toBe(2);
		expect(record.coordinatorVersion).toBe(INDEX_WRITE_OWNER_COORDINATOR_VERSION);
		expect(record.instanceToken).toBe('owner-1');
		expect(record.root).toBe(normalizeIndexRootKey(root));
		expect(record.process.pid).toBe(process.pid);
		expect(record.process.hostname).toBe(os.hostname());
		expect(record.acquiredAt).toBeGreaterThan(0);

		const released = await handle.release();
		expect(released).toEqual({ released: true, reason: 'released' });
		expect(readLockRaw(root)).toBeNull();
	});

	it('同进程同令牌 - 重复获取 - 幂等复用且不重写锁文件', async () => {
		const root = tempRoot();
		const first = await acquireOwnerLock({ root, instanceToken: 'owner-same' });
		const rawBefore = readLockRaw(root);
		const second = await acquireOwnerLock({ root, instanceToken: 'owner-same' });

		expect(second.raw).toBe(first.raw);
		expect(readLockRaw(root)).toBe(rawBefore);
		await second.release();
	});

	it('外机锁 - 主机名不同 - 拒绝自动回收', async () => {
		const root = tempRoot();
		writeLockRecord(
			root,
			lockRecord({ root, instanceToken: 'remote-owner', pid: 12345, hostname: 'another-machine.local' }),
		);

		const inspection = await inspectOwnerLock({ root, instanceToken: 'local-owner' });
		expect(inspection).toMatchObject({ state: 'foreign-host', reason: 'foreign-host' });
		await expectRejection(
			acquireOwnerLock({ root, instanceToken: 'local-owner' }),
			'owner-lock-foreign-host',
		);
		// 关键路径:拒绝接管不得删除原锁。
		expect(readLockRaw(root)).not.toBeNull();
	});

	it('空锁 - 内容为空 - 拒绝接管且保留原文件', async () => {
		const root = tempRoot();
		fs.writeFileSync(lockPath(root), '', 'utf8');

		const inspection = await inspectOwnerLock({ root, instanceToken: 'owner-x' });
		expect(inspection).toMatchObject({ state: 'corrupt', reason: 'record-invalid' });
		await expectRejection(acquireOwnerLock({ root, instanceToken: 'owner-x' }), 'owner-lock-corrupt');
		expect(readLockRaw(root)).toBe('');
	});

	it('PID 存活但实例身份不明 - 无法证明退出 - 拒绝自动回收', async () => {
		const root = tempRoot();
		const pid = livePid();
		writeLockRecord(root, lockRecord({ root, instanceToken: 'alive-other', pid }));

		const inspection = await inspectOwnerLock({ root, instanceToken: 'owner-y' });
		expect(inspection).toMatchObject({ state: 'held-by-live-owner', reason: 'process-alive' });
		await expectRejection(acquireOwnerLock({ root, instanceToken: 'owner-y' }), 'owner-busy');
	});

	it('无权限探测 - 进程存在但不可检查 - 拒绝自动回收', async () => {
		const root = tempRoot();
		writeLockRecord(root, lockRecord({ root, instanceToken: 'perm-owner', pid: 4242 }));
		const probe: ProcessProbe = () => 'no-permission';

		const inspection = await inspectOwnerLock({ root, instanceToken: 'owner-z', probeProcess: probe });
		expect(inspection).toMatchObject({ state: 'held-by-live-owner', reason: 'no-permission' });
		await expectRejection(
			acquireOwnerLock({ root, instanceToken: 'owner-z', probeProcess: probe }),
			'owner-busy',
		);
	});

	it('同进程但实例已不活跃 - 协调器确认 - 允许回收', async () => {
		const root = tempRoot();
		// 关键路径:同进程内 identity 可核实 —— 令牌不在共享协调器里 = 该实例已不存在。
		writeLockRecord(root, lockRecord({ root, instanceToken: 'gone-instance' }));

		const inspection = await inspectOwnerLock({ root, instanceToken: 'owner-next' });
		expect(inspection).toMatchObject({ state: 'recoverable', reason: 'instance-inactive' });
		const handle = await acquireOwnerLock({ root, instanceToken: 'owner-next' });
		expect(handle.record.instanceToken).toBe('owner-next');
		await handle.release();
	});
});

// ---------------------------------------------------------------------------
// 4. owner 锁:恢复门与恢复竞争
// ---------------------------------------------------------------------------

describe('owner 锁 - 恢复门与恢复竞争', () => {
	it('本机进程已退出 - 恢复门内核对旧令牌 - 接管为新锁', async () => {
		const root = tempRoot();
		const pid = exitedPid();
		const staleRaw = writeLockRecord(root, lockRecord({ root, instanceToken: 'dead-owner', pid }));

		const inspection = await inspectOwnerLock({ root, instanceToken: 'owner-next' });
		expect(inspection).toMatchObject({ state: 'recoverable', reason: 'process-exited' });

		const handle = await acquireOwnerLock({ root, instanceToken: 'owner-next' });
		expect(handle.record.instanceToken).toBe('owner-next');
		expect(handle.record.process.pid).toBe(process.pid);
		expect(readLockRaw(root)).not.toBe(staleRaw);
		await handle.release();
	});

	it('两恢复者依据同一旧快照 - 后进入恢复门者 - 拒绝覆盖后继锁', async () => {
		const root = tempRoot();
		const pid = exitedPid();
		writeLockRecord(root, lockRecord({ root, instanceToken: 'dead-owner', pid }));

		// 两个恢复者都基于同一份「可回收」快照。
		const stale = await inspectOwnerLock({ root, instanceToken: 'recoverer-1' });
		const first = await acquireOwnerLock({ root, instanceToken: 'recoverer-1' });

		// 第二个恢复者进入门后重新读取,发现令牌已变 → 拒绝,且不得删除后继锁。
		await expectRejection(
			recoverOwnerLock({ root, instanceToken: 'recoverer-2', expected: stale }),
			'owner-token-changed',
		);
		const after = await inspectOwnerLock({ root, instanceToken: 'recoverer-2' });
		expect(after.record?.instanceToken).toBe('recoverer-1');
		expect(readLockRaw(root)).toBe(first.raw);
		await first.release();
	});

	it('恢复门被占用且无法证明持有者退出 - 保守报占用', async () => {
		const root = tempRoot();
		const gate = await enterOwnerRecoveryGate({ root, instanceToken: 'gate-holder' });
		try {
			await expectRejection(acquireOwnerLock({ root, instanceToken: 'owner-q' }), 'recovery-gate-busy');
		} finally {
			await gate.release();
		}
		// 门释放后可以正常创建。
		const handle = await acquireOwnerLock({ root, instanceToken: 'owner-q' });
		await handle.release();
	});

	it('恢复门持有者进程已退出 - 清理残门后重新取得', async () => {
		const root = tempRoot();
		const pid = exitedPid();
		fs.writeFileSync(
			gatePath(root),
			JSON.stringify({ schemaVersion: 2, token: 'dead-gate', pid, hostname: os.hostname(), acquiredAt: Date.now() }),
			'utf8',
		);

		const gate = await enterOwnerRecoveryGate({ root, instanceToken: 'gate-next' });
		await gate.release();
		expect(fs.existsSync(gatePath(root))).toBe(false);
	});

	it('释放 - 令牌已被后继实例替换 - 不删除后继锁', async () => {
		const root = tempRoot();
		const handle = await acquireOwnerLock({ root, instanceToken: 'owner-old' });
		// 模拟后继实例在旧实例释放前完成接管。
		writeLockRecord(root, lockRecord({ root, instanceToken: 'owner-successor' }));

		const result = await handle.release();
		expect(result).toEqual({ released: false, reason: 'not-owner' });
		const raw = readLockRaw(root);
		expect(raw).not.toBeNull();
		expect((JSON.parse(raw ?? '{}') as OwnerLockRecord).instanceToken).toBe('owner-successor');
	});
});

// ---------------------------------------------------------------------------
// 5. 门面:协调器 + 锁
// ---------------------------------------------------------------------------

describe('写所有权门面 - 协调器与锁同时交接', () => {
	it('接管 - 前任未释放 - 新实例拒绝写入;前任释放后 - 新实例取得新 epoch', async () => {
		const root = tempRoot();
		const options = (instanceToken: string): OwnerLockOptions & { closeTimeoutMs: number } => ({
			root,
			instanceToken,
			closeTimeoutMs: 10,
		});

		const first = await IndexWriteOwner.acquire(options('facade-a'));
		expect(first.epoch).toBe(1);
		first.assertWritable();
		expect((JSON.parse(readLockRaw(root) ?? '{}') as OwnerLockRecord).instanceToken).toBe('facade-a');

		await expectRejection(IndexWriteOwner.acquire(options('facade-b')), 'predecessor-not-closed');

		await first.release();
		const second = await IndexWriteOwner.acquire(options('facade-b'));
		expect(second.epoch).toBe(2);
		expect((JSON.parse(readLockRaw(root) ?? '{}') as OwnerLockRecord).instanceToken).toBe('facade-b');
		expectThrow(() => first.assertWritable(), 'lease-released');
		second.assertWritable();

		await second.release();
		expect(readLockRaw(root)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 6. 在途提交(I2)与可注入时钟
// ---------------------------------------------------------------------------

describe('共享协调器 - 在途提交不覆盖与注入时钟', () => {
	it('提交进行中释放 - closing 等提交结算 - 新实例获取被阻塞到提交结束', async () => {
		const root = tempRoot();
		const coordinator = getWriteOwnerCoordinator(root);
		const first = await coordinator.acquire({ instanceToken: 'inflight-a' });
		const ticket = first.beginCommit();

		await first.release();
		// 关键路径(I2):release 只标记已释放,closing 仍在等在途提交结算。
		expect(first.isActive()).toBe(false);
		expect(coordinator.snapshot()).toMatchObject({ instanceToken: null, closingPending: true });

		let acquired = false;
		const pending = coordinator
			.acquire({ instanceToken: 'inflight-b', closeTimeoutMs: 5_000 })
			.then((lease) => {
				acquired = true;
				return lease;
			});
		await nextTick();
		expect(acquired).toBe(false);

		ticket.settle();
		const second = await pending;
		expect(acquired).toBe(true);
		expect(second.epoch).toBe(first.epoch + 1);
		expect(coordinator.snapshot()).toMatchObject({ instanceToken: 'inflight-b', closingPending: false });
		// 关键路径:已释放的实例不能再登记新提交(撤销 epoch 只挡住新提交,不打断在途的)。
		expectThrow(() => first.beginCommit(), 'lease-released');
		await second.release();
	});

	it('先发起接管再释放 - 接管不因 release 直接放行 - 提交结算后才发放新 epoch', async () => {
		const root = tempRoot();
		const coordinator = getWriteOwnerCoordinator(root);
		const first = await coordinator.acquire({ instanceToken: 'late-a' });
		const ticket = first.beginCommit();

		const pending = coordinator.acquire({ instanceToken: 'late-b', closeTimeoutMs: 5_000 });
		await nextTick();
		await first.release();
		let settled = false;
		void pending.then(
			() => {
				settled = true;
			},
			() => undefined,
		);
		await nextTick();
		await nextTick();
		expect(settled).toBe(false);
		expect(coordinator.snapshot().closingPending).toBe(true);

		ticket.settle();
		const second = await pending;
		expect(settled).toBe(true);
		expect(second.epoch).toBe(first.epoch + 1);
		await second.release();
	});

	it('在途提交永不结算 - 注入时钟判定占用 - 不抢写也不消耗真实等待', async () => {
		const root = tempRoot();
		const coordinator = getWriteOwnerCoordinator(root);
		const first = await coordinator.acquire({ instanceToken: 'stuck-a' });
		const ticket = first.beginCommit();
		await first.release();

		// 关键路径:默认时钟是 `globalThis` 上的真实定时器;注入假时钟即可同步判定超时。
		const timers: Array<() => void> = [];
		const clock: OwnerClock = {
			setTimeout: (handler) => {
				timers.push(handler);
				return timers.length;
			},
			clearTimeout: () => undefined,
		};
		const pending = coordinator.acquire({ instanceToken: 'stuck-b', closeTimeoutMs: 5_000, clock });
		await nextTick();
		expect(timers).toHaveLength(1);
		timers[0]?.();
		await expectRejection(pending, 'predecessor-not-closed');
		expect(coordinator.snapshot()).toMatchObject({ instanceToken: null, closingPending: true });

		ticket.settle();
		const second = await coordinator.acquire({ instanceToken: 'stuck-b' });
		expect(second.epoch).toBe(first.epoch + 1);
		await second.release();
	});

	it('全局注册表 - 注册在 globalThis 的符号键上 - 同根目录共享同一协调器', () => {
		const root = tempRoot();
		const coordinator = getWriteOwnerCoordinator(root);
		// 关键路径:plan 要求注册在 `globalThis`(renderer 内等价于 `window`),符号键取 Symbol.for。
		expect(INDEX_WRITE_OWNER_SYMBOL).toBe(Symbol.for(INDEX_WRITE_OWNER_SYMBOL_KEY));
		const scope = globalThis as unknown as { [key: symbol]: RegistryProbe | undefined };
		expect(scope[INDEX_WRITE_OWNER_SYMBOL]?.version).toBe(INDEX_WRITE_OWNER_COORDINATOR_VERSION);
		expect(scope[INDEX_WRITE_OWNER_SYMBOL]?.roots.get(normalizeIndexRootKey(root))).toBe(coordinator);
		expect(getWriteOwnerCoordinator(root)).toBe(coordinator);
	});
});

/** `globalThis` 注册表的探测形状。 */
interface RegistryProbe {
	readonly version: number;
	readonly roots: Map<string, unknown>;
}

// ---------------------------------------------------------------------------
// 7. 原子写入(B2)与真实跨进程排他
// ---------------------------------------------------------------------------

describe('owner 锁 - 原子写入与真实跨进程排他', () => {
	it('原子写入 - 目标路径只出现完整内容且不留临时文件', async () => {
		const root = tempRoot();
		const handle = await acquireOwnerLock({ root, instanceToken: 'atomic-owner' });

		// 关键路径(B2):原子写入下目标路径上不会出现 0 字节或半截 JSON。
		const raw = readLockRaw(root);
		expect(raw).not.toBeNull();
		expect(() => JSON.parse(raw ?? '')).not.toThrow();
		expect((JSON.parse(raw ?? '{}') as OwnerLockRecord).instanceToken).toBe('atomic-owner');

		const gate = await enterOwnerRecoveryGate({ root, instanceToken: 'atomic-owner' });
		expect(() => JSON.parse(fs.readFileSync(gatePath(root), 'utf8'))).not.toThrow();
		await gate.release();

		expect(tempArtifacts(root)).toEqual([]);
		await handle.release();
		expect(readLockRaw(root)).toBeNull();
		expect(tempArtifacts(root)).toEqual([]);
	});

	it('原子写入 - 写入期间高频读取 - 目标路径只出现完整记录不出现 0 字节', async () => {
		const root = tempRoot();
		// 关键路径(B2):`wx` 建空文件再写的实现会让并发读者看到 0 字节锁并判 corrupt。
		// 子进程(真实第二进程)取得锁后持锁等信号,父进程在此期间贴着读,直到看到完整记录。
		const writer = spawnChild(root, 'atomic-writer', 'contest', 0);
		const kinds = new Set<string>();
		const deadline = Date.now() + 15_000;
		while (!kinds.has('complete') && !writer.hasExited() && Date.now() < deadline) {
			const raw = readLockRaw(root);
			if (raw === null) kinds.add('missing');
			else if (raw.length === 0) kinds.add('empty');
			else if (raw.startsWith('{') && raw.endsWith('}')) kinds.add('complete');
			else kinds.add('partial');
		}
		fs.writeFileSync(path.join(root, '.child-release'), 'go');
		expect((await writer.result).ok).toBe(true);
		expect([...kinds]).toContain('complete');
		expect([...kinds]).not.toContain('empty');
		expect([...kinds]).not.toContain('partial');
	});

	it('真实第二进程 - 父进程持锁时 acquire 被拒 - 父进程释放后即可取得', async () => {
		const root = tempRoot();
		expect(fs.existsSync(OWNER_MODULE_PATH)).toBe(true);

		const parent = await acquireOwnerLock({ root, instanceToken: 'parent-owner' });
		const blocked = runChildSync(root, 'child-owner');
		expect(blocked.killedBySignal).toBe(false);
		expect(blocked.ok).toBe(false);
		expect(blocked.code).toBe('owner-busy');
		expect(blocked.pid).not.toBe(process.pid);

		await parent.release();
		const allowed = runChildSync(root, 'child-owner-2');
		expect(allowed.ok).toBe(true);
		expect(allowed.code).toBeNull();
		expect(allowed.pid).not.toBe(process.pid);
		// 子进程自己释放后不留锁。
		expect(readLockRaw(root)).toBeNull();
	});

	it('真实第二进程 - 子进程持锁 - 磁盘记录是子进程身份且第三个进程被拒', async () => {
		const root = tempRoot();
		const holder = spawnChild(root, 'child-holder', 'contest', 0);
		await waitUntil(
			() => fs.existsSync(path.join(root, '.child-holding')),
			15_000,
			'子进程取得 owner 锁',
		);

		// 关键路径:锁是真实第二进程写的,不是伪造记录 —— 断言磁盘记录里的 pid 就是那个进程。
		const record = JSON.parse(readLockRaw(root) ?? '{}') as OwnerLockRecord;
		expect(record.process.pid).toBe(holder.pid);
		expect(record.process.pid).not.toBe(process.pid);
		const inspection = await inspectOwnerLock({ root, instanceToken: 'parent-observer' });
		expect(inspection).toMatchObject({ state: 'held-by-live-owner', reason: 'process-alive' });
		await expectRejection(acquireOwnerLock({ root, instanceToken: 'parent-observer' }), 'owner-busy');
		// 第三个真实进程同样被拒:排他性跨进程成立。
		expect(runChildSync(root, 'child-third').code).toBe('owner-busy');

		fs.writeFileSync(path.join(root, '.child-release'), 'go');
		expect((await holder.result).ok).toBe(true);
		expect(readLockRaw(root)).toBeNull();
	});

	it('并发抢占 - 四个真实进程同时创建同一把锁 - 只有一个成功且失败码不是损坏', async () => {
		const root = tempRoot();
		const tokens = ['contest-a', 'contest-b', 'contest-c', 'contest-d'];
		const runs = tokens.map((token) => spawnChild(root, token, 'contest', 120));
		await waitUntil(
			() => fs.existsSync(path.join(root, '.child-holding')),
			15_000,
			'某个子进程取得 owner 锁',
		);
		// 关键路径:等其余竞争者全部退出后才让赢家释放,保证「同时竞争同一把锁」成立。
		await waitUntil(
			() => runs.filter((run) => !run.hasExited()).length === 1,
			15_000,
			'其余竞争者退出',
		);
		fs.writeFileSync(path.join(root, '.child-release'), 'go');
		const results = await Promise.all(runs.map((run) => run.result));

		const winners = results.filter((result) => result.ok);
		const losers = results.filter((result) => !result.ok);
		expect(winners).toHaveLength(1);
		expect(losers).toHaveLength(tokens.length - 1);
		// 关键路径(B2):`wx` 建空文件的窗口会让竞争者读到 0 字节锁并判 corrupt;原子写入下不可能出现。
		for (const loser of losers) {
			expect(loser.killedBySignal).toBe(false);
			expect(loser.code).not.toBe('owner-lock-corrupt');
			expect(['owner-busy', 'recovery-gate-busy', 'owner-token-changed']).toContain(loser.code);
		}
		expect(winners[0]?.pid).not.toBe(process.pid);
		expect(readLockRaw(root)).toBeNull();
		expect(tempArtifacts(root)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 8. 损坏锁/门的显式恢复
// ---------------------------------------------------------------------------

describe('owner 锁 - 损坏文件的显式恢复', () => {
	it('截断锁 - 默认拒绝且错误码稳定 - 显式隔离后恢复可用', async () => {
		const root = tempRoot();
		const truncated = '{"schemaVersion":2,"coordinatorVersion":2,"root":"/x"';
		fs.writeFileSync(lockPath(root), truncated, 'utf8');

		// 关键路径:损坏文件默认继续拒绝写入,不自动抢锁。
		await expectRejection(acquireOwnerLock({ root, instanceToken: 'owner-after' }), 'owner-lock-corrupt');
		await expectRejection(acquireOwnerLock({ root, instanceToken: 'owner-after' }), 'owner-lock-corrupt');
		const inspection = await inspectOwnerLock({ root, instanceToken: 'owner-after' });
		expect(inspection).toMatchObject({ state: 'corrupt', reason: 'record-invalid' });
		expect(readLockRaw(root)).toBe(truncated);

		// 未经显式确认时隔离 API 也拒绝。
		await expectRejection(
			quarantineCorruptOwnerLock({ root, instanceToken: 'owner-after', confirm: false }),
			'quarantine-not-confirmed',
		);
		expect(readLockRaw(root)).toBe(truncated);

		const quarantined = await quarantineCorruptOwnerLock({
			root,
			instanceToken: 'owner-after',
			confirm: true,
		});
		expect(quarantined.quarantined).toBe(true);
		expect(quarantined.quarantinedPath).toMatch(/owner\.lock\.corrupt-/);
		expect(fs.readFileSync(quarantined.quarantinedPath ?? '', 'utf8')).toBe(truncated);
		expect(readLockRaw(root)).toBeNull();

		const handle = await acquireOwnerLock({ root, instanceToken: 'owner-after' });
		expect(handle.record.instanceToken).toBe('owner-after');
		await handle.release();
		expect(readLockRaw(root)).toBeNull();
	});

	it('合法锁 - 隔离 API 只处理损坏文件 - 不碰有效锁', async () => {
		const root = tempRoot();
		const handle = await acquireOwnerLock({ root, instanceToken: 'valid-owner' });
		const result = await quarantineCorruptOwnerLock({ root, instanceToken: 'other-owner', confirm: true });
		expect(result).toEqual({ quarantined: false, reason: 'not-corrupt', quarantinedPath: null });
		expect(readLockRaw(root)).toBe(handle.raw);

		await handle.release();
		const missing = await quarantineCorruptOwnerLock({ root, instanceToken: 'other-owner', confirm: true });
		expect(missing).toEqual({ quarantined: false, reason: 'missing', quarantinedPath: null });
	});

	it('截断门 - 默认拒绝且不自动清理 - 显式隔离后门与锁都能重建', async () => {
		const root = tempRoot();
		const truncated = '{"schemaVersion":2,"token":"dead-gate"';
		fs.writeFileSync(gatePath(root), truncated, 'utf8');

		await expectRejection(acquireOwnerLock({ root, instanceToken: 'gate-after' }), 'recovery-gate-busy');
		// 关键路径:探测为 missing(持有者已退出)也不能自动清理损坏门 —— 内容坏了就证明不了身份。
		await expectRejection(
			enterOwnerRecoveryGate({ root, instanceToken: 'gate-after', probeProcess: () => 'missing' }),
			'recovery-gate-busy',
		);
		expect(fs.readFileSync(gatePath(root), 'utf8')).toBe(truncated);

		await expectRejection(
			quarantineCorruptRecoveryGate({ root, instanceToken: 'gate-after', confirm: false }),
			'quarantine-not-confirmed',
		);
		const quarantined = await quarantineCorruptRecoveryGate({
			root,
			instanceToken: 'gate-after',
			confirm: true,
		});
		expect(quarantined.quarantined).toBe(true);
		expect(quarantined.quarantinedPath).toMatch(/owner\.recovery\.lock\.corrupt-/);
		expect(fs.readFileSync(quarantined.quarantinedPath ?? '', 'utf8')).toBe(truncated);
		expect(fs.existsSync(gatePath(root))).toBe(false);

		const gate = await enterOwnerRecoveryGate({ root, instanceToken: 'gate-after' });
		await gate.release();
		const handle = await acquireOwnerLock({ root, instanceToken: 'gate-after' });
		await handle.release();
	});

	it('合法恢复门 - 隔离 API 拒绝摘走他人活门', async () => {
		const root = tempRoot();
		const liveGateRaw = JSON.stringify({
			schemaVersion: 2,
			token: 'live-gate',
			pid: process.pid,
			hostname: os.hostname(),
			acquiredAt: Date.now(),
		});
		fs.writeFileSync(gatePath(root), liveGateRaw, 'utf8');

		const result = await quarantineCorruptRecoveryGate({ root, instanceToken: 'other', confirm: true });
		expect(result).toEqual({ quarantined: false, reason: 'not-corrupt', quarantinedPath: null });
		expect(fs.readFileSync(gatePath(root), 'utf8')).toBe(liveGateRaw);
	});
});

// ---------------------------------------------------------------------------
// 9. 恢复门 TOCTOU、释放失败与可重试
// ---------------------------------------------------------------------------

describe('owner 锁 - 恢复门 TOCTOU 与失败处理', () => {
	it('残门清理 TOCTOU - 读到残门后被后继实例替换 - 不删除后继实例的活门', async () => {
		const root = tempRoot();
		const staleRaw = JSON.stringify({
			schemaVersion: 2,
			token: 'dead-gate',
			pid: exitedPid(),
			hostname: os.hostname(),
			acquiredAt: Date.now() - 1_000,
		});
		const successorRaw = JSON.stringify({
			schemaVersion: 2,
			token: 'successor-gate',
			pid: process.pid,
			hostname: os.hostname(),
			acquiredAt: Date.now(),
		});
		fs.writeFileSync(gatePath(root), staleRaw, 'utf8');

		// 关键路径(I3):探测点是「读门之后、删除之前」;这里在探测回调里把门换成后继实例的活门。
		const probe: ProcessProbe = () => {
			fs.writeFileSync(gatePath(root), successorRaw, 'utf8');
			return 'missing';
		};
		await expectRejection(
			enterOwnerRecoveryGate({ root, instanceToken: 'gate-next', probeProcess: probe }),
			'recovery-gate-busy',
		);

		// 关键路径:后继实例的门必须原样还在 —— read-then-rm 会在这里把它删掉。
		expect(fs.readFileSync(gatePath(root), 'utf8')).toBe(successorRaw);
		expect(tempArtifacts(root)).toEqual([]);
	});

	it.skipIf(!canDenyRead)('门释放失败 - 不覆盖门内已抛出的主错误', async () => {
		const root = tempRoot();
		// 关键路径(I4):利用 now 接缝在门内工作阶段(建锁记录时)制造「工作先失败 + 门释放也失败」。
		// 主错误是门内发现锁已被其他实例创建;门释放的 EACCES 不得覆盖它。
		const now = (): number => {
			if (fs.existsSync(gatePath(root)) && !fs.existsSync(lockPath(root))) {
				fs.writeFileSync(
					lockPath(root),
					JSON.stringify(lockRecord({ root, instanceToken: 'race-winner' })),
					'utf8',
				);
				fs.chmodSync(gatePath(root), 0o000);
			}
			return Date.now();
		};
		const error = await catchError(acquireOwnerLock({ root, instanceToken: 'owner-loser', now }));
		expect(error.code).toBe('owner-token-changed');
		expect(error.code).not.toBe('owner-lock-permission-denied');
	});

	it.skipIf(!canDenyRead)('门释放失败 - 回滚刚创建的锁且保留原始错误', async () => {
		const root = tempRoot();
		// 关键路径(I4):门释放失败发生在工作成功之后 —— 必须回滚本次新建的锁,
		// 不能留下「调用方以为失败、磁盘上却有一把锁」的泄漏,也不能吞掉原始错误。
		const now = (): number => {
			if (fs.existsSync(gatePath(root))) fs.chmodSync(gatePath(root), 0o000);
			return Date.now();
		};
		const error = await catchError(acquireOwnerLock({ root, instanceToken: 'owner-rollback', now }));
		expect(error.code).toBe('owner-lock-permission-denied');
		expect(error.detail.errno).toBe('EACCES');
		expect(error.cause).toBeInstanceOf(Error);
		expect(readLockRaw(root)).toBeNull();

		// 关键路径:失败后根目录仍可用(门与锁都回到了干净状态)。
		const handle = await acquireOwnerLock({ root, instanceToken: 'owner-rollback' });
		await handle.release();
		expect(readLockRaw(root)).toBeNull();
	});

	it.skipIf(!canDenyRead)('恢复门句柄 - 释放失败后仍可重试 - 不把仍在磁盘上的门记成已释放', async () => {
		const root = tempRoot();
		const gate = await enterOwnerRecoveryGate({ root, instanceToken: 'gate-retry' });
		try {
			// 关键路径(I5):让摘门的 rename 本身失败(目录不可写),此时门文件还在原处。
			fs.chmodSync(root, 0o555);
			const failed = await catchError(gate.release());
			expect(failed.code).toBe('owner-lock-permission-denied');
			expect(fs.existsSync(gatePath(root))).toBe(true);
		} finally {
			fs.chmodSync(root, 0o755);
		}
		// 关键路径:释放失败不得把门记成已释放 —— 重试必须真的删掉门,而不是回报 missing。
		expect(await gate.release()).toEqual({ released: true, reason: 'released' });
		expect(fs.existsSync(gatePath(root))).toBe(false);
	});

	it('门面 release - 首次 gate-busy 失败不吞掉重试能力 - 门空闲时真正删除锁', async () => {
		const root = tempRoot();
		const owner = await IndexWriteOwner.acquire({ root, instanceToken: 'facade-retry' });
		const blocker = await enterOwnerRecoveryGate({ root, instanceToken: 'gate-blocker' });
		try {
			// 门被同进程持有者占着:release 抛稳定错误码,且锁文件仍在。
			await expectRejection(owner.release(), 'recovery-gate-busy');
			expect(readLockRaw(root)).not.toBeNull();
		} finally {
			await blocker.release();
		}

		// 关键路径(I5):首次失败不得被记成「已释放」;第二次必须真的删掉锁。
		expect(await owner.release()).toEqual({ released: true, reason: 'released' });
		expect(readLockRaw(root)).toBeNull();
		// 成功后才幂等:重复调用返回同一结论。
		expect(await owner.release()).toEqual({ released: true, reason: 'released' });
	});
});

// ---------------------------------------------------------------------------
// 10. 根目录身份与稳定错误码
// ---------------------------------------------------------------------------

describe('根目录身份与稳定错误码', () => {
	/** 大小写不敏感卷(darwin/win32)才谈得上大小写写法合并。 */
	const caseInsensitivePlatform = process.platform === 'darwin' || process.platform === 'win32';

	it('符号链接写法不同 - 命同一个根 - 旧写法的锁不被判 corrupt 且可复用', async () => {
		const root = tempRoot();
		const aliasDir = tempRoot('ratel-alias-');
		const alias = path.join(aliasDir, 'link-to-root');
		fs.symlinkSync(root, alias, 'dir');
		expect(normalizeIndexRootKey(alias)).toBe(normalizeIndexRootKey(root));

		// 关键路径(I6):旧版本可能按符号链接写法存 root;读取时不能因此判 corrupt。
		expect((await acquireOwnerLock({ root, instanceToken: 'alias-owner' })).record.instanceToken).toBe(
			'alias-owner',
		);
		writeLockJson(root, { root: alias, instanceToken: 'alias-owner' });
		const inspection = await inspectOwnerLock({ root: alias, instanceToken: 'alias-owner' });
		expect(inspection).toMatchObject({ state: 'held-by-us', reason: 'same-token' });

		// 旧写法的锁仍然可用:同令牌复用后按原文释放。
		const reused = await acquireOwnerLock({ root: alias, instanceToken: 'alias-owner' });
		await reused.release();
		expect(readLockRaw(root)).toBeNull();
	});

	it('大小写不同的写法 - 按平台决定是否命同一个根', async () => {
		const root = tempRoot();
		if (!caseInsensitivePlatform) {
			// Linux 等大小写敏感平台:两个真实不同的目录不能被合并成同一个身份。
			expect(normalizeIndexRootKey(root.toUpperCase())).not.toBe(normalizeIndexRootKey(root));
			return;
		}
		expect(normalizeIndexRootKey(root.toUpperCase())).toBe(normalizeIndexRootKey(root));
		// 关键路径(I6):大小写不敏感卷上,大小写写法的锁必须仍然被认成自己的锁。
		expect((await acquireOwnerLock({ root, instanceToken: 'case-owner' })).record.instanceToken).toBe(
			'case-owner',
		);
		writeLockJson(root, { root: root.toUpperCase(), instanceToken: 'case-owner' });
		expect(await inspectOwnerLock({ root, instanceToken: 'case-owner' })).toMatchObject({
			state: 'held-by-us',
		});
		const reused = await acquireOwnerLock({ root, instanceToken: 'case-owner' });
		await reused.release();
		expect(readLockRaw(root)).toBeNull();
	});

	it('锁记录根目录是另一个真实目录 - root-mismatch - 拒绝接管且不删除', async () => {
		const root = tempRoot();
		const other = tempRoot();
		const raw = writeLockJson(root, {
			root: normalizeIndexRootKey(other),
			instanceToken: 'other-root-owner',
			// 进程已退出也照样拒绝:根目录不符是坏锁,不是可回收锁。
			process: { pid: exitedPid(), hostname: os.hostname(), startTimeMs: null },
		});
		const inspection = await inspectOwnerLock({ root, instanceToken: 'owner-r' });
		expect(inspection).toMatchObject({ state: 'corrupt', reason: 'root-mismatch' });
		await expectRejection(acquireOwnerLock({ root, instanceToken: 'owner-r' }), 'owner-lock-corrupt');
		expect(readLockRaw(root)).toBe(raw);
	});

	it('锁由其他协调器版本写入 - owner-lock-version-mismatch - 拒绝接管且不删除', async () => {
		const root = tempRoot();
		const raw = writeLockJson(root, {
			coordinatorVersion: INDEX_WRITE_OWNER_COORDINATOR_VERSION - 1,
			instanceToken: 'old-coordinator',
			process: { pid: exitedPid(), hostname: os.hostname(), startTimeMs: null },
		});
		const inspection = await inspectOwnerLock({ root, instanceToken: 'owner-v' });
		expect(inspection).toMatchObject({ state: 'version-mismatch', reason: 'coordinator-version-mismatch' });
		await expectRejection(acquireOwnerLock({ root, instanceToken: 'owner-v' }), 'owner-lock-version-mismatch');
		expect(readLockRaw(root)).toBe(raw);
	});

	it('根目录为空或含 NUL - root-invalid', async () => {
		expectThrow(() => normalizeIndexRoot(''), 'root-invalid');
		expectThrow(() => normalizeIndexRoot('bad\0root'), 'root-invalid');
		expectThrow(() => normalizeIndexRootKey(''), 'root-invalid');
		expectThrow(() => getWriteOwnerCoordinator(''), 'root-invalid');
		await expectRejection(inspectOwnerLock({ root: '', instanceToken: 'owner-r' }), 'root-invalid');
		await expectRejection(acquireOwnerLock({ root: '', instanceToken: 'owner-r' }), 'root-invalid');
		await expectRejection(enterOwnerRecoveryGate({ root: '', instanceToken: 'owner-r' }), 'root-invalid');
	});

	it('实例令牌为空 - instance-token-invalid', async () => {
		const root = tempRoot();
		await expectRejection(inspectOwnerLock({ root, instanceToken: '' }), 'instance-token-invalid');
		await expectRejection(acquireOwnerLock({ root, instanceToken: '' }), 'instance-token-invalid');
		await expectRejection(enterOwnerRecoveryGate({ root, instanceToken: '' }), 'instance-token-invalid');
		await expectRejection(
			getWriteOwnerCoordinator(root).acquire({ instanceToken: '' }),
			'instance-token-invalid',
		);
	});

	it('真实 fs 错误 - 根目录位置是文件 - 收敛为 owner-lock-write-failed 并保留 errno', async () => {
		const parent = tempRoot();
		const notADirectory = path.join(parent, 'not-a-directory');
		fs.writeFileSync(notADirectory, 'x', 'utf8');

		const readFailed = await catchError(acquireOwnerLock({ root: notADirectory, instanceToken: 'owner-f' }));
		expect(readFailed.code).toBe('owner-lock-write-failed');
		expect(readFailed.detail.errno).toBe('ENOTDIR');
		expect(readFailed.cause).toBeInstanceOf(Error);

		// 创建根目录失败(mkdir 命中同名文件)同样收敛为稳定错误码。
		const mkdirFailed = await catchError(
			enterOwnerRecoveryGate({ root: notADirectory, instanceToken: 'owner-f' }),
		);
		expect(mkdirFailed.code).toBe('owner-lock-write-failed');
		expect(mkdirFailed.detail.errno).toBe('EEXIST');
	});

	it('fs errno 映射表 - 集中声明且未列出的 errno 收敛为 owner-lock-write-failed', () => {
		for (const code of Object.values(OWNER_IO_ERROR_CODE_BY_ERRNO)) {
			expect(INDEX_WRITE_OWNER_ERROR_CODES).toContain(code);
		}
		const enospc = Object.assign(new Error('no space'), { code: 'ENOSPC' });
		const mapped = toOwnerIoError(enospc, '写入索引锁', { path: '/tmp/x' });
		expect(mapped.code).toBe('owner-lock-no-space');
		expect(mapped.detail).toMatchObject({ errno: 'ENOSPC', action: '写入索引锁' });
		expect(mapped.cause).toBe(enospc);

		const readonlyFs = toOwnerIoError(Object.assign(new Error('ro'), { code: 'EROFS' }), '写入', {});
		expect(readonlyFs.code).toBe('owner-lock-read-only-fs');

		const unmapped = toOwnerIoError(Object.assign(new Error('not a dir'), { code: 'ENOTDIR' }), '读取', {});
		expect(unmapped.code).toBe('owner-lock-write-failed');
		expect(unmapped.detail.errno).toBe('ENOTDIR');

		const noErrno = toOwnerIoError(new Error('boom'), '读取索引锁', { path: '/tmp/x' });
		expect(noErrno).toBeInstanceOf(IndexWriteOwnerError);
		expect(noErrno.code).toBe('owner-lock-write-failed');
		expect(noErrno.detail.errno).toBeNull();
	});
});
