/**
 * @file src/skills/preview-skill-ecosystem.test.ts
 * @description buildEcosystemPreview 单元测试
 * @module skills/preview-skill-ecosystem.test
 */

import { describe, it, expect } from 'vitest';
import { buildEcosystemPreview } from './preview-skill-ecosystem';
import type { ParsedSkillEcosystem, PluginPresence } from './ecosystem-types';
import type { Skill } from './types';

const t = (code: string, params?: Record<string, string>) =>
	params ? `${code}:${JSON.stringify(params)}` : code;

function makeSkill(ecosystem: ParsedSkillEcosystem, name = 'monthly-notes'): Skill {
	return {
		manifest: {
			name,
			description: 'test',
			enabled: true,
			activation: 'auto',
			tags: [],
			ecosystem,
		},
		instructions: '',
		source: 'vault',
		dir: '/vault/.ratel/skills/monthly-notes',
	};
}

function mockPresence(enabled: string[], installed: string[] = []): PluginPresence {
	const enabledSet = new Set(enabled);
	const installedSet = new Set(installed);
	return {
		listEnabled: async () => [...enabledSet],
		isInstalled: async (pluginId) => installedSet.has(pluginId),
	};
}

describe('buildEcosystemPreview', () => {
	it('无 presence - dataview 依赖 - presence 为 unknown', async () => {
		const skill = makeSkill({
			validity: 'valid',
			value: {
				plugins: [{ pluginId: 'dataview', required: true }],
				ratel: [],
				vaultFiles: [],
			},
			issues: [],
		});
		const preview = await buildEcosystemPreview(skill, { t });
		expect(preview.plugins).toEqual([
			{ pluginId: 'dataview', required: true, presence: 'unknown' },
		]);
	});

	it('presence 含 dataview - 已启用 - presence 为 enabled', async () => {
		const skill = makeSkill({
			validity: 'valid',
			value: {
				plugins: [{ pluginId: 'dataview', required: true }],
				ratel: [],
				vaultFiles: [],
			},
			issues: [],
		});
		const preview = await buildEcosystemPreview(skill, {
			presence: mockPresence(['dataview']),
			t,
		});
		expect(preview.plugins[0].presence).toBe('enabled');
	});

	it('已安装未启用 - presence 为 installed', async () => {
		const skill = makeSkill({
			validity: 'valid',
			value: {
				plugins: [{ pluginId: 'dataview', required: true }],
				ratel: [],
				vaultFiles: [],
			},
			issues: [],
		});
		const preview = await buildEcosystemPreview(skill, {
			presence: mockPresence([], ['dataview']),
			t,
		});
		expect(preview.plugins[0].presence).toBe('installed');
	});

	it('未安装 - presence 为 missing', async () => {
		const skill = makeSkill({
			validity: 'valid',
			value: {
				plugins: [{ pluginId: 'dataview', required: true }],
				ratel: [],
				vaultFiles: [],
			},
			issues: [],
		});
		const preview = await buildEcosystemPreview(skill, {
			presence: mockPresence([]),
			t,
		});
		expect(preview.plugins[0].presence).toBe('missing');
	});

	it('validity absent - 空列表且 applyReady 为 false', async () => {
		const skill = makeSkill({ validity: 'absent', issues: [] });
		const preview = await buildEcosystemPreview(skill, { t });
		expect(preview.validity).toBe('absent');
		expect(preview.plugins).toEqual([]);
		expect(preview.ratel).toEqual([]);
		expect(preview.vaultFiles).toEqual([]);
		expect(preview.applyReady).toBe(false);
	});

	it('validity valid - applyReady 为 true', async () => {
		const skill = makeSkill({
			validity: 'valid',
			value: {
				plugins: [{ pluginId: 'dataview', required: true }],
				ratel: [{ key: 'dailyNoteFolder' }],
				vaultFiles: [{ dest: 'T/D.md', source: 'skill://monthly-notes/t.md', sourceRel: 't.md' }],
			},
			issues: [],
		});
		const preview = await buildEcosystemPreview(skill, { t });
		expect(preview.applyReady).toBe(true);
		expect(preview.ratel).toEqual([{ key: 'dailyNoteFolder' }]);
		expect(preview.vaultFiles).toEqual([{ dest: 'T/D.md', source: 'skill://monthly-notes/t.md' }]);
	});

	it('validity invalid - applyReady 为 false 且 issues 带 message', async () => {
		const skill = makeSkill({
			validity: 'invalid',
			value: {
				plugins: [],
				ratel: [{ key: 'badKey' }],
				vaultFiles: [],
			},
			issues: [{ code: 'ratelKeyUnknown', detail: 'ratel.key 不在白名单: badKey', params: { key: 'badKey' } }],
		});
		const preview = await buildEcosystemPreview(skill, { t });
		expect(preview.applyReady).toBe(false);
		expect(preview.issues).toEqual([
			{ code: 'ratelKeyUnknown', message: 'ratelKeyUnknown:{"key":"badKey"}' },
		]);
	});
});
