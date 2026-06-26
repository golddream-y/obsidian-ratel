/**
 * @file src/core/hooks.ts
 * @description HookRegistry — 知识治理钩子注册中心,按阶段(phase)组织 pre/post 钩子。
 * @module core/hooks
 * @depends ../ports/llm
 */

import type { ToolCall } from '../ports/llm';
import { devLogger } from '../logging/dev-logger';

/**
 * Hook 执行结果。
 * - void / undefined:放行(无意见)
 * - { allow: false, reason: string }:阻断
 * - { allow: true }:显式放行
 */
export type HookResult = { allow: boolean; reason?: string } | void;

export interface HookDecision {
	allowed: boolean;
	deniedBy?: string;
	reason?: string;
}

/**
 * 钩子注册表。
 */
export class HookRegistry {
	private handlers = new Map<string, Array<(toolCall: ToolCall) => Promise<HookResult>>>();
	private handlerIds = new Map<string, string[]>();

	register(
		phase: string,
		handler: (toolCall: ToolCall) => Promise<HookResult>,
		id?: string,
	): void {
		const list = this.handlers.get(phase) ?? [];
		list.push(handler);
		this.handlers.set(phase, list);
		if (id) {
			const ids = this.handlerIds.get(phase) ?? [];
			ids.push(id);
			this.handlerIds.set(phase, ids);
		}
	}

	async run(phase: string, toolCall: ToolCall): Promise<HookDecision> {
		const list = this.handlers.get(phase) ?? [];
		const ids = this.handlerIds.get(phase) ?? [];
		for (let i = 0; i < list.length; i++) {
			const handler = list[i]!;
			try {
				const result = await handler(toolCall);
				if (result && result.allow === false) {
					return {
						allowed: false,
						deniedBy: ids[i] ?? `hook-${i}`,
						reason: result.reason ?? '工具调用被钩子拒绝',
					};
				}
			} catch (err) {
				devLogger.error('hooks', `Hook error in ${phase}`, err);
			}
		}
		return { allowed: true };
	}

	/** 向后兼容:不阻断的阶段(post-tool-use 等) */
	async runVoid(phase: string, toolCall: ToolCall): Promise<void> {
		await this.run(phase, toolCall);
	}
}
