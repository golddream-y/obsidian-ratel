/**
 * @file src/core/goal-store.test.ts
 * @description GoalStore 单元测试 — 单活仲裁 / 损坏隔离 / 迁移表 / 归档
 * @module core/goal-store.test
 * @depends core/goal-store
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { GoalStore, GOAL_ACTIVE_ELSEWHERE } from './goal-store';
import type { CreateGoalInput } from './goal-store';

function makeTempPluginDir(): string {
	return mkdtempSync(path.join(tmpdir(), 'ratel-goal-store-'));
}

function baseInput(overrides: Partial<CreateGoalInput> = {}): CreateGoalInput {
	return {
		objective: '整理 projects 笔记 frontmatter',
		completionCriteria: { text: '全部含 status 属性' },
		birthSessionId: 'session-birth',
		...overrides,
	};
}

describe('GoalStore', () => {
	let pluginDir: string;
	let store: GoalStore;

	beforeEach(() => {
		pluginDir = makeTempPluginDir();
		store = new GoalStore(pluginDir);
	});

	afterEach(() => {
		rmSync(pluginDir, { recursive: true, force: true });
	});

	it('create - 落盘后可 get 且 objective 不可经 update 修改', async () => {
		const goal = await store.create(baseInput());
		expect(goal.id).toMatch(/^g_/);
		expect(goal.status).toBe('pending');
		expect(goal.objective).toBe('整理 projects 笔记 frontmatter');

		await expect(
			store.update(goal.id, { objective: '篡改' } as never),
		).rejects.toThrow();

		const loaded = await store.get(goal.id);
		expect(loaded?.objective).toBe('整理 projects 笔记 frontmatter');
	});

	it('activate - 已有 active 时拒绝双活', async () => {
		const g1 = await store.create(baseInput({ objective: '目标一' }));
		const g2 = await store.create(baseInput({ objective: '目标二' }));
		await store.activate(g1.id, 'session-a');

		await expect(store.activate(g2.id, 'session-b')).rejects.toThrow(GOAL_ACTIVE_ELSEWHERE);
	});

	it('activate - 已 active 换会话 - 只改绑定不抛迁移错误', async () => {
		const goal = await store.create(baseInput());
		await store.activate(goal.id, 'session-a');
		const rebound = await store.activate(goal.id, 'session-b');
		expect(rebound.status).toBe('active');
		expect(rebound.activeSessionId).toBe('session-b');
	});

	it('activate - 已绑定本会话 - 幂等', async () => {
		const goal = await store.create(baseInput());
		await store.activate(goal.id, 'session-a');
		const again = await store.activate(goal.id, 'session-a');
		expect(again.status).toBe('active');
		expect(again.activeSessionId).toBe('session-a');
	});

	it('findIncomplete - 优先 active 再 paused', async () => {
		const paused = await store.create(baseInput({ objective: '已暂停' }));
		await store.activate(paused.id, 'session-a');
		await store.transition(paused.id, 'paused');
		const leftover = await store.create(baseInput({ objective: '遗留 pending' }));
		expect(leftover.status).toBe('pending');
		const found = await store.findIncomplete();
		expect(found?.objective).toBe('已暂停');
		expect(found?.status).toBe('paused');
	});

	it('list - 损坏 JSON 隔离到 corrupt 且其余可读', async () => {
		const good = await store.create(baseInput());
		const goalsDir = path.join(pluginDir, 'goals');
		writeFileSync(path.join(goalsDir, 'g_bad.json'), '{ not json', 'utf8');

		const listed = await store.list();
		expect(listed).toHaveLength(1);
		expect(listed[0]!.id).toBe(good.id);
		expect(existsSync(path.join(goalsDir, 'corrupt', 'g_bad.json'))).toBe(true);
		expect(existsSync(path.join(goalsDir, 'g_bad.json'))).toBe(false);
	});

	it('transition - pending 直接 completed 非法', async () => {
		const goal = await store.create(baseInput());
		await expect(store.transition(goal.id, 'completed')).rejects.toThrow();
	});

	it('archive - 移入 archive 后 list 不再返回', async () => {
		const goal = await store.create(baseInput());
		await store.transition(goal.id, 'cancelled');
		await store.archive(goal.id);

		expect(await store.list()).toHaveLength(0);
		expect(existsSync(path.join(pluginDir, 'goals', 'archive', `${goal.id}.json`))).toBe(true);
	});

	it('listStaleTerminal - 只列出超期终态不自动搬家', async () => {
		const goal = await store.create(baseInput());
		await store.activate(goal.id, 'session-a');
		await store.transition(goal.id, 'completed');

		const goalsDir = path.join(pluginDir, 'goals');
		const filePath = path.join(goalsDir, `${goal.id}.json`);
		const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
		const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
		raw.updatedAt = eightDaysAgo;
		writeFileSync(filePath, JSON.stringify(raw, null, 2), 'utf8');

		const stale = await store.listStaleTerminal(7);
		expect(stale).toHaveLength(1);
		expect(stale[0]!.id).toBe(goal.id);
		expect(existsSync(filePath)).toBe(true);
	});

	it('activate - 写入使用 tmp+rename 原子模式', async () => {
		const goal = await store.create(baseInput());
		await store.activate(goal.id, 'session-x');

		const filePath = path.join(pluginDir, 'goals', `${goal.id}.json`);
		expect(existsSync(`${filePath}.tmp`)).toBe(false);
		const onDisk = JSON.parse(readFileSync(filePath, 'utf8')) as { status: string; activeSessionId: string };
		expect(onDisk.status).toBe('active');
		expect(onDisk.activeSessionId).toBe('session-x');
	});

	it('getBoundActive - 仅返回绑定会话的 active 目标', async () => {
		const goal = await store.create(baseInput());
		await store.activate(goal.id, 'session-bound');

		expect(store.getBoundActive('session-bound')?.id).toBe(goal.id);
		expect(store.getBoundActive('other-session')).toBeNull();
	});
});
