/**
 * @file tests/ui/slash-commands.test.ts
 * @description slash-commands — 命令注册表与过滤纯函数单测
 * @module tests/ui/slash-commands
 * @depends ui/slash-commands
 */

import { describe, it, expect } from 'vitest';
import {
	getSlashCommands,
	filterCommands,
	parseSlashGoalInput,
	splitLeadingSlashCommand,
	completeUniqueSlashCommand,
	filterSlashMenu,
	skillInvokeTexts,
	slashSelectionLandsInInput,
	composerEnterSends,
	matchLeadingSkill,
	isSlashGoalCreateTurn,
} from '../../src/ui/chat/input/slash-commands';
import { shouldCreateSkillManageModal } from '../../src/ui/skills/SkillManageModal';

describe('slash-commands', () => {
	it('getSlashCommands - 含 5 个命令(new/goal/compact/model/reindex)', () => {
		const names = getSlashCommands().map((c) => c.name);
		expect(names).toEqual(['/new', '/goal', '/compact', '/model', '/reindex']);
	});

	it('getSlashCommands - 每个命令含 name/description/icon', () => {
		for (const cmd of getSlashCommands()) {
			expect(cmd.name).toMatch(/^\//);
			expect(cmd.description.length).toBeGreaterThan(0);
			expect(cmd.icon.length).toBeGreaterThan(0);
		}
	});

	it('filterCommands - 空串(仅 /) - 返回全部命令', () => {
		expect(filterCommands('/')).toHaveLength(5);
	});

	it('filterCommands - /n - 只返回 /new', () => {
		const result = filterCommands('/n');
		expect(result).toHaveLength(1);
		expect(result[0]!.name).toBe('/new');
	});

	it('filterCommands - /g - 只返回 /goal', () => {
		const result = filterCommands('/g');
		expect(result).toHaveLength(1);
		expect(result[0]!.name).toBe('/goal');
	});

	it('filterCommands - /c - 只返回 /compact', () => {
		const result = filterCommands('/c');
		expect(result).toHaveLength(1);
		expect(result[0]!.name).toBe('/compact');
	});

	it('filterCommands - /m - 只返回 /model', () => {
		const result = filterCommands('/m');
		expect(result).toHaveLength(1);
		expect(result[0]!.name).toBe('/model');
	});

	it('filterCommands - /r - 只返回 /reindex', () => {
		const result = filterCommands('/r');
		expect(result).toHaveLength(1);
		expect(result[0]!.name).toBe('/reindex');
	});

	it('filterCommands - /unknown - 返回空数组', () => {
		expect(filterCommands('/unknown')).toEqual([]);
	});

	it('filterCommands - 不以 / 开头 - 返回空数组', () => {
		expect(filterCommands('hello')).toEqual([]);
	});

	it('filterCommands - 含空格(如 /new hello) - 返回空数组(已脱离命令模式)', () => {
		// 关键路径:输入 /new 加空格后进入实际消息模式,菜单关闭
		expect(filterCommands('/new hello')).toEqual([]);
	});

	it('filterCommands - 大小写不敏感(/NEW 匹配 /new)', () => {
		const result = filterCommands('/NEW');
		expect(result).toHaveLength(1);
		expect(result[0]!.name).toBe('/new');
	});

	it('completeUniqueSlashCommand - /go 只剩 /goal - 补成 /goal 加空格', () => {
		expect(completeUniqueSlashCommand('/go')).toBe('/goal ');
	});

	it('completeUniqueSlashCommand - 仅 / 多条 - 不补全', () => {
		expect(completeUniqueSlashCommand('/')).toBeNull();
	});

	it('filterSlashMenu - 空斜杠 - 命令固定顺序在前,技能按名字在后', () => {
		const rows = filterSlashMenu('/', [
			{ name: 'zeta-skill', description: '后', origin: 'builtin' },
			{ name: 'alpha-skill', description: '前', origin: 'vault' },
		]);
		expect(rows.map((row) => row.name)).toEqual([
			'/new',
			'/goal',
			'/compact',
			'/model',
			'/reindex',
			'alpha-skill',
			'zeta-skill',
		]);
		expect(rows[0]!.kind).toBe('command');
		expect(rows[5]!.kind).toBe('skill');
		expect(rows[5]!.origin).toBe('vault');
		expect(rows[0]!.origin).toBeUndefined();
	});

	it('skillInvokeTexts - 点选技能 - 气泡是 /名字,模型文案另写', () => {
		const invoke = skillInvokeTexts('calendar-week-start');
		expect(invoke.text).toBe('/calendar-week-start');
		expect(invoke.llmText).toContain('calendar-week-start');
		expect(invoke.llmText).not.toBe(invoke.text);
	});

	it('slashSelectionLandsInInput - 技能和 /goal - 先落到输入框', () => {
		expect(slashSelectionLandsInInput({ kind: 'skill', name: 'install-diary-plugins' })).toBe(true);
		expect(slashSelectionLandsInInput({ kind: 'command', name: '/goal' })).toBe(true);
		expect(slashSelectionLandsInInput({ kind: 'command', name: '/new' })).toBe(false);
	});

	it('composerEnterSends - 技能已落到输入框 - 再按回车发送', () => {
		const skill = { kind: 'skill' as const, name: 'install-diary-plugins' };
		expect(composerEnterSends('/install-diary-plugins ', skill)).toBe(true);
		expect(composerEnterSends('/install-diary-plugins 安排今天', skill)).toBe(true);
		expect(composerEnterSends('/new', { kind: 'command', name: '/new' })).toBe(false);
	});

	it('matchLeadingSkill - 技能名后有补充 - 拆出 rest', () => {
		expect(matchLeadingSkill('/diary-month-ledger 安排今天的工作', ['diary-month-ledger', 'diary'])).toEqual({
			name: 'diary-month-ledger',
			rest: '安排今天的工作',
		});
		expect(matchLeadingSkill('/diary-month-ledger', ['diary-month-ledger'])).toEqual({
			name: 'diary-month-ledger',
			rest: '',
		});
		expect(matchLeadingSkill('普通句子', ['diary-month-ledger'])).toBeNull();
	});

	it('filterSlashMenu - /c - 命令与技能都按前缀命中,命令权重在前', () => {
		const rows = filterSlashMenu('/c', [
			{ name: 'calendar-week-start', description: '周一开始', origin: 'builtin' },
		]);
		expect(rows.map((row) => row.name)).toEqual(['/compact', 'calendar-week-start']);
	});
});

describe('parseSlashGoalInput', () => {
	it('parseSlashGoalInput - 仅 /goal - 空陈述且不忽略时限', () => {
		expect(parseSlashGoalInput('/goal')).toEqual({ objective: '', timeLimitIgnored: false });
	});

	it('parseSlashGoalInput - /goal 后接陈述 - 预填 objective', () => {
		expect(parseSlashGoalInput('/goal 把 projects 补上 status')).toEqual({
			objective: '把 projects 补上 status',
			timeLimitIgnored: false,
		});
	});

	it('parseSlashGoalInput - 开头 30m - 剥掉时限并标记', () => {
		expect(parseSlashGoalInput('/goal 30m 补全属性')).toEqual({
			objective: '补全属性',
			timeLimitIgnored: true,
		});
	});

	it('parseSlashGoalInput - /goalie 不是命令', () => {
		expect(parseSlashGoalInput('/goalie')).toBeNull();
	});

	it('isSlashGoalCreateTurn - /goal 加陈述 - true;空 /goal 与普通句 - false', () => {
		expect(isSlashGoalCreateTurn('/goal 审查妖市')).toBe(true);
		expect(isSlashGoalCreateTurn('/goal')).toBe(false);
		expect(isSlashGoalCreateTurn('审查妖市')).toBe(false);
	});
});

describe('splitLeadingSlashCommand', () => {
	it('splitLeadingSlashCommand - 完整 /goal 加空格 - 命令段强调', () => {
		expect(splitLeadingSlashCommand('/goal 补全属性')).toEqual([
			{ kind: 'command', text: '/goal' },
			{ kind: 'text', text: ' 补全属性' },
		]);
	});

	it('splitLeadingSlashCommand - 仅前缀 /g - 不高亮', () => {
		expect(splitLeadingSlashCommand('/g')).toEqual([{ kind: 'text', text: '/g' }]);
	});

	it('splitLeadingSlashCommand - /goalie 不高亮', () => {
		expect(splitLeadingSlashCommand('/goalie')).toEqual([{ kind: 'text', text: '/goalie' }]);
	});

	it('splitLeadingSlashCommand - 命中技能全名 - 技能段单独标色', () => {
		expect(splitLeadingSlashCommand('/install-diary-plugins', ['install-diary-plugins'])).toEqual([
			{ kind: 'skill', text: '/install-diary-plugins' },
		]);
	});

	it('splitLeadingSlashCommand - 未登记的斜杠名 - 不高亮', () => {
		expect(splitLeadingSlashCommand('/install-diary-plugins', ['diary-month-ledger'])).toEqual([
			{ kind: 'text', text: '/install-diary-plugins' },
		]);
	});
});

describe('shouldCreateSkillManageModal', () => {
	it('单例判定 - null 才新建', () => {
		expect(shouldCreateSkillManageModal(null)).toBe(true);
		expect(shouldCreateSkillManageModal({} as never)).toBe(false);
	});
});
