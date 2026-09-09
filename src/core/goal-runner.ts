/**
 * @file src/core/goal-runner.ts
 * @description Goal 回合记账与收口 — finalizeRound、锚定与谓词评估(S-GOAL spec 4.4/4.8)
 * @module core/goal-runner
 * @depends core/goal-store, core/goal-guard, core/goal-grant, ports/vault, utils/glob-to-regex
 */

import type { AgentEvent } from '../types';
import type { VaultPort } from '../ports/vault';
import type { AgentGoal, GoalStore } from './goal-store';
import { evaluateNoProgress, checkBudgets, isGoalBudgetExhausted } from './goal-guard';
import { GOAL_GRANTABLE_TOOLS } from './goal-grant';
import { globToRegex } from '../utils/glob-to-regex';
import { tNow } from '../i18n';
import { devLogger } from '../logging/dev-logger';

const ANCHOR_MAX_BYTES = 2048;

/** 单轮统计 — 从 ask 事件流或 message.end 汇总 */
export interface RoundCollectedStats {
	promptTokens: number;
	completionTokens: number;
	grantWrites: number;
	grantWrittenPaths: string[];
	stepsUsed: number;
}

/** finalizeRound 入参 */
export interface FinalizeRoundInput {
	sessionId: string;
	aborted: boolean;
	goalRoundFlag: boolean;
	events: AgentEvent[];
}

/** finalizeRound 结果摘要 */
export interface FinalizeRoundResult {
	roundCounted: boolean;
	completed: boolean;
	blocked: boolean;
	/** predicate 收口完成时的 goal id — 供完成三选一 Modal */
	completedGoalId?: string;
	budgetAction?: 'continue' | 'endRound' | 'askRounds';
}

export interface GoalRunnerDeps {
	goalStore: GoalStore;
	vault: VaultPort;
	settings: () => { goalRoundTokenSoftCap: number; agentMaxSteps: number };
}

interface RoundSnapshot {
	remaining: number | null;
	grantWrites: number;
	progressNote: string;
}

/**
 * Goal 回合收口 — 挂 plugin.ask() 尾部统一记账(spec 4.4 / 外审 C1)。
 *
 * 设计要点:
 * - usage 每次 ask 都落盘;计轮仅 goalRoundFlag ∨ grantWrites>0
 * - aborted 时不计轮、不触发守卫、不改 status
 * - predicate 收口唯一(D10):evaluateFrontmatterAll 全满足时 transition completed
 */
export class GoalRunner {
	private readonly snapshots = new Map<string, RoundSnapshot>();

	constructor(private readonly deps: GoalRunnerDeps) {}

	/**
	 * ask 尾部统一收口 — 见 plan 速查 3。
	 *
	 * @param input - 会话、取消标记、续跑 flag 与事件流
	 */
	async finalizeRound(input: FinalizeRoundInput): Promise<FinalizeRoundResult> {
		const goal = this.deps.goalStore.getBoundActive(input.sessionId);
		if (!goal) {
			return { roundCounted: false, completed: false, blocked: false };
		}

		const stats = collectRoundStats(input.events);
		const usage = {
			inputTokens: goal.usage.inputTokens + stats.promptTokens,
			outputTokens: goal.usage.outputTokens + stats.completionTokens,
		};
		await this.deps.goalStore.update(goal.id, { usage });

		if (input.aborted) {
			return { roundCounted: false, completed: false, blocked: false };
		}

		// 关键路径:满轮后只记账 usage,不再计轮、不烧守卫、不改 status
		if (isGoalBudgetExhausted(goal)) {
			return {
				roundCounted: false,
				completed: false,
				blocked: false,
				budgetAction: 'askRounds',
			};
		}

		const shouldCountRound = input.goalRoundFlag || stats.grantWrites > 0;
		if (!shouldCountRound) {
			return { roundCounted: false, completed: false, blocked: false };
		}

		const roundsDone = goal.roundsDone + 1;
		await this.deps.goalStore.update(goal.id, { roundsDone });
		const fresh = await this.deps.goalStore.get(goal.id);
		if (!fresh || fresh.status !== 'active') {
			return { roundCounted: true, completed: false, blocked: false };
		}

		const predicate = fresh.completionCriteria.predicate;
		let remainingNow: number | null = null;
		if (predicate) {
			const evalResult = await evaluateFrontmatterAll(
				this.deps.vault,
				predicate.pathGlob,
				predicate.property,
				stats.grantWrittenPaths,
			);
			remainingNow = evalResult.missing.length;
			if (remainingNow === 0) {
				await this.deps.goalStore.transition(fresh.id, 'completed');
				this.snapshots.delete(fresh.id);
				return {
					roundCounted: true,
					completed: true,
					blocked: false,
					completedGoalId: fresh.id,
				};
			}
		}

		const snapshot = this.snapshots.get(fresh.id);
		if (snapshot) {
			const noProgress = evaluateNoProgress({
				remainingPrev: snapshot.remaining,
				remainingNow,
				writesPrevRound: snapshot.grantWrites,
				writesThisRound: predicate ? 0 : stats.grantWrites,
				progressNotePrev: snapshot.progressNote,
				progressNoteNow: fresh.progressNote,
			});

			if (noProgress.blocked) {
				await this.deps.goalStore.transition(fresh.id, 'blocked', noProgress.reason);
				return { roundCounted: true, completed: false, blocked: true };
			}
		}

		const budget = checkBudgets({
			stepsUsed: stats.stepsUsed,
			maxSteps: this.deps.settings().agentMaxSteps,
			roundTokens: stats.promptTokens + stats.completionTokens,
			roundTokenSoftCap: this.deps.settings().goalRoundTokenSoftCap,
			roundsDone,
			maxRounds: fresh.maxRounds,
		});

		this.snapshots.set(fresh.id, {
			remaining: remainingNow,
			grantWrites: stats.grantWrites,
			progressNote: fresh.progressNote,
		});

		return {
			roundCounted: true,
			completed: false,
			blocked: false,
			budgetAction: budget.action,
		};
	}
}

/**
 * 从 ask 事件流汇总回合统计(F1/F2)。
 *
 * @param events - agentLoop yield 的事件列表
 */
export function collectRoundStats(events: AgentEvent[]): RoundCollectedStats {
	let promptTokens = 0;
	let completionTokens = 0;
	let grantWrites = 0;
	const grantWrittenPaths: string[] = [];
	let stepsUsed = 0;
	let sawStepFields = false;

	const toolCallPaths = new Map<string, string>();
	for (const ev of events) {
		if (ev.type === 'tool.call') {
			const args = ev.payload.args as Record<string, unknown>;
			if (typeof args.path === 'string') {
				toolCallPaths.set(ev.payload.name, args.path);
			}
			stepsUsed++;
		}
		if (ev.type === 'tool.result') {
			const name = ev.payload.name;
			const result = ev.payload.result;
			if (!GOAL_GRANTABLE_TOOLS.has(name)) continue;
			if (typeof result === 'string' && result.startsWith('Error:')) continue;
			grantWrites++;
			const p = toolCallPaths.get(name);
			if (p) grantWrittenPaths.push(p);
		}
		if (ev.type === 'message.end') {
			const p = ev.payload;
			if (p.stepPromptTokens != null && p.stepCompletionTokens != null) {
				promptTokens = p.stepPromptTokens;
				completionTokens = p.stepCompletionTokens;
				sawStepFields = true;
			} else {
				promptTokens = p.promptTokens ?? 0;
				completionTokens = p.completionTokens ?? 0;
				if (!sawStepFields) {
					devLogger.warn('goal', 'message.end 缺少 stepPromptTokens,降级旧字段累计');
				}
			}
		}
	}

	return {
		promptTokens,
		completionTokens,
		grantWrites,
		grantWrittenPaths,
		stepsUsed,
	};
}

/**
 * 拼装 goal 复述锚定文本 — ephemeral 注入用(spec 4.5),≤2048 字节。
 * 满轮时追加预算耗尽行,不含完成暗示。
 *
 * @param goal - 当前绑定 goal
 */
export function composeGoalAnchor(goal: AgentGoal): string {
	const lines = [
		tNow('goal.anchor.objective', { text: goal.objective }),
		tNow('goal.anchor.criteria', { text: goal.completionCriteria.text }),
		tNow('goal.anchor.progress', { text: goal.progressNote || '—' }),
	];
	if (isGoalBudgetExhausted(goal)) {
		lines.push(tNow('goal.anchor.budgetExhausted'));
	}
	let text = lines.join('\n');
	while (Buffer.byteLength(text, 'utf8') > ANCHOR_MAX_BYTES) {
		text = text.slice(0, Math.max(0, text.length - 32));
	}
	return text;
}

/**
 * 继续 chip / 显式续跑的用户可见短句(spec 4.4)。
 */
export function composeContinueMessage(): string {
	return tNow('goal.continue.message');
}

/**
 * 已有未完成目标时斜杠立新目标 — 交给模型当面问用户,不弹拒绝提示、不排队。
 *
 * @param currentObjective - 进行中的目标陈述
 * @param nextObjective - 用户新写的目标陈述
 */
export function composeGoalConflictSteer(currentObjective: string, nextObjective: string): string {
	return tNow('goal.slash.conflictSteer', {
		current: currentObjective.trim(),
		next: nextObjective.trim(),
	});
}

/**
 * 斜杠立目标且尚无未完成目标 — 发给模型复述确认,本回合禁止 create。
 *
 * @param objective - 用户写下的目标陈述
 * @param maxRounds - 当前设置 goalMaxRounds
 */
export function composeGoalCreateSteer(objective: string, maxRounds: number): string {
	return tNow('goal.slash.createSteer', {
		objective: objective.trim(),
		rounds: String(maxRounds),
	});
}

/**
 * frontmatter-all 谓词评估 — listMarkdownFiles + getMetadata(spec 4.8)。
 *
 * @param vault - Vault 外观
 * @param pathGlob - 路径 glob
 * @param property - frontmatter 属性名
 * @param grantWrittenPaths - 本回合 grant 写入路径(缓存滞后 readFile 兜底)
 */
export async function evaluateFrontmatterAll(
	vault: VaultPort,
	pathGlob: string,
	property: string,
	grantWrittenPaths: string[] = [],
): Promise<{ total: number; missing: string[] }> {
	const regex = globToRegex(pathGlob);
	const matched = vault.listMarkdownFiles().filter((p) => regex.test(p));
	const missing: string[] = [];
	const writtenSet = new Set(grantWrittenPaths);

	for (const filePath of matched) {
		const fm = vault.getMetadata(filePath)?.frontmatter;
		if (fm && property in fm && fm[property] != null && fm[property] !== '') {
			continue;
		}
		if (writtenSet.has(filePath)) {
			try {
				const head = await vault.readFile(filePath);
				if (hasFrontmatterProperty(head, property)) continue;
			} catch {
				// 读失败仍计缺失
			}
		}
		missing.push(filePath);
	}

	return { total: matched.length, missing };
}

/** 轻量 frontmatter 属性探测 — 只读文件头,不全文解析 */
function hasFrontmatterProperty(content: string, property: string): boolean {
	if (!content.startsWith('---')) return false;
	const end = content.indexOf('\n---', 3);
	if (end === -1) return false;
	const fm = content.slice(3, end);
	return new RegExp(`^${escapeRegExp(property)}\\s*:`, 'm').test(fm);
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
