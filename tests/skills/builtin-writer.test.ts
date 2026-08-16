/**
 * @file tests/skills/builtin-writer.test.ts
 * @description syncBuiltinSkills 幂等写出发单测(用真实临时目录,不 mock fs)
 * @module tests/skills/builtin-writer
 * @depends node:fs, skills/builtin-writer
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { syncBuiltinSkills } from '../../src/skills/builtin-writer';

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'ratel-skills-'));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const SKILL_MD = `---
name: ratel-config
description: 测试用
activation: auto
---

# 正文
`;

describe('syncBuiltinSkills', () => {
	it('首次调用 - 写出 SKILL.md 且 frontmatter 注入 version', () => {
		const r = syncBuiltinSkills(dir, { 'ratel-config': SKILL_MD }, '0.3.0');
		expect(r.written).toEqual(['ratel-config']);
		const content = readFileSync(path.join(dir, 'ratel-config', 'SKILL.md'), 'utf-8');
		expect(content).toContain('version: 0.3.0');
		expect(content).toContain('# 正文');
	});

	it('version 相同 - 跳过不重写', () => {
		syncBuiltinSkills(dir, { 'ratel-config': SKILL_MD }, '0.3.0');
		const r2 = syncBuiltinSkills(dir, { 'ratel-config': SKILL_MD }, '0.3.0');
		expect(r2.skipped).toEqual(['ratel-config']);
		expect(r2.written).toHaveLength(0);
	});

	it('version 不同 - 重写为新版本', () => {
		syncBuiltinSkills(dir, { 'ratel-config': SKILL_MD }, '0.3.0');
		const r2 = syncBuiltinSkills(dir, { 'ratel-config': SKILL_MD }, '0.4.0');
		expect(r2.written).toEqual(['ratel-config']);
		expect(readFileSync(path.join(dir, 'ratel-config', 'SKILL.md'), 'utf-8')).toContain('version: 0.4.0');
	});

	it('磁盘已有旧 version 字段 - 覆盖为当前版本', () => {
		mkdirSync(path.join(dir, 'ratel-config'), { recursive: true });
		writeFileSync(
			path.join(dir, 'ratel-config', 'SKILL.md'),
			SKILL_MD.replace('activation: auto', 'activation: auto\nversion: 0.1.0'),
		);
		const r = syncBuiltinSkills(dir, { 'ratel-config': SKILL_MD }, '0.3.0');
		expect(r.written).toEqual(['ratel-config']);
	});

	it('写出失败(目标为文件) - 不抛错且不计入 written', () => {
		// 用同名文件堵住目录创建,制造 EEXIST/ENOTDIR
		writeFileSync(path.join(dir, 'ratel-config'), 'not a dir');
		const r = syncBuiltinSkills(dir, { 'ratel-config': SKILL_MD }, '0.3.0');
		expect(r.written).toHaveLength(0);
	});

	it('无内置 skill - 空结果', () => {
		const r = syncBuiltinSkills(dir, {}, '0.3.0');
		expect(r.written).toHaveLength(0);
		expect(r.skipped).toHaveLength(0);
	});
});
