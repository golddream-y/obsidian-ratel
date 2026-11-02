/**
 * @file src/worker/index-runtime-worker.ts
 * @description 索引运行时 Worker 端 — 有界 RPC 服务循环、撤销与终态收敛
 * @module src/worker/index-runtime-worker
 *
 * 关键路径:
 * - 只处理通过协议校验、runtimeId/epoch 与当前 grant 一致的请求;未知请求一律回错误帧,不留悬挂。
 * - 撤销后不再受理新请求,并回报 `revoked-and-drained`,让宿主知道可以转交写入权。
 * - 每个请求只回一帧终态:成功或失败,不重复发送。
 * - 本文件不导入 Obsidian;文件与存储能力由上层注入,便于在 Node 测试与宿主内复用同一套循环。
 */

import {
	INDEX_RUNTIME_PROTOCOL_VERSION,
	parseRuntimeMessage,
	type IndexRuntimeControl,
	type IndexRuntimeMessage,
	type IndexRuntimeRequest,
	type IndexRuntimeResponse,
} from './index-runtime-protocol';

/** 可注入的线程端口。 */
export interface RuntimeServerPort {
	postMessage(message: unknown): void;
	onmessage: ((event: { data: unknown }) => void) | null;
}

/** 处理器集合:方法名 → 实现。 */
export type RuntimeHandlers = Record<string, (payload: unknown) => unknown>;

/** 服务配置。 */
export interface RuntimeServerOptions {
	/** 线程端口。 */
	port: RuntimeServerPort;
	/** grant 校验:必须与当前持有的一致。 */
	grant: { runtimeId: string; epoch: number };
	/** 业务处理器。 */
	handlers: RuntimeHandlers;
	/** 撤销回调;用于释放文件句柄与存储。 */
	onRevoked?: () => Promise<void> | void;
}

/** 运行时服务句柄。 */
export interface RuntimeServer {
	/** 是否已撤销。 */
	readonly revoked: boolean;
	/** 已处理的请求数。 */
	readonly served: number;
	/** 撤销并等待在途请求收敛。 */
	revoke(reason: string): Promise<void>;
}

/**
 * 启动服务循环。
 * @param options 端口、grant 与处理器
 */
export function serveRuntime(options: RuntimeServerOptions): RuntimeServer {
	const { port, grant, handlers, onRevoked } = options;
	let revoked = false;
	let served = 0;
	let drainPromise: Promise<void> | null = null;
	const inflight = new Set<string>();

	const send = (message: IndexRuntimeMessage): void => {
		try {
			port.postMessage(message);
		} catch {
			// 端口已关闭:不再重试,宿主退出由生命周期处理。
		}
	};

	const respond = (request: IndexRuntimeRequest, ok: boolean, result?: unknown, error?: string): void => {
		const response: IndexRuntimeResponse = {
			kind: 'response',
			protocolVersion: INDEX_RUNTIME_PROTOCOL_VERSION,
			runtimeId: request.runtimeId,
			epoch: request.epoch,
			requestId: request.requestId,
			ok,
			result,
			error,
		};
		send(response);
	};

	port.onmessage = (event) => {
		const message = parseRuntimeMessage(event.data);
		if (message === null) return;
		if (message.runtimeId !== grant.runtimeId || message.epoch !== grant.epoch) return;

		if (message.kind === 'control') {
			handleControl(message);
			return;
		}
		if (message.kind !== 'request') return;

		if (revoked) {
			respond(message, false, undefined, '运行时已撤销');
			return;
		}
		if (inflight.has(message.requestId)) return;
		const handler = handlers[message.method];
		if (handler === undefined) {
			respond(message, false, undefined, `未知方法: ${message.method}`);
			return;
		}

		inflight.add(message.requestId);
		served += 1;
		void Promise.resolve()
			.then(() => handler(message.payload))
			.then(
				(result) => respond(message, true, result),
				(error) => respond(message, false, undefined, error instanceof Error ? error.message : String(error)),
			)
			.finally(() => {
				inflight.delete(message.requestId);
			});
	};

	const doRevoke = (reason?: string): Promise<void> => {
		if (revoked) return drainPromise ?? Promise.resolve();
		revoked = true;
		drainPromise = Promise.resolve()
			.then(async () => { await onRevoked?.(); })
			.catch(() => {
				// 撤销回调失败不阻止回报终态:宿主需要知道写入权已不再持有。
			})
			.then(() => {
				send({
					kind: 'control',
					protocolVersion: INDEX_RUNTIME_PROTOCOL_VERSION,
					runtimeId: grant.runtimeId,
					epoch: grant.epoch,
					control: 'revoked-and-drained',
					reason,
				});
			});
		return drainPromise;
	};

	const handleControl = (message: IndexRuntimeControl): void => {
		if (message.control === 'revoke' || message.control === 'close') {
			void doRevoke(message.reason);
			return;
		}
		if (message.control === 'cancel' && message.requestId !== undefined) {
			// 关键路径:确认取消,宿主据此归还配额;实际中断由各处理器自己的取消语义负责。
			send({
				kind: 'control',
				protocolVersion: INDEX_RUNTIME_PROTOCOL_VERSION,
				runtimeId: grant.runtimeId,
				epoch: grant.epoch,
				control: 'cancel-ack',
				requestId: message.requestId,
			});
		}
	};

	return {
		get revoked(): boolean {
			return revoked;
		},
		get served(): number {
			return served;
		},
		revoke(reason: string): Promise<void> {
			return doRevoke(reason);
		},
	};
}
