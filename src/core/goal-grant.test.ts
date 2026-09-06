/**
 * @file src/core/goal-grant.test.ts
 * @description goal-grant 单元测试 — 白名单 / glob / 会话绑定矩阵
 * @module core/goal-grant.test
 * @depends core/goal-grant, core/goal-store
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
	GOAL_GRANTABLE_TOOLS,
	validateGrantGlobs,
	createGoalGrantCheck,
} from './goal-grant';
import { GoalStore } from './goal-store';
import {
	ToolPermissionSessionGrants,
	resolveToolPermission,
} from './tool-permissions';
import type { ToolCall } from '../ports/llm';
import { setConfigDir } from '../utils/path-safety';

const SESSION = 'session-bound';

function makeStore(): { store: GoalStore; dir: string } {
	const dir = mkdtempSync(path.join(tmpdir(), 'ratel-goal-grant-'));
	return { store: new GoalStore(dir), dir };
}

describe('validateGrantGlobs', () => {
	it('validateGrantGlobs - 空数组与裸 ** - 抛错', () => {
		expect(() => validateGrantGlobs([])).toThrow();
		expect(() => validateGrantGlobs(['**'])).toThrow();
	});

	it('validateGrantGlobs - 裸 * 无目录前缀 - 抛错', () => {
		expect(() => validateGrantGlobs(['*'])).toThrow();
		expect(() => validateGrantGlobs(['*.md'])).toThrow();
	});

	it('validateGrantGlobs - 含 .. 或绝对路径 - 抛错', () => {
		expect(() => validateGrantGlobs(['../secret/**'])).toThrow();
		expect(() => validateGrantGlobs(['/abs/path/**'])).toThrow();
	});

	it('validateGrantGlobs - projects/** - 通过', () => {
		expect(() => validateGrantGlobs(['projects/**'])).not.toThrow();
	});
});

describe('createGoalGrantCheck', () => {
	let store: GoalStore;
	let pluginDir: string;

	beforeEach(async () => {
		setConfigDir('.obsidian');
		const made = makeStore();
		store = made.store;
		pluginDir = made.dir;
		const goal = await store.create({
			objective: '写 projects',
			completionCriteria: { text: '完成' },
			birthSessionId: SESSION,
			grant: ['projects/**'],
		});
		await store.activate(goal.id, SESSION);
	});

	afterEach(() => {
		rmSync(pluginDir, { recursive: true, force: true });
	});

	it('grant 矩阵 - 白名单工具命中 glob 放行', () => {
		const check = createGoalGrantCheck({ goalStore: store, currentSessionId: SESSION });
		const tc: ToolCall = { id: '1', name: 'write_note', args: { path: 'projects/a.md', content: 'x' } };
		expect(check(tc)).toBe(true);
	});

	it('grant 矩阵 - delete_note 不放行', () => {
		const check = createGoalGrantCheck({ goalStore: store, currentSessionId: SESSION });
		const tc: ToolCall = { id: '2', name: 'delete_note', args: { path: 'projects/a.md' } };
		expect(check(tc)).toBe(false);
	});

	it('grant 矩阵 - mcp__ 不放行', () => {
		const check = createGoalGrantCheck({ goalStore: store, currentSessionId: SESSION });
		const tc: ToolCall = { id: '3', name: 'mcp__srv__tool', args: {} };
		expect(check(tc)).toBe(false);
	});

	it('grant 矩阵 - 非绑定会话不放行', () => {
		const check = createGoalGrantCheck({ goalStore: store, currentSessionId: 'other-session' });
		const tc: ToolCall = { id: '4', name: 'write_note', args: { path: 'projects/a.md', content: 'x' } };
		expect(check(tc)).toBe(false);
	});

	it('grant 矩阵 - paused 后不放行', async () => {
		const goals = await store.list();
		await store.transition(goals[0]!.id, 'paused');
		const check = createGoalGrantCheck({ goalStore: store, currentSessionId: SESSION });
		const tc: ToolCall = { id: '5', name: 'write_note', args: { path: 'projects/a.md', content: 'x' } };
		expect(check(tc)).toBe(false);
	});

	it('grant 矩阵 - glob 未命中不放行', () => {
		const check = createGoalGrantCheck({ goalStore: store, currentSessionId: SESSION });
		const tc: ToolCall = { id: '6', name: 'write_note', args: { path: 'other/a.md', content: 'x' } };
		expect(check(tc)).toBe(false);
	});
});

describe('resolveToolPermission goal grant 插入点', () => {
	const writeCall: ToolCall = { id: '1', name: 'write_note', args: { path: 'projects/a.md', content: 'x' } };

	it('deny 工具 - goal grant 仍拒', async () => {
		const grants = new ToolPermissionSessionGrants();
		const goalGrant = vi.fn().mockReturnValue(true);
		await expect(
			resolveToolPermission(
				writeCall,
				{ toolPermissionLevel: 'safe', toolPermissions: { write_note: 'deny' } },
				grants,
				vi.fn(),
				goalGrant,
			),
		).rejects.toThrow('已被禁用');
		expect(goalGrant).not.toHaveBeenCalled();
	});

	it('ask 档位 - goal grant 命中时不弹窗', async () => {
		const grants = new ToolPermissionSessionGrants();
		const confirm = vi.fn();
		const goalGrant = vi.fn().mockReturnValue(true);
		await resolveToolPermission(
			writeCall,
			{ toolPermissionLevel: 'safe', toolPermissions: { write_note: 'ask' } },
			grants,
			confirm,
			goalGrant,
		);
		expect(confirm).not.toHaveBeenCalled();
	});

	it('ask 档位 - goal grant 未命中走原流程', async () => {
		const grants = new ToolPermissionSessionGrants();
		const confirm = vi.fn().mockResolvedValue('allow' as const);
		await resolveToolPermission(
			writeCall,
			{ toolPermissionLevel: 'safe', toolPermissions: { write_note: 'ask' } },
			grants,
			confirm,
			() => false,
		);
		expect(confirm).toHaveBeenCalledTimes(1);
	});
});

describe('GOAL_GRANTABLE_TOOLS', () => {
	it('GOAL_GRANTABLE_TOOLS - 含写侧三件套', () => {
		expect(GOAL_GRANTABLE_TOOLS.has('write_note')).toBe(true);
		expect(GOAL_GRANTABLE_TOOLS.has('edit_note')).toBe(true);
		expect(GOAL_GRANTABLE_TOOLS.has('append_note')).toBe(true);
		expect(GOAL_GRANTABLE_TOOLS.has('delete_note')).toBe(false);
	});
});
