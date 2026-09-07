/**
 * @file src/tools/manage-goal.ts
 * @description `manage_goal` 工具 — 单工具多 action 管理 Agent 目标(S-GOAL spec 4.10)
 * @module tools/manage-goal
 * @depends core/goal-store, core/goal-grant, i18n
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import {
	GoalStore,
	GOAL_ACTIVE_ELSEWHERE,
	type AgentGoal,
	type GoalPredicate,
} from '../core/goal-store';
import { validateGrantGlobs } from '../core/goal-grant';
import { tNow } from '../i18n';
import { isSlashGoalCreateTurn } from '../ui/chat/input/slash-commands';

/** manage_goal action 清单 — 无 archive(spec v1.4) */
export const MANAGE_GOAL_ACTIONS = [
	'create',
	'update',
	'list',
	'pause',
	'resume',
	'cancel',
	'complete',
] as const;

export type ManageGoalAction = (typeof MANAGE_GOAL_ACTIONS)[number];

/** create Modal 入参草稿 — Task 7 Modal 与单测共用 */
export interface GoalCreateDraft {
	objective: string;
	criteriaText: string;
	maxRounds?: number;
	grant?: string[] | null;
	predicate?: GoalPredicate;
	/** 始终建议激活 — v1.6 无「仅排队」入口,保留字段给 Modal 兼容 */
	suggestActivate: boolean;
}

/** create Modal 确认结果 */
export interface GoalCreateConfirmResult {
	confirmed: boolean;
	activate?: boolean;
	objective?: string;
	criteriaText?: string;
	maxRounds?: number;
	grant?: string[] | null;
	predicate?: GoalPredicate;
}

/** 动作内确认回调 — resume/cancel/complete 用;create 用 promptCreate */
export interface ManageGoalPrompts {
	promptCreate: (draft: GoalCreateDraft) => Promise<GoalCreateConfirmResult>;
	promptConfirm: (opts: {
		action: 'resume' | 'cancel' | 'complete';
		goal: AgentGoal;
	}) => Promise<boolean>;
	/** 终态收口后三选一/二选一 Modal(spec 4.9) */
	onTerminal?: (goal: AgentGoal, kind: 'completed' | 'cancelled') => void | Promise<void>;
}

/**
 * 构造 `manage_goal` 工具。
 *
 * 设计要点:
 * - create 对话确认后才落盘,斜杠同回合硬拒(spec 4.3)
 * - 已有未完成目标时 create 不落盘,返回冲突短句(v1.6 无用户可见排队)
 * - predicate 型 complete 由 runner 收口,工具直接拒绝
 *
 * @param goalStore - Goal 存储
 * @param definition - LLM schema
 * @param getSessionId - 当前 chat 会话 id(getter,避免 onload 注册时拍死)
 * @param prompts - Modal 回调(单测注入 stub;create 不再调用 promptCreate)
 * @param defaultMaxRounds - 默认回合上限(来自 settings.goalMaxRounds)
 * @param getLastUserText - 本轮用户原文;斜杠同回合硬拒 create
 */
export function createManageGoalTool(
	goalStore: GoalStore,
	definition: ToolDefinition,
	getSessionId: () => string,
	prompts: ManageGoalPrompts,
	defaultMaxRounds: () => number,
	getLastUserText?: () => string,
): Tool {
	return {
		definition,
		readOnly: false,
		async execute(args: Record<string, unknown>) {
			const sessionId = getSessionId();
			const action = parseAction(args.action);
			switch (action) {
				case 'create':
					return handleCreate(
						goalStore,
						sessionId,
						args,
						defaultMaxRounds,
						getLastUserText,
					);
				case 'update':
					return handleUpdate(goalStore, args);
				case 'list':
					return handleList(goalStore);
				case 'pause':
					return handlePause(goalStore, args);
				case 'resume':
					return handleResume(goalStore, sessionId, args, prompts);
				case 'cancel':
					return handleCancel(goalStore, args, prompts);
				case 'complete':
					return handleComplete(goalStore, args, prompts);
				default:
					throw new Error(tNow('goal.error.invalidAction', { action: String(args.action) }));
			}
		},
	};
}

function parseAction(raw: unknown): ManageGoalAction {
	if (typeof raw !== 'string' || !MANAGE_GOAL_ACTIONS.includes(raw as ManageGoalAction)) {
		throw new Error(tNow('goal.error.invalidAction', { action: String(raw) }));
	}
	return raw as ManageGoalAction;
}

function assertCriteria(objective: string, criteriaText: string): void {
	const trimmed = criteriaText.trim();
	if (!trimmed) {
		throw new Error(tNow('goal.error.criteriaEmpty'));
	}
	if (trimmed === objective.trim()) {
		throw new Error(tNow('goal.error.criteriaSameAsObjective'));
	}
}

/**
 * 斜杠立目标时的默认完成标准 — 必须与 objective 不同,否则 store 拒收。
 *
 * @param objective - 用户写下的目标陈述
 */
export function defaultGoalCriteriaFromObjective(objective: string): string {
	return tNow('goal.slash.defaultCriteria', { objective: objective.trim() });
}


function parsePredicate(args: Record<string, unknown>): GoalPredicate | undefined {
	const pred = args.predicate;
	if (!pred || typeof pred !== 'object') return undefined;
	const p = pred as Record<string, unknown>;
	if (p.kind !== 'frontmatter-all') return undefined;
	if (typeof p.pathGlob !== 'string' || typeof p.property !== 'string') return undefined;
	return { kind: 'frontmatter-all', pathGlob: p.pathGlob, property: p.property };
}

function parseGrant(args: Record<string, unknown>): string[] | null {
	if (args.grant == null) return null;
	if (!Array.isArray(args.grant)) {
		throw new Error(tNow('goal.error.invalidGrant'));
	}
	const globs = args.grant.filter((g): g is string => typeof g === 'string');
	if (globs.length) validateGrantGlobs(globs);
	return globs.length ? globs : null;
}

async function requireGoal(store: GoalStore, goalId: unknown): Promise<AgentGoal> {
	if (typeof goalId !== 'string' || !goalId) {
		throw new Error(tNow('goal.error.goalNotFound', { id: String(goalId) }));
	}
	const goal = await store.get(goalId);
	if (!goal || goal.status === 'completed' || goal.status === 'cancelled') {
		throw new Error(tNow('goal.error.goalNotFound', { id: goalId }));
	}
	return goal;
}

async function handleCreate(
	store: GoalStore,
	sessionId: string,
	args: Record<string, unknown>,
	defaultMaxRounds: () => number,
	getLastUserText?: () => string,
): Promise<string> {
	const objective = typeof args.objective === 'string' ? args.objective.trim() : '';
	if (!objective) {
		throw new Error(tNow('goal.error.objectiveEmpty'));
	}
	const criteriaText = typeof args.criteriaText === 'string' ? args.criteriaText : '';
	assertCriteria(objective, criteriaText);
	const grant = parseGrant(args);
	const predicate = parsePredicate(args);
	const maxRounds =
		typeof args.maxRounds === 'number' && args.maxRounds > 0
			? args.maxRounds
			: defaultMaxRounds();

	const incomplete = await store.findIncomplete();
	if (incomplete) {
		return tNow('goal.tool.createBlocked', { current: incomplete.objective });
	}

	const lastUser = getLastUserText?.() ?? '';
	if (isSlashGoalCreateTurn(lastUser)) {
		return tNow('goal.tool.createNeedConfirm');
	}

	return commitGoalCreate(
		store,
		sessionId,
		{
			confirmed: true,
			activate: true,
			objective,
			criteriaText,
			maxRounds,
			grant,
			predicate,
		},
		{ objective, criteriaText, maxRounds, grant, predicate },
	);
}

/** 斜杠 `/goal` 与 manage_goal create 共用的落盘 — Modal 确认后才写 store */
export interface GoalCreateSeed {
	objective: string;
	criteriaText: string;
	maxRounds: number;
	grant: string[] | null;
	predicate?: GoalPredicate;
}

/**
 * 把创建表单确认结果写入 GoalStore。
 *
 * @param store - Goal 存储
 * @param sessionId - 当前 chat 会话;激活时绑定
 * @param confirmed - Modal 结果
 * @param seed - Modal 打开前的草稿,字段被确认结果覆盖
 * @returns 给模型或 Notice 的短句
 * @throws 陈述为空、完成标准不合规、grant 非法
 */
export async function commitGoalCreate(
	store: GoalStore,
	sessionId: string,
	confirmed: GoalCreateConfirmResult,
	seed: GoalCreateSeed,
): Promise<string> {
	if (!confirmed.confirmed || confirmed.activate === false) {
		return tNow('goal.tool.createCancelled');
	}

	const incomplete = await store.findIncomplete();
	if (incomplete) {
		throw new Error(tNow('goal.error.incompleteExists', { current: incomplete.objective }));
	}

	const finalObjective = (confirmed.objective ?? seed.objective).trim();
	if (!finalObjective) {
		throw new Error(tNow('goal.error.objectiveEmpty'));
	}
	const finalCriteria = (confirmed.criteriaText ?? seed.criteriaText).trim();
	assertCriteria(finalObjective, finalCriteria);
	const finalGrant = confirmed.grant !== undefined ? confirmed.grant : seed.grant;
	if (finalGrant?.length) validateGrantGlobs(finalGrant);
	const finalPredicate = confirmed.predicate ?? seed.predicate;
	const finalMaxRounds = confirmed.maxRounds ?? seed.maxRounds;

	const completionCriteria = finalPredicate
		? { text: finalCriteria, predicate: finalPredicate }
		: { text: finalCriteria };

	const goal = await store.create({
		objective: finalObjective,
		completionCriteria,
		maxRounds: finalMaxRounds,
		grant: finalGrant,
		birthSessionId: sessionId,
		status: 'pending',
	});

	if (sessionId) {
		await store.activate(goal.id, sessionId);
		return tNow('goal.tool.createdActive', { objective: finalObjective });
	}
	return tNow('goal.tool.createdPending', { objective: finalObjective });
}

async function handleUpdate(store: GoalStore, args: Record<string, unknown>): Promise<string> {
	const goal = await requireGoal(store, args.goalId);
	if (goal.status !== 'active') {
		throw new Error(tNow('goal.error.notActive', { id: goal.id }));
	}
	const patch: { progressNote?: string; usage?: AgentGoal['usage'] } = {};
	if (typeof args.progressNote === 'string') {
		patch.progressNote = args.progressNote;
	}
	const usage = args.usage;
	if (usage && typeof usage === 'object') {
		const u = usage as Record<string, unknown>;
		if (typeof u.inputTokens === 'number' && typeof u.outputTokens === 'number') {
			patch.usage = { inputTokens: u.inputTokens, outputTokens: u.outputTokens };
		}
	}
	if (!patch.progressNote && !patch.usage) {
		throw new Error(tNow('goal.error.nothingToUpdate'));
	}
	await store.update(goal.id, patch);
	return tNow('goal.tool.updated', { id: goal.id });
}

async function handleList(store: GoalStore): Promise<string> {
	const goals = await store.list();
	if (!goals.length) {
		return tNow('goal.tool.listEmpty');
	}
	const lines = goals.map(
		(g) =>
			`- [${g.status}] ${g.objective} (id=${g.id}, rounds=${g.roundsDone}/${g.maxRounds})`,
	);
	return lines.join('\n');
}

async function handlePause(store: GoalStore, args: Record<string, unknown>): Promise<string> {
	const goal = await requireGoal(store, args.goalId);
	await store.transition(goal.id, 'paused');
	return tNow('goal.tool.paused', { objective: goal.objective });
}

async function handleResume(
	store: GoalStore,
	sessionId: string,
	args: Record<string, unknown>,
	prompts: ManageGoalPrompts,
): Promise<string> {
	const goal = await requireGoal(store, args.goalId);
	const ok = await prompts.promptConfirm({ action: 'resume', goal });
	if (!ok) {
		return tNow('goal.tool.actionCancelled');
	}
	try {
		await store.activate(goal.id, sessionId);
	} catch (err) {
		if (err instanceof Error && err.message === GOAL_ACTIVE_ELSEWHERE) {
			throw new Error(tNow('goal.error.activeElsewhere'));
		}
		throw err;
	}
	return tNow('goal.tool.resumed', { objective: goal.objective });
}

async function handleCancel(
	store: GoalStore,
	args: Record<string, unknown>,
	prompts: ManageGoalPrompts,
): Promise<string> {
	if (typeof args.goalId !== 'string' || !args.goalId) {
		throw new Error(tNow('goal.error.goalNotFound', { id: String(args.goalId) }));
	}
	const existing = await store.get(args.goalId);
	if (!existing) {
		throw new Error(tNow('goal.error.goalNotFound', { id: args.goalId }));
	}
	// 已放弃则幂等返回,避免模型连打两次 cancel 时放弃确认与归档弹窗来回叠
	if (existing.status === 'cancelled') {
		return tNow('goal.tool.cancelled', { objective: existing.objective });
	}
	const goal = existing.status === 'completed' ? null : existing;
	if (!goal) {
		throw new Error(tNow('goal.error.goalNotFound', { id: args.goalId }));
	}
	const ok = await prompts.promptConfirm({ action: 'cancel', goal });
	if (!ok) {
		return tNow('goal.tool.actionCancelled');
	}
	const updated = await store.transition(goal.id, 'cancelled');
	await prompts.onTerminal?.(updated, 'cancelled');
	return tNow('goal.tool.cancelled', { objective: goal.objective });
}

async function handleComplete(
	store: GoalStore,
	args: Record<string, unknown>,
	prompts: ManageGoalPrompts,
): Promise<string> {
	const goal = await requireGoal(store, args.goalId);
	if (goal.completionCriteria.predicate) {
		throw new Error(tNow('goal.error.predicateCompleteRejected'));
	}
	const ok = await prompts.promptConfirm({ action: 'complete', goal });
	if (!ok) {
		return tNow('goal.tool.actionCancelled');
	}
	const updated = await store.transition(goal.id, 'completed');
	await prompts.onTerminal?.(updated, 'completed');
	return tNow('goal.tool.completed', { objective: goal.objective });
}
