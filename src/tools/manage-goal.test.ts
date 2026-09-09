/**
 * @file src/tools/manage-goal.test.ts
 * @description manage_goal 工具单元测试 — 动作矩阵与本地兜底校验
 * @module tools/manage-goal.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
	commitGoalCreate,
	createManageGoalTool,
	defaultGoalCriteriaFromObjective,
	type ManageGoalPrompts,
} from './manage-goal';
import { GoalStore } from '../core/goal-store';
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
		promptClose: async () => ({ choice: 'keep' }),
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

	it('create - 无 promptCreate 仍落盘并激活', async () => {
		const tool = createManageGoalTool(
			store,
			fakeDef,
			() => SESSION,
			autoConfirmPrompts(),
			() => 10,
			() => '可以,就按这个标准',
		);
		const result = await tool.execute({
			action: 'create',
			objective: '审查妖市',
			criteriaText: '写出完整审查报告并落盘',
		});
		expect(result).toMatch(/已创建|开始/);
		expect((await store.list())[0]!.status).toBe('active');
	});

	it('create - 本轮用户是 /goal 陈述 - 不落盘并返回需确认', async () => {
		const tool = createManageGoalTool(
			store,
			fakeDef,
			() => SESSION,
			autoConfirmPrompts(),
			() => 10,
			() => '/goal 审查妖市',
		);
		const result = await tool.execute({
			action: 'create',
			objective: '审查妖市',
			criteriaText: '写出完整审查报告并落盘',
		});
		expect(result).toMatch(/还不能创建/);
		expect(await store.list()).toHaveLength(0);
	});

	it('create - 落盘成功 - 调用 onChanged 刷 UI', async () => {
		const onChanged = vi.fn();
		const tool = createManageGoalTool(
			store,
			fakeDef,
			() => SESSION,
			autoConfirmPrompts({ onChanged }),
			() => 10,
			() => '可以',
		);
		await tool.execute({
			action: 'create',
			objective: '审查妖市',
			criteriaText: '写出完整审查报告并落盘',
		});
		expect(onChanged).toHaveBeenCalledTimes(1);
	});

	it('create - 本轮仍是 /goal - 不调用 onChanged', async () => {
		const onChanged = vi.fn();
		const tool = createManageGoalTool(
			store,
			fakeDef,
			() => SESSION,
			autoConfirmPrompts({ onChanged }),
			() => 10,
			() => '/goal 审查妖市',
		);
		await tool.execute({
			action: 'create',
			objective: '审查妖市',
			criteriaText: '写出完整审查报告并落盘',
		});
		expect(onChanged).not.toHaveBeenCalled();
	});

	it('create - 用户确认后落盘并激活 - 返回成功', async () => {
		const tool = createManageGoalTool(
			store,
			fakeDef,
			() => SESSION,
			autoConfirmPrompts(),
			() => 10,
			() => '可以',
		);
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

	it('create - 已有 active - 不落盘并返回冲突文案', async () => {
		const existing = await store.create({
			objective: '进行中',
			completionCriteria: { text: '完成' },
			birthSessionId: SESSION,
		});
		await store.activate(existing.id, SESSION);

		let opened = false;
		const tool = createManageGoalTool(
			store,
			fakeDef,
			() => SESSION,
			autoConfirmPrompts({
				promptCreate: async () => {
					opened = true;
					return { confirmed: true, activate: true, objective: '第二条', criteriaText: '另一标准' };
				},
			}),
			() => 10,
		);
		const msg = await tool.execute({
			action: 'create',
			objective: '第二条',
			criteriaText: '另一标准',
		});
		expect(opened).toBe(false);
		expect(msg).toContain('进行中');
		expect(msg).toMatch(/不要再建|不要排队/);
		const goals = await store.list();
		expect(goals).toHaveLength(1);
		expect(goals[0]!.objective).toBe('进行中');
	});

	it('create - 已有 paused - 不落盘', async () => {
		const existing = await store.create({
			objective: '已暂停',
			completionCriteria: { text: '完成' },
			birthSessionId: SESSION,
		});
		await store.activate(existing.id, SESSION);
		await store.transition(existing.id, 'paused');
		const tool = createManageGoalTool(store, fakeDef, () => SESSION, autoConfirmPrompts(), () => 10);
		const msg = await tool.execute({
			action: 'create',
			objective: '第二条',
			criteriaText: '另一标准',
		});
		expect(msg).toContain('已暂停');
		expect(await store.list()).toHaveLength(1);
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

	it('cancel - 已是 cancelled - 不弹确认', async () => {
		const g = await store.create({
			objective: '放弃测',
			completionCriteria: { text: '完成' },
			birthSessionId: SESSION,
		});
		await store.activate(g.id, SESSION);
		await store.transition(g.id, 'cancelled');
		const promptClose = vi.fn(async () => ({ choice: 'keep' as const }));
		const onTerminal = vi.fn();
		const tool = createManageGoalTool(
			store,
			fakeDef,
			() => SESSION,
			{ ...autoConfirmPrompts(), promptClose, onTerminal },
			() => 10,
		);
		const out = await tool.execute({ action: 'cancel', goalId: g.id });
		expect(out).toMatch(/已放弃|Cancelled/i);
		expect(promptClose).not.toHaveBeenCalled();
		expect(onTerminal).not.toHaveBeenCalled();
	});

	it('cancel - 用户点取消 - 不改状态', async () => {
		const g = await store.create({
			objective: '放弃测',
			completionCriteria: { text: '完成' },
			birthSessionId: SESSION,
		});
		await store.activate(g.id, SESSION);
		const tool = createManageGoalTool(
			store,
			fakeDef,
			() => SESSION,
			autoConfirmPrompts({ promptClose: async () => null }),
			() => 10,
		);
		const out = await tool.execute({ action: 'cancel', goalId: g.id });
		expect(out).toMatch(/取消/);
		expect((await store.get(g.id))?.status).toBe('active');
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

	it('complete - 自检型 - 变为 completed 且不弹去留', async () => {
		const g = await store.create({
			objective: '自检目标',
			completionCriteria: { text: '人工确认完成' },
			birthSessionId: SESSION,
		});
		await store.activate(g.id, SESSION);
		const promptClose = vi.fn(async () => ({ choice: 'archive' as const }));
		const tool = createManageGoalTool(
			store,
			fakeDef,
			() => SESSION,
			autoConfirmPrompts({ promptClose }),
			() => 10,
		);
		await tool.execute({ action: 'complete', goalId: g.id });
		expect(promptClose).not.toHaveBeenCalled();
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

	it('update - 提高本条 maxRounds - 落盘', async () => {
		const g = await store.create({
			objective: '加轮测',
			completionCriteria: { text: '完成' },
			birthSessionId: SESSION,
			maxRounds: 10,
		});
		await store.activate(g.id, SESSION);
		const tool = createManageGoalTool(store, fakeDef, () => SESSION, autoConfirmPrompts(), () => 10);
		await tool.execute({ action: 'update', goalId: g.id, maxRounds: 15 });
		expect((await store.get(g.id))?.maxRounds).toBe(15);
	});

	it('update - maxRounds 未高于当前 - 抛错', async () => {
		const g = await store.create({
			objective: '加轮拒',
			completionCriteria: { text: '完成' },
			birthSessionId: SESSION,
			maxRounds: 10,
		});
		await store.activate(g.id, SESSION);
		const tool = createManageGoalTool(store, fakeDef, () => SESSION, autoConfirmPrompts(), () => 10);
		await expect(tool.execute({ action: 'update', goalId: g.id, maxRounds: 10 })).rejects.toThrow(
			/加轮|maxRounds/,
		);
	});

	it('readOnly 为 false', () => {
		const tool = createManageGoalTool(store, fakeDef, () => SESSION, autoConfirmPrompts(), () => 10);
		expect(tool.readOnly).toBe(false);
	});

	it('commitGoalCreate - 斜杠空完成标准由 Modal 补齐后落盘', async () => {
		const msg = await commitGoalCreate(
			store,
			SESSION,
			{
				confirmed: true,
				activate: true,
				objective: '补全属性',
				criteriaText: '匹配文件都有 status',
				maxRounds: 10,
				grant: null,
			},
			{
				objective: '补全属性',
				criteriaText: '',
				maxRounds: 10,
				grant: null,
			},
		);
		expect(msg).toMatch(/已创建/);
		const goals = await store.list();
		expect(goals).toHaveLength(1);
		expect(goals[0]!.status).toBe('active');
	});

	it('commitGoalCreate - 已有未完成 - 抛错且不落第二条', async () => {
		const existing = await store.create({
			objective: '进行中',
			completionCriteria: { text: '完成' },
			birthSessionId: SESSION,
		});
		await store.activate(existing.id, SESSION);
		await expect(
			commitGoalCreate(
				store,
				SESSION,
				{
					confirmed: true,
					activate: true,
					objective: '第二条',
					criteriaText: '另一标准',
					maxRounds: 10,
					grant: null,
				},
				{
					objective: '第二条',
					criteriaText: '另一标准',
					maxRounds: 10,
					grant: null,
				},
			),
		).rejects.toThrow(/未完成/);
		expect(await store.list()).toHaveLength(1);
	});

	it('defaultGoalCriteriaFromObjective - 与陈述不同且非空', () => {
		const objective = '把 projects 补上 status';
		const criteria = defaultGoalCriteriaFromObjective(objective);
		expect(criteria.length).toBeGreaterThan(0);
		expect(criteria).not.toBe(objective);
		expect(criteria).toContain(objective);
	});
});
