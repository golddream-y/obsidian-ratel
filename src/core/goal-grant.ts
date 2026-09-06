/**
 * @file src/core/goal-grant.ts
 * @description Goal grant 白名单评估 — 工具 × glob × 在场条件(S-GOAL spec 4.6)
 * @module core/goal-grant
 * @depends core/goal-store, utils/glob-to-regex, utils/path-safety
 */

import type { ToolCall } from '../ports/llm';
import type { GoalStore } from './goal-store';
import { globToRegex } from '../utils/glob-to-regex';
import { isExcludedVaultPath, validateVaultPath } from '../utils/path-safety';

/** grant 可放行的写侧工具白名单 */
export const GOAL_GRANTABLE_TOOLS = new Set(['write_note', 'edit_note', 'append_note']);

export interface GoalGrantCheckDeps {
	goalStore: GoalStore;
	currentSessionId: string;
}

/**
 * 校验 grant glob 列表 — 拒绝空、裸 **、裸 *、vault 根、穿越与绝对路径(F5/spec 4.6)。
 *
 * @param globs - 用户授权的 vault 相对路径 glob
 * @throws 非法 glob
 */
export function validateGrantGlobs(globs: string[]): void {
	if (!globs.length) {
		throw new Error('grant glob 不能为空');
	}
	for (const glob of globs) {
		const trimmed = glob.trim();
		if (!trimmed) {
			throw new Error('grant glob 不能为空字符串');
		}
		if (trimmed === '**' || trimmed === '*') {
			throw new Error(`非法 grant glob: ${glob}`);
		}
		if (trimmed.includes('..')) {
			throw new Error(`grant glob 禁止 .. 穿越: ${glob}`);
		}
		if (trimmed.startsWith('/') || /^[A-Za-z]:[/\\]/.test(trimmed)) {
			throw new Error(`grant glob 禁止绝对路径: ${glob}`);
		}
		// 关键路径:必须含具体目录前缀 — 首段为字面量目录名,拒绝 vault 根与裸 *
		const slashIdx = trimmed.indexOf('/');
		if (slashIdx === -1) {
			throw new Error(`grant glob 必须有目录前缀: ${glob}`);
		}
		const firstSegment = trimmed.slice(0, slashIdx);
		if (!firstSegment || /[*?]/.test(firstSegment)) {
			throw new Error(`grant glob 必须有目录前缀: ${glob}`);
		}
		if (trimmed.startsWith('**/')) {
			throw new Error(`grant glob 禁止 vault 根匹配: ${glob}`);
		}
	}
}

/**
 * 创建 goal grant 判定闭包 — 供 resolveToolPermission 第 5 参注入。
 *
 * 生效条件:绑定会话存在 active goal → 工具在白名单 → path 命中 grant glob → path-safety 通过。
 *
 * @param deps - goalStore 与当前会话 id
 * @returns 对 ToolCall 返回是否 goal grant 放行
 */
export function createGoalGrantCheck(deps: GoalGrantCheckDeps): (toolCall: ToolCall) => boolean {
	return (toolCall: ToolCall) => {
		if (!GOAL_GRANTABLE_TOOLS.has(toolCall.name)) {
			return false;
		}
		const goal = deps.goalStore.getBoundActive(deps.currentSessionId);
		if (!goal || goal.status !== 'active' || !goal.grant?.length) {
			return false;
		}
		const pathArg = toolCall.args.path;
		if (typeof pathArg !== 'string' || !pathArg) {
			return false;
		}
		try {
			const normalized = validateVaultPath(pathArg);
			if (isExcludedVaultPath(normalized)) {
				return false;
			}
			return goal.grant.some((glob) => globToRegex(glob).test(normalized));
		} catch {
			return false;
		}
	};
}
