# open_note 工具与内置配置 Skill 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 PRD CFG-01/02 — `open_note` 笔记打开工具、`ratel-config` 内置 Skill(构建内联分发,version 随应用)、配置 3 工具(`get_app_config` / `update_app_config` / `open_settings`),并抽取共享 settings-apply 模块。

**Architecture:** WorkspacePort 扩展两个 UI 操作方法(openNote/openPluginSettings);设置写入副作用从 SettingTab 抽到 `src/settings/settings-apply.ts` 供设置面板与 `update_app_config` 工具共用;builtin SKILL.md 经 esbuild 虚拟模块内联进 main.js,启动时幂等写出到 `pluginDir/skills/<name>/`(version 与 manifest.json 一致),复用既有三源 Skill 加载。

**Tech Stack:** TypeScript strict、Svelte 5、esbuild virtual module、vitest、gray-matter(已有依赖)。

**Spec:** [docs/superpowers/specs/2026-08-16-open-note-config-skill-design.md](../specs/2026-08-16-open-note-config-skill-design.md)

---

## 已核实的代码事实(执行者必读)

- **Tool 接口**:`{ definition: ToolDefinition; readOnly: boolean; execute(args: Record<string, unknown>): Promise<unknown> }`,定义于 `src/core/tool-registry.ts`。工具构造模式为 `createXxxTool(依赖…, definition) => Tool`,见 `src/tools/get-active-note.ts`。
- **工具注册**:`src/main.ts` onload 内 `this.tools.register(createReadNoteTool(...))`(约 line 384 附近),`toolDefMap` 来自 `composeToolDefinitions(this.settings.promptOverrides, ALL_TOOL_NAMES)`。
- **LLM schema**:`src/prompts/tool-schemas.ts` 的 `TOOL_SCHEMAS` 对象(以工具名为 key)+ `ALL_TOOL_NAMES` 数组(line 270)。
- **prompt 覆盖条目**:`src/prompts/sections.ts` 每个工具的 description/param 各一条 `{ id: 'tool.<name>.description', zone: 'tool', allowOverride: true, … }`(参照 line 105-121 的 tool.read_note)。
- **i18n**:`src/i18n/zh.ts` / `en.ts` 平铺 key:`'tool.name.<name>'`(UI 显示名,支持 `{path}` 插值)、`'settings.toolPermissions.<name>'`(设置面板标签)、`'promptLabel.tool.<name>.description'`(+`.desc`)、`'promptLabel.tool.<name>.param.<p>'`(+`.desc`)。
- **工具 result 的 message 硬编码中文**(LLM 读,不走 i18n)— 既有模式,见 `src/tools/get-active-note.ts` line 41。
- **默认权限**:`src/settings.ts` `DEFAULT_SETTINGS.toolPermissions`(line ~244 有 `get_vault_structure: 'allow'`)。
- **测试 helpers**:`tests/helpers/make-tool-def.ts`(`makeToolDef(name)` 返回 ToolDefinition)、`tests/helpers/mock-vault-port.ts`(`createMockVaultPort({ files, metadata })`)。
- **测试命令**:`npx vitest run <file>`;全量 `npm test`;类型 `npm run typecheck`;lint `npm run lint`。
- **SettingTab**:`src/settings.ts` — `SettingsUiTab` 类型(line 63)、私有 `activeSettingsTab`(line 333)、切 tab 模式「赋值 + `refreshDomState()`」(line 486-494)、`setControlValue`(line 1175-1228)。
- **preset 函数**:`applyChatPreset` 在 `src/settings/chat-preset.ts`、`applyContextLengthPreset` 在 `src/ui/tokens/context-length-presets.ts`、`applyLangPreference` 在 `src/i18n/index.ts`。
- **secrets**:`src/secrets/ratel-secrets.ts` — `hasChatApiKey(app, settings)`、`resolveChatSecretId(settings)`、`hasEmbedApiKey(app, settings)`、`resolveEmbedSecretId(settings)`、`hasRerankApiKey(app)`(精确签名以该文件为准,先读再写)。
- **索引状态**:`src/core/index-manager.ts` — `indexManager.status$` 为 Svelte writable,`IndexStatus` 含 `state` / `totalDocs` / `lastIndexTime`(`get(status$)` 读当前值,from `'svelte/store'`)。
- **Skill 加载**:`src/main.ts` line 250-265 — `builtinSkillsDir = path.join(pluginDir, 'skills')`,`SkillFsAdapter('builtin', builtinSkillsDir)` 只扫直接子目录且必须含 `SKILL.md`。
- **esbuild 内联先例**:`esbuild.config.mjs` `inlineEmbeddingWorkerPlugin()`(line 19-39)。
- **注释规范**:文件头 `@file/@description/@module/@depends` JSDoc;测试描述 `it('行为 - 条件 - 期望')` 中文。

---

### Task 1: 抽取 settings-apply 共享模块

**Files:**
- Create: `src/settings/settings-apply.ts`
- Modify: `src/settings.ts:1159-1228`(setControlValue 改为薄封装)
- Test: `tests/settings-apply.test.ts`(新建;`tests/settings.declarative.test.ts` 中 setControlValue 行为测试迁移到此)

- [ ] **Step 1: 写失败测试**

新建 `tests/settings-apply.test.ts`(从 `tests/settings.declarative.test.ts` 复制其 mock plugin 构造方式,把 `tab.setControlValue(...)` 断言改为对 `applySettingValue` 的断言;原文件中仅保留纯 UI 渲染类用例,凡测写入/副作用的全迁走):

```typescript
/**
 * @file tests/settings-apply.test.ts
 * @description applySettingValue 共享设置应用逻辑单测(从 settings.declarative.test.ts 迁移)
 */

import { describe, it, expect, vi } from 'vitest';
import { applySettingValue, type SettingApplier } from '../src/settings/settings-apply';
import { DEFAULT_SETTINGS } from '../src/settings';

function mockApplier(): SettingApplier & {
	rebuildLLM: ReturnType<typeof vi.fn>;
	rebuildEmbeddingAdapter: ReturnType<typeof vi.fn>;
	syncToolDefinitions: ReturnType<typeof vi.fn>;
} {
	return {
		settings: structuredClone(DEFAULT_SETTINGS),
		rebuildLLM: vi.fn(),
		rebuildEmbeddingAdapter: vi.fn(),
		syncToolDefinitions: vi.fn(),
	};
}

describe('applySettingValue', () => {
	it('嵌套 toolPermissions key - 写入嵌套对象', () => {
		const p = mockApplier();
		applySettingValue(p, 'toolPermissions.search_vault', 'allow');
		expect(p.settings.toolPermissions.search_vault).toBe('allow');
	});

	it('嵌套 promptOverrides key - 写入并触发 syncToolDefinitions', () => {
		const p = mockApplier();
		applySettingValue(p, 'promptOverrides.system.role', 'custom text');
		expect((p.settings.promptOverrides as Record<string, string | undefined>)['system.role']).toBe('custom text');
		expect(p.syncToolDefinitions).toHaveBeenCalledTimes(1);
	});

	it('chatModel 变更 - preset 切 custom 并 rebuildLLM', () => {
		const p = mockApplier();
		applySettingValue(p, 'chatModel', 'gpt-4');
		expect(p.settings.chatModel).toBe('gpt-4');
		expect(p.settings.chatPreset).toBe('custom');
		expect(p.rebuildLLM).toHaveBeenCalledTimes(1);
	});

	it('chatApiBase 变更 - rebuildLLM', () => {
		const p = mockApplier();
		applySettingValue(p, 'chatApiBase', 'http://new:11434/v1');
		expect(p.rebuildLLM).toHaveBeenCalledTimes(1);
	});

	it('embedApiBase 变更 - 触发 rebuildEmbeddingAdapter', () => {
		const p = mockApplier();
		applySettingValue(p, 'embedApiBase', 'http://new:11434/v1');
		expect(p.rebuildEmbeddingAdapter).toHaveBeenCalledTimes(1);
	});

	it('embedLocalModel 变更 - 不触发 rebuildEmbeddingAdapter', () => {
		const p = mockApplier();
		applySettingValue(p, 'embedLocalModel', 'Xenova/other');
		expect(p.rebuildEmbeddingAdapter).not.toHaveBeenCalled();
	});

	it('chatPreset deepseek - 写入多字段并 rebuildLLM', () => {
		const p = mockApplier();
		applySettingValue(p, 'chatPreset', 'deepseek');
		expect(p.settings.chatModel).toBe(DEFAULT_SETTINGS.chatModel); // 默认已是 deepseek 预设字段
		expect(p.rebuildLLM).toHaveBeenCalledTimes(1);
	});

	it('contextLengthPreset 变更 - 同步 chatModelMaxTokens', () => {
		const p = mockApplier();
		applySettingValue(p, 'contextLengthPreset', '32k');
		expect(p.settings.chatModelMaxTokens).toBeGreaterThan(0);
		expect(p.settings.contextLengthPreset).toBe('32k');
	});

	it('toolPermissionLevel 非法值 - 不写入', () => {
		const p = mockApplier();
		const before = p.settings.toolPermissionLevel;
		applySettingValue(p, 'toolPermissionLevel', 'yolo');
		expect(p.settings.toolPermissionLevel).toBe(before);
	});

	it('顶层普通 key - 直接写入', () => {
		const p = mockApplier();
		applySettingValue(p, 'chunkSize', 800);
		expect(p.settings.chunkSize).toBe(800);
	});
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/settings-apply.test.ts`
Expected: FAIL — `Cannot find module '../src/settings/settings-apply'`

- [ ] **Step 3: 实现 settings-apply.ts**

新建 `src/settings/settings-apply.ts`(逻辑**逐行搬**自 `src/settings.ts` line 1175-1225 的主体,不改动任何行为):

```typescript
/**
 * @file src/settings/settings-apply.ts
 * @description 共享的设置写入与副作用分发 — SettingTab 与 update_app_config 工具的唯一入口
 * @module settings/settings-apply
 * @depends settings, settings/chat-preset, ui/tokens/context-length-presets, i18n, utils/dev-logger
 */

import type { RatelVaultSettings, ToolPermission } from '../settings';
import { applyChatPreset, type ChatPresetId } from './chat-preset';
import { applyContextLengthPreset } from '../ui/tokens/context-length-presets';
import { applyLangPreference, type LangPreference } from '../i18n';
import { devLogger } from '../utils/dev-logger';

/**
 * 设置应用的最小宿主接口 — RatelVaultPlugin 结构兼容,测试用 mock。
 *
 * 设计要点:
 * - 不直接依赖 RatelVaultPlugin 类型,避免 settings-apply ↔ main 循环 import。
 * - 副作用回调(rebuildLLM 等)由宿主注入,本模块只负责「写哪个 key + 触发哪个副作用」的映射。
 */
export interface SettingApplier {
	settings: RatelVaultSettings;
	rebuildLLM(): void;
	rebuildEmbeddingAdapter(): void;
	syncToolDefinitions(): void;
}

/**
 * 写入一个设置 key 并分发副作用(不落盘、不刷新 UI — 由调用方收尾)。
 *
 * 关键路径:SettingTab.setControlValue 与 update_app_config 工具共用本函数,
 * 两处副作用行为永不漂移(这正是「改 preset 抽屉长度不变」类 bug 的根源预防)。
 *
 * @param plugin - 宿主(settings + 副作用回调)
 * @param key - control key,可为嵌套 key 如 "toolPermissions.search_vault"
 * @param value - 新值(调用方保证类型;枚举非法值静默忽略,与旧行为一致)
 */
export function applySettingValue(plugin: SettingApplier, key: string, value: unknown): void {
	// 嵌套 key 分发
	if (key.startsWith('toolPermissions.')) {
		const toolName = key.slice('toolPermissions.'.length);
		plugin.settings.toolPermissions[toolName] = value as ToolPermission;
	} else if (key.startsWith('promptOverrides.')) {
		const sectionId = key.slice('promptOverrides.'.length);
		(plugin.settings.promptOverrides as Record<string, string | undefined>)[sectionId] = value as string;
		plugin.syncToolDefinitions();
	} else if (key === 'chatPreset') {
		// 关键路径:预设写入多字段,不能只赋 chatPreset 一个 key
		applyChatPreset(plugin.settings, value as ChatPresetId);
		plugin.rebuildLLM();
	} else if (key === 'contextLengthPreset') {
		// 修复:下拉只写 preset 时 chatModelMaxTokens 仍是旧值,抽屉上限不跟着变
		applyContextLengthPreset(plugin.settings, value as Parameters<typeof applyContextLengthPreset>[1]);
	} else if (key === 'toolPermissionLevel') {
		// 关键路径:仅接受三档枚举,防止写入非法字符串
		if (value === 'safe' || value === 'auto' || value === 'danger') {
			plugin.settings.toolPermissionLevel = value;
		}
	} else if (key === 'chatNavRailSide') {
		// 关键路径:仅接受 left|right,防止写入非法字符串
		if (value === 'left' || value === 'right') {
			plugin.settings.chatNavRailSide = value;
		}
	} else {
		(plugin.settings as unknown as Record<string, unknown>)[key] = value;
	}

	// 副作用分发
	if (key === 'chatModel' || key === 'chatApiBase') {
		// 关键路径:手改模型或 Base → 场景预设自动切到 custom
		plugin.settings.chatPreset = 'custom';
		plugin.rebuildLLM();
	}
	if (key.startsWith('embed') && key !== 'embedLocalModel') {
		plugin.rebuildEmbeddingAdapter();
	}
	if (key === 'debugLog') {
		devLogger.setDebugEnabled(value as boolean);
	}
	// 关键路径:language 切换后立即应用,触发 langStore 更新,Svelte 组件自动重渲染
	if (key === 'language') {
		applyLangPreference(value as LangPreference);
	}
}
```

注意:`applyContextLengthPreset` 的第二参数类型从其源文件导出(读 `src/ui/tokens/context-length-presets.ts` line 52 确认;若已导出 `ContextLengthPresetId` 类型则直接用,不要用 `Parameters<>` 绕路写法)。

- [ ] **Step 4: 运行新测试通过**

Run: `npx vitest run tests/settings-apply.test.ts`
Expected: 10 PASS

- [ ] **Step 5: SettingTab.setControlValue 改薄封装**

修改 `src/settings.ts` line 1175-1228:删除搬走的主体逻辑,JSDoc 更新为「写入 control 值并持久化 + 刷新 UI;写入与副作用逻辑在 settings-apply.ts(与 update_app_config 工具共享)」,方法体变为:

```typescript
	async setControlValue(key: string, value: unknown): Promise<void> {
		// 关键路径:写入与副作用统一走 settings-apply(与 update_app_config 工具共享,防止两处漂移)
		applySettingValue(this.plugin, key, value);
		await this.plugin.saveSettings();
		this.update();
	}
```

同时:settings.ts 顶部 `import { applySettingValue } from './settings/settings-apply';`;删除 settings.ts 内因此不再使用的 import(如 `applyChatPreset`、`applyContextLengthPreset`、`applyLangPreference`、`devLogger` — 若同文件其他位置仍在用则保留,以 eslint 无 unused 报错为准)。

- [ ] **Step 6: 迁移旧测试 + 全量验证**

- `tests/settings.declarative.test.ts`:删除已迁移到 settings-apply.test.ts 的用例(嵌套 key 写入、rebuild 触发、chatPreset 多字段、preset 切 custom),保留纯 getControlValue / UI 渲染类用例;
- Run: `npx vitest run tests/settings-apply.test.ts tests/settings.declarative.test.ts`
- Expected: 全 PASS;
- Run: `npm run typecheck && npm run lint`
- Expected: 无错误。

- [ ] **Step 7: Commit**

```bash
git add src/settings/settings-apply.ts src/settings.ts tests/settings-apply.test.ts tests/settings.declarative.test.ts
git commit -m "refactor: 设置写入副作用收敛到 settings-apply 共享模块

设置面板改配置与后续 update_app_config 工具需要走同一套写入+副作用
逻辑,否则两处漂移会产生「面板改生效、工具改不生效」类 bug;先抽出
共享模块,SettingTab.setControlValue 变为薄封装。"
```

---

### Task 2: WorkspacePort 扩展 openNote / openPluginSettings

**Files:**
- Modify: `src/ports/workspace.ts`(接口加两方法)
- Modify: `src/adapters/obsidian-workspace.ts`(实现两方法)
- Modify: `src/settings.ts:333` 附近(SettingTab 加公有 focusTab)
- Modify: `src/main.ts:202`(ObsidianWorkspace 构造注入 getSettingTab)与 line 672(addSettingTab 时保存实例引用)
- Test: `tests/adapters/obsidian-workspace.test.ts`(新建)

- [ ] **Step 1: 写失败测试**

新建 `tests/adapters/obsidian-workspace.test.ts`(mock 最小 `App` 形状,参照 `tests/helpers/obsidian-mock.ts` 现有 mock 方式;不真实 import obsidian — adapter 只用类型,运行时方法都是被 mock 的对象):

```typescript
/**
 * @file tests/adapters/obsidian-workspace.test.ts
 * @description ObsidianWorkspace openNote / openPluginSettings 适配层单测
 */

import { describe, it, expect, vi } from 'vitest';
import { ObsidianWorkspace } from '../../src/adapters/obsidian-workspace';

function makeApp(opts: { openLinkText?: unknown } = {}) {
	return {
		workspace: {
			openLinkText: opts.openLinkText ?? vi.fn().mockResolvedValue({}),
			getActiveFile: () => null,
			getActiveViewOfType: () => null,
		},
		setting: {
			open: vi.fn(),
			openTabById: vi.fn(),
		},
	} as unknown as Parameters<typeof ObsidianWorkspace.prototype.constructor>[0] extends never
		? never
		: any;
}

describe('ObsidianWorkspace.openNote', () => {
	it('openNote - 正常 linktext - 调 openLinkText 并返回 true', async () => {
		const openLinkText = vi.fn().mockResolvedValue({});
		const ws = new ObsidianWorkspace(makeApp({ openLinkText }), () => null);
		const ok = await ws.openNote('notes/foo.md#标题');
		expect(openLinkText).toHaveBeenCalledWith('notes/foo.md#标题', '', false);
		expect(ok).toBe(true);
	});

	it('openNote - openLinkText 返回 null(链接不可解析) - 返回 false', async () => {
		const openLinkText = vi.fn().mockResolvedValue(null);
		const ws = new ObsidianWorkspace(makeApp({ openLinkText }), () => null);
		const ok = await ws.openNote('不存在.md');
		expect(ok).toBe(false);
	});
});

describe('ObsidianWorkspace.openPluginSettings', () => {
	it('SettingTab 实例存在 - 打开设置并定位 tab,返回 focusTab 结果', async () => {
		const app = makeApp();
		const focusTab = vi.fn().mockReturnValue(true);
		const ws = new ObsidianWorkspace(app, () => ({ focusTab }) as never);
		const ok = await ws.openPluginSettings('index');
		expect(app.setting.open).toHaveBeenCalledTimes(1);
		expect(app.setting.openTabById).toHaveBeenCalledWith('ratel-vault');
		expect(focusTab).toHaveBeenCalledWith('index');
		expect(ok).toBe(true);
	});

	it('SettingTab 实例为 null - 返回 false', async () => {
		const app = makeApp();
		const ws = new ObsidianWorkspace(app, () => null);
		const ok = await ws.openPluginSettings('chat');
		expect(ok).toBe(false);
	});
});
```

(上面 `makeApp` 返回类型表达式写得过绕 — 实现时直接 `as unknown as App`,与项目其他 adapter 测试一致;`as any` 不符合 strict lint。)

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/adapters/obsidian-workspace.test.ts`
Expected: FAIL — `ws.openNote is not a function`(接口还没两方法)

- [ ] **Step 3: 实现接口与 adapter**

`src/ports/workspace.ts` 接口追加:

```typescript
	/** 在 Obsidian 中打开笔记并滚动定位到锚点;linktext 语法同 wikilink(path / path#标题 / path#^blockId) */
	openNote(linktext: string): Promise<boolean>;
	/** 打开 Ratel 设置面板并定位到指定 tab;省略 tab 打开默认 tab。宿主未创建 SettingTab 时返回 false */
	openPluginSettings(tab?: string): Promise<boolean>;
```

`src/adapters/obsidian-workspace.ts`:

```typescript
import { App, MarkdownView, Setting, TFile } from 'obsidian';
import type { RatelVaultSettingTab } from '../settings';
// … 既有 import 保持

export class ObsidianWorkspace implements WorkspacePort {
	constructor(
		private readonly app: App,
		// 关键路径:设置 tab 定位需要 SettingTab 实例;main.ts 在 addSettingTab 后注入 getter
		private readonly getSettingTab: () => RatelVaultSettingTab | null = () => null,
	) {}

	// … 既有 getActiveFilePath / getActiveSelection 保持

	/**
	 * 复用当前 tab 打开笔记(与点击双链行为一致),锚点由 Obsidian 原生解析并滚动。
	 *
	 * @returns 打开成功返回 true;链接不可解析(openLinkText 返回 null)返回 false
	 */
	async openNote(linktext: string): Promise<boolean> {
		const leaf = await this.app.workspace.openLinkText(linktext, '', false);
		return leaf != null;
	}

	/**
	 * 打开 Obsidian 设置 → Ratel 插件页,并让 SettingTab 切到目标 tab。
	 *
	 * @param tab - SettingsUiTab 之一(chat/index/agent/appearance/advanced);非法值由 focusTab 拒绝
	 * @returns 定位成功返回 true;SettingTab 尚未创建返回 false
	 */
	async openPluginSettings(tab?: string): Promise<boolean> {
		this.app.setting.open();
		this.app.setting.openTabById('ratel-vault');
		const settingTab = this.getSettingTab();
		if (!settingTab) return false;
		return settingTab.focusTab(tab);
	}
}
```

`src/settings.ts` RatelVaultSettingTab 加公有方法(参照 line 486-494 既有切 tab 模式):

```typescript
	/**
	 * 程序化切换设置 tab — open_settings 工具入口。
	 *
	 * @param tab - 目标 tab id;省略或非法值保持当前 tab,返回 false 仅当非法值
	 * @returns 非法 tab 返回 false;合法或省略返回 true
	 */
	focusTab(tab?: string): boolean {
		const valid: SettingsUiTab[] = ['chat', 'index', 'agent', 'appearance', 'advanced'];
		if (tab == null || (valid as string[]).includes(tab)) {
			this.activeSettingsTab = (tab ?? this.activeSettingsTab) as SettingsUiTab;
			// 关键路径:与顶部导航点击同路径 — visible 谓词重算,cls 用 refreshDomState 而非 update()
			this.refreshDomState();
			return true;
		}
		return false;
	}
```

`src/main.ts` 两处:

1. 类字段加 `private settingTab: RatelVaultSettingTab | null = null;`(与 workspacePort 字段同区域);
2. line 202 构造改为 `this.workspacePort = new ObsidianWorkspace(this.app, () => this.settingTab);`
3. line 672 改为:

```typescript
		this.settingTab = new RatelVaultSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
```

- [ ] **Step 4: 运行测试通过**

Run: `npx vitest run tests/adapters/obsidian-workspace.test.ts`
Expected: 4 PASS

- [ ] **Step 5: 类型与 lint 验证**

Run: `npm run typecheck && npm run lint`
Expected: 无错误(`RatelVaultSettingTab` 从 `../settings` 导出已存在,确认无循环依赖报错 — settings-apply 用 SettingApplier 接口正是为避开它)。

- [ ] **Step 6: Commit**

```bash
git add src/ports/workspace.ts src/adapters/obsidian-workspace.ts src/settings.ts src/main.ts tests/adapters/obsidian-workspace.test.ts
git commit -m "feat: WorkspacePort 支持打开笔记与定位设置页

对话里 Agent 只能贴笔记内容,用户说「打开这篇」时无能为力;为
WorkspacePort 增加 openNote(openLinkText 锚点定位)与
openPluginSettings(设置页 tab 定位)两个 UI 操作入口。"
```

---

### Task 3: open_note 工具

**Files:**
- Create: `src/tools/open-note.ts`
- Modify: `src/prompts/tool-schemas.ts`(TOOL_SCHEMAS + ALL_TOOL_NAMES)
- Modify: `src/prompts/sections.ts`(promptLabel 条目)
- Modify: `src/i18n/zh.ts` / `src/i18n/en.ts`
- Modify: `src/settings.ts`(DEFAULT_SETTINGS.toolPermissions)
- Modify: `src/main.ts`(注册)
- Test: `tests/tools/open-note.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
/**
 * @file tests/tools/open-note.test.ts
 * @description open_note 工具单测
 */

import { describe, it, expect, vi } from 'vitest';
import { createOpenNoteTool } from '../../src/tools/open-note';
import { createMockVaultPort } from '../helpers/mock-vault-port';
import { makeToolDef } from '../helpers/make-tool-def';
import type { WorkspacePort } from '../../src/ports/workspace';

function mockWorkspace(openNote = vi.fn().mockResolvedValue(true)): WorkspacePort {
	return {
		getActiveFilePath: () => null,
		getActiveSelection: () => null,
		openNote: openNote as WorkspacePort['openNote'],
		openPluginSettings: vi.fn(),
	};
}

describe('open_note', () => {
	it('文件存在无锚点 - 直接传 path 打开', async () => {
		const openNote = vi.fn().mockResolvedValue(true);
		const vault = createMockVaultPort({ files: { 'notes/foo.md': 'hi' } });
		const tool = createOpenNoteTool(mockWorkspace(openNote), vault, makeToolDef('open_note'));
		const result = (await tool.execute({ path: 'notes/foo.md' })) as Record<string, unknown>;
		expect(openNote).toHaveBeenCalledWith('notes/foo.md');
		expect(result.opened).toBe(true);
		expect(tool.readOnly).toBe(true);
	});

	it('path 省略 .md - 归一化补扩展名后验证', async () => {
		const openNote = vi.fn().mockResolvedValue(true);
		const vault = createMockVaultPort({ files: { 'notes/foo.md': 'hi' } });
		const tool = createOpenNoteTool(mockWorkspace(openNote), vault, makeToolDef('open_note'));
		await tool.execute({ path: 'notes/foo' });
		expect(openNote).toHaveBeenCalledWith('notes/foo.md');
	});

	it('标题锚点 - 拼接 path#标题', async () => {
		const openNote = vi.fn().mockResolvedValue(true);
		const vault = createMockVaultPort({ files: { 'notes/foo.md': 'hi' } });
		const tool = createOpenNoteTool(mockWorkspace(openNote), vault, makeToolDef('open_note'));
		await tool.execute({ path: 'notes/foo.md', anchor: '第二章 安装' });
		expect(openNote).toHaveBeenCalledWith('notes/foo.md#第二章 安装');
	});

	it('块锚点 ^abc - 拼接 path#^abc', async () => {
		const openNote = vi.fn().mockResolvedValue(true);
		const vault = createMockVaultPort({ files: { 'notes/foo.md': 'hi' } });
		const tool = createOpenNoteTool(mockWorkspace(openNote), vault, makeToolDef('open_note'));
		await tool.execute({ path: 'notes/foo.md', anchor: '^abc123' });
		expect(openNote).toHaveBeenCalledWith('notes/foo.md#^abc123');
	});

	it('文件不存在 - 不抛错,返回降级提示与 opened=false', async () => {
		const openNote = vi.fn();
		const vault = createMockVaultPort({ files: { 'other.md': 'hi' } });
		const tool = createOpenNoteTool(mockWorkspace(openNote), vault, makeToolDef('open_note'));
		const result = (await tool.execute({ path: 'notes/foo.md' })) as Record<string, unknown>;
		expect(result.opened).toBe(false);
		expect(String(result.message)).toContain('search_vault');
		expect(openNote).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/tools/open-note.test.ts`
Expected: FAIL — `Cannot find module '../../src/tools/open-note'`

- [ ] **Step 3: 实现工具**

新建 `src/tools/open-note.ts`(路径安全:先经 `vault.fileExists` 验证,vault 内不存在的路径不传给 openLinkText,天然不会越出 vault):

```typescript
/**
 * @file src/tools/open-note.ts
 * @description open_note 工具 — 在 Obsidian 中为用户打开笔记并定位到标题/块
 * @module tools/open-note
 * @depends core/tool-registry, ports/workspace, ports/vault
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { VaultPort } from '../ports/vault';
import type { WorkspacePort } from '../ports/workspace';

/**
 * 构造 `open_note` 工具。
 *
 * 设计要点:
 * - 纯 UI 导航,不写任何文件 → readOnly: true,默认权限 allow。
 * - 锚点只拼 linktext,由 Obsidian 原生解析(标题 / ^blockId,阅读视图也能滚动);
 *   不预校验锚点存在性(避免为此读全文,锚点无效时 Obsidian 只打开文件)。
 * - 文件不存在不抛错:返回降级提示让 Agent 改用 search_vault / glob 定位。
 *
 * @param workspace - 打开笔记
 * @param vault - 文件存在性验证
 * @param definition - LLM schema
 */
export function createOpenNoteTool(
	workspace: WorkspacePort,
	vault: VaultPort,
	definition: ToolDefinition,
): Tool {
	return {
		definition,
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			const rawPath = String(args.path ?? '');
			// 关键路径:可省略 .md — 先试原文,再试补 .md,与 Obsidian 链接解析习惯一致
			const candidates = rawPath.endsWith('.md') ? [rawPath] : [rawPath, `${rawPath}.md`];
			let resolved: string | null = null;
			for (const candidate of candidates) {
				if (await vault.fileExists(candidate)) {
					resolved = candidate;
					break;
				}
			}

			if (!resolved) {
				return {
					opened: false,
					message: `笔记不存在: ${rawPath}。请先用 search_vault 或 glob 确认正确路径后再试。`,
				};
			}

			const anchor = typeof args.anchor === 'string' && args.anchor.length > 0 ? args.anchor : null;
			// 关键路径:块锚点形如 ^abc123,标题锚点是裸标题名;统一拼成 wikilink 锚点语法
			const linktext = anchor ? `${resolved}#${anchor}` : resolved;
			const opened = await workspace.openNote(linktext);
			return {
				opened,
				path: resolved,
				anchor: anchor ?? undefined,
				...(opened ? {} : { message: 'Obsidian 未能打开该链接(可能锚点不可解析),但文件存在。' }),
			};
		},
	};
}
```

- [ ] **Step 4: 运行测试通过**

Run: `npx vitest run tests/tools/open-note.test.ts`
Expected: 5 PASS

- [ ] **Step 5: schema / sections / i18n / 默认权限 / 注册**

`src/prompts/tool-schemas.ts` — TOOL_SCHEMAS 追加(放在 `get_vault_structure` 条目后):

```typescript
	open_note: {
		name: 'open_note',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'vault 相对路径,可省略 .md' },
				anchor: {
					type: 'string',
					description: '定位锚点:裸标题名(如 "第二章")或块 ID(如 "^abc123")',
				},
			},
			required: ['path'],
		},
	},
```

`ALL_TOOL_NAMES` 数组末尾追加 `'open_note'`。

`src/prompts/sections.ts` — 参照 `tool.read_note`(line 105-121)追加两条:

```typescript
	// --- tool.open_note ---
	{
		id: 'tool.open_note.description',
		label: tNow('promptLabel.tool.open_note.description'),
		description: tNow('promptLabel.tool.open_note.description.desc'),
		zone: 'tool',
		placeholders: [],
		allowOverride: true,
	},
	{
		id: 'tool.open_note.param.path',
		label: tNow('promptLabel.tool.open_note.param.path'),
		description: tNow('promptLabel.tool.open_note.param.path.desc'),
		zone: 'tool',
		placeholders: [],
		allowOverride: true,
	},
	{
		id: 'tool.open_note.param.anchor',
		label: tNow('promptLabel.tool.open_note.param.anchor'),
		description: tNow('promptLabel.tool.open_note.param.anchor.desc'),
		zone: 'tool',
		placeholders: [],
		allowOverride: true,
	},
```

`src/i18n/zh.ts` 追加(与既有 key 同区放置):

```typescript
  'tool.name.open_note': '打开 {path}',
  'settings.toolPermissions.open_note': '打开笔记',
  'promptLabel.tool.open_note.description': 'open_note 描述',
  'promptLabel.tool.open_note.description.desc': '在 Obsidian 中为用户打开一篇笔记,可定位到标题或块',
  'promptLabel.tool.open_note.param.path': 'open_note.path',
  'promptLabel.tool.open_note.param.path.desc': 'vault 相对路径,可省略 .md',
  'promptLabel.tool.open_note.param.anchor': 'open_note.anchor',
  'promptLabel.tool.open_note.param.anchor.desc': '定位锚点:裸标题名或 ^块ID',
```

`src/i18n/en.ts` 追加镜像:

```typescript
  'tool.name.open_note': 'Open {path}',
  'settings.toolPermissions.open_note': 'Open note',
  'promptLabel.tool.open_note.description': 'open_note description',
  'promptLabel.tool.open_note.description.desc': 'Open a note for the user in Obsidian, optionally jumping to a heading or block',
  'promptLabel.tool.open_note.param.path': 'open_note.path',
  'promptLabel.tool.open_note.param.path.desc': 'Vault-relative path; .md optional',
  'promptLabel.tool.open_note.param.anchor': 'open_note.anchor',
  'promptLabel.tool.open_note.param.anchor.desc': 'Anchor: bare heading name or ^blockId',
```

`src/settings.ts` `DEFAULT_SETTINGS.toolPermissions` 追加 `open_note: 'allow',`。

`src/main.ts` 工具注册区(line 384 附近)追加:

```typescript
		this.tools.register(createOpenNoteTool(this.workspacePort, this.vault, toolDefMap.get('open_note')!));
```

顶部 import 追加 `createOpenNoteTool`。

- [ ] **Step 6: 全量验证**

Run: `npx vitest run tests/tools/open-note.test.ts && npm run typecheck && npm run lint`
Expected: 全 PASS 无错误(i18n key 若有类型表 `src/i18n/types.ts` 约束,按其 StringKey 生成方式同步 — 先读该文件确认 key 是松散 string 还是强类型)。

- [ ] **Step 7: Commit**

```bash
git add src/tools/open-note.ts src/prompts/tool-schemas.ts src/prompts/sections.ts src/i18n/zh.ts src/i18n/en.ts src/settings.ts src/main.ts tests/tools/open-note.test.ts
git commit -m "feat: 新增 open_note 工具 — 对话中直接打开笔记并定位标题/块

检索到笔记后 Agent 只能贴内容,用户想看原文得自己找;open_note 让
Agent 用 wikilink 锚点语法(path#标题 / path#^块ID)在 Obsidian 里
打开笔记,路径不存在时降级提示改用检索工具。"
```

---

### Task 4: get_app_config 工具

**Files:**
- Create: `src/tools/get-app-config.ts`
- Modify: `src/prompts/tool-schemas.ts`、`src/prompts/sections.ts`、`src/i18n/zh.ts`、`src/i18n/en.ts`、`src/settings.ts`、`src/main.ts`(同 Task 3 模式)
- Test: `tests/tools/get-app-config.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
/**
 * @file tests/tools/get-app-config.test.ts
 * @description get_app_config 工具单测(脱敏快照 + 密钥状态 + 索引状态)
 */

import { describe, it, expect, vi } from 'vitest';
import { createGetAppConfigTool, type AppConfigSnapshot } from '../../src/tools/get-app-config';
import { makeToolDef } from '../helpers/make-tool-def';
import { DEFAULT_SETTINGS } from '../../src/settings';
import { writable } from 'svelte/store';
import type { IndexStatus } from '../../src/core/index-manager';

const secrets = {
	hasChatApiKey: vi.fn().mockReturnValue(true),
	resolveChatSecretId: vi.fn().mockReturnValue('ratel-chat-openai-compatible'),
	hasEmbedApiKey: vi.fn().mockReturnValue(false),
	resolveEmbedSecretId: vi.fn().mockReturnValue('ratel-embed-openai-compatible'),
	hasRerankApiKey: vi.fn().mockReturnValue(false),
};

describe('get_app_config', () => {
	it('返回配置快照 + 密钥 boolean + 所需 secret ID + 索引状态', async () => {
		const status = writable<IndexStatus>({ state: 'Ready', totalDocs: 42, lastIndexTime: 123 });
		const tool = createGetAppConfigTool(
			{ app: {} as never, secrets },
			{ settings: structuredClone(DEFAULT_SETTINGS) },
			() => status,
			makeToolDef('get_app_config'),
		);
		const result = (await tool.execute({})) as AppConfigSnapshot;
		expect(result.config.chatModel).toBe(DEFAULT_SETTINGS.chatModel);
		expect(result.secrets.hasChatApiKey).toBe(true);
		expect(result.secrets.requiredChatSecretId).toBe('ratel-chat-openai-compatible');
		expect(result.secrets.hasEmbedApiKey).toBe(false);
		expect(result.index.state).toBe('Ready');
		expect(result.index.totalDocs).toBe(42);
		expect(tool.readOnly).toBe(true);
		// 脱敏:绝不出现密钥值字段
		expect(JSON.stringify(result)).not.toMatch(/apiKey|sk-/i);
	});
});
```

(测试里对 secrets 函数组的形状按 `src/secrets/ratel-secrets.ts` 实际导出微调 — 工具文件导出 `AppConfigSnapshot` 类型供断言。)

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/tools/get-app-config.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现工具**

新建 `src/tools/get-app-config.ts`。**依赖注入而非 import secrets 模块直接调**:secrets 函数组作为参数注入(app + 函数集),便于测试。签名:

```typescript
/**
 * @file src/tools/get-app-config.ts
 * @description get_app_config 工具 — 脱敏配置快照 + 密钥配置状态 + 索引状态
 * @module tools/get-app-config
 * @depends core/tool-registry, ports/llm, secrets/ratel-secrets, core/index-manager
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { RatelVaultSettings } from '../settings';
import { get, type Readable } from 'svelte/store';
import type { IndexStatus } from '../core/index-manager';

/** 密钥探测函数组 — 由 main.ts 注入 ratel-secrets 的真实现,测试注入 mock */
export interface SecretProbe {
	hasChatApiKey(settings: RatelVaultSettings): boolean;
	resolveChatSecretId(settings: RatelVaultSettings): string | null;
	hasEmbedApiKey(settings: RatelVaultSettings): boolean;
	resolveEmbedSecretId(settings: RatelVaultSettings): string | null;
	hasRerankApiKey(): boolean;
}

/** get_app_config 返回形状 */
export interface AppConfigSnapshot {
	config: Record<string, unknown>;
	secrets: {
		hasChatApiKey: boolean;
		requiredChatSecretId: string | null;
		hasEmbedApiKey: boolean;
		requiredEmbedSecretId: string | null;
		hasRerankApiKey: boolean;
	};
	index: { state: string; totalDocs?: number; lastIndexTime?: number; paused: boolean };
}

/**
 * 构造 `get_app_config` 工具。
 *
 * 设计要点:
 * - settings 本身无密钥字段(全在钥匙串),快照直接全量返回即天然脱敏;
 *   密钥只回 boolean 存在性 + 当前 provider 所需 secret ID(引导用户去钥匙串配)。
 * - readOnly: true,默认权限 allow。
 *
 * @param host - { app: App(透传给 probe), secrets: SecretProbe }
 * @param settingsHost - { settings } 引用(live 对象,读取当前值)
 * @param indexStatus - indexManager.status$ store
 * @param definition - LLM schema
 */
export function createGetAppConfigTool(
	host: { app: unknown; secrets: SecretProbe },
	settingsHost: { settings: RatelVaultSettings },
	indexStatus: Readable<IndexStatus>,
	definition: ToolDefinition,
): Tool {
	return {
		definition,
		readOnly: true,
		async execute() {
			const s = settingsHost.settings;
			const st = get(indexStatus);
			const snapshot: AppConfigSnapshot = {
				config: s as unknown as Record<string, unknown>,
				secrets: {
					hasChatApiKey: host.secrets.hasChatApiKey(s),
					requiredChatSecretId: host.secrets.resolveChatSecretId(s),
					hasEmbedApiKey: host.secrets.hasEmbedApiKey(s),
					requiredEmbedSecretId: host.secrets.resolveEmbedSecretId(s),
					hasRerankApiKey: host.secrets.hasRerankApiKey(),
				},
				index: {
					state: st.state,
					totalDocs: st.totalDocs,
					lastIndexTime: st.lastIndexTime,
					paused: s.indexPaused,
				},
			};
			return snapshot;
		},
	};
}
```

**注意**:先读 `src/secrets/ratel-secrets.ts` 确认真实签名 — 若 `hasChatApiKey(app, settings)` 带 app 参数,则 `SecretProbe` 接口对应加 app;`resolveChatSecretId` 若只吃 settings 就如上。**以真实签名为准调整接口与 main.ts 接线**,不要为接口好看改 secrets 模块签名。

- [ ] **Step 4: 运行测试通过**

Run: `npx vitest run tests/tools/get-app-config.test.ts` → PASS

- [ ] **Step 5: schema / sections / i18n / 默认权限 / 注册**

`tool-schemas.ts` TOOL_SCHEMAS 追加:

```typescript
	get_app_config: {
		name: 'get_app_config',
		parameters: { type: 'object', properties: {}, required: [] },
	},
```

ALL_TOOL_NAMES 追加 `'get_app_config'`。

`sections.ts` 追加一条(无参数,只有 description):

```typescript
	// --- tool.get_app_config ---
	{
		id: 'tool.get_app_config.description',
		label: tNow('promptLabel.tool.get_app_config.description'),
		description: tNow('promptLabel.tool.get_app_config.description.desc'),
		zone: 'tool',
		placeholders: [],
		allowOverride: true,
	},
```

`zh.ts`:

```typescript
  'tool.name.get_app_config': '查看应用配置',
  'settings.toolPermissions.get_app_config': '查看应用配置',
  'promptLabel.tool.get_app_config.description': 'get_app_config 描述',
  'promptLabel.tool.get_app_config.description.desc': '读取 Ratel 当前配置快照(模型/索引/记忆等)、密钥配置状态(仅 boolean)与索引状态',
```

`en.ts` 镜像:

```typescript
  'tool.name.get_app_config': 'View app config',
  'settings.toolPermissions.get_app_config': 'View app config',
  'promptLabel.tool.get_app_config.description': 'get_app_config description',
  'promptLabel.tool.get_app_config.description.desc': 'Read Ratel config snapshot (model/index/memory), key presence booleans, and index status',
```

DEFAULT_SETTINGS.toolPermissions 追加 `get_app_config: 'allow',`。

`main.ts` 注册(接真实现,secrets probe 直接绑 ratel-secrets 函数):

```typescript
		// 关键路径:配置读取工具 — secrets 探测注入真实现,索引状态读 status$ 当前值
		this.tools.register(
			createGetAppConfigTool(
				{ app: this.app, secrets: ratelSecretProbe(this.app) },
				this,
				this.indexController.indexManager.status$,
				toolDefMap.get('get_app_config')!,
			),
		);
```

其中 `ratelSecretProbe(app)` 是本 Task 在 `src/secrets/ratel-secrets.ts` 里**新增的小导出**(把现有散函数适配成 `SecretProbe` 形状,签名以文件真实情况为准;若散函数签名已与接口一致,则直接在 main.ts 内联对象字面量,不新增导出)。`this.indexController` 若构造时机晚于工具注册,把注册移到 indexController 就绪之后(main.ts 现有工具注册区若已引用 indexController 之外的后续对象,以编译通过为准就近排布)。

- [ ] **Step 6: 全量验证**

Run: `npx vitest run tests/tools/get-app-config.test.ts && npm run typecheck && npm run lint`
Expected: 全 PASS。

- [ ] **Step 7: Commit**

```bash
git add src/tools/get-app-config.ts src/secrets/ratel-secrets.ts src/prompts/tool-schemas.ts src/prompts/sections.ts src/i18n/zh.ts src/i18n/en.ts src/settings.ts src/main.ts tests/tools/get-app-config.test.ts
git commit -m "feat: 新增 get_app_config 工具 — Agent 可读取脱敏配置与密钥状态

排查「为什么不工作」需要先看配置现状;工具返回设置快照(本身无密钥
字段)、密钥 boolean 存在性与当前 provider 所需 secret ID,密钥值
零暴露。"
```

---

### Task 5: update_app_config 工具(白名单)

**Files:**
- Create: `src/settings/config-whitelist.ts`
- Create: `src/tools/update-app-config.ts`
- Modify: `src/prompts/tool-schemas.ts`、`src/prompts/sections.ts`、`src/i18n/zh.ts`、`src/i18n/en.ts`、`src/settings.ts`、`src/main.ts`
- Test: `tests/settings/config-whitelist.test.ts`、`tests/tools/update-app-config.test.ts`

- [ ] **Step 1: 写失败测试(白名单)**

`tests/settings/config-whitelist.test.ts`:

```typescript
/**
 * @file tests/settings/config-whitelist.test.ts
 * @description update_app_config 白名单与值校验单测
 */

import { describe, it, expect } from 'vitest';
import { CONFIG_UPDATE_WHITELIST, isWhitelistedKey, validateConfigValue } from '../../src/settings/config-whitelist';
import { DEFAULT_SETTINGS } from '../../src/settings';

describe('CONFIG_UPDATE_WHITELIST', () => {
	it('白名单不含提权项 - toolPermissions / mcpServers / promptOverrides / chatPreset', () => {
		expect(isWhitelistedKey('toolPermissions.search_vault')).toBe(false);
		expect(isWhitelistedKey('mcpServers')).toBe(false);
		expect(isWhitelistedKey('mcpApprovedSpawns')).toBe(false);
		expect(isWhitelistedKey('promptOverrides.system.role')).toBe(false);
		expect(isWhitelistedKey('chatPreset')).toBe(false);
		expect(isWhitelistedKey('toolPermissionLevel')).toBe(false);
	});

	it('白名单含常规配置项', () => {
		expect(isWhitelistedKey('chatModel')).toBe(true);
		expect(isWhitelistedKey('contextLengthPreset')).toBe(true);
		expect(isWhitelistedKey('embedProvider')).toBe(true);
		expect(isWhitelistedKey('language')).toBe(true);
	});

	it('白名单 key 全部存在于 DEFAULT_SETTINGS', () => {
		for (const key of CONFIG_UPDATE_WHITELIST) {
			expect((DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key]).not.toBeUndefined();
		}
	});
});

describe('validateConfigValue', () => {
	it('embedProvider 非枚举值 - 拒绝', () => {
		const r = validateConfigValue('embedProvider', 'quantum');
		expect(r.ok).toBe(false);
	});

	it('embedProvider 枚举值 - 通过', () => {
		expect(validateConfigValue('embedProvider', 'local').ok).toBe(true);
	});

	it('chunkSize 非数字 - 拒绝', () => {
		expect(validateConfigValue('chunkSize', 'big').ok).toBe(false);
	});

	it('chunkSize 负数 - 拒绝', () => {
		expect(validateConfigValue('chunkSize', -5).ok).toBe(false);
	});

	it('boolean 开关 - 字符串 "true" 拒绝', () => {
		expect(validateConfigValue('autoIndex', 'true').ok).toBe(false);
		expect(validateConfigValue('autoIndex', true).ok).toBe(true);
	});

	it('contextLengthPreset 非枚举 - 拒绝', () => {
		expect(validateConfigValue('contextLengthPreset', 'huge').ok).toBe(false);
	});
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/settings/config-whitelist.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现白名单模块**

新建 `src/settings/config-whitelist.ts`。枚举值**从 DEFAULT_SETTINGS 与既有类型常量取**(写之前先读 `src/settings.ts` 的类型定义区确认各枚举的真实取值集合,如 EmbedProvider / ContextLengthPresetId / LangPreference;不要编造枚举值):

```typescript
/**
 * @file src/settings/config-whitelist.ts
 * @description update_app_config 工具的可改 key 白名单与值校验
 * @module settings/config-whitelist
 * @depends settings
 */

import { DEFAULT_SETTINGS } from '../settings';

/**
 * 允许 Agent 代改的顶层设置 key(硬编码,不可通过配置扩展)。
 *
 * 安全红线 — 永不进白名单:
 * - toolPermissions / toolPermissionLevel(模型不能给自己提权)
 * - mcpServers / mcpApprovedSpawns(MCP 接入面)
 * - promptOverrides / chatPreset(prompt 覆盖与预设切换)
 * - debugLog / agentMaxSteps / modelRegistryUrl(高影响面)
 */
export const CONFIG_UPDATE_WHITELIST: ReadonlySet<string> = new Set([
	// 对话模型
	'chatModel', 'chatApiBase', 'contextLengthPreset', 'chatModelMaxTokens', 'autoCompactEnabled',
	// 分块与索引
	'chunkSize', 'chunkOverlap', 'autoIndex', 'indexPaused',
	// Embedding / Rerank
	'embedProvider', 'embedApiBase', 'embedApiModel', 'embedApiDimensions',
	'rerankerApiBase', 'rerankerModel',
	// 记忆
	'memoryEnabled', 'memoryAutoWrite', 'memoryStorageLimitMB', 'memoryInjectLimitKB',
	'memoryDynamicLimitKB', 'memoryContextTotalLimitKB',
	// Skill / 日记
	'enableSkills', 'dailyNoteFolder', 'dailyNoteFormat',
	// 语言与外观
	'language', 'uiColorScheme', 'uiAccent', 'chatNavRailEnabled', 'chatNavRailSide', 'chatMotionEnabled',
]);

/** key 是否在白名单内 */
export function isWhitelistedKey(key: string): boolean {
	return CONFIG_UPDATE_WHITELIST.has(key);
}

/** 枚举约束表 — key → 合法取值(undefined 表示无枚举约束,走类型校验) */
const ENUM_CONSTRAINTS: Record<string, readonly unknown[]> = {
	// 示例;真实枚举集合执行时从 settings.ts 类型常量抄录(embedProvider / contextLengthPreset / language / uiColorScheme / chatNavRailSide / uiAccent 若为枚举)
};

/** 数值约束表 — key → { min?, max? } */
const NUMBER_CONSTRAINTS: Record<string, { min?: number; max?: number }> = {
	chunkSize: { min: 100, max: 4000 },
	chunkOverlap: { min: 0, max: 1000 },
	chatModelMaxTokens: { min: 1024, max: 262144 },
	embedApiDimensions: { min: 64, max: 8192 },
	memoryStorageLimitMB: { min: 1, max: 2048 },
	memoryInjectLimitKB: { min: 0, max: 128 },
	memoryDynamicLimitKB: { min: 0, max: 512 },
	memoryContextTotalLimitKB: { min: 0, max: 1024 },
};

/** boolean 开关 key 集合 */
const BOOLEAN_KEYS: ReadonlySet<string> = new Set([
	'autoCompactEnabled', 'autoIndex', 'indexPaused', 'memoryEnabled', 'memoryAutoWrite',
	'enableSkills', 'chatNavRailEnabled', 'chatMotionEnabled',
]);

/** 字符串自由文本 key(仅非空校验) */
const STRING_KEYS: ReadonlySet<string> = new Set([
	'chatModel', 'chatApiBase', 'embedApiBase', 'embedApiModel',
	'rerankerApiBase', 'rerankerModel', 'dailyNoteFolder', 'dailyNoteFormat', 'uiAccent',
]);

/**
 * 校验一个 key 的候选值是否可写入。
 *
 * @returns ok=true 可写入;ok=false 时 reason 为中文拒绝原因(返回给 LLM)
 */
export function validateConfigValue(key: string, value: unknown): { ok: true } | { ok: false; reason: string } {
	if (!isWhitelistedKey(key)) {
		return { ok: false, reason: `「${key}」不允许通过对话修改(安全红线或需在设置面板手动调整)` };
	}
	if (ENUM_CONSTRAINTS[key] && !ENUM_CONSTRAINTS[key].includes(value)) {
		return { ok: false, reason: `「${key}」合法取值: ${ENUM_CONSTRAINTS[key].join(' / ')}` };
	}
	if (BOOLEAN_KEYS.has(key) && typeof value !== 'boolean') {
		return { ok: false, reason: `「${key}」需要 boolean(true/false)` };
	}
	if (NUMBER_CONSTRAINTS[key]) {
		const { min, max } = NUMBER_CONSTRAINTS[key];
		if (typeof value !== 'number' || Number.isNaN(value) || (min != null && value < min) || (max != null && value > max)) {
			return { ok: false, reason: `「${key}」需要数字${min != null ? `,≥${min}` : ''}${max != null ? `,≤${max}` : ''}` };
		}
	}
	if (STRING_KEYS.has(key) && (typeof value !== 'string' || value.trim().length === 0)) {
		return { ok: false, reason: `「${key}」需要非空字符串` };
	}
	return { ok: true };
}
```

**执行要求**:`ENUM_CONSTRAINTS` 里的占位注释必须落成真实枚举(读 settings.ts 类型定义与 context-length-presets.ts 的 preset id 集合),数值边界若与 settings UI 现有校验不一致,以 settings UI 为准抄录;测试同步使用真实枚举值。

- [ ] **Step 4: 白名单测试通过**

Run: `npx vitest run tests/settings/config-whitelist.test.ts` → 全 PASS

- [ ] **Step 5: 写工具失败测试**

`tests/tools/update-app-config.test.ts`:

```typescript
/**
 * @file tests/tools/update-app-config.test.ts
 * @description update_app_config 工具单测
 */

import { describe, it, expect, vi } from 'vitest';
import { createUpdateAppConfigTool } from '../../src/tools/update-app-config';
import { makeToolDef } from '../helpers/make-tool-def';
import { DEFAULT_SETTINGS } from '../../src/settings';

function mockHost() {
	return {
		settings: structuredClone(DEFAULT_SETTINGS),
		rebuildLLM: vi.fn(),
		rebuildEmbeddingAdapter: vi.fn(),
		syncToolDefinitions: vi.fn(),
		saveSettings: vi.fn().mockResolvedValue(undefined),
	};
}

describe('update_app_config', () => {
	it('白名单 key - 写入 + 持久化 + 返回成功', async () => {
		const host = mockHost();
		const tool = createUpdateAppConfigTool(host, makeToolDef('update_app_config'));
		const result = (await tool.execute({ updates: { autoIndex: false, chunkSize: 600 } })) as {
			results: Array<{ key: string; ok: boolean }>;
		};
		expect(host.settings.autoIndex).toBe(false);
		expect(host.settings.chunkSize).toBe(600);
		expect(host.saveSettings).toHaveBeenCalledTimes(1);
		expect(result.results.every((r) => r.ok)).toBe(true);
	});

	it('chatModel 变更 - 触发 rebuildLLM 副作用', async () => {
		const host = mockHost();
		const tool = createUpdateAppConfigTool(host, makeToolDef('update_app_config'));
		await tool.execute({ updates: { chatModel: 'deepseek-chat' } });
		expect(host.rebuildLLM).toHaveBeenCalled();
	});

	it('白名单外 key - 该 key 拒绝,其余照常应用', async () => {
		const host = mockHost();
		const tool = createUpdateAppConfigTool(host, makeToolDef('update_app_config'));
		const result = (await tool.execute({ updates: { toolPermissions: { open_note: 'allow' }, chunkSize: 700 } })) as {
			results: Array<{ key: string; ok: boolean; reason?: string }>;
		};
		expect(host.settings.chunkSize).toBe(700);
		const rejected = result.results.find((r) => !r.ok)!;
		expect(rejected.key).toBe('toolPermissions');
		expect(rejected.reason).toBeTruthy();
	});

	it('空 updates - 返回空结果不持久化', async () => {
		const host = mockHost();
		const tool = createUpdateAppConfigTool(host, makeToolDef('update_app_config'));
		const result = (await tool.execute({ updates: {} })) as { results: unknown[] };
		expect(result.results).toHaveLength(0);
		expect(host.saveSettings).not.toHaveBeenCalled();
	});

	it('readOnly 标记为 false(写操作)', () => {
		const tool = createUpdateAppConfigTool(mockHost(), makeToolDef('update_app_config'));
		expect(tool.readOnly).toBe(false);
	});
});
```

- [ ] **Step 6: 运行确认失败后实现工具**

Run: `npx vitest run tests/tools/update-app-config.test.ts` → FAIL(module not found)

新建 `src/tools/update-app-config.ts`:

```typescript
/**
 * @file src/tools/update-app-config.ts
 * @description update_app_config 工具 — 白名单内批量代改设置(权限 ask,写前用户确认)
 * @module tools/update-app-config
 * @depends core/tool-registry, ports/llm, settings/config-whitelist, settings/settings-apply
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import { isWhitelistedKey, validateConfigValue } from '../settings/config-whitelist';
import { applySettingValue, type SettingApplier } from '../settings/settings-apply';

/** 宿主 = SettingApplier + 持久化 */
export interface ConfigUpdateHost extends SettingApplier {
	saveSettings(): Promise<void>;
}

/**
 * 构造 `update_app_config` 工具。
 *
 * 设计要点:
 * - 逐 key 白名单 + 值校验,单 key 拒绝不影响同批其他 key。
 * - 全部 key 校验失败时不落盘;有任一成功才 applySettingValue + saveSettings。
 * - 权限 ask(Write Gate 在外层确认后才进入 execute,这里不再弹窗)。
 */
export function createUpdateAppConfigTool(host: ConfigUpdateHost, definition: ToolDefinition): Tool {
	return {
		definition,
		readOnly: false,
		async execute(args: Record<string, unknown>) {
			const updates = (args.updates ?? {}) as Record<string, unknown>;
			const results: Array<{ key: string; ok: boolean; reason?: string }> = [];
			let appliedAny = false;

			for (const [key, value] of Object.entries(updates)) {
				const verdict = validateConfigValue(key, value);
				if (!verdict.ok) {
					results.push({ key, ok: false, reason: verdict.reason });
					continue;
				}
				applySettingValue(host, key, value);
				results.push({ key, ok: true });
				appliedAny = true;
			}

			if (appliedAny) {
				await host.saveSettings();
			}
			return { results, applied: results.filter((r) => r.ok).map((r) => r.key) };
		},
	};
}
```

Run: `npx vitest run tests/tools/update-app-config.test.ts` → 5 PASS

- [ ] **Step 7: schema / sections / i18n / 默认权限 / 注册**

`tool-schemas.ts`:

```typescript
	update_app_config: {
		name: 'update_app_config',
		parameters: {
			type: 'object',
			properties: {
				updates: {
					type: 'object',
					description: '要修改的设置键值对;仅白名单内 key 生效',
					additionalProperties: true,
				},
			},
			required: ['updates'],
		},
	},
```

ALL_TOOL_NAMES 追加 `'update_app_config'`。

`sections.ts` 追加 `tool.update_app_config.description` + `tool.update_app_config.param.updates` 两条(照 Task 3 的 sections 结构)。

`zh.ts`:

```typescript
  'tool.name.update_app_config': '修改应用配置',
  'settings.toolPermissions.update_app_config': '修改应用配置',
  'promptLabel.tool.update_app_config.description': 'update_app_config 描述',
  'promptLabel.tool.update_app_config.description.desc': '批量修改 Ratel 设置(仅白名单内 key:模型/索引/记忆/外观等);工具权限、MCP、prompt 覆盖不可改',
  'promptLabel.tool.update_app_config.param.updates': 'update_app_config.updates',
  'promptLabel.tool.update_app_config.param.updates.desc': '键值对,如 {"chunkSize": 600, "autoIndex": false}',
```

`en.ts` 镜像:

```typescript
  'tool.name.update_app_config': 'Update app config',
  'settings.toolPermissions.update_app_config': 'Update app config',
  'promptLabel.tool.update_app_config.description': 'update_app_config description',
  'promptLabel.tool.update_app_config.description.desc': 'Batch-update Ratel settings (whitelisted keys only: model/index/memory/appearance); tool permissions, MCP, prompt overrides excluded',
  'promptLabel.tool.update_app_config.param.updates': 'update_app_config.updates',
  'promptLabel.tool.update_app_config.param.updates.desc': 'Key-value pairs, e.g. {"chunkSize": 600, "autoIndex": false}',
```

DEFAULT_SETTINGS.toolPermissions 追加 `update_app_config: 'ask',`。

`main.ts` 注册:

```typescript
		this.tools.register(createUpdateAppConfigTool(this, toolDefMap.get('update_app_config')!));
```

(RatelVaultPlugin 结构满足 ConfigUpdateHost — settings/rebuildLLM/rebuildEmbeddingAdapter/syncToolDefinitions/saveSettings 均已存在,直接传 this。)

- [ ] **Step 8: 全量验证 + Commit**

Run: `npx vitest run tests/settings/config-whitelist.test.ts tests/tools/update-app-config.test.ts && npm run typecheck && npm run lint`

```bash
git add src/settings/config-whitelist.ts src/tools/update-app-config.ts src/prompts/tool-schemas.ts src/prompts/sections.ts src/i18n/zh.ts src/i18n/en.ts src/settings.ts src/main.ts tests/settings/config-whitelist.test.ts tests/tools/update-app-config.test.ts
git commit -m "feat: 新增 update_app_config 工具 — 白名单内代改设置

让用户不动手就能完成「开关联索/换模型/调分块」类配置;白名单硬编码
排除工具权限、MCP、prompt 覆盖等提权面,值校验拒绝非法枚举与越界
数字,写入走 settings-apply 与设置面板同一套副作用。"
```

---

### Task 6: open_settings 工具

**Files:**
- Create: `src/tools/open-settings.ts`
- Modify: `src/prompts/tool-schemas.ts`、`src/prompts/sections.ts`、`src/i18n/zh.ts`、`src/i18n/en.ts`、`src/settings.ts`、`src/main.ts`
- Test: `tests/tools/open-settings.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
/**
 * @file tests/tools/open-settings.test.ts
 * @description open_settings 工具单测
 */

import { describe, it, expect, vi } from 'vitest';
import { createOpenSettingsTool } from '../../src/tools/open-settings';
import { makeToolDef } from '../helpers/make-tool-def';
import type { WorkspacePort } from '../../src/ports/workspace';

function mockWorkspace(openPluginSettings = vi.fn().mockResolvedValue(true)): WorkspacePort {
	return {
		getActiveFilePath: () => null,
		getActiveSelection: () => null,
		openNote: vi.fn(),
		openPluginSettings: openPluginSettings as WorkspacePort['openPluginSettings'],
	};
}

describe('open_settings', () => {
	it('合法 tab - 透传打开', async () => {
		const open = vi.fn().mockResolvedValue(true);
		const tool = createOpenSettingsTool(mockWorkspace(open), makeToolDef('open_settings'));
		const result = (await tool.execute({ tab: 'index' })) as Record<string, unknown>;
		expect(open).toHaveBeenCalledWith('index');
		expect(result.opened).toBe(true);
		expect(tool.readOnly).toBe(true);
	});

	it('省略 tab - 打开默认 tab', async () => {
		const open = vi.fn().mockResolvedValue(true);
		const tool = createOpenSettingsTool(mockWorkspace(open), makeToolDef('open_settings'));
		await tool.execute({});
		expect(open).toHaveBeenCalledWith(undefined);
	});

	it('非法 tab - 不调用打开,返回提示', async () => {
		const open = vi.fn();
		const tool = createOpenSettingsTool(mockWorkspace(open), makeToolDef('open_settings'));
		const result = (await tool.execute({ tab: 'secret' })) as Record<string, unknown>;
		expect(open).not.toHaveBeenCalled();
		expect(result.opened).toBe(false);
		expect(String(result.message)).toContain('chat');
	});
});
```

- [ ] **Step 2: 运行确认失败后实现**

Run: `npx vitest run tests/tools/open-settings.test.ts` → FAIL;新建 `src/tools/open-settings.ts`:

```typescript
/**
 * @file src/tools/open-settings.ts
 * @description open_settings 工具 — 打开 Ratel 设置面板并定位到 tab
 * @module tools/open-settings
 * @depends core/tool-registry, ports/workspace, ports/llm
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { WorkspacePort } from '../ports/workspace';

/** 合法 tab 枚举 — 与 SettingsUiTab 保持一致 */
const VALID_TABS = ['chat', 'index', 'agent', 'appearance', 'advanced'] as const;

/**
 * 构造 `open_settings` 工具。
 *
 * 设计要点:纯 UI 导航,readOnly: true,默认 allow;非法 tab 工具层拒绝
 * (枚举校验先于打开调用)。
 */
export function createOpenSettingsTool(workspace: WorkspacePort, definition: ToolDefinition): Tool {
	return {
		definition,
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			const tab = typeof args.tab === 'string' && args.tab.length > 0 ? args.tab : undefined;
			if (tab != null && !(VALID_TABS as readonly string[]).includes(tab)) {
				return {
					opened: false,
					message: `tab 只能是: ${VALID_TABS.join(' / ')}。`,
				};
			}
			const opened = await workspace.openPluginSettings(tab);
			return {
				opened,
				tab: tab ?? 'chat',
				...(opened ? {} : { message: '未能打开设置面板,请让用户手动打开:设置 → Ratel。' }),
			};
		},
	};
}
```

Run: `npx vitest run tests/tools/open-settings.test.ts` → 3 PASS

- [ ] **Step 3: schema / sections / i18n / 默认权限 / 注册**

`tool-schemas.ts`:

```typescript
	open_settings: {
		name: 'open_settings',
		parameters: {
			type: 'object',
			properties: {
				tab: { type: 'string', enum: ['chat', 'index', 'agent', 'appearance', 'advanced'] },
			},
			required: [],
		},
	},
```

ALL_TOOL_NAMES 追加 `'open_settings'`。sections.ts 追加 `tool.open_settings.description` + `tool.open_settings.param.tab` 两条。`zh.ts`:

```typescript
  'tool.name.open_settings': '打开设置面板',
  'settings.toolPermissions.open_settings': '打开设置面板',
  'promptLabel.tool.open_settings.description': 'open_settings 描述',
  'promptLabel.tool.open_settings.description.desc': '打开 Ratel 设置面板,可定位到对话/索引/记忆与权限/外观/高级 tab',
  'promptLabel.tool.open_settings.param.tab': 'open_settings.tab',
  'promptLabel.tool.open_settings.param.tab.desc': 'chat/index/agent/appearance/advanced 之一,省略打开默认',
```

`en.ts` 镜像:

```typescript
  'tool.name.open_settings': 'Open settings',
  'settings.toolPermissions.open_settings': 'Open settings',
  'promptLabel.tool.open_settings.description': 'open_settings description',
  'promptLabel.tool.open_settings.description.desc': 'Open the Ratel settings panel, optionally focusing a tab (chat/index/agent/appearance/advanced)',
  'promptLabel.tool.open_settings.param.tab': 'open_settings.tab',
  'promptLabel.tool.open_settings.param.tab.desc': 'One of chat/index/agent/appearance/advanced; omit for default',
```

DEFAULT_SETTINGS.toolPermissions 追加 `open_settings: 'allow',`;main.ts 注册:

```typescript
		this.tools.register(createOpenSettingsTool(this.workspacePort, toolDefMap.get('open_settings')!));
```

- [ ] **Step 4: 全量验证 + Commit**

Run: `npx vitest run tests/tools/open-settings.test.ts && npm run typecheck && npm run lint`

```bash
git add src/tools/open-settings.ts src/prompts/tool-schemas.ts src/prompts/sections.ts src/i18n/zh.ts src/i18n/en.ts src/settings.ts src/main.ts tests/tools/open-settings.test.ts
git commit -m "feat: 新增 open_settings 工具 — 定位打开 Ratel 设置面板

白名单外配置(密钥、MCP、prompt 覆盖)需要用户手动改;工具让 Agent
直接把对应 tab 打开到用户眼前,引导词不再让用户自己翻菜单。"
```

---

### Task 7: builtin Skill 内联分发 + ratel-config SKILL.md

**Files:**
- Create: `src/skills/builtin/ratel-config/SKILL.md`
- Create: `src/skills/builtin-writer.ts`
- Modify: `esbuild.config.mjs`(inlineBuiltinSkillsPlugin)
- Modify: `src/main.ts:261` 之前(syncBuiltinSkills 接线)
- Test: `tests/skills/builtin-writer.test.ts`

- [ ] **Step 1: 写 builtin-writer 失败测试**

```typescript
/**
 * @file tests/skills/builtin-writer.test.ts
 * @description syncBuiltinSkills 幂等写出发单测(用真实临时目录,不 mock fs)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
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

	it('写出失败(目标为文件) - 不抛错,记入 skipped 语义', () => {
		// 用同名文件堵住目录创建,制造 EEXIST/ENOTDIR
		writeFileSync(path.join(dir, 'ratel-config'), 'not a dir');
		const r = syncBuiltinSkills(dir, { 'ratel-config': SKILL_MD }, '0.3.0');
		expect(r.written).toHaveLength(0);
	});

	it('无内置 skill - 空结果', () => {
		const r = syncBuiltinSkills(dir, {}, '0.3.0');
		expect(r.written).toHaveLength(0);
		expect(r.skipped).toHaveLength(0);
		expect(existsSync(dir)).toBe(true);
	});
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/skills/builtin-writer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 builtin-writer**

新建 `src/skills/builtin-writer.ts`。**frontmatter 解析用项目已有依赖 gray-matter**(先 `grep gray-matter package.json src/` 确认;若未安装则 `npm i gray-matter`,纯 JS 无原生模块):

```typescript
/**
 * @file src/skills/builtin-writer.ts
 * @description 内置 Skill 幂等写出 — 把构建期内联的 SKILL.md 落到 pluginDir/skills/
 * @module skills/builtin-writer
 * @depends gray-matter, node:fs, node:path, utils/dev-logger
 */

import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { devLogger } from '../utils/dev-logger';

/**
 * 同步内置 skill 到磁盘(幂等,按 version 判断是否重写)。
 *
 * 目录契约:SkillFsAdapter 只扫 skills/ 的直接子目录且必须含 SKILL.md,
 * 写出路径 <skillsDir>/<目录名>/SKILL.md 与之严格对齐。
 *
 * @param skillsDir - pluginDir/skills
 * @param builtinSkills - skill 目录名 → SKILL.md 原文(来自构建期内联清单)
 * @param appVersion - manifest.json 的 version,写进 frontmatter
 * @returns written=本次写出的目录名;skipped=已同版本跳过的
 */
export function syncBuiltinSkills(
	skillsDir: string,
	builtinSkills: Record<string, string>,
	appVersion: string,
): { written: string[]; skipped: string[] } {
	const written: string[] = [];
	const skipped: string[] = [];

	for (const [name, raw] of Object.entries(builtinSkills)) {
		const skillDir = path.join(skillsDir, name);
		const skillMdPath = path.join(skillDir, 'SKILL.md');
		try {
			// 关键路径:幂等判断 — 磁盘版本与当前应用版本一致则零写入
			if (fs.existsSync(skillMdPath)) {
				const diskVersion = extractVersion(fs.readFileSync(skillMdPath, 'utf-8'));
				if (diskVersion === appVersion) {
					skipped.push(name);
					continue;
				}
			}
			fs.mkdirSync(skillDir, { recursive: true });
			fs.writeFileSync(skillMdPath, withVersionFrontmatter(raw, appVersion));
			written.push(name);
		} catch (err) {
			// 关键路径:写出失败不阻塞启动,skill 只是不能覆盖升级,vault/global 源照常加载
			devLogger.warn('skill', `内置 skill 写出失败: ${name}`, err);
		}
	}
	return { written, skipped };
}

/** 从 SKILL.md frontmatter 提取 version;无 frontmatter / 无 version 返回 null */
function extractVersion(content: string): string | null {
	try {
		const data = matter(content).data as Record<string, unknown>;
		return typeof data.version === 'string' ? data.version : null;
	} catch {
		return null;
	}
}

/** 把 version 写进(或覆盖进)frontmatter,正文原样保留 */
function withVersionFrontmatter(raw: string, appVersion: string): string {
	const parsed = matter(raw);
	// gray-matter stringify 会重建 frontmatter;数据键原样 + version 强制当前版本
	return parsed.stringify(parsed.content, { ...parsed.data, version: appVersion });
}
```

Run: `npx vitest run tests/skills/builtin-writer.test.ts` → 6 PASS

- [ ] **Step 4: 写 SKILL.md 与 esbuild 插件**

新建 `src/skills/builtin/ratel-config/SKILL.md`(frontmatter 不写 version — 构建注入):

```markdown
---
name: ratel-config
description: 配置与排障 Ratel 自身:模型选择、API 密钥状态、索引、记忆、诊断。用户问「帮我配模型 / 为什么不工作 / 索引怎么开」等配置类问题时激活。
activation: auto
tags: [config]
---

# Ratel 配置助手

帮用户完成 Ratel 自身配置与排障。固定流程:

## 1. 先看现状,不要凭空猜

调 `get_app_config` 拿配置快照、密钥状态与索引状态,再下结论。

## 2. 分诊处理

- **模型/分块/索引/记忆/外观类配置**:属于可代改项。先说明要改什么、为什么,征得用户同意后调 `update_app_config`(一次可传多个 key)。
- **API Key**:一律不代改。`get_app_config` 的 `secrets.requiredChatSecretId` / `requiredEmbedSecretId` 给出当前 provider 需要的 secret ID。引导:Obsidian 设置 → 钥匙串(Keychain)→ 添加该 ID 的条目。改完让用户说一声,复查 `hasChatApiKey`。
- **工具权限 / MCP / prompt 覆盖**:不在代改范围。调 `open_settings` 定位到对应 tab(agent tab),文字指引用户手动改。
- **localhost Ollama 无需密钥**:若 chatApiBase 指向 localhost 且用户被密钥问题困扰,提示可换 Ollama 免 Key。

## 3. 红线(任何情况不例外)

- 绝不修改 toolPermissions / toolPermissionLevel / mcpServers / mcpApprovedSpawns / promptOverrides(白名单会拒绝,也不要尝试绕过)。
- 绝不向用户索要、展示或存储 API Key 明文;密钥只存在 Obsidian 钥匙串。
- 不确定配置项含义时,先用 get_app_config 复查再动手;改完主动汇报改了什么。
```

`esbuild.config.mjs` — 仿 `inlineEmbeddingWorkerPlugin`(line 19-39)追加:

```javascript
const BUILTIN_SKILLS_DIR = path.resolve(__dirname, 'src/skills/builtin');

/**
 * 把 src/skills/builtin/**/SKILL.md 与 manifest version 内联进 main.js。
 * 商店 release 只有 main.js 三文件,内置 skill 靠运行时落盘分发(ADR-006 同思路)。
 */
function inlineBuiltinSkillsPlugin() {
	return {
		name: 'inline-builtin-skills',
		setup(build) {
			build.onResolve({ filter: /^@ratel\/builtin-skills-code$/ }, () => ({
				path: '@ratel/builtin-skills-code',
				namespace: 'ratel-builtin-skills',
			}));
			build.onLoad({ filter: /.*/, namespace: 'ratel-builtin-skills' }, () => {
				const skills = {};
				if (existsSync(BUILTIN_SKILLS_DIR)) {
					for (const entry of fs.readdirSync(BUILTIN_SKILLS_DIR, { withFileTypes: true })) {
						if (!entry.isDirectory()) continue;
						const skillMd = path.join(BUILTIN_SKILLS_DIR, entry.name, 'SKILL.md');
						if (existsSync(skillMd)) {
							skills[entry.name] = readFileSync(skillMd, 'utf-8');
						}
					}
				}
				const manifest = JSON.parse(readFileSync(path.resolve(__dirname, 'manifest.json'), 'utf-8'));
				return {
					contents:
						`export const BUILTIN_SKILLS = ${JSON.stringify(skills)};\n` +
						`export const APP_VERSION = ${JSON.stringify(manifest.version)};\n`,
					loader: 'js',
				};
			});
		},
	};
}
```

(esbuild.config.mjs 已 import `readFileSync`/`existsSync` from 'node:fs',追加 `readdirSync`;插件加入 mainContext.plugins 数组,放在 `inlineEmbeddingWorkerPlugin()` 旁。)

- [ ] **Step 5: main.ts 接线**

`src/main.ts` line 261(`// 关键路径:onload 异步加载 skills…` 注释)**之前**插入(无条件执行,enableSkills=false 也落盘,保证开启后立即可用且版本升级时能刷新):

```typescript
		// 关键路径:内置 skill 分发(ADR-006 三文件约束) — 构建期内联,启动时幂等落盘;
		// version 随应用版本,升级自动重写;用户在 vault 源放同名 skill 可覆盖(三源合并 vault > builtin)。
		const builtinSync = syncBuiltinSkills(builtinSkillsDir, BUILTIN_SKILLS, APP_VERSION);
		if (builtinSync.written.length > 0) {
			devLogger.info('skill', `内置 skill 已更新: ${builtinSync.written.join(', ')}`);
		}
```

顶部 import:

```typescript
import { syncBuiltinSkills } from './skills/builtin-writer';
import { BUILTIN_SKILLS, APP_VERSION } from '@ratel/builtin-skills-code';
```

(TS 识别虚拟模块:若类型报错,在仓库根加声明 `src/types/builtin-skills.d.ts`:

```typescript
/** esbuild 虚拟模块 @ratel/builtin-skills-code 的类型声明(内容见 esbuild.config.mjs inlineBuiltinSkillsPlugin) */
declare module '@ratel/builtin-skills-code' {
	export const BUILTIN_SKILLS: Record<string, string>;
	export const APP_VERSION: string;
}
```

)

- [ ] **Step 6: 构建 + 全量验证**

Run: `node esbuild.config.mjs production && npx vitest run tests/skills/ && npm run typecheck && npm run lint`
Expected: 构建成功(检查 dist/main.js 里 `grep -c "ratel-config" dist/main.js` ≥ 1);全部通过。

- [ ] **Step 7: Commit**

```bash
git add src/skills/builtin/ratel-config/SKILL.md src/skills/builtin-writer.ts esbuild.config.mjs src/main.ts src/types/builtin-skills.d.ts tests/skills/builtin-writer.test.ts
git commit -m "feat: 内置 ratel-config Skill 经构建内联分发,版本随应用

商店 release 只有 main.js 三文件,pluginDir/skills 装完是空的,内置
skill 从来没真正分发出去;仿 embedding worker 把 SKILL.md 内联进
main.js,启动幂等落盘并注入应用版本号,升级自动刷新,vault 同名
skill 仍可覆盖内置版。"
```

---

### Task 8: 用户文档更新

**Files:**
- Modify: `docs/user-guide.md`(场景表 +2 行、FAQ +1 条)
- Modify: `README.md` / `README.zh-CN.md`(功能清单 bullet)

- [ ] **Step 1: user-guide 场景表**

`docs/user-guide.md` §3「日常怎么问」表格(line 46-60),`当前打开的这篇` 行后追加:

```markdown
| 打开某一篇 | 「打开那篇读书笔记」「跳到它的第二章」 | `open_note`(可定位标题 / 块,直接在 Obsidian 里翻开) |
```

表格末尾(`写综述 / 整理` 行前或后)追加:

```markdown
| 帮我配置 / 排障 | 「帮我换个模型」「索引怎么不跑了」 | 内置 ratel-config skill → `get_app_config` 诊断 → 代改或 `open_settings` 引导(密钥只会引导去钥匙串,不会代填) |
```

FAQ 区追加:

```markdown
| 为什么不帮我填 API Key? | 密钥只存 Obsidian 钥匙串,Agent 只能看到「配没配」,拿不到也填不了明文;照提示去 设置 → 钥匙串 添加对应 secret ID |
```

- [ ] **Step 2: README 功能清单**

`README.md` 功能 bullet 清单加两条(放在检索/阅读相关 bullet 附近,保持既有 emoji + 短句风格):

```markdown
- 🔎 Ask "open that note" — the agent opens it in Obsidian and jumps to the heading
- 🛠 Configure by chat — built-in config skill reads settings, applies whitelisted changes, and walks you through keychain setup
```

`README.zh-CN.md` 对应:

```markdown
- 🔎 说一声「打开那篇」— 直接在 Obsidian 里翻开并定位到标题
- 🛠 对话式配置 — 内置配置 skill 读现状、白名单内代改、密钥引导去钥匙串
```

- [ ] **Step 3: 验证 + Commit**

Run: `npm run lint`(md 不在 eslint 范围则跳过;人工复读两处表格对齐)。

```bash
git add docs/user-guide.md README.md README.zh-CN.md
git commit -m "docs: 补 open_note 与配置 Skill 的用户文档

user-guide 场景表加「打开某一篇」「帮我配置」两行,FAQ 说明密钥为何
不代填;双语 README 功能清单同步。"
```

---

## 自审(Self-Review)

1. **Spec 覆盖**:§4.1 端口(Task 2)、§4.2 open_note(Task 3)、§4.3 内联分发(Task 7)、§4.4 SKILL.md 内容(Task 7 Step 4)、§4.5 三工具与白名单(Task 4/5/6)、§4.6 i18n 与权限(各工具 Task 内)、§8 文档(Task 8)、§9 测试策略(各 Task 的测试即对应)。**无缺口。**
2. **占位符扫描**:Task 5 Step 3 的 `ENUM_CONSTRAINTS` 留了「执行时抄真实枚举」的指令 — 已在步骤内写明数据来源(settings.ts 类型定义 + context-length-presets.ts)与验收要求(测试用真实枚举值),非 TBD;Task 4 的 secrets 签名同理,写明「以 ratel-secrets.ts 真实签名为准」。其余步骤均含完整代码。
3. **类型一致性**:`SettingApplier`(Task 1)在 Task 5 `ConfigUpdateHost extends SettingApplier` 复用;`WorkspacePort.openNote/openPluginSettings`(Task 2)被 Task 3/6 工具消费;`BUILTIN_SKILLS`/`APP_VERSION`(Task 7)命名在插件/声明/接线三处一致;工具名四处(schema/ALL_TOOL_NAMES/i18n/DEFAULT_SETTINGS)逐 Task 对齐。
4. **顺序依赖**:Task 1(settings-apply)先行,Task 5 依赖它;Task 2 先于 3/6;Task 7 独立可并行;Task 8 收尾。

## 执行提示

- 每个 Task 的 vitest/typecheck/lint 全绿才算完成;全部完成后跑 `npm run build` 并按 AGENTS.md「文档同步规则」确认清单(spec §8 之外是否还有遗漏,如 CHANGELOG 留待发版)。
