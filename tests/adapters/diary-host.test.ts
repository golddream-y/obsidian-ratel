/**
 * @file tests/adapters/diary-host.test.ts
 * @description 日记宿主两项开关的合并与落盘
 * @module tests/adapters/diary-host
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { setConfigDir } from '../../src/utils/path-safety';
import {
	DIARY_FOLDER,
	DIARY_TEMPLATE_PATH,
	TEMPLATER_LOCAL_KEY,
	applyDiaryHost,
	mergeDailyNotesConfig,
	mergeTemplaterLocal,
	resolveDiaryFolder,
	type DiaryHostApp,
} from '../../src/adapters/diary-host';

function folderAdapter(written: { text: string }, made: string[]) {
	const have = new Set<string>();
	return {
		read: async () => {
			throw new Error('missing');
		},
		write: async (_path: string, data: string) => {
			written.text = data;
		},
		exists: async (path: string) => have.has(path),
		mkdir: async (path: string) => {
			made.push(path);
			have.add(path);
		},
	};
}

describe('diary-host', () => {
	beforeEach(() => setConfigDir('.obsidian'));

	it('mergeTemplaterLocal - 已有本机项 - 只打开新建触发', () => {
		expect(mergeTemplaterLocal({ enable_system_commands: false, trigger_on_file_creation: false })).toEqual({
			enable_system_commands: false,
			trigger_on_file_creation: true,
		});
	});

	it('mergeDailyNotesConfig - 平铺默认格式 - 改成带月份目录', () => {
		expect(mergeDailyNotesConfig({ format: 'YYYY-MM-DD', autorun: false })).toEqual({
			format: 'YYYY/MM-MMMM/YYYY-MM-DD-dddd',
			autorun: false,
			folder: DIARY_FOLDER,
			template: DIARY_TEMPLATE_PATH,
		});
	});

	it('mergeDailyNotesConfig - 用户已设其它格式 - 保留', () => {
		expect(mergeDailyNotesConfig({ format: 'YYYY/[Daily]/YYYY-MM-DD' }).format).toBe('YYYY/[Daily]/YYYY-MM-DD');
	});

	it('resolveDiaryFolder - 空 - 用建议目录；穿越 - 拒绝', () => {
		expect(resolveDiaryFolder(undefined)).toBe(DIARY_FOLDER);
		expect(resolveDiaryFolder('Notes/Journal')).toBe('Notes/Journal');
		expect(() => resolveDiaryFolder('../secret')).toThrow();
	});

	it('applyDiaryHost - 插件未加载 - 写 localStorage、daily-notes.json，并建目录', async () => {
		const storage: Record<string, unknown> = {};
		const written = { text: '' };
		const made: string[] = [];
		const app: DiaryHostApp = {
			loadLocalStorage: (key) => storage[key] ?? null,
			saveLocalStorage: (key, data) => {
				storage[key] = data;
			},
			vault: {
				configDir: '.obsidian',
				adapter: folderAdapter(written, made),
			},
		};
		const result = await applyDiaryHost(app, 'Notes/Journal');
		expect(storage[TEMPLATER_LOCAL_KEY]).toEqual({ trigger_on_file_creation: true });
		expect(JSON.parse(written.text)).toEqual({
			folder: 'Notes/Journal',
			template: DIARY_TEMPLATE_PATH,
			format: 'YYYY/MM-MMMM/YYYY-MM-DD-dddd',
		});
		expect(made).toEqual(['Notes', 'Notes/Journal']);
		expect(result.folder).toBe('Notes/Journal');
	});

	it('applyDiaryHost - Dataview 已加载 - 打开内存里的 JS 并保存', async () => {
		const settings: Record<string, unknown> = { enableDataviewJs: false };
		let saved = false;
		const written = { text: '' };
		const made: string[] = [];
		const app: DiaryHostApp = {
			loadLocalStorage: () => null,
			saveLocalStorage: () => {},
			vault: { configDir: '.obsidian', adapter: folderAdapter(written, made) },
			plugins: {
				plugins: {
					dataview: {
						settings,
						saveSettings: async () => {
							saved = true;
						},
					},
				},
			},
		};
		const result = await applyDiaryHost(app);
		expect(settings.enableDataviewJs).toBe(true);
		expect(saved).toBe(true);
		expect(result.dataviewJs).toBe(true);
	});

	it('applyDiaryHost - 核心日记已加载 - 改 options 并 saveOptions，不另写文件', async () => {
		const options: Record<string, unknown> = { format: 'YYYY-MM-DD' };
		let saved = false;
		let wroteFile = false;
		const made: string[] = [];
		const app: DiaryHostApp = {
			loadLocalStorage: () => ({ enable_startup_templates: false }),
			saveLocalStorage: () => {},
			vault: {
				configDir: '.obsidian',
				adapter: {
					read: async () => '{}',
					write: async () => {
						wroteFile = true;
					},
					exists: async () => false,
					mkdir: async () => {
						made.push('ok');
					},
				},
			},
			internalPlugins: {
				getPluginById: () => ({
					enabled: true,
					enable: () => {},
					instance: {
						options,
						saveOptions: async () => {
							saved = true;
						},
					},
				}),
			},
		};
		await applyDiaryHost(app);
		expect(saved).toBe(true);
		expect(wroteFile).toBe(false);
		expect(options.folder).toBe(DIARY_FOLDER);
		expect(options.template).toBe(DIARY_TEMPLATE_PATH);
		expect(options.format).toBe('YYYY/MM-MMMM/YYYY-MM-DD-dddd');
		expect(made).toEqual(['ok', 'ok']);
	});
});
