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
});

describe('shouldCreateSkillManageModal', () => {
	it('单例判定 - null 才新建', () => {
		expect(shouldCreateSkillManageModal(null)).toBe(true);
		expect(shouldCreateSkillManageModal({} as never)).toBe(false);
	});
});
