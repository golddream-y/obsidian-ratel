/**
 * @file src/worker/index-runtime-entry.ts
 * @description 索引运行时 Worker 入口 — 等待 init 授权,再以受限文件能力提供服务
 * @module src/worker/index-runtime-entry
 *
 * 关键路径:
 * - Worker 启动后**不立即读写**:必须先收到 init 帧(grant + 索引根),否则一律忽略。
 * - 只读模式在处理器层拒绝一切写入,不能只靠上层不调用;关闭自动索引时要保证零写入。
 * - 文件能力来自 Worker 作用域的 Node 集成,由调用方注入 `require`,便于 Node 测试替换。
 * - 撤销后服务循环回报 drained,宿主据此转交写入权。
 */

import { serveRuntime, type RuntimeHandlers, type RuntimeServer, type RuntimeServerPort } from './index-runtime-worker';
import { createIndexSessionHandlers } from './index-runtime-session';
import { createTokenCounter, TOKEN_BUDGET_RESERVE } from '../core/token-counter';
import { DEFAULT_CHUNK_OVERLAP } from './chunker';
import {
	createIndexRuntimeHandlers,
	type RuntimeFileSystem,
} from './index-runtime-fs-handlers';

/** Worker 作用域的最小接口。 */
export interface RuntimeWorkerScope {
	postMessage(message: unknown): void;
	onmessage: ((event: { data: unknown }) => void) | null;
}

/** 初始化帧 —— 不属于运行时协议,单独一帧且只接受一次。 */
export interface RuntimeInitMessage {
	kind: 'init';
	runtimeId: string;
	epoch: number;
	root: string;
	access: 'read-only' | 'read-write';
	/** 分块预算;缺省按模型输入上限留出保留区。 */
	chunkOptions?: { maxTokens?: number; overlapTokens?: number };
	/**
	 * 本地词表内容(vocab.txt)。
	 *
	 * 关键路径:分块的 token 计数必须与主线程用同一套词表,否则同一条配置在
	 * 线程模式与主线程模式会切出不同的块 —— 索引结果不严格等价,切换模式后
	 * 完成记录的内容哈希对不上,表现为整库重索引。
	 */
	vocabContent?: string;
}

/** 判断是否为 init 帧。 */
export function isInitMessage(value: unknown): value is RuntimeInitMessage {
	const record = value as Record<string, unknown> | null;
	return record !== null
		&& record.kind === 'init'
		&& typeof record.runtimeId === 'string'
		&& typeof record.epoch === 'number'
		&& typeof record.root === 'string'
		&& (record.access === 'read-only' || record.access === 'read-write');
}

/** 只读模式禁止的写方法。 */
const WRITE_METHODS = new Set(['fs.write', 'fs.mkdir', 'fs.rename', 'fs.remove', 'fs.syncDir']);

/** 只读模式下包裹处理器,写入直接拒绝。 */
export function guardReadOnly(handlers: RuntimeHandlers): RuntimeHandlers {
	const guarded: RuntimeHandlers = {};
	for (const [method, handler] of Object.entries(handlers)) {
		guarded[method] = WRITE_METHODS.has(method)
			? () => { throw new Error('只读运行时拒绝写入'); }
			: handler;
	}
	return guarded;
}

/** 入口句柄。 */
export interface IndexRuntimeEntry {
	/** 初始化完成;未收到 init 时一直挂起。 */
	readonly ready: Promise<void>;
	/** 当前服务循环;未初始化时为 null。 */
	server(): RuntimeServer | null;
	/** 停止并关闭端口。 */
	dispose(): void;
}

/**
 * 启动 Worker 入口:等 init 帧,装配受限处理器并开始服务。
 * @param options.scope Worker 作用域(生产为 self)
 * @param options.requireFn Node 模块加载函数(生产为 Worker 作用域的 require)
 * @param options.fsOverride 测试注入的文件系统
 */
export function startIndexRuntimeWorker(options: {
	scope: RuntimeWorkerScope;
	requireFn?: (id: string) => unknown;
	fsOverride?: RuntimeFileSystem;
}): IndexRuntimeEntry {
	const { scope } = options;
	let server: RuntimeServer | null = null;
	let initialized = false;
	let resolveReady!: () => void;
	const ready = new Promise<void>((resolve) => { resolveReady = resolve; });

	const port: RuntimeServerPort = {
		postMessage: (message) => scope.postMessage(message),
		onmessage: null,
	};

	scope.onmessage = (event) => {
		const data = event.data as Record<string, unknown> | null;
		if (!initialized && isInitMessage(data)) {
			initialized = true;
			const grant = { runtimeId: data.runtimeId, epoch: data.epoch };
			const baseHandlers = createIndexRuntimeHandlers({
				fs: options.fsOverride ?? loadNodeFileSystem(options.requireFn),
				root: data.root,
			});
			// 关键路径:只读模式不装配索引入口 —— 关闭自动索引时必须零写入,不能靠上层不调用。
			// 关键路径:事件出口要用服务循环的 send,而服务循环又需要 handlers ——
			// 先占位,创建 server 之后立刻接上真实实现。
			let emitEvent: (type: string, payload?: unknown) => void = () => {};
			const handlers: RuntimeHandlers = data.access === 'read-only'
				? guardReadOnly(baseHandlers)
				: {
					...baseHandlers,
					...createIndexSessionHandlers({
						root: data.root,
						chunkOptions: resolveChunkOptions(data.chunkOptions, data.vocabContent),
						emit: (type, payload) => emitEvent(type, payload),
					}),
				};
			const sessionClose = handlers['session.close'];
			const runtime = serveRuntime({
				port,
				grant,
				handlers,
				// 关键路径:撤销时先关会话 —— 写权与存储句柄必须随运行时一起释放,
				// 不能等宿主停掉线程才发现还有在途写。
				onRevoked: async () => {
					try {
						await sessionClose?.({});
					} catch {
						// 关闭失败不阻止回报 drained;写权已由运行时撤销。
					}
				},
			});
			// 关键路径:接上真实的事件出口(此时 server 已存在)。
			emitEvent = (type, payload) => runtime.emit(type, payload);
			server = runtime;
			resolveReady();
			return;
		}
		// 未初始化前的任何请求都不处理:没有 grant 就没有可操作的范围。
		port.onmessage?.(event);
	};

	return {
		ready,
		server: () => server,
		dispose: () => {
			scope.onmessage = null;
		},
	};
}

/**
 * 构造分块参数 — count 是函数,不能过 postMessage,必须在 Worker 内部构造。
 *
 * 关键路径:必须带上本地词表做 token 计数。早先传 `null` 会退化成字符计数,
 * 与主线程模式的 token 计数不一致,同一条 chunkSize 在两种模式下切出的块不同。
 */
export function resolveChunkOptions(
	overrides?: { maxTokens?: number; overlapTokens?: number },
	vocabContent?: string,
): { maxTokens: number; overlapTokens: number; count: (text: string) => number } {
	const counter = createTokenCounter(vocabContent ?? null);
	return {
		maxTokens: overrides?.maxTokens ?? counter.maxInputTokens - TOKEN_BUDGET_RESERVE,
		overlapTokens: overrides?.overlapTokens ?? DEFAULT_CHUNK_OVERLAP,
		count: (text: string) => counter.count(text),
	};
}

/** 用 Worker 作用域的 require 组装文件系统。 */
export function loadNodeFileSystem(requireFn?: (id: string) => unknown): RuntimeFileSystem {
	if (requireFn === undefined) throw new Error('索引线程缺少 Node 文件能力');
	const fsp = requireFn('node:fs/promises') as typeof import('node:fs/promises');
	const nodePath = requireFn('node:path') as typeof import('node:path');

	return {
		readFile: (target) => fsp.readFile(target, 'utf8'),
		writeFile: async (target, data) => {
			// 关键路径:同目录临时文件 + rename,半写内容不会出现在最终路径。
			const temp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
			const handle = await fsp.open(temp, 'w');
			try {
				await handle.write(data);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await fsp.rename(temp, target);
			await syncDirectory(fsp, nodePath.dirname(target));
		},
		rename: (from, to) => fsp.rename(from, to),
		stat: async (target) => {
			try {
				const stats = await fsp.stat(target);
				return { size: stats.size, mtimeMs: stats.mtimeMs, isFile: stats.isFile(), isDirectory: stats.isDirectory() };
			} catch (error) {
				if ((error as { code?: string }).code === 'ENOENT') return null;
				throw error;
			}
		},
		readdir: (target) => fsp.readdir(target),
		mkdir: async (target) => { await fsp.mkdir(target, { recursive: true }); },
		remove: (target, recursive) => fsp.rm(target, { recursive, force: true }),
		syncDirectory: (target) => syncDirectory(fsp, target),
	};

	/** 目录 fsync;平台不支持时降级为成功,与原子存储一致。 */
	async function syncDirectory(targetFs: typeof import('node:fs/promises'), directory: string): Promise<void> {
		let handle: import('node:fs/promises').FileHandle | null = null;
		try {
			handle = await targetFs.open(directory, 'r');
			await handle.sync();
		} catch (error) {
			const code = (error as { code?: string }).code;
			if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR' && code !== 'EPERM') throw error;
		} finally {
			await handle?.close().catch(() => {});
		}
	}
}

// 关键路径:作为独立 Worker 产物执行时自举;在 Node 测试中 self 不存在,不触发。
if (typeof self !== 'undefined' && typeof (self as unknown as { postMessage?: unknown }).postMessage === 'function') {
	const scope = self as unknown as RuntimeWorkerScope;
	const loader = (self as unknown as { require?: (id: string) => unknown }).require;
	if (typeof loader === 'function') startIndexRuntimeWorker({ scope, requireFn: (id) => loader.call(self, id) });
}
