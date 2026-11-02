/**
 * @file src/worker/index-runtime-protocol.ts
 * @description 索引运行时跨线程协议 — 信封、grant、控制消息与幂等结算的唯一声明
 * @module src/worker/index-runtime-protocol
 *
 * 关键路径:
 * - 只传可结构化克隆的数据:函数、类实例、AbortSignal 一律不进信封。
 * - 每个请求必须恰好结算一次:重复响应、超时后的迟到响应、Worker 退出都不能二次结算。
 * - 载荷按估算字节计费,超预算的请求在发出前拒绝,避免一次大消息挤占通道。
 * - 协议版本不匹配直接拒绝,不做兼容猜测。
 */

/** 协议版本;存储格式与内容指纹不受它影响。 */
export const INDEX_RUNTIME_PROTOCOL_VERSION = 1 as const;

/** 运行时执行权描述。 */
export interface IndexRuntimeGrant {
	protocolVersion: typeof INDEX_RUNTIME_PROTOCOL_VERSION;
	runtimeId: string;
	epoch: number;
	generationId: string;
	indexRoot: string;
	generationRoot: string;
	access: 'read-only' | 'read-write';
}

/** 控制消息种类。 */
export type IndexControlKind =
	| 'revoke'
	| 'cancel'
	| 'close'
	| 'revoked-and-drained'
	| 'cancel-ack';

/** 宿主 → Worker 的请求。 */
export interface IndexRuntimeRequest {
	kind: 'request';
	protocolVersion: typeof INDEX_RUNTIME_PROTOCOL_VERSION;
	runtimeId: string;
	epoch: number;
	requestId: string;
	method: string;
	payload?: unknown;
}

/** Worker → 宿主的响应。 */
export interface IndexRuntimeResponse {
	kind: 'response';
	protocolVersion: typeof INDEX_RUNTIME_PROTOCOL_VERSION;
	runtimeId: string;
	epoch: number;
	requestId: string;
	ok: boolean;
	result?: unknown;
	error?: string;
}

/** 控制消息;不携带业务载荷。 */
export interface IndexRuntimeControl {
	kind: 'control';
	protocolVersion: typeof INDEX_RUNTIME_PROTOCOL_VERSION;
	runtimeId: string;
	epoch: number;
	control: IndexControlKind;
	requestId?: string;
	reason?: string;
}

/** Worker → 宿主的反向调用(例如请求一批嵌入向量)。 */
export interface IndexRuntimeCall {
	kind: 'call';
	protocolVersion: typeof INDEX_RUNTIME_PROTOCOL_VERSION;
	runtimeId: string;
	epoch: number;
	callId: string;
	method: string;
	payload?: unknown;
}

/** 宿主对反向调用的应答。 */
export interface IndexRuntimeCallResult {
	kind: 'call-result';
	protocolVersion: typeof INDEX_RUNTIME_PROTOCOL_VERSION;
	runtimeId: string;
	epoch: number;
	callId: string;
	ok: boolean;
	result?: unknown;
	error?: string;
}

/** 协议消息全集。 */
export type IndexRuntimeMessage =
	| IndexRuntimeRequest
	| IndexRuntimeResponse
	| IndexRuntimeControl
	| IndexRuntimeCall
	| IndexRuntimeCallResult;

/** 单条消息载荷上限（估算字节）。 */
export const MAX_MESSAGE_BYTES = 24 * 1024 * 1024;

/** 判断值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 判断是否为受支持的控制动作。 */
export function isControlKind(value: unknown): value is IndexControlKind {
	return value === 'revoke' || value === 'cancel' || value === 'close'
		|| value === 'revoked-and-drained' || value === 'cancel-ack';
}

/**
 * 校验一条入站消息。
 * @param value 待校验的值
 * @returns 合法时为消息本身,否则为 `null`
 */
export function parseRuntimeMessage(value: unknown): IndexRuntimeMessage | null {
	if (!isRecord(value)) return null;
	if (value.protocolVersion !== INDEX_RUNTIME_PROTOCOL_VERSION) return null;
	if (typeof value.runtimeId !== 'string' || value.runtimeId.length === 0) return null;
	if (typeof value.epoch !== 'number' || !Number.isInteger(value.epoch) || value.epoch < 0) return null;

	if (value.kind === 'request') {
		if (typeof value.requestId !== 'string' || typeof value.method !== 'string') return null;
		return value as unknown as IndexRuntimeRequest;
	}
	if (value.kind === 'response') {
		if (typeof value.requestId !== 'string' || typeof value.ok !== 'boolean') return null;
		return value as unknown as IndexRuntimeResponse;
	}
	if (value.kind === 'control') {
		if (!isControlKind(value.control)) return null;
		return value as unknown as IndexRuntimeControl;
	}
	if (value.kind === 'call') {
		if (typeof value.callId !== 'string' || typeof value.method !== 'string') return null;
		return value as unknown as IndexRuntimeCall;
	}
	if (value.kind === 'call-result') {
		if (typeof value.callId !== 'string' || typeof value.ok !== 'boolean') return null;
		return value as unknown as IndexRuntimeCallResult;
	}
	return null;
}

/**
 * 估算载荷字节数:字符串按 UTF-16 长度,数组/对象递归累加,其余按 8 字节。
 * 只用于背压预算,不追求精确序列化尺寸。
 */
export function estimatePayloadBytes(payload: unknown, depth = 0): number {
	if (depth > 8) return 0;
	if (payload === null || payload === undefined) return 0;
	if (typeof payload === 'string') return payload.length * 2;
	if (typeof payload === 'number' || typeof payload === 'boolean') return 8;
	if (Array.isArray(payload)) {
		let total = 0;
		for (const item of payload) total += estimatePayloadBytes(item, depth + 1);
		return total;
	}
	if (isRecord(payload)) {
		let total = 0;
		for (const key of Object.keys(payload)) {
			total += key.length * 2 + estimatePayloadBytes(payload[key], depth + 1);
		}
		return total;
	}
	return 8;
}

/** 恰好一次的结算守卫。 */
export class SettleOnce {
	private settled = false;

	/** 是否已结算。 */
	get isSettled(): boolean {
		return this.settled;
	}

	/**
	 * 首次调用执行结算,之后返回 false。
	 * @param settle 结算动作
	 */
	settle(settle: () => void): boolean {
		if (this.settled) return false;
		this.settled = true;
		settle();
		return true;
	}
}
