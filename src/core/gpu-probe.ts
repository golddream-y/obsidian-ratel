/**
 * @file src/core/gpu-probe.ts
 * @description GPU 嵌入 Worker 探测判定 — 把消息归约为「可用 / 不可用 / 继续等」
 * @module core/gpu-probe
 *
 * 关键路径(2026-11-09 现场):
 * - 预热失败意味着「这个执行器跑不通推理」，必须判为不可用并回退；
 * - 曾经的实现把 `warmup:error` 也判成成功，等于把一个坏掉的 GPU 实例投入使用 ——
 *   之后每次索引都在 `OrtRun` 里失败或挂起，表现为请求等到 120 秒超时、Worker 反复重建。
 * - 现场证据:`Failed to wait for the operation:3`(WebGPU 等待操作失败)。
 */

/** 探测期可能收到的消息（只保留判定需要的字段）。 */
export interface GpuProbeMessage {
	/** 消息类型:ready / error / warmup:done / warmup:error。 */
	type: string;
	/** 失败原因，`error` 与 `warmup:error` 携带。 */
	error?: string;
}

/** 判定结果。 */
export interface GpuProbeVerdict {
	/** 是否已经可以下结论；false 表示还需要继续等后续消息。 */
	decided: boolean;
	/** 结论为可用时 true。`decided` 为 false 时无意义。 */
	usable: boolean;
	/** 不可用时的开发向原因。 */
	reason?: string;
}

/**
 * 把一条探测消息归约为判定结果。
 *
 * @param message - 来自 GPU 探测 Worker 的消息。
 * @returns 判定结果。
 */
export function judgeGpuProbeMessage(message: GpuProbeMessage): GpuProbeVerdict {
	switch (message.type) {
		case 'ready':
			// 只能说「已装载」，不能说「能推理」—— 必须等预热给出实测结果。
			return { decided: false, usable: false };
		case 'warmup:done':
			return { decided: true, usable: true };
		case 'warmup:error':
			// 关键路径:预热失败 = 执行器不可用。这里判成功是本缺陷的源头。
			return { decided: true, usable: false, reason: `GPU 预热失败:${message.error ?? 'unknown'}` };
		case 'error':
			return { decided: true, usable: false, reason: `GPU 嵌入 Worker 初始化失败:${message.error ?? 'unknown'}` };
		default:
			return { decided: false, usable: false };
	}
}
