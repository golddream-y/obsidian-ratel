/**
 * @file tests/helpers/obsidian-mock.ts
 * @description vitest 全局 obsidian 模块 mock — 提供常用导出的最小桩实现
 * @module tests/helpers/obsidian-mock
 *
 * 关键路径:vitest 在 Node 环境运行,无法解析 obsidian 包(其 package.json 无 main/exports)。
 * 通过 vitest.config.ts 的 resolve.alias 把 'obsidian' 指向本文件,
 * 所有 `import { xxx } from 'obsidian'` 在测试环境解析到这里。
 *
 * 添加新导出时,只需在下方提供最小桩实现。具体行为由各测试用 vi.mock 或 spy 覆盖。
 */

/** requestUrl 桩 — 默认返回空 200,测试用 vi.mock('obsidian') 覆盖具体行为 */
export async function requestUrl(_options: unknown): Promise<{
	status: number;
	text: string;
	json: unknown;
	arrayBuffer: ArrayBuffer;
}> {
	return { status: 200, text: '', json: {}, arrayBuffer: new ArrayBuffer(0) };
}

/** Notice 桩 */
export class Notice {
	constructor(_message?: unknown, _timeout?: number) {}
}

/** TFile 桩 — instanceof 检查需要构造器 */
export class TFile {
	path = '';
	name = '';
	extension = '';
	basename = '';
	stat = { mtime: 0, size: 0, ctime: 0 };
}

/** TFolder 桩 */
export class TFolder {
	path = '';
	name = '';
	parent: TFolder | null = null;
}

/** FileManager 案例:trashFile 默认 no-op,测试可覆盖 */
export class FileManager {
	async trashFile(_file: unknown): Promise<void> {}
}

/** Plugin 桩 */
export class Plugin {
	app: unknown;
	manifest: unknown;
	constructor(_app: unknown, _manifest: unknown) {
		this.app = _app;
		this.manifest = _manifest;
	}
	addCommand() {
		return this;
	}
	addRibbonIcon() {
		return this;
	}
	addSettingTab() {
		return this;
	}
	registerView() {
		return this;
	}
	loadData() {
		return Promise.resolve({});
	}
	saveData() {
		return Promise.resolve();
	}
	onunload() {}
}

/** Setting 桩 — 链式 API */
export class Setting {
	containerEl: unknown;
	constructor(containerEl: unknown) {
		this.containerEl = containerEl;
	}
	setName() {
		return this;
	}
	setDesc() {
		return this;
	}
	setHeading() {
		return this;
	}
	addText() {
		return this;
	}
	addToggle() {
		return this;
	}
	addDropdown() {
		return this;
	}
	addSlider() {
		return this;
	}
	addButton() {
		return this;
	}
	addExtraButton() {
		return this;
	}
	setTooltip() {
		return this;
	}
	setClass() {
		return this;
	}
	setDisabled() {
		return this;
	}
}

/**
 * PluginSettingTab 桩 — 提供 1.13.0 声明式 API 的默认实现。
 *
 * 关键路径:默认 getControlValue / setControlValue 直接读写 settings[key](字面量 key),
 * 嵌套 key(如 "toolPermissions.search_vault")会读到 undefined / 写到错误位置,
 * 由子类 override 处理嵌套分发。
 */
export class PluginSettingTab {
	app: unknown;
	// 关键路径:plugin 类型用 unknown,子类会以更具体的 RatelVaultPlugin 覆盖。
	plugin: unknown;
	containerEl: unknown = {};
	constructor(app: unknown, plugin: unknown) {
		this.app = app;
		this.plugin = plugin;
	}
	display(): void {}
	getSettingDefinitions(): unknown[] {
		return [];
	}
	getControlValue(key: string): unknown {
		const settings = (this.plugin as { settings?: Record<string, unknown> })?.settings;
		return settings?.[key];
	}
	async setControlValue(key: string, value: unknown): Promise<void> {
		const settings = (this.plugin as { settings: Record<string, unknown> }).settings;
		settings[key] = value;
	}
	update(): void {}
}

/**
 * SettingPage 桩 — 1.13.0 声明式 settings 子页面基类。
 *
 * 关键路径:settings.ts 导入 DiagnosticsSettingPage(extends SettingPage),
 * 测试环境需提供可构造的基类。display() 在测试中不被调用,留空实现即可。
 */
export class SettingPage {
	rootEl: unknown = {};
	titlebarEl: unknown = {};
	containerEl: unknown = {};
	title = '';
	constructor() {}
	display(): void {}
	hide(): void {}
}

/** Modal 桩 */
export class Modal {
	app: unknown;
	contentEl: { empty: () => void; createEl: () => HTMLElement; addClass: () => void };
	constructor(app: unknown) {
		this.app = app;
		this.contentEl = {
			empty: () => {},
			createEl: () => ({}) as HTMLElement,
			addClass: () => {},
		};
	}
	open() {}
	close() {}
}

/** ItemView 桩 */
export class ItemView {
	app: unknown;
	 getViewType() {
		return 'ratel-chat';
	}
	getDisplayText() {
		return 'Ratel';
	}
	getIcon() {
		return 'paw-print';
	}
}

/** WorkspaceLeaf 桩 */
export class WorkspaceLeaf {
	view: unknown;
	containerEl: { empty: () => void; createEl: () => HTMLElement };
	constructor() {
		this.containerEl = {
			empty: () => {},
			createEl: () => ({}) as HTMLElement,
		};
	}
}

/** FileSystemAdapter 桩 */
export class FileSystemAdapter {
	exists(_path: string) {
		return Promise.resolve(false);
	}
	read(_path: string) {
		return Promise.resolve('');
	}
	write(_path: string, _data: string) {
		return Promise.resolve();
	}
}

/** 其他常用导出(桩) */
export const Platform = { isMobile: false, isDesktop: true };
export const Keymap = { mods: () => '' };
