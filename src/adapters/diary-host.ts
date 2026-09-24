/**
 * @file src/adapters/diary-host.ts
 * @description 日记宿主两项开关：Templater 本机「新建即触发」与核心日记模板路径
 * @module adapters/diary-host
 * @depends obsidian
 */

import type { DataAdapter } from 'obsidian';
import { tNow } from '../i18n';
import { validateEcosystemPath, validateVaultPath } from '../utils/path-safety';

/** 核心日记模板，不含 .md，与 Obsidian 日记设置里的写法一致 */
export const DIARY_TEMPLATE_PATH = 'Template/Diary/Daily Note Template';

/** 建议的日记根。初次确认时问用户要不要改，同意后再写入。 */
export const DIARY_FOLDER = 'Work/Diary';

/**
 * 核心日记的相对路径。`/` 是月份目录。
 * Obsidian 按界面语言调用 moment.locale：简体中文时 MMMM 为「九月」、dddd 为「星期四」。
 * 缺省或仍是平铺的 YYYY-MM-DD 时写入这份，当天日记才会进月份文件夹。
 */
export const DIARY_NOTE_FORMAT = 'YYYY/MM-MMMM/YYYY-MM-DD-dddd';

const FLAT_NOTE_FORMAT = 'YYYY-MM-DD';

/** Templater 用 app.saveLocalStorage 存的键，不在 plugins/templater-obsidian/data.json */
export const TEMPLATER_LOCAL_KEY = 'templater-local-settings';

export interface DiaryHostResult {
	triggerOnFileCreation: true;
	dataviewJs: boolean;
	folder: string;
	template: string;
	format: string;
}

/** 宿主上用到的最小表面，便于测试不拉起整份 App */
export interface DiaryHostApp {
	loadLocalStorage(key: string): unknown;
	saveLocalStorage(key: string, data: unknown): void;
	vault: {
		configDir: string;
		adapter: Pick<DataAdapter, 'read' | 'write' | 'exists' | 'mkdir'>;
	};
	internalPlugins?: {
		getPluginById?(id: string): DailyNotesPlugin | null;
	};
	plugins?: {
		plugins?: Record<string, CommunityPlugin | undefined>;
	};
}

interface CommunityPlugin {
	settings?: Record<string, unknown>;
	saveSettings?: () => Promise<void>;
	saveData?: (data: unknown) => Promise<void>;
}

interface DailyNotesPlugin {
	enabled: boolean;
	enable(): Promise<void> | void;
	instance?: {
		options?: Record<string, unknown>;
		saveOptions?: () => Promise<void>;
	};
}

/**
 * 保留已有本机项，只把「新建文件时触发」打开。
 *
 * @param current - loadLocalStorage 的原值，可能为空或非对象
 * @returns 写回 localStorage 的对象
 */
export function mergeTemplaterLocal(current: unknown): Record<string, unknown> {
	const base =
		current && typeof current === 'object' && !Array.isArray(current)
			? { ...(current as Record<string, unknown>) }
			: {};
	return { ...base, trigger_on_file_creation: true };
}

/**
 * 确认后的日记根。缺省用建议路径。拒绝配置目录和穿越。
 *
 * @param input - 工具参数 folder；空则用建议目录
 * @returns 库内相对路径
 */
export function resolveDiaryFolder(input: unknown): string {
	if (input === undefined || input === null || input === '') return DIARY_FOLDER;
	if (typeof input !== 'string') {
		throw new Error(tNow('error.tool.invalidArg', { label: 'folder', type: typeof input }));
	}
	const normalized = validateVaultPath(input.trim());
	if (!normalized) {
		throw new Error(tNow('error.tool.invalidArg', { label: 'folder', type: 'empty' }));
	}
	return normalized;
}

/**
 * 日记相对路径。空或平铺的 `YYYY-MM-DD` 换成带月份目录的格式；用户已设的其它格式保留。
 *
 * @param current - 现有 format
 * @returns 写回核心日记的 format
 */
export function resolveDiaryNoteFormat(current: unknown): string {
	if (typeof current !== 'string') return DIARY_NOTE_FORMAT;
	const trimmed = current.trim();
	if (!trimmed || trimmed === FLAT_NOTE_FORMAT) return DIARY_NOTE_FORMAT;
	return trimmed;
}

/**
 * 改目录、模板，并在格式仍是平铺默认时补上月份目录。
 *
 * @param current - daily-notes.json 解析结果
 * @param folder - 用户确认过的日记根
 * @returns 写回的对象
 */
export function mergeDailyNotesConfig(current: unknown, folder: string = DIARY_FOLDER): Record<string, unknown> {
	const base =
		current && typeof current === 'object' && !Array.isArray(current)
			? { ...(current as Record<string, unknown>) }
			: {};
	return {
		...base,
		folder,
		template: DIARY_TEMPLATE_PATH,
		format: resolveDiaryNoteFormat(base.format),
	};
}

/**
 * 打开 Templater 新建触发，并把核心日记目录和模板指到日记方案。
 *
 * 设计要点:
 * - trigger_on_file_creation 走 Templater 的 localStorage，configure_plugin 只写 data.json，碰不到
 * - 核心日记在 `{configDir}/daily-notes.json`，文件名在通道 B 的宿主清单里；优先改已加载插件的 options 再 saveOptions，避免内存里的旧值把文件盖回去
 *
 * @param app - 当前库的 Obsidian App
 * @param folder - 用户确认过的日记根；缺省为建议目录
 * @returns 实际写入的三项
 */
export async function applyDiaryHost(app: DiaryHostApp, folder: string = DIARY_FOLDER): Promise<DiaryHostResult> {
	const diaryFolder = resolveDiaryFolder(folder);
	app.saveLocalStorage(TEMPLATER_LOCAL_KEY, mergeTemplaterLocal(app.loadLocalStorage(TEMPLATER_LOCAL_KEY)));
	const dataviewJs = await enableDataviewJs(app);
	const format =
		(await trySaveDailyNotesPlugin(app, diaryFolder)) ??
		(await writeDailyNotesFile(app.vault.adapter, app.vault.configDir, diaryFolder));
	await ensureDiaryFolder(app.vault.adapter, diaryFolder);
	return {
		triggerOnFileCreation: true,
		dataviewJs,
		folder: diaryFolder,
		template: DIARY_TEMPLATE_PATH,
		format,
	};
}

/**
 * 改已加载核心日记的目录、模板和格式，并 saveOptions。
 *
 * @param app - 当前库
 * @param folder - 用户确认过的日记根
 * @returns 写入的 format；插件未加载或无法保存时 null
 */
async function trySaveDailyNotesPlugin(app: DiaryHostApp, folder: string): Promise<string | null> {
	const plugin = app.internalPlugins?.getPluginById?.('daily-notes') ?? null;
	if (!plugin) return null;
	try {
		if (!plugin.enabled) await plugin.enable();
	} catch {
		return null;
	}
	if (!plugin.instance?.options || !plugin.instance.saveOptions) return null;
	const merged = mergeDailyNotesConfig(plugin.instance.options, folder);
	plugin.instance.options.folder = merged.folder;
	plugin.instance.options.template = merged.template;
	plugin.instance.options.format = merged.format;
	await plugin.instance.saveOptions();
	return String(merged.format);
}

async function writeDailyNotesFile(
	adapter: Pick<DataAdapter, 'read' | 'write'>,
	configDir: string,
	folder: string,
): Promise<string> {
	// 关键路径:宿主文件也过通道 B，不因为「不是 data.json」另开一条不校验的写盘
	const rel = validateEcosystemPath(`${configDir}/daily-notes.json`, {
		catalogIds: new Set(),
		installedIds: new Set(),
	});
	let current: unknown = {};
	try {
		current = JSON.parse(await adapter.read(rel));
	} catch {
		// 修复: 核心日记尚未启用时文件不存在，按空对象创建
		current = {};
	}
	const next = mergeDailyNotesConfig(current, folder);
	await adapter.write(rel, JSON.stringify(next, null, 2));
	return String(next.format);
}

/**
 * 打开正在运行的 Dataview JS。只改 data.json 时，已加载的插件内存里仍是关的，
 * 日记里的 dataviewjs 会继续显示 queries are disabled。
 *
 * @param app - 当前库
 * @returns 是否写到了运行中的插件或它的 data.json
 */
async function enableDataviewJs(app: DiaryHostApp): Promise<boolean> {
	const plugin = app.plugins?.plugins?.dataview;
	if (plugin?.settings) {
		plugin.settings.enableDataviewJs = true;
		if (plugin.saveSettings) await plugin.saveSettings();
		else if (plugin.saveData) await plugin.saveData(plugin.settings);
		return true;
	}
	const manifest = `${app.vault.configDir}/plugins/dataview/manifest.json`;
	try {
		const raw = await app.vault.adapter.read(manifest);
		const parsed = JSON.parse(raw) as { id?: string };
		if (parsed.id !== 'dataview') return false;
	} catch {
		return false;
	}
	const rel = validateEcosystemPath(`${app.vault.configDir}/plugins/dataview/data.json`, {
		catalogIds: new Set(),
		installedIds: new Set(['dataview']),
	});
	let current: unknown = {};
	try {
		current = JSON.parse(await app.vault.adapter.read(rel));
	} catch {
		current = {};
	}
	await app.vault.adapter.write(rel, JSON.stringify({ ...(current as object), enableDataviewJs: true }, null, 2));
	return true;
}

/** 逐级创建日记根。Obsidian 新建日记时目录必须已经存在。 */
async function ensureDiaryFolder(adapter: Pick<DataAdapter, 'exists' | 'mkdir'>, folder: string): Promise<void> {
	const parts = folder.split('/').filter((part) => part.length > 0);
	let acc = '';
	for (const part of parts) {
		acc = acc ? `${acc}/${part}` : part;
		if (await adapter.exists(acc)) continue;
		await adapter.mkdir(acc);
	}
}
