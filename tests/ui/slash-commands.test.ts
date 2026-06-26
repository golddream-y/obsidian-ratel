/**
 * @file tests/ui/slash-commands.test.ts
 * @description slash-commands — 命令注册表与过滤纯函数单测
 * @module tests/ui/slash-commands
 * @depends ui/slash-commands
 */

import { describe, it, expect } from 'vitest';
import { SLASH_COMMANDS, filterCommands, type SlashCommand } from '../../src/ui/slash-commands';

describe('slash-commands', () => {
	it('SLASH_COMMANDS - 含 4 个命令(new/compact/model/reindex)', () => {
		const names = SLASH_COMMANDS.map((c) => c.name);
		expect(names).toEqual(['/new', '/compact', '/model', '/reindex']);
	});

	it('SLASH_COMMANDS - 每个命令含 name/description/icon', () => {
		for (const cmd of SLASH_COMMANDS) {
			expect(cmd.name).toMatch(/^\//);
			expect(cmd.description.length).toBeGreaterThan(0);
			expect(cmd.icon.length).toBeGreaterThan(0);
		}
	});

	it('filterCommands - 空串(仅 /) - 返回全部命令', () => {
		expect(filterCommands('/')).toHaveLength(4);
	});

	it('filterCommands - /n - 只返回 /new', () => {
		const result = filterCommands('/n');
		expect(result).toHaveLength(1);
		expect(result[0]!.name).toBe('/new');
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
});
