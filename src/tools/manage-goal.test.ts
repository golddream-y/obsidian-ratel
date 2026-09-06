/**
 * @file src/tools/manage-goal.test.ts
 * @description manage_goal 工具单元测试 — 动作矩阵与本地兜底校验
 * @module tools/manage-goal.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
	createManageGoalTool,
	type GoalCreateDraft,
	type ManageGoalPrompts,
} from './manage-goal';
import { GoalStore, GOAL_ACTIVE_ELSEWHERE } from '../core/goal-store';
import { setLang } from '../i18n';
import type { ToolDefinition } from '../ports/llm';

const SESSION = 'session-test';
const fakeDef: ToolDefinition = {
	name: 'manage_goal',
	description: 'test',
	parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
};

function makeStore(): { store: GoalStore; dir: string } {
	const dir = mkdtempSync(path.join(tmpdir(), 'ratel-manage-goal-'));
	return { store: new GoalStore(dir), dir };
}

function autoConfirmPrompts(overrides?: Partial<ManageGoalPrompts>): ManageGoalPrompts {
	return {
		promptCreate: async (draft) => ({
			confirmed: true,
			activate: draft.suggestActivate ?? true,
			objective: draft.objective,
			criteriaText: draft.criteriaText,
			maxRounds: draft.maxRounds,
			grant: draft.grant,
			predicate: draft.predicate,
		}),
		promptConfirm: async () => true,
		...overrides,
	};
}

describe('manage_goal 工具', () => {
	let store: GoalStore;
	let pluginDir: string;

	beforeEach(() => {
		setLang('zh');
		const made = makeStore();
		store = made.store;
		pluginDir = made.dir;
	});

	afterEach(() => {
		rmSync(pluginDir, { recursive: true, force: true });
	});

	it('create - 用户确认后落盘并激活 - 返回成功', async () => {
		const tool = createManageGoalTool(store, fakeDef, () => SESSION, autoConfirmPrompts(), () => 10);
		const result = await tool.execute({
			action: 'create',
			objective: '补全 frontmatter',
			criteriaText: '所有匹配文件含 status 字段',
			grant: ['projects/**'],
		});
		expect(result).toMatch(/已创建|创建/);
		const goals = await store.list();
		expect(goals).toHaveLength(1);
		expect(goals[0].status).toBe('active');
		expect(goals[0].activeSessionId).toBe(SESSION);
	});

	it('create - 用户取消 Modal - 不落盘', async () => {
		const tool = createManageGoalTool(
			store,
			fakeDef,
			() => SESSION,
			autoConfirmPrompts({
				promptCreate: async () => ({ confirmed: false }),
			}),
			() => 10,
		);
		const result = await tool.execute({
			action: 'create',
			objective: '测试',
			criteriaText: '标准不同',
		});
		expect(result).toMatch(/取消/);
		expect(await store.list()).toHaveLength(0);
	});

	it('create - criteria 为空 - 抛错且不落盘', async () => {
		const tool = createManageGoalTool(store, fakeDef, () => SESSION, autoConfirmPrompts(), () => 10);
		await expect(
			tool.execute({ action: 'create', objective: '目标', criteriaText: '' }),
		).rejects.toThrow(/完成标准/);
		expect(await store.list()).toHaveLength(0);
	});

	it('create - criteria 与 objective 相同 - 抛错', async () => {
		const tool = createManageGoalTool(store, fakeDef, () => SESSION, autoConfirmPrompts(), () => 10);
		await expect(
			tool.execute({ action: 'create', objective: '同一句话', criteriaText: '同一句话' }),
		).rejects.toThrow(/完成标准/);
	});

	it('create - 裸 ** grant - 抛错', async () => {
		const tool = createManageGoalTool(store, fakeDef, () => SESSION, autoConfirmPrompts(), () => 10);
		await expect(
			tool.execute({
				action: 'create',
				objective: '目标',
				criteriaText: '标准',
				grant: ['**'],
			}),
		).rejects.toThrow();
	});

	it('create - 已有 active - 仅创建 pending', async () => {
		const existing = await store.create({
			objective: '进行中',
			completionCriteria: { text: '完成' },
			birthSessionId: SESSION,
		});
		await store.activate(existing.id, SESSION);

		let draft: GoalCreateDraft | undefined;
		const tool = createManageGoalTool(
			store,
			fakeDef,
			() => SESSION,
			autoConfirmPrompts({
				promptCreate: async (d) => {
					draft = d;
					return {
						confirmed: true,
						activate: true,
						objective: d.objective,
						criteriaText: d.criteriaText,
					};
				},
			}),
			() => 10,
		);
		await tool.execute({
			action: 'create',
			objective: '排队目标',
			criteriaText: '另一标准',
		});
		expect(draft?.suggestActivate).toBe(false);
		const goals = await store.list();
		const pending = goals.find((g) => g.objective === '排队目标');
		expect(pending?.status).toBe('pending');
	});

	it('resume - 用户确认 - 激活并绑定会话', async () => {
		const g = await store.create({
			objective: '待恢复',
			completionCriteria: { text: '完成' },
			birthSessionId: SESSION,
			status: 'pending',
		});
		const tool = createManageGoalTool(store, fakeDef, () => SESSION, autoConfirmPrompts(), () => 10);
		await tool.execute({ action: 'resume', goalId: g.id });
		const updated = await store.get(g.id);
		expect(updated?.status).toBe('active');
		expect(updated?.activeSessionId).toBe(SESSION);
	});

	it('resume - 双活冲突 - 转 activeElsewhere 错误', async () => {
		const a = await store.create({
			objective: 'A',
			completionCriteria: { text: 'a' },
			birthSessionId: SESSION,
		});
		await store.activate(a.id, SESSION);
		const b = await store.create({
			objective: 'B',
			completionCriteria: { text: 'b' },
			birthSessionId: 'other',
			status: 'pending',
		});
		const tool = createManageGoalTool(store, fakeDef, () => SESSION, autoConfirmPrompts(), () => 10);
		await expect(tool.execute({ action: 'resume', goalId: b.id })).rejects.toThrow(/另一场对话/);
	});

	it('pause - active goal - 变为 paused', async () => {
		const g = await store.create({
			objective: '暂停测',
			completionCriteria: { text: '完成' },
			birthSessionId: SESSION,
		});
		await store.activate(g.id, SESSION);
		const tool = createManageGoalTool(store, fakeDef, () => SESSION, autoConfirmPrompts(), () => 10);
		await tool.execute({ action: 'pause', goalId: g.id });
		expect((await store.get(g.id))?.status).toBe('paused');
	});

	it('cancel - 用户确认 - 变为 cancelled', async () => {
		const g = await store.create({
			objective: '放弃测',
			completionCriteria: { text: '完成' },
			birthSessionId: SESSION,
		});
		await store.activate(g.id, SESSION);
		const tool = createManageGoalTool(store, fakeDef, () => SESSION, autoConfirmPrompts(), () => 10);
		await tool.execute({ action: 'cancel', goalId: g.id });
		expect((await store.get(g.id))?.status).toBe('cancelled');
	});

	it('complete - predicate 型 - 抛错拒绝', async () => {
		const g = await store.create({
			objective: '谓词目标',
			completionCriteria: {
				text: '全部含 tag',
				predicate: { kind: 'frontmatter-all', pathGlob: 'notes/**', property: 'tag' },
			},
			birthSessionId: SESSION,
		});
		await store.activate(g.id, SESSION);
		const tool = createManageGoalTool(store, fakeDef, () => SESSION, autoConfirmPrompts(), () => 10);
		await expect(tool.execute({ action: 'complete', goalId: g.id })).rejects.toThrow(/谓词|自动/);
	});

	it('complete - 自检型且确认 - 变为 completed', async () => {
		const g = await store.create({
			objective: '自检目标',
			completionCriteria: { text: '人工确认完成' },
			birthSessionId: SESSION,
		});
		await store.activate(g.id, SESSION);
		const tool = createManageGoalTool(store, fakeDef, () => SESSION, autoConfirmPrompts(), () => 10);
		await tool.execute({ action: 'complete', goalId: g.id });
		expect((await store.get(g.id))?.status).toBe('completed');
	});

	it('list - 返回队列摘要', async () => {
		await store.create({
			objective: '列表示例',
			completionCriteria: { text: '完成' },
			birthSessionId: SESSION,
		});
		const tool = createManageGoalTool(store, fakeDef, () => SESSION, autoConfirmPrompts(), () => 10);
		const result = await tool.execute({ action: 'list' });
		expect(result).toContain('列表示例');
	});

	it('update - active goal 写 progressNote', async () => {
		const g = await store.create({
			objective: '更新测',
			completionCriteria: { text: '完成' },
			birthSessionId: SESSION,
		});
		await store.activate(g.id, SESSION);
		const tool = createManageGoalTool(store, fakeDef, () => SESSION, autoConfirmPrompts(), () => 10);
		await tool.execute({ action: 'update', goalId: g.id, progressNote: '已处理 3/10' });
		expect((await store.get(g.id))?.progressNote).toBe('已处理 3/10');
	});

	it('readOnly 为 false', () => {
		const tool = createManageGoalTool(store, fakeDef, () => SESSION, autoConfirmPrompts(), () => 10);
		expect(tool.readOnly).toBe(false);
	});
});
