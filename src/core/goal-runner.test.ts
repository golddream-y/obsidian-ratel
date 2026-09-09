/**
 * @file src/core/goal-runner.test.ts
 * @description GoalRunner 单元测试 — finalizeRound 假事件流与谓词收口
 * @module core/goal-runner.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
	GoalRunner,
	composeGoalAnchor,
	composeContinueMessage,
	composeGoalConflictSteer,
	composeGoalCreateSteer,
	evaluateFrontmatterAll,
	collectRoundStats,
} from './goal-runner';
import { GoalStore } from './goal-store';
import type { AgentEvent } from '../types';
import type { VaultPort } from '../ports/vault';
import { setLang } from '../i18n';

const SESSION = 'session-runner';

function makeStore(): { store: GoalStore; dir: string } {
	const dir = mkdtempSync(path.join(tmpdir(), 'ratel-goal-runner-'));
	return { store: new GoalStore(dir), dir };
}

function fakeVault(overrides?: Partial<VaultPort>): VaultPort {
	return {
		readFile: async () => '',
		writeFile: async () => {},
		getBacklinks: () => new Map(),
		getMetadata: () => null,
		getLinks: () => ({ outgoing: [], backlinks: [], unresolved: [] }),
		findByTag: () => [],
		findByProperty: () => [],
		getVaultStructure: () => ({}),
		listMarkdownFiles: () => [],
		stat: () => null,
		cachedRead: async () => '',
		appendFile: async () => {},
		trashFile: async () => {},
		trashFolder: async () => {},
		listFiles: async () => ({ files: [], folders: [] }),
		fileExists: async () => false,
		processFile: async (_p, fn) => fn(''),
		...overrides,
	};
}

function endEvent(prompt = 0, completion = 0, stepPrompt?: number, stepCompletion?: number): AgentEvent {
	return {
		type: 'message.end',
		payload: {
			tokens: 1,
			promptTokens: prompt,
			completionTokens: completion,
			stepPromptTokens: stepPrompt,
			stepCompletionTokens: stepCompletion,
		},
	};
}

function toolResult(name: string, result: unknown): AgentEvent {
	return { type: 'tool.result', payload: { name, result } };
}

describe('composeGoalAnchor', () => {
	it('composeGoalAnchor - 含三行且自限字节', async () => {
		const store = makeStore().store;
		const goal = await store.create({
			objective: '补全 frontmatter',
			completionCriteria: { text: '全部含 status' },
			progressNote: '已处理 2/5',
			birthSessionId: SESSION,
		});
		const anchor = composeGoalAnchor(goal);
		expect(anchor).toContain('补全 frontmatter');
		expect(anchor).toContain('全部含 status');
		expect(anchor).toContain('已处理 2/5');
		expect(Buffer.byteLength(anchor, 'utf8')).toBeLessThanOrEqual(2048);
	});

	it('composeGoalAnchor - 满轮 - 含预算耗尽提示且不含完成暗示', async () => {
		setLang('zh');
		const store = makeStore().store;
		const goal = await store.create({
			objective: '补全 frontmatter',
			completionCriteria: { text: '全部含 status' },
			birthSessionId: SESSION,
			maxRounds: 10,
		});
		await store.update(goal.id, { roundsDone: 10 });
		const fresh = await store.get(goal.id);
		const anchor = composeGoalAnchor(fresh!);
		expect(anchor).toMatch(/加轮|预算/);
		expect(anchor).not.toMatch(/完成目标|收尾/);
	});
});

describe('composeContinueMessage', () => {
	it('composeContinueMessage - 返回一句短句', () => {
		setLang('zh');
		expect(composeContinueMessage()).toBe('继续推进当前目标');
	});

	it('composeGoalConflictSteer - 含当前与新目标且不拒绝', () => {
		setLang('zh');
		const text = composeGoalConflictSteer('整理旧笔记', '补全属性');
		expect(text).toContain('整理旧笔记');
		expect(text).toContain('补全属性');
		expect(text).toMatch(/问用户/);
		expect(text).not.toMatch(/暂停当前/);
	});

	it('composeGoalCreateSteer - 含陈述与回合数且禁止本回合 create', () => {
		setLang('zh');
		const text = composeGoalCreateSteer('审查妖市', 10);
		expect(text).toContain('审查妖市');
		expect(text).toContain('10');
		expect(text).toMatch(/禁止调用 manage_goal create/);
	});
});

describe('evaluateFrontmatterAll', () => {
	it('evaluateFrontmatterAll - metadata 命中与缺失', async () => {
		const vault = fakeVault({
			listMarkdownFiles: () => ['notes/a.md', 'notes/b.md', 'other/c.md'],
			getMetadata: (p) =>
				p === 'notes/a.md' ? { frontmatter: { status: 'ok' } } : { frontmatter: {} },
		});
		const result = await evaluateFrontmatterAll(vault, 'notes/**', 'status');
		expect(result.total).toBe(2);
		expect(result.missing).toEqual(['notes/b.md']);
	});

	it('evaluateFrontmatterAll - 本回合写入路径走 readFile 兜底', async () => {
		const vault = fakeVault({
			listMarkdownFiles: () => ['notes/a.md'],
			getMetadata: () => ({ frontmatter: {} }),
			readFile: async (p) =>
				p === 'notes/a.md' ? '---\nstatus: done\n---\nbody' : '',
		});
		const result = await evaluateFrontmatterAll(vault, 'notes/**', 'status', ['notes/a.md']);
		expect(result.missing).toEqual([]);
	});
});

describe('collectRoundStats', () => {
	it('collectRoundStats - 跨步 usage 优先 step 累计字段', () => {
		const events: AgentEvent[] = [
			endEvent(5, 2, 15, 7),
			toolResult('write_note', 'ok'),
			toolResult('write_note', 'Error: denied'),
		];
		const stats = collectRoundStats(events);
		expect(stats.promptTokens).toBe(15);
		expect(stats.completionTokens).toBe(7);
		expect(stats.grantWrites).toBe(1);
	});

	it('collectRoundStats - 无 step 字段时降级 message.end 旧字段', () => {
		const events: AgentEvent[] = [endEvent(8, 4)];
		const stats = collectRoundStats(events);
		expect(stats.promptTokens).toBe(8);
		expect(stats.completionTokens).toBe(4);
	});
});

describe('GoalRunner.finalizeRound', () => {
	let store: GoalStore;
	let pluginDir: string;
	let runner: GoalRunner;

	beforeEach(async () => {
		setLang('zh');
		const made = makeStore();
		store = made.store;
		pluginDir = made.dir;
		runner = new GoalRunner({
			goalStore: store,
			vault: fakeVault(),
			settings: () => ({ goalRoundTokenSoftCap: 0, agentMaxSteps: 50 }),
		});
	});

	afterEach(() => {
		rmSync(pluginDir, { recursive: true, force: true });
	});

	async function seedActive(predicate?: boolean) {
		const g = await store.create({
			objective: '测试目标',
			completionCriteria: predicate
				? {
						text: '全部含 tag',
						predicate: { kind: 'frontmatter-all', pathGlob: 'notes/**', property: 'tag' },
					}
				: { text: '人工确认' },
			birthSessionId: SESSION,
		});
		await store.activate(g.id, SESSION);
		return g;
	}

	it('finalizeRound - 零写入插话不计轮', async () => {
		await seedActive();
		const result = await runner.finalizeRound({
			sessionId: SESSION,
			aborted: false,
			goalRoundFlag: false,
			events: [endEvent(3, 1, 3, 1)],
		});
		expect(result.roundCounted).toBe(false);
		const goal = store.getBoundActive(SESSION);
		expect(goal?.roundsDone).toBe(0);
		expect(goal?.usage.inputTokens).toBe(3);
	});

	it('finalizeRound - 已满轮再续跑 - 不计轮', async () => {
		const g = await seedActive();
		await store.update(g.id, { roundsDone: 10, maxRounds: 10 });
		const result = await runner.finalizeRound({
			sessionId: SESSION,
			aborted: false,
			goalRoundFlag: true,
			events: [endEvent(2, 1, 2, 1)],
		});
		expect(result.roundCounted).toBe(false);
		expect(result.budgetAction).toBe('askRounds');
		const goal = store.getBoundActive(SESSION);
		expect(goal?.roundsDone).toBe(10);
		expect(goal?.status).toBe('active');
		expect(goal?.usage.inputTokens).toBe(2);
	});

	it('finalizeRound - goalRoundFlag 计轮', async () => {
		await seedActive();
		const result = await runner.finalizeRound({
			sessionId: SESSION,
			aborted: false,
			goalRoundFlag: true,
			events: [endEvent(2, 1, 2, 1)],
		});
		expect(result.roundCounted).toBe(true);
		expect(store.getBoundActive(SESSION)?.roundsDone).toBe(1);
	});

	it('finalizeRound - CANCELLED 只记 usage 不计轮', async () => {
		await seedActive();
		await runner.finalizeRound({
			sessionId: SESSION,
			aborted: true,
			goalRoundFlag: true,
			events: [endEvent(5, 5, 5, 5)],
		});
		expect(store.getBoundActive(SESSION)?.roundsDone).toBe(0);
		expect(store.getBoundActive(SESSION)?.usage.inputTokens).toBe(5);
	});

	it('finalizeRound - predicate 全满足时 complete 一次', async () => {
		await seedActive(true);
		const vault = fakeVault({
			listMarkdownFiles: () => ['notes/a.md'],
			getMetadata: () => ({ frontmatter: { tag: 'x' } }),
		});
		runner = new GoalRunner({
			goalStore: store,
			vault,
			settings: () => ({ goalRoundTokenSoftCap: 0, agentMaxSteps: 50 }),
		});
		const r1 = await runner.finalizeRound({
			sessionId: SESSION,
			aborted: false,
			goalRoundFlag: true,
			events: [toolResult('write_note', 'ok'), endEvent(1, 1, 1, 1)],
		});
		expect(r1.completed).toBe(true);
		const goal = await store.get((await store.list())[0].id);
		expect(goal?.status).toBe('completed');
	});

	it('finalizeRound - 自检型不自动 complete', async () => {
		await seedActive(false);
		await runner.finalizeRound({
			sessionId: SESSION,
			aborted: false,
			goalRoundFlag: true,
			events: [toolResult('edit_note', 'saved'), endEvent(1, 1, 1, 1)],
		});
		expect(store.getBoundActive(SESSION)?.status).toBe('active');
	});

	it('finalizeRound - 连续两轮无进展变 blocked', async () => {
		const vault = fakeVault({
			listMarkdownFiles: () => ['notes/a.md', 'notes/b.md'],
			getMetadata: () => ({ frontmatter: {} }),
		});
		runner = new GoalRunner({
			goalStore: store,
			vault,
			settings: () => ({ goalRoundTokenSoftCap: 0, agentMaxSteps: 50 }),
		});
		await seedActive(true);
		await runner.finalizeRound({
			sessionId: SESSION,
			aborted: false,
			goalRoundFlag: true,
			events: [endEvent(1, 0, 1, 0)],
		});
		await runner.finalizeRound({
			sessionId: SESSION,
			aborted: false,
			goalRoundFlag: true,
			events: [endEvent(1, 0, 1, 0)],
		});
		const goals = await store.list();
		const goal = goals.find((g) => g.objective === '测试目标');
		expect(goal?.status).toBe('blocked');
		expect(goal?.blockedReason).toMatch(/无进展/);
	});

	it('finalizeRound - Error 前缀写入不计 grant 成功写', async () => {
		await seedActive();
		await runner.finalizeRound({
			sessionId: SESSION,
			aborted: false,
			goalRoundFlag: false,
			events: [toolResult('write_note', 'Error: rejected')],
		});
		expect(store.getBoundActive(SESSION)?.roundsDone).toBe(0);
	});
});
