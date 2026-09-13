/**
 * @file src/skills/parse-skill-ecosystem.test.ts
 * @description parseSkillEcosystem 单元测试
 * @module skills/parse-skill-ecosystem.test
 */

import { describe, it, expect } from 'vitest';
import { parseSkillEcosystem } from './parse-skill-ecosystem';
import { isWhitelistedKey } from '../settings/config-whitelist';
import { setConfigDir } from '../utils/path-safety';

const ctx = {
	skillName: 'monthly-notes',
	isWhitelistedKey,
	lookupProfile: { lookup: () => undefined },
};

describe('parseSkillEcosystem', () => {
	it('缺省 - 无 ecosystem 字段 - absent 且无 issues', () => {
		const r = parseSkillEcosystem(undefined, ctx);
		expect(r.validity).toBe('absent');
		expect(r.issues).toEqual([]);
		expect(r.value).toBeUndefined();
	});

	it('合法最小插件项 - 无档案 - valid', () => {
		const r = parseSkillEcosystem(
			{ plugins: [{ pluginId: 'dataview' }] },
			ctx,
		);
		expect(r.validity).toBe('valid');
		expect(r.value?.plugins[0]).toEqual({
			pluginId: 'dataview',
			required: true,
		});
	});

	it('profileId 无匹配档案 - invalid', () => {
		const r = parseSkillEcosystem(
			{
				plugins: [{ pluginId: 'dataview', profileId: 'dataview-js-queries', presetId: 'enable-js' }],
			},
			ctx,
		);
		expect(r.validity).toBe('invalid');
		expect(r.issues.some((i) => i.code === 'profileMissing')).toBe(true);
	});

	it('profileId 非字符串 - invalid', () => {
		const r = parseSkillEcosystem(
			{
				plugins: [{ pluginId: 'dataview', profileId: 123, presetId: 'enable-js' }],
			},
			ctx,
		);
		expect(r.validity).toBe('invalid');
		expect(r.issues.some((i) => i.code === 'profileIncomplete')).toBe(true);
	});

	it('ratel.key 不在白名单 - invalid', () => {
		const r = parseSkillEcosystem(
			{ ratel: [{ key: 'toolPermissions' }] },
			ctx,
		);
		expect(r.validity).toBe('invalid');
		expect(r.issues.some((i) => i.code === 'ratelKeyUnknown')).toBe(true);
	});

	it('ratel.key 为 dailyNoteFolder - valid', () => {
		const r = parseSkillEcosystem(
			{ ratel: [{ key: 'dailyNoteFolder' }] },
			ctx,
		);
		expect(r.validity).toBe('valid');
	});

	it('skill:// 指向别的 skill - invalid', () => {
		const r = parseSkillEcosystem(
			{
				vaultFiles: [{ dest: 'Template/Daily.md', source: 'skill://other/templates/daily.md' }],
			},
			ctx,
		);
		expect(r.validity).toBe('invalid');
		expect(r.issues.some((i) => i.code === 'skillUrlWrongSkill')).toBe(true);
	});

	it('skill:// 含 .. - invalid', () => {
		const r = parseSkillEcosystem(
			{
				vaultFiles: [{ dest: 'Template/Daily.md', source: 'skill://monthly-notes/templates/../../x.md' }],
			},
			ctx,
		);
		expect(r.validity).toBe('invalid');
		expect(r.issues.some((i) => i.code === 'skillUrlTraversal')).toBe(true);
	});

	it('vault dest 指向 configDir - invalid', () => {
		setConfigDir('.obsidian');
		const r = parseSkillEcosystem(
			{
				vaultFiles: [{ dest: '.obsidian/plugins/foo/data.json', source: 'skill://monthly-notes/templates/a.md' }],
			},
			ctx,
		);
		expect(r.validity).toBe('invalid');
		expect(r.issues.some((i) => i.code === 'vaultDestUnsafe')).toBe(true);
	});

	it('plugin 项带 keys 裸补丁 - invalid', () => {
		const r = parseSkillEcosystem(
			{ plugins: [{ pluginId: 'dataview', keys: { enableDataviewJs: true } }] },
			ctx,
		);
		expect(r.validity).toBe('invalid');
		expect(r.issues.some((i) => i.code === 'barePluginKeys')).toBe(true);
	});

	it('pluginId 为 ratel-vault - invalid', () => {
		const r = parseSkillEcosystem(
			{ plugins: [{ pluginId: 'ratel-vault' }] },
			ctx,
		);
		expect(r.validity).toBe('invalid');
		expect(r.issues.some((i) => i.code === 'forbiddenPluginId')).toBe(true);
	});

	it('未知顶层键 - invalid', () => {
		const r = parseSkillEcosystem({ dataJson: { foo: 1 } }, ctx);
		expect(r.validity).toBe('invalid');
		expect(r.issues.some((i) => i.code === 'unknownTopLevel')).toBe(true);
	});

	it('plugins 非数组 - notArray', () => {
		const r = parseSkillEcosystem({ plugins: {} }, ctx);
		expect(r.validity).toBe('invalid');
		expect(r.issues).toContainEqual({ code: 'notArray', detail: 'plugins 必须是数组' });
	});

	it('plugins 项非对象 - itemNotObject', () => {
		const r = parseSkillEcosystem({ plugins: ['bad'] }, ctx);
		expect(r.validity).toBe('invalid');
		expect(r.issues).toContainEqual({ code: 'itemNotObject', detail: 'plugins 每项必须是对象' });
	});

	it('required 非布尔 - requiredNotBoolean', () => {
		const r = parseSkillEcosystem(
			{ plugins: [{ pluginId: 'dataview', required: 'yes' }] },
			ctx,
		);
		expect(r.validity).toBe('invalid');
		expect(r.issues).toContainEqual({ code: 'requiredNotBoolean', detail: 'required 必须为布尔值' });
	});

	it('档案 pluginId 不一致 - profilePluginMismatch 带 profileId', () => {
		const r = parseSkillEcosystem(
			{
				plugins: [{ pluginId: 'dataview', profileId: 'dv', presetId: 'js' }],
			},
			{
				...ctx,
				lookupProfile: {
					lookup: () => ({
						pluginId: 'templater',
						enabled: true,
						draft: false,
						presetExists: true,
					}),
				},
			},
		);
		expect(r.validity).toBe('invalid');
		const issue = r.issues.find((i) => i.code === 'profilePluginMismatch');
		expect(issue?.params).toEqual({ profileId: 'dv' });
	});
});
