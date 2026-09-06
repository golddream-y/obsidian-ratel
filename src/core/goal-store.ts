/**
 * @file src/core/goal-store.ts
 * @description Goal 落盘存储 — CRUD、单活仲裁、会话绑定、损坏隔离与归档移动(S-GOAL)
 * @module core/goal-store
 * @depends fs, path
 */

import fs from 'fs';
import path from 'path';

/** Goal 生命周期状态 */
export type GoalStatus = 'pending' | 'active' | 'paused' | 'blocked' | 'completed' | 'cancelled';

/** v0 代码谓词 — 仅 frontmatter-all */
export interface GoalPredicate {
	kind: 'frontmatter-all';
	pathGlob: string;
	property: string;
}

/** 落盘 Goal 记录 — 字段与 spec 4.1 一致 */
export interface AgentGoal {
	version: 1;
	id: string;
	objective: string;
	completionCriteria: {
		text: string;
		predicate?: GoalPredicate;
	};
	progressNote: string;
	status: GoalStatus;
	blockedReason?: string;
	activeSessionId?: string;
	roundsDone: number;
	maxRounds: number;
	usage: { inputTokens: number; outputTokens: number };
	grant: string[] | null;
	birthSessionId: string;
	createdAt: string;
	updatedAt: string;
}

/** create 入参 — objective 创建后不可变 */
export interface CreateGoalInput {
	objective: string;
	completionCriteria: AgentGoal['completionCriteria'];
	progressNote?: string;
	maxRounds?: number;
	grant?: string[] | null;
	birthSessionId: string;
	status?: 'pending';
}

/** update 白名单字段 — 禁改 objective / id / createdAt */
export type GoalUpdatePatch = Partial<
	Pick<
		AgentGoal,
		'progressNote' | 'usage' | 'grant' | 'maxRounds' | 'blockedReason' | 'roundsDone' | 'completionCriteria'
	>
>;

/** activate 时已有其他 active goal 的抛错标识 */
export const GOAL_ACTIVE_ELSEWHERE = 'GOAL_ACTIVE_ELSEWHERE';

type TransitionTarget = 'paused' | 'blocked' | 'completed' | 'cancelled';

const TERMINAL_STATUSES = new Set<GoalStatus>(['completed', 'cancelled']);

const TRANSITIONS: Record<GoalStatus, readonly GoalStatus[]> = {
	pending: ['active', 'cancelled'],
	active: ['paused', 'blocked', 'completed', 'cancelled'],
	paused: ['active', 'cancelled'],
	blocked: ['active', 'cancelled'],
	completed: [],
	cancelled: [],
};

/**
 * Goal 文件存储 — 原子写、单活仲裁、损坏隔离。
 *
 * 设计要点:
 * - `goals/*.json` 为活跃队列;`archive/` 与 `corrupt/` 不参与 list 扫描
 * - `listStaleTerminal` 只标记查询,绝不自动 rename 进 archive(spec 4.9)
 * - `activate` 在 store 层拒绝双活,抛 `GOAL_ACTIVE_ELSEWHERE`
 */
export class GoalStore {
	readonly goalsDir: string;
	readonly archiveDir: string;
	readonly corruptDir: string;

	/**
	 * @param pluginDir - 插件根目录(`.obsidian/plugins/ratel-vault`)
	 */
	constructor(private readonly pluginDir: string) {
		this.goalsDir = path.join(pluginDir, 'goals');
		this.archiveDir = path.join(this.goalsDir, 'archive');
		this.corruptDir = path.join(this.goalsDir, 'corrupt');
	}

	/**
	 * 扫描活跃队列 — 解析失败单文件移入 corrupt/,不影响其余。
	 *
	 * @returns 有效 goal 列表(不含 archive / corrupt)
	 */
	async list(): Promise<AgentGoal[]> {
		await this.ensureDirs();
		let entries: string[];
		try {
			entries = await fs.promises.readdir(this.goalsDir);
		} catch {
			return [];
		}

		const goals: AgentGoal[] = [];
		for (const name of entries) {
			if (!name.endsWith('.json')) continue;
			const filePath = path.join(this.goalsDir, name);
			try {
				const stat = await fs.promises.stat(filePath);
				if (!stat.isFile()) continue;
			} catch {
				continue;
			}
			try {
				const raw = await fs.promises.readFile(filePath, 'utf8');
				goals.push(JSON.parse(raw) as AgentGoal);
			} catch {
				// 关键路径:损坏文件隔离,不静默丢弃(spec 4.1)
				await this.moveToCorrupt(name);
			}
		}
		return goals;
	}

	/**
	 * 按 id 读取单个 goal(含 archive 内文件,供归档后查阅)。
	 *
	 * @param id - goal id
	 * @returns 记录或 null
	 */
	async get(id: string): Promise<AgentGoal | null> {
		const activePath = this.goalPath(id);
		if (fs.existsSync(activePath)) {
			return this.readGoalFile(activePath);
		}
		const archivedPath = path.join(this.archiveDir, `${id}.json`);
		if (fs.existsSync(archivedPath)) {
			return this.readGoalFile(archivedPath);
		}
		return null;
	}

	/**
	 * 创建新 goal — 默认 pending,生成短 id `g_<timestamp36>`。
	 *
	 * @param input - 创建字段
	 * @returns 落盘后的完整记录
	 */
	async create(input: CreateGoalInput): Promise<AgentGoal> {
		await this.ensureDirs();
		const now = new Date().toISOString();
		const goal: AgentGoal = {
			version: 1,
			id: `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
			objective: input.objective,
			completionCriteria: input.completionCriteria,
			progressNote: input.progressNote ?? '',
			status: input.status ?? 'pending',
			roundsDone: 0,
			maxRounds: input.maxRounds ?? 10,
			usage: { inputTokens: 0, outputTokens: 0 },
			grant: input.grant ?? null,
			birthSessionId: input.birthSessionId,
			createdAt: now,
			updatedAt: now,
		};
		await this.writeGoal(goal);
		return goal;
	}

	/**
	 * 白名单字段更新 — 禁止改 objective / id / createdAt。
	 *
	 * @param id - goal id
	 * @param patch - 允许更新的字段
	 * @returns 更新后的记录
	 * @throws 记录不存在或含非法字段
	 */
	async update(id: string, patch: GoalUpdatePatch): Promise<AgentGoal> {
		if ('objective' in (patch as object) || 'id' in (patch as object) || 'createdAt' in (patch as object)) {
			throw new Error('goal update 禁止修改 objective / id / createdAt');
		}
		const goal = await this.requireActiveFile(id);
		const next: AgentGoal = {
			...goal,
			...patch,
			id: goal.id,
			objective: goal.objective,
			createdAt: goal.createdAt,
			updatedAt: new Date().toISOString(),
		};
		await this.writeGoal(next);
		return next;
	}

	/**
	 * 激活 goal — 单活仲裁 + 会话绑定。
	 *
	 * @param id - goal id
	 * @param sessionId - 当前会话 id
	 * @returns 更新后的记录
	 * @throws GOAL_ACTIVE_ELSEWHERE 当已有其他 active goal
	 */
	async activate(id: string, sessionId: string): Promise<AgentGoal> {
		const all = await this.list();
		const otherActive = all.find((g) => g.status === 'active' && g.id !== id);
		if (otherActive) {
			throw new Error(GOAL_ACTIVE_ELSEWHERE);
		}

		const goal = await this.requireActiveFile(id);
		const allowed = TRANSITIONS[goal.status];
		if (!allowed.includes('active')) {
			throw new Error(`非法状态迁移: ${goal.status} → active`);
		}

		const next: AgentGoal = {
			...goal,
			status: 'active',
			activeSessionId: sessionId,
			updatedAt: new Date().toISOString(),
		};
		await this.writeGoal(next);
		return next;
	}

	/**
	 * 状态迁移 — 校验 F6 迁移表;终态不可再迁。
	 *
	 * @param id - goal id
	 * @param next - 目标状态(非 active,active 走 activate)
	 * @param reason - blocked 等原因
	 * @returns 更新后的记录
	 */
	async transition(id: string, next: TransitionTarget, reason?: string): Promise<AgentGoal> {
		const goal = await this.requireActiveFile(id);
		if (TERMINAL_STATUSES.has(goal.status)) {
			throw new Error(`终态不可迁移: ${goal.status}`);
		}
		const allowed = TRANSITIONS[goal.status];
		if (!allowed.includes(next)) {
			throw new Error(`非法状态迁移: ${goal.status} → ${next}`);
		}

		const updated: AgentGoal = {
			...goal,
			status: next,
			updatedAt: new Date().toISOString(),
		};
		if (next === 'blocked') {
			updated.blockedReason = reason ?? '';
		}
		if (next === 'paused' || next === 'cancelled' || next === 'completed') {
			delete updated.activeSessionId;
		}
		await this.writeGoal(updated);
		return updated;
	}

	/**
	 * 用户确认后归档 — rename 到 goals/archive/,退出活跃队列。
	 *
	 * @param id - goal id
	 */
	async archive(id: string): Promise<void> {
		await this.ensureDirs();
		const src = this.goalPath(id);
		if (!fs.existsSync(src)) {
			throw new Error(`goal 不存在: ${id}`);
		}
		const dest = path.join(this.archiveDir, `${id}.json`);
		await fs.promises.rename(src, dest);
	}

	/**
	 * 列出超期终态 goal — 仅查询,不自动搬家(spec 4.9)。
	 *
	 * @param days - 超过多少天未更新视为待归档
	 * @returns 符合条件的 completed / cancelled 列表
	 */
	async listStaleTerminal(days: number): Promise<AgentGoal[]> {
		const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
		const all = await this.list();
		return all.filter((g) => {
			if (!TERMINAL_STATUSES.has(g.status)) return false;
			const updated = Date.parse(g.updatedAt);
			return !Number.isNaN(updated) && updated < cutoff;
		});
	}

	/**
	 * 返回绑定到指定会话的 active goal — grant 与续跑入口惰性比较用。
	 *
	 * @param sessionId - 当前会话 id
	 * @returns 绑定的 active goal 或 null
	 */
	getBoundActive(sessionId: string): AgentGoal | null {
		if (!fs.existsSync(this.goalsDir)) return null;
		const entries = fs.readdirSync(this.goalsDir);
		for (const name of entries) {
			if (!name.endsWith('.json')) continue;
			const filePath = path.join(this.goalsDir, name);
			try {
				const raw = fs.readFileSync(filePath, 'utf8');
				const goal = JSON.parse(raw) as AgentGoal;
				if (goal.status === 'active' && goal.activeSessionId === sessionId) {
					return goal;
				}
			} catch {
				// 损坏文件由 list() 隔离;此处跳过
			}
		}
		return null;
	}

	private goalPath(id: string): string {
		return path.join(this.goalsDir, `${id}.json`);
	}

	private async ensureDirs(): Promise<void> {
		await fs.promises.mkdir(this.goalsDir, { recursive: true });
		await fs.promises.mkdir(this.archiveDir, { recursive: true });
		await fs.promises.mkdir(this.corruptDir, { recursive: true });
	}

	private async writeGoal(goal: AgentGoal): Promise<void> {
		await this.ensureDirs();
		const filePath = this.goalPath(goal.id);
		// 关键路径:tmp + rename 原子写,沿用 index-manifest 模式
		const tmpPath = `${filePath}.tmp`;
		await fs.promises.writeFile(tmpPath, JSON.stringify(goal, null, 2), 'utf8');
		await fs.promises.rename(tmpPath, filePath);
	}

	private async requireActiveFile(id: string): Promise<AgentGoal> {
		const filePath = this.goalPath(id);
		const goal = await this.readGoalFile(filePath);
		if (!goal) {
			throw new Error(`goal 不存在: ${id}`);
		}
		return goal;
	}

	private async readGoalFile(filePath: string): Promise<AgentGoal | null> {
		try {
			const raw = await fs.promises.readFile(filePath, 'utf8');
			return JSON.parse(raw) as AgentGoal;
		} catch {
			return null;
		}
	}

	private async moveToCorrupt(fileName: string): Promise<void> {
		await this.ensureDirs();
		const src = path.join(this.goalsDir, fileName);
		const dest = path.join(this.corruptDir, fileName);
		try {
			await fs.promises.rename(src, dest);
		} catch {
			// 并发 list 可能重复尝试,忽略
		}
	}
}
