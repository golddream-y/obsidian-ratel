# 设置面板声明式迁移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `RatelVaultSettingTab` 从 deprecated `display()` 全量迁移到 `getSettingDefinitions()` 声明式 API,解除 Obsidian plugin checker 的 `no-deprecated-display` 错误,通过 0.1.2 发版。

**Architecture:** `getSettingDefinitions()` 返回 group/action/render/page 四类声明式 item;`setControlValue`/`getControlValue` 双 override 集中处理副作用与嵌套 key;诊断 Tab 改用 `SettingDefinitionPage` + `SettingPage` 子类命令式渲染;`display()` 完全删除。

**Tech Stack:** TypeScript 5、Obsidian 1.13.0 API(`SettingDefinitionItem` / `SettingPage`)、esbuild、`eslint-plugin-obsidianmd@0.4.1`。

**Spec:** [docs/superpowers/specs/2026-07-05-settings-declarative-migration-design.md](../specs/2026-07-05-settings-declarative-migration-design.md)

---

## 文件结构

| 文件 | 类型 | 职责 |
|---|---|---|
| `src/settings.ts` | 重写 | `RatelVaultSettingTab` 声明式实现,删除 `display()` |
| `src/ui/settings/diagnostics-setting-page.ts` | 新建 | `DiagnosticsSettingPage extends SettingPage`,渲染 3 个诊断子 tab |
| `src/ui/settings/secret-hint-render.ts` | 新建 | 适配 `SettingDefinitionRender` 的 secret hint 包装函数 |
| `src/ui/settings/prompt-override-render.ts` | 新建 | 适配 `SettingDefinitionRender` 的 prompt override section 包装函数 |
| `tests/settings.declarative.test.ts` | 新建 | `getControlValue`/`setControlValue` 嵌套 key 单元测试 |

**不改动**:`src/ui/components/secret-hint.ts`(保持原 `renderSecretHint` 签名,新文件做 wrapper)、`src/ui/diagnostics/tab-bar.ts`、`src/ui/diagnostics/embedding-test.ts`、`src/ui/diagnostics/llm-test.ts`、`src/ui/diagnostics/rerank-test.ts`、`src/prompts/`、`src/secrets/`、`src/main.ts`。

---

## Task 1:建测试骨架 — `getControlValue`/`setControlValue` 嵌套 key 行为

**Files:**
- Create: `tests/settings.declarative.test.ts`

**目的:** 用 TDD 锁定嵌套 key 行为(读 `toolPermissions.search_vault` 写到 `settings.toolPermissions.search_vault` 而非 `settings["toolPermissions.search_vault"]`)。先写测试看它失败(因为 `RatelVaultSettingTab` 还没 override 这两个方法)。

- [ ] **Step 1: 写失败测试**

Create `tests/settings.declarative.test.ts`:

```typescript
/**
 * @file tests/settings.declarative.test.ts
 * @description 声明式 SettingTab 的 getControlValue / setControlValue 嵌套 key 行为测试
 * @module tests/settings.declarative
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App } from 'obsidian';
import { RatelVaultSettingTab, DEFAULT_SETTINGS } from '../src/settings';
import type { RatelVaultPlugin } from '../src/main';
import type { RatelVaultSettings } from '../src/settings';

// 关键路径:mock 最小 Plugin,只需 settings + saveSettings + rebuildLLM/rebuildEmbeddingAdapter/syncToolDefinitions
function makeMockPlugin(settings: RatelVaultSettings): RatelVaultPlugin {
	return {
		settings,
		saveSettings: vi.fn().mockResolvedValue(undefined),
		rebuildLLM: vi.fn(),
		rebuildEmbeddingAdapter: vi.fn(),
		syncToolDefinitions: vi.fn(),
	} as unknown as RatelVaultPlugin;
}

describe('RatelVaultSettingTab 嵌套 key 读写', () => {
	let plugin: RatelVaultPlugin;
	let tab: RatelVaultSettingTab;

	beforeEach(() => {
		plugin = makeMockPlugin(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
		// 关键路径:App mock 只需 secretStorage 字段不存在,不影响嵌套 key 测试
		const app = {} as App;
		tab = new RatelVaultSettingTab(app, plugin);
	});

	it('getControlValue - 嵌套 toolPermissions key - 返回嵌套对象的值', () => {
		plugin.settings.toolPermissions.search_vault = 'deny';
		expect(tab.getControlValue('toolPermissions.search_vault')).toBe('deny');
	});

	it('getControlValue - 嵌套 promptOverrides key - 返回嵌套对象的值', () => {
		plugin.settings.promptOverrides['system.role'] = 'custom';
		expect(tab.getControlValue('promptOverrides.system.role')).toBe('custom');
	});

	it('getControlValue - 顶层 key - 返回直接字段', () => {
		plugin.settings.chatModel = 'claude-3-5-sonnet';
		expect(tab.getControlValue('chatModel')).toBe('claude-3-5-sonnet');
	});

	it('setControlValue - 嵌套 toolPermissions key - 写入嵌套对象', async () => {
		await tab.setControlValue('toolPermissions.search_vault', 'allow');
		expect(plugin.settings.toolPermissions.search_vault).toBe('allow');
		// 关键路径:不应创建字面量字段 "toolPermissions.search_vault"
		expect(
			(plugin.settings as unknown as Record<string, unknown>)['toolPermissions.search_vault'],
		).toBeUndefined();
	});

	it('setControlValue - 嵌套 promptOverrides key - 写入嵌套对象', async () => {
		await tab.setControlValue('promptOverrides.system.role', 'custom text');
		expect(plugin.settings.promptOverrides['system.role']).toBe('custom text');
	});

	it('setControlValue - 顶层 key - 写入直接字段', async () => {
		await tab.setControlValue('chatModel', 'gpt-4');
		expect(plugin.settings.chatModel).toBe('gpt-4');
	});

	it('setControlValue - chatModel 变更 - 触发 rebuildLLM', async () => {
		await tab.setControlValue('chatModel', 'gpt-4');
		expect(plugin.rebuildLLM).toHaveBeenCalled();
	});

	it('setControlValue - embedApiBase 变更 - 触发 rebuildEmbeddingAdapter', async () => {
		await tab.setControlValue('embedApiBase', 'http://new:11434/v1');
		expect(plugin.rebuildEmbeddingAdapter).toHaveBeenCalled();
	});

	it('setControlValue - embedLocalModel 变更 - 不触发 rebuildEmbeddingAdapter', async () => {
		await tab.setControlValue('embedLocalModel', 'Xenova/other');
		expect(plugin.rebuildEmbeddingAdapter).not.toHaveBeenCalled();
	});

	it('setControlValue - promptOverrides 变更 - 触发 syncToolDefinitions', async () => {
		await tab.setControlValue('promptOverrides.system.role', 'custom');
		expect(plugin.syncToolDefinitions).toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run tests/settings.declarative.test.ts`
Expected: FAIL — `getControlValue('toolPermissions.search_vault')` 返回 undefined(默认实现 `settings[key]` 读不到嵌套字段)。

- [ ] **Step 3: Commit**

```bash
git add tests/settings.declarative.test.ts
git commit -m "test: 加 RatelVaultSettingTab 嵌套 key 读写测试 (RED)"
```

---

## Task 2:实现 `getControlValue` / `setControlValue` override

**Files:**
- Modify: `src/settings.ts`

**目的:** 让 Task 1 的测试转 GREEN。先实现两个 override,不动 `display()` 与 `getSettingDefinitions()`(下一步处理)。

- [ ] **Step 1: 在 `RatelVaultSettingTab` 类内加 `getControlValue` / `setControlValue` override**

在 `src/settings.ts` 现有 `getSettingDefinitions()` 方法后(行号约 223)、`display()` 方法前,加入:

```typescript
	/**
	 * 读取 control 值 — override 处理嵌套 key。
	 *
	 * 关键路径:`toolPermissions.<name>` 与 `promptOverrides.<sectionId>` 不是直接字段,
	 * 默认实现 `this.plugin.settings[key]` 会读到 undefined,必须手动分发。
	 *
	 * @param key - control key,可能是 "chatModel" 或 "toolPermissions.search_vault"
	 * @returns 当前值
	 */
	getControlValue(key: string): unknown {
		if (key.startsWith('toolPermissions.')) {
			const toolName = key.slice('toolPermissions.'.length);
			return this.plugin.settings.toolPermissions[toolName];
		}
		if (key.startsWith('promptOverrides.')) {
			const sectionId = key.slice('promptOverrides.'.length);
			return this.plugin.settings.promptOverrides[sectionId];
		}
		return (this.plugin.settings as Record<string, unknown>)[key];
	}

	/**
	 * 写入 control 值并触发副作用 — override 处理嵌套 key + rebuild/sync。
	 *
	 * 关键路径:
	 * - 嵌套 key 必须分发到嵌套对象,否则会写入字面量字段 `settings["toolPermissions.xxx"]`
	 * - chatModel / chatApiBase 变更需 rebuildLLM
	 * - embed* 变更(除 embedLocalModel)需 rebuildEmbeddingAdapter
	 * - promptOverrides.* 变更需 syncToolDefinitions
	 * - debugLog 变更需 setDebugEnabled
	 * - 替代原 onChange 回调里散落的 this.display(),改用 this.update()
	 *
	 * @param key - control key
	 * @param value - 新值
	 */
	async setControlValue(key: string, value: unknown): Promise<void> {
		// 嵌套 key 分发
		if (key.startsWith('toolPermissions.')) {
			const toolName = key.slice('toolPermissions.'.length);
			this.plugin.settings.toolPermissions[toolName] = value as ToolPermission;
		} else if (key.startsWith('promptOverrides.')) {
			const sectionId = key.slice('promptOverrides.'.length);
			this.plugin.settings.promptOverrides[sectionId] = value as string;
			this.plugin.syncToolDefinitions();
		} else {
			(this.plugin.settings as Record<string, unknown>)[key] = value;
		}

		// 副作用分发
		if (key === 'chatModel' || key === 'chatApiBase') {
			this.plugin.rebuildLLM();
		}
		// 关键路径:embedLocalModel 当前是只读字段(内置模型),不会触发 setControlValue,
		// 但保险起见排除,避免未来误触发 rebuild。
		if (key.startsWith('embed') && key !== 'embedLocalModel') {
			this.plugin.rebuildEmbeddingAdapter();
		}
		if (key === 'debugLog') {
			devLogger.setDebugEnabled(value as boolean);
		}

		await this.plugin.saveSettings();
		this.update();
	}
```

- [ ] **Step 2: 跑测试验证通过**

Run: `npx vitest run tests/settings.declarative.test.ts`
Expected: PASS — 全部 10 个测试通过。

- [ ] **Step 3: 跑 lint 确保 override 没引入新问题**

Run: `npx eslint src/settings.ts`
Expected: 已有 warnings 数不变(`display` deprecated 仍存在,下一步才删),无新增 error。

- [ ] **Step 4: Commit**

```bash
git add src/settings.ts
git commit -m "feat(settings): 实现 getControlValue/setControlValue override 处理嵌套 key (GREEN)"
```

---

## Task 3:新建 `DiagnosticsSettingPage`

**Files:**
- Create: `src/ui/settings/diagnostics-setting-page.ts`

**目的:** 把当前 `renderDiagnostics(containerEl)` 的内容搬到独立 `SettingPage` 子类,作为声明式 page 的 imperative 渲染兜底。

- [ ] **Step 1: 新建文件**

Create `src/ui/settings/diagnostics-setting-page.ts`:

```typescript
/**
 * @file src/ui/settings/diagnostics-setting-page.ts
 * @description 诊断测试子页面 — 命令式渲染 Embedding/LLM/Rerank 三个子 Tab
 * @module ui/settings/diagnostics-setting-page
 * @depends obsidian, ../../main, ../diagnostics/tab-bar, ../diagnostics/embedding-test, ../diagnostics/llm-test, ../diagnostics/rerank-test
 */

import { App, SettingPage } from 'obsidian';
import type RatelVaultPlugin from '../../main';
import { createTabBar } from '../diagnostics/tab-bar';
import { renderEmbeddingTest } from '../diagnostics/embedding-test';
import { renderLLMTest } from '../diagnostics/llm-test';
import { renderRerankTest } from '../diagnostics/rerank-test';

/**
 * 诊断测试子页面 — 在声明式 settings 中作为 `SettingDefinitionPage` 的 imperative 兜底。
 *
 * 设计要点:
 * - 继承 `SettingPage`,实现 `display()`(注:这是 SettingPage 自己的抽象方法,非 deprecated)
 * - 内部走现有 `createTabBar` + `render*Test`,不改诊断逻辑
 * - 用户从 settings 主页面点击 "Diagnostics" 条目进入此子页面
 */
export class DiagnosticsSettingPage extends SettingPage {
	app: App;
	plugin: RatelVaultPlugin;

	constructor(app: App, plugin: RatelVaultPlugin) {
		super();
		this.app = app;
		this.plugin = plugin;
	}

	/**
	 * 渲染诊断子页面。
	 *
	 * 关键路径:SettingPage 的 abstract 方法,页面打开时调用。
	 * 内部渲染 3 个子 Tab,逻辑与原 `renderDiagnostics(containerEl)` 完全一致。
	 */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('p', {
			text: '调试工具:用于验证 Embedding、LLM、Rerank 适配器是否正常工作。所有参数仅临时生效,不会修改插件配置。',
			attr: { style: 'color: var(--text-muted); margin-bottom: 16px; font-size: 13px;' },
		});

		createTabBar(containerEl, [
			{
				id: 'embedding',
				label: 'Embedding',
				render: (el) => renderEmbeddingTest(el, this.plugin),
			},
			{
				id: 'llm',
				label: 'LLM',
				render: (el) => renderLLMTest(el, this.plugin),
			},
			{
				id: 'rerank',
				label: 'Rerank',
				render: (el) => renderRerankTest(el, this.plugin),
			},
		], 'embedding');
	}
}
```

- [ ] **Step 2: 跑 lint**

Run: `npx eslint src/ui/settings/diagnostics-setting-page.ts`
Expected: 0 errors。如出现 `import/no-unresolved` 说明路径写错。

- [ ] **Step 3: 跑 build 验证类型**

Run: `npm run build`
Expected: TypeScript 编译通过(此时新文件还没被 settings.ts 引用,但不影响 build)。

- [ ] **Step 4: Commit**

```bash
git add src/ui/settings/diagnostics-setting-page.ts
git commit -m "feat(settings): 新建 DiagnosticsSettingPage 命令式子页面"
```

---

## Task 4:新建 secret-hint 与 prompt-override 的 `SettingDefinitionRender` wrapper

**Files:**
- Create: `src/ui/settings/secret-hint-render.ts`
- Create: `src/ui/settings/prompt-override-render.ts`

**目的:** `SettingDefinitionRender` 的回调签名是 `(setting: Setting, group: SettingGroup) => void | (() => void)`,需要把现有 `renderSecretHint(containerEl, opts)` 与 prompt override 的命令式渲染逻辑包装成这个签名。

- [ ] **Step 1: 新建 `secret-hint-render.ts`**

Create `src/ui/settings/secret-hint-render.ts`:

```typescript
/**
 * @file src/ui/settings/secret-hint-render.ts
 * @description secret hint 的 SettingDefinitionRender wrapper
 * @module ui/settings/secret-hint-render
 * @depends obsidian, ../../secrets/ratel-secrets, ../components/secret-hint
 */

import { App, Setting, SettingGroup } from 'obsidian';
import type { RatelVaultSettings } from '../../settings';
import type RatelVaultPlugin from '../../main';
import { renderSecretHint, renderNoKeyNeeded } from '../components/secret-hint';
import {
	getChatSecretId,
	getEmbedSecretId,
	getRerankSecretId,
	hasChatApiKey,
	hasEmbedApiKey,
	hasRerankApiKey,
} from '../../secrets/ratel-secrets';

/**
 * 渲染 Chat API Key hint(声明式 render 回调)。
 *
 * @param app - Obsidian App
 * @param plugin - 插件实例
 * @returns SettingDefinitionRender 的 render 函数
 */
export function renderChatSecretHint(
	app: App,
	plugin: RatelVaultPlugin,
): (setting: Setting, group: SettingGroup) => void {
	return (setting) => {
		const secretId = getChatSecretId(plugin.settings);
		if (secretId) {
			renderSecretHint(setting.settingEl, {
				secretId,
				hasKey: hasChatApiKey(app, plugin.settings),
			});
		} else {
			renderNoKeyNeeded(setting.settingEl, '当前为本地 Ollama,无需 API Key。');
		}
	};
}

/**
 * 渲染 Embedding API Key hint(声明式 render 回调)。
 */
export function renderEmbedSecretHint(
	app: App,
	plugin: RatelVaultPlugin,
): (setting: Setting, group: SettingGroup) => void {
	return (setting) => {
		const secretId = getEmbedSecretId(plugin.settings);
		if (secretId) {
			renderSecretHint(setting.settingEl, {
				secretId,
				hasKey: hasEmbedApiKey(app, plugin.settings),
			});
		} else {
			renderNoKeyNeeded(setting.settingEl, '当前为本地 Ollama Embedding,无需 API Key。');
		}
	};
}

/**
 * 渲染 Rerank API Key hint(声明式 render 回调)。
 */
export function renderRerankSecretHint(
	app: App,
	plugin: RatelVaultPlugin,
): (setting: Setting, group: SettingGroup) => void {
	return (setting) => {
		renderSecretHint(setting.settingEl, {
			secretId: getRerankSecretId(),
			hasKey: hasRerankApiKey(app),
			note: '未配置密钥时 Rerank 自动关闭。',
		});
	};
}
```

- [ ] **Step 2: 新建 `prompt-override-render.ts`**

Create `src/ui/settings/prompt-override-render.ts`:

```typescript
/**
 * @file src/ui/settings/prompt-override-render.ts
 * @description prompt override section 的 SettingDefinitionRender wrapper
 * @module ui/settings/prompt-override-render
 * @depends obsidian, ../../main, ../../prompts, ../../logging/dev-logger
 */

import { Setting, SettingGroup, ToggleComponent, Modal } from 'obsidian';
import type RatelVaultPlugin from '../../main';
import type { RatelVaultSettingTab } from '../../settings';
import type { SectionMeta } from '../../prompts/types';
import { ZH_DEFAULTS } from '../../prompts/defaults/zh';
import { validatePlaceholders } from '../../prompts/interpolate';
import { composeAgentSystem } from '../../prompts/composer';
import { devLogger } from '../../logging/dev-logger';

/**
 * 渲染单个 prompt override section(声明式 render 回调)。
 *
 * 关键路径:每个 section 含:
 * - 提示文案(section label / zone / description / 占位符列表)
 * - "使用自定义" toggle — 开启时显示 textarea,关闭时删除 override
 * - textarea — 校验占位符缺失,显示 warn 行
 * - "恢复本段默认" 按钮 — 删除 override 并刷新
 *
 * @param tab - SettingTab 实例,用于触发 update() 重渲染
 * @param plugin - 插件实例
 * @param meta - section 元信息(来自 listEditableSections)
 * @returns SettingDefinitionRender 的 render 函数
 */
export function renderPromptOverrideSection(
	tab: RatelVaultSettingTab,
	plugin: RatelVaultPlugin,
	meta: SectionMeta,
): (setting: Setting, group: SettingGroup) => void {
	return (setting) => {
		const container = setting.settingEl;
		const useCustom = plugin.settings.promptOverrides[meta.id] !== undefined;

		// section 标题行
		const heading = container.createDiv({ cls: 'ratel-prompt-section-row' });
		new Setting(heading).setName(`${meta.label} (${meta.zone})`).setHeading();
		heading.createEl('p', { text: meta.description, cls: 'setting-item-description' });

		if (meta.placeholders.length > 0) {
			heading.createEl('p', {
				text: `请勿删除占位符: ${meta.placeholders.map((p) => `{{${p}}}`).join(', ')}`,
				cls: 'ratel-prompt-placeholder-hint',
			});
		}

		// 使用自定义 toggle
		new Setting(container)
			.setName('使用自定义')
			.addToggle((toggle: ToggleComponent) => {
				toggle.setValue(useCustom);
				toggle.onChange(async (on) => {
					if (!on) {
						delete plugin.settings.promptOverrides[meta.id];
					} else {
						// 关键路径:首次开启时用当前默认值填充,避免空 textarea 让用户从头写。
						plugin.settings.promptOverrides[meta.id] =
							plugin.settings.promptOverrides[meta.id] ?? ZH_DEFAULTS[meta.id];
					}
					await plugin.saveSettings();
					plugin.syncToolDefinitions();
					// 关键路径:刷新当前 section 的可见状态(toggle off 时隐藏 textarea)
					// 通过 SettingTab 实例方法 update() 触发 declarative 重渲染(非 app.setting.update())。
					tab.update();
				});
			});

		if (useCustom) {
			const ta = container.createEl('textarea', { cls: 'ratel-prompt-override-textarea' });
			ta.value = plugin.settings.promptOverrides[meta.id] ?? ZH_DEFAULTS[meta.id] ?? '';
			ta.rows = 8;
			ta.onchange = async () => {
				const value = ta.value;
				const missing = validatePlaceholders(value, meta.placeholders);
				const warnEl = container.querySelector('.ratel-prompt-warn');
				if (missing.length > 0) {
					if (!warnEl) {
						container.createEl('p', {
							cls: 'ratel-prompt-warn',
							text: `缺少占位符: ${missing.join(', ')}`,
						});
					} else {
						(warnEl as HTMLElement).textContent = `缺少占位符: ${missing.join(', ')}`;
					}
					devLogger.warn('agent', `override ${meta.id} 缺少占位符`, missing);
				} else if (warnEl) {
					warnEl.remove();
				}
				plugin.settings.promptOverrides[meta.id] = value;
				await plugin.saveSettings();
			};

			new Setting(container).setName('恢复本段默认').addButton((btn) =>
				btn.setButtonText('恢复').onClick(async () => {
					delete plugin.settings.promptOverrides[meta.id];
					await plugin.saveSettings();
					tab.update();
				}),
			);
		}
	};
}

/**
 * 渲染 "预览 RAG 系统提示词" 按钮(声明式 render 回调)。
 *
 * 关键路径:点击后弹出 Modal,显示用当前工具列表 + overrides 合成的完整 prompt。
 */
export function renderPromptPreviewButton(
	plugin: RatelVaultPlugin,
): (setting: Setting, group: SettingGroup) => void {
	return (setting) => {
		new Setting(setting.settingEl)
			.setName('预览当前 RAG 系统提示词')
			.setDesc('使用当前工具列表与 overrides 合成(点击后弹出模态框)')
			.addButton((btn) =>
				btn.setButtonText('预览').onClick(() => {
					const preview = composeAgentSystem(
						'rag',
						{ tools: plugin.tools.definitions() },
						plugin.settings.promptOverrides,
					);
					const modal = new Modal(plugin.app);
					modal.titleEl.setText('RAG 系统提示词预览');
					const pre = modal.contentEl.createEl('pre', { text: preview });
					pre.setCssProps({
						whiteSpace: 'pre-wrap',
						wordBreak: 'break-word',
						fontFamily: 'var(--font-monospace)',
						fontSize: 'var(--font-smaller)',
						margin: '0',
					});
					modal.open();
				}),
			);
	};
}
```

- [ ] **Step 3: 跑 lint**

Run: `npx eslint src/ui/settings/secret-hint-render.ts src/ui/settings/prompt-override-render.ts`
Expected: 0 errors。如有 `import/no-unresolved` 或 type 错误,修正路径。

- [ ] **Step 4: 跑 build**

Run: `npm run build`
Expected: 通过(此时新文件还没被引用)。

- [ ] **Step 5: Commit**

```bash
git add src/ui/settings/secret-hint-render.ts src/ui/settings/prompt-override-render.ts
git commit -m "feat(settings): 新建 secret-hint 与 prompt-override 的声明式 render wrapper"
```

---

## Task 5:重写 `getSettingDefinitions()` + 删除 `display()`

**Files:**
- Modify: `src/settings.ts`

**目的:** 这是核心迁移步骤。把 `display()` / `renderSettings()` / `renderDiagnostics()` / `renderToolPermissions()` / `renderPromptOverrides()` 全部删除,改为 `getSettingDefinitions()` 返回完整声明式结构。

- [ ] **Step 1: 在 `src/settings.ts` 顶部加 imports**

在现有 import 块末尾加(保留所有现有 import,只新增):

```typescript
import {
	getSettingDefinitions as _getSettingDefinitions,
} from 'obsidian';
// 关键路径:声明式 settings 子页面与 render wrapper
import { DiagnosticsSettingPage } from './ui/settings/diagnostics-setting-page';
import {
	renderChatSecretHint,
	renderEmbedSecretHint,
	renderRerankSecretHint,
} from './ui/settings/secret-hint-render';
import {
	renderPromptOverrideSection,
	renderPromptPreviewButton,
} from './ui/settings/prompt-override-render';
import { listEditableSections } from './prompts';
```

- [ ] **Step 2: 替换 `getSettingDefinitions()` 实现**

把现有空数组 `getSettingDefinitions()` 替换为完整实现:

```typescript
	/**
	 * 声明式设置定义 — Obsidian 1.13.0 起替代 display()。
	 *
	 * 关键路径:框架根据此返回值自动渲染设置面板,visible() 控制条件项,
	 * action/render 回调处理命令式逻辑。删除所有 render* 私有方法。
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		const settings = this.plugin.settings;

		return [
			// ==================== Chat ====================
			{
				type: 'group',
				heading: 'Chat model',
				items: [
					{
						name: 'Model',
						desc: 'Chat model identifier',
						control: { type: 'text', key: 'chatModel', placeholder: 'deepseek-chat' },
					},
					{
						name: 'API base URL',
						desc: 'Chat model API base URL',
						control: {
							type: 'text',
							key: 'chatApiBase',
							placeholder: 'https://api.deepseek.com',
						},
					},
				],
			},

			// ==================== Context length ====================
			{
				type: 'group',
				heading: 'Context length',
				items: [
					{
						name: 'Context length',
						desc: '模型上下文窗口上限。点击「获取推荐」将验证配置并从公开模型库填入推荐值。',
						control: {
							type: 'dropdown',
							key: 'contextLengthPreset',
							options: CONTEXT_LENGTH_PRESET_OPTIONS,
						},
					},
					{
						name: '获取推荐',
						action: (el) => void this.handleProbeContext(el),
					},
					{
						name: '自定义 token 数',
						desc: `范围 ${CUSTOM_TOKEN_MIN.toLocaleString()} – ${CUSTOM_TOKEN_MAX.toLocaleString()}`,
						control: {
							type: 'number',
							key: 'chatModelMaxTokens',
							min: CUSTOM_TOKEN_MIN,
							max: CUSTOM_TOKEN_MAX,
						},
						visible: () => this.plugin.settings.contextLengthPreset === 'custom',
					},
				],
			},

			// ==================== Advanced ====================
			{
				type: 'group',
				heading: 'Advanced',
				items: [
					{
						name: '模型映射表 URL',
						desc: '留空使用 LiteLLM 默认源。可填企业镜像或 pin 版本地址。',
						control: {
							type: 'text',
							key: 'modelRegistryUrl',
							placeholder: DEFAULT_MODEL_REGISTRY_URL,
						},
					},
					{
						name: '恢复默认',
						action: () => {
							this.plugin.settings.modelRegistryUrl = '';
							void this.plugin.saveSettings().then(() => this.update());
						},
					},
					{
						name: 'Chat API Key',
						render: renderChatSecretHint(this.app, this.plugin),
					},
				],
			},

			// ==================== Embedding ====================
			{
				type: 'group',
				heading: 'Embedding model',
				items: [
					{
						name: 'Provider',
						desc: 'Local uses built-in ONNX model (zero-config). API uses OpenAI-compatible endpoint (Ollama/SiliconFlow/etc). 更改此项需重启 Obsidian 生效(下次启动 smartReindex 检测模型变化自动全量重建)。',
						control: {
							type: 'dropdown',
							key: 'embedProvider',
							options: { local: 'Local (built-in)', api: 'API (external)' },
						},
					},
					{
						name: 'Model',
						desc: '本地默认模型为 bge-small-zh-v1.5,首次启用时自动从 ModelScope 下载 ONNX 权重与词表。',
						control: {
							type: 'text',
							key: 'embedLocalModel',
							disabled: true,
						},
						visible: () => settings.embedProvider === 'local',
					},
					{
						name: 'API base URL',
						desc: 'Embedding API base URL (Ollama: http://localhost:11434/v1)',
						control: {
							type: 'text',
							key: 'embedApiBase',
							placeholder: 'http://localhost:11434/v1',
						},
						visible: () => settings.embedProvider === 'api',
					},
					{
						name: 'Embedding API Key',
						render: renderEmbedSecretHint(this.app, this.plugin),
						visible: () => settings.embedProvider === 'api',
					},
					{
						name: 'Model',
						desc: 'Embedding model identifier',
						control: {
							type: 'text',
							key: 'embedApiModel',
							placeholder: 'bge-m3',
						},
						visible: () => settings.embedProvider === 'api',
					},
				],
			},

			// ==================== Reranker ====================
			{
				type: 'group',
				heading: 'Reranker (百炼,可选)',
				items: [
					{
						name: 'API base URL',
						desc: 'Reranker API base URL(百炼 DashScope compatible-api)',
						control: { type: 'text', key: 'rerankerApiBase' },
					},
					{
						name: 'Model',
						desc: 'Reranker model identifier',
						control: { type: 'text', key: 'rerankerModel' },
					},
					{
						name: 'Rerank API Key',
						render: renderRerankSecretHint(this.app, this.plugin),
					},
				],
			},

			// ==================== Indexing ====================
			{
				type: 'group',
				heading: 'Indexing',
				items: [
					{
						name: 'Chunk size (tokens)',
						desc: 'Number of tokens per chunk. 更改此项需重启 Obsidian 生效(下次启动 smartReindex 检测参数变化自动全量重建)。',
						control: {
							type: 'slider',
							key: 'chunkSize',
							min: 100,
							max: 1000,
							step: 50,
						},
					},
					{
						name: 'Chunk overlap (tokens)',
						desc: 'Overlap between chunks. 更改此项需重启 Obsidian 生效(下次启动 smartReindex 检测参数变化自动全量重建)。',
						control: {
							type: 'slider',
							key: 'chunkOverlap',
							min: 0,
							max: 200,
							step: 10,
						},
					},
					{
						name: 'Auto index',
						desc: 'Automatically re-index on file changes',
						control: { type: 'toggle', key: 'autoIndex' },
					},
				],
			},

			// ==================== Tool permissions ====================
			{
				type: 'group',
				heading: 'Tool permissions',
				items: this.buildToolPermissionItems(),
			},

			// ==================== Prompt overrides (advanced) ====================
			{
				type: 'group',
				heading: 'Prompt overrides (advanced)',
				items: this.buildPromptOverrideItems(),
			},

			// ==================== Diagnostics (sub-page) ====================
			{
				type: 'page',
				name: 'Diagnostics',
				desc: '调试工具:验证 Embedding、LLM、Rerank 适配器是否正常工作',
				page: () => new DiagnosticsSettingPage(this.app, this.plugin),
			},

			// ==================== Developer ====================
			{
				type: 'group',
				heading: 'Developer',
				items: [
					{
						name: 'Debug 日志',
						desc: '在控制台输出 [Ratel:*] debug 级日志',
						control: { type: 'toggle', key: 'debugLog' },
					},
					{
						name: 'Agent 最大步数',
						desc: 'Agent Loop 工具调用循环上限,防止死循环',
						control: {
							type: 'slider',
							key: 'agentMaxSteps',
							min: 5,
							max: 200,
							step: 5,
						},
					},
				],
			},
		];
	}

	/**
	 * 构建 Tool permissions group 的 items。
	 *
	 * 关键路径:信任模式 toggle + 9 个工具 dropdown,
	 * key 用 `toolPermissions.<name>` 嵌套格式,getControlValue/setControlValue 会分发。
	 */
	private buildToolPermissionItems(): SettingGroupItem[] {
		const labels: Record<string, string> = {
			search_vault: '语义搜索',
			read_note: '读取笔记',
			grep: '精确搜索',
			glob: '文件名匹配',
			list_files: '列目录',
			write_note: '创建/覆盖',
			append_note: '追加内容',
			edit_note: '精确替换',
			delete_note: '移到回收站',
		};
		const allTools = ['search_vault', 'read_note', 'grep', 'glob', 'list_files', 'write_note', 'append_note', 'edit_note', 'delete_note'];

		const items: SettingGroupItem[] = [
			{
				name: '信任模式',
				desc: '开启后所有工具直接执行,不再弹出确认对话框',
				control: { type: 'toggle', key: 'trustMode' },
			},
		];

		for (const name of allTools) {
			items.push({
				name: labels[name] ?? name,
				desc: name,
				control: {
					type: 'dropdown',
					key: `toolPermissions.${name}`,
					options: { allow: '允许', ask: '询问', deny: '拒绝' },
				},
			});
		}

		return items;
	}

	/**
	 * 构建 Prompt overrides group 的 items。
	 *
	 * 关键路径:
	 * - 说明段用 SettingDefinitionEmpty(只有 name + desc)
	 * - 每个 section 用 SettingDefinitionRender,内部 toggle + textarea + warn + 恢复按钮
	 * - 预览按钮用 SettingDefinitionRender(内部 new Setting + addButton)
	 */
	private buildPromptOverrideItems(): SettingGroupItem[] {
		const items: SettingGroupItem[] = [
			{
				name: '说明',
				desc: '按段落自定义 LLM 系统提示词。检索结果安全外框不可编辑。',
			},
		];

		for (const meta of listEditableSections()) {
			items.push({
				name: `${meta.label} (${meta.zone})`,
				desc: meta.description,
				render: renderPromptOverrideSection(this, this.plugin, meta),
			});
		}

		items.push({
			name: '预览',
			desc: '使用当前工具列表与 overrides 合成(点击后弹出模态框)',
			render: renderPromptPreviewButton(this.plugin),
		});

		return items;
	}

	/**
	 * 处理「获取推荐」按钮点击。
	 *
	 * 关键路径:发送 probe 请求,成功后 setControlValue + update。
	 */
	private async handleProbeContext(btnEl: HTMLElement): Promise<void> {
		if (
			requiresChatApiKey(this.plugin.settings) &&
			!hasChatApiKey(this.app, this.plugin.settings)
		) {
			new Notice('请先在钥匙串配置 Chat API 密钥', 5000);
			return;
		}
		const originalText = btnEl.textContent ?? '获取推荐';
		btnEl.textContent = '获取中…';
		btnEl.setAttribute('disabled', 'true');

		const registryUrl = this.plugin.settings.modelRegistryUrl || DEFAULT_MODEL_REGISTRY_URL;
		const result = await probeChatConnection({
			apiBase: this.plugin.settings.chatApiBase,
			apiKey: resolveChatApiKey(this.app, this.plugin.settings) ?? '',
			model: this.plugin.settings.chatModel,
			registry: this.plugin.modelContextRegistry,
			registryUrl,
		});

		btnEl.textContent = originalText;
		btnEl.removeAttribute('disabled');

		if (!result.ok) {
			new Notice(`✗ ${result.error}`, 5000);
			return;
		}

		if (result.recommendedTokens != null) {
			const applied = applyContextRecommendation(result.recommendedTokens);
			await this.setControlValue('contextLengthPreset', applied.preset);
			await this.setControlValue('chatModelMaxTokens', applied.chatModelMaxTokens);
			new Notice(
				`✓ 已获取推荐:${result.recommendedTokens.toLocaleString()} tokens`,
				4000,
			);
		} else {
			new Notice('✓ 配置有效,但模型库未命中推荐值,请手动选择或填写', 5000);
		}
	}
```

- [ ] **Step 3: 删除 `display()` / `renderSettings()` / `renderDiagnostics()` / `renderToolPermissions()` / `renderPromptOverrides()`**

把这 5 个方法整体删除(包括 `// eslint-disable-next-line obsidianmd/no-deprecated-display` 注释)。**保留**:`getSettingDefinitions()` / `getControlValue()` / `setControlValue()` / `buildToolPermissionItems()` / `buildPromptOverrideItems()` / `handleProbeContext()`。

- [ ] **Step 4: 移除不再需要的 imports**

删除以下不再使用的 import:
- `import { createTabBar } from './ui/diagnostics/tab-bar';`
- `import { renderEmbeddingTest } from './ui/diagnostics/embedding-test';`
- `import { renderLLMTest } from './ui/diagnostics/llm-test';`
- `import { renderRerankTest } from './ui/diagnostics/rerank-test';`
- `import { renderSecretHint, renderNoKeyNeeded } from './ui/components/secret-hint';`
- `import { Modal } from 'obsidian';` (移到 prompt-override-render.ts 已 import)
- `import { composeAgentSystem } from './prompts/composer';`
- `import { ZH_DEFAULTS } from './prompts/defaults/zh';`
- `import { validatePlaceholders } from './prompts';` (如已存在)
- `import { listEditableSections, validatePlaceholders } from './prompts';` — 改为只 `import { listEditableSections } from './prompts';`
- `import type { OverrideMap } from './prompts/types';`(若不再使用)
- `getSettingDefinitions as _getSettingDefinitions`(Step 1 加的占位,这里删掉)

**保留**:`App, Modal, Notice, PluginSettingTab, Setting, type SettingDefinitionItem, type SettingGroupItem`(Modal 用于 handleProbeContext?不,handleProbeContext 用 Notice;Modal 移到 prompt-override-render.ts。所以这里 `Modal` 也可删)。

最终 import 块应包含:
```typescript
import {
	App,
	Notice,
	PluginSettingTab,
	Setting,
	type SettingDefinitionItem,
	type SettingGroupItem,
} from 'obsidian';
import RatelVaultPlugin from './main';
import { devLogger } from './logging/dev-logger';
import type { ToolPermission } from './core/tool-permissions';
import {
	getChatSecretId,
	getEmbedSecretId,
	getRerankSecretId,
	hasChatApiKey,
	hasEmbedApiKey,
	hasRerankApiKey,
	requiresChatApiKey,
	resolveChatApiKey,
} from './secrets/ratel-secrets';
import type { ContextLengthPresetId } from './ui/tokens/context-length-presets';
import {
	applyContextRecommendation,
	CUSTOM_TOKEN_MAX,
	CUSTOM_TOKEN_MIN,
	presetToTokens,
} from './ui/tokens/context-length-presets';
import { DEFAULT_MODEL_REGISTRY_URL } from './ui/tokens/model-context-registry';
import { probeChatConnection } from './ui/tokens/probe-model';
import { DiagnosticsSettingPage } from './ui/settings/diagnostics-setting-page';
import {
	renderChatSecretHint,
	renderEmbedSecretHint,
	renderRerankSecretHint,
} from './ui/settings/secret-hint-render';
import {
	renderPromptOverrideSection,
	renderPromptPreviewButton,
} from './ui/settings/prompt-override-render';
import { listEditableSections } from './prompts';
```

(注:`inferPresetFromTokens` 与 `normalizeContextLengthSettings` 仍在用,保留 import;`OverrideMap` 若 normalizeContextLengthSettings 不再使用则删除)

- [ ] **Step 5: 跑 lint**

Run: `npx eslint src/settings.ts`
Expected: 0 errors。`no-deprecated-display` 规则应消失。`prefer-update-over-display` 警告消失。`@typescript-eslint/no-deprecated` 警告消失。

- [ ] **Step 6: 跑 build**

Run: `npm run build`
Expected: TypeScript 编译 + svelte-check + esbuild 全部通过。如有类型错误,修正。

- [ ] **Step 7: 跑测试**

Run: `npx vitest run tests/settings.declarative.test.ts`
Expected: PASS(嵌套 key 测试仍通过)。

- [ ] **Step 8: Commit**

```bash
git add src/settings.ts
git commit -m "feat(settings): 全量迁移到 getSettingDefinitions() 声明式 API,删除 display()"
```

---

## Task 6:验证 lint 全通过 + 手动功能验证

**Files:**
- 无修改,纯验证

- [ ] **Step 1: 跑全量 lint**

Run: `npm run lint`
Expected: 与 settings.ts 相关的所有 obsidianmd 规则 error/warning 全部消失。

- [ ] **Step 2: 跑全量测试**

Run: `npm test`
Expected: 全部通过。

- [ ] **Step 3: 跑 build**

Run: `npm run build`
Expected: 通过。

- [ ] **Step 4: 部署到 sandbox vault 验证 UI**

Run: `npm run link:vault`
然后重载 Obsidian,打开插件设置面板。

- [ ] **Step 5: 手动功能验证清单**

逐项验证(每项打勾):

- [ ] 设置面板能正常打开,显示所有 group(不是空白)
- [ ] Chat model / API base URL 输入框正常,修改后触发 rebuildLLM
- [ ] Context length dropdown 切换,选 custom 时显示「自定义 token 数」输入框
- [ ] 「获取推荐」按钮点击,成功后填入推荐值,失败时显示 Notice
- [ ] 模型映射表 URL 输入框 + 「恢复默认」按钮工作
- [ ] Chat API Key hint 显示密钥名与状态
- [ ] Embedding Provider 切换 local/api,字段组正确显示/隐藏
- [ ] local 模式下 Model 输入框只读(disabled)
- [ ] api 模式下 API base URL / Secret hint / Model 显示
- [ ] Reranker API base URL / Model 输入框正常
- [ ] Rerank API Key hint 显示
- [ ] Chunk size / overlap slider 工作
- [ ] Auto index toggle 工作
- [ ] 信任模式 toggle 工作
- [ ] 9 个工具权限 dropdown 显示当前值,切换后保存
- [ ] Prompt overrides 说明段显示
- [ ] 每个 section 显示 toggle + textarea(开启后)
- [ ] textarea 缺占位符时显示 warn
- [ ] 「恢复本段默认」按钮工作
- [ ] 「预览」按钮弹出 Modal 显示完整 prompt
- [ ] Diagnostics 子页面能进入,3 个子 tab 切换正常
- [ ] Debug 日志 toggle 工作
- [ ] Agent 最大步数 slider 工作

- [ ] **Step 6: Commit(若有调整)**

如手动验证发现 bug 并修正,最后 commit:
```bash
git add -A
git commit -m "fix(settings): 修正手动验证发现的问题"
```

---

## Task 7:升版本 0.1.1 → 0.1.2 + 发布

**Files:**
- Modify: `manifest.json`
- Modify: `versions.json`

- [ ] **Step 1: 改 manifest.json**

```json
{
	"id": "ratel-vault",
	"name": "Ratel",
	"version": "0.1.2",
	"minAppVersion": "1.13.0",
	"description": "Chat with your vault. Ask questions with cited answers, and auto-research across notes to write summaries.",
	"author": "golddream-y",
	"authorUrl": "https://github.com/golddream-y",
	"isDesktopOnly": true
}
```

- [ ] **Step 2: 改 versions.json**

```json
{
	"0.1.0": "1.13.0",
	"0.1.1": "1.13.0",
	"0.1.2": "1.13.0"
}
```

- [ ] **Step 3: 重新 build**

Run: `npm run build`

- [ ] **Step 4: Commit + tag + push**

```bash
git add manifest.json versions.json
git commit -m "chore(release): 升版本 0.1.2 — 修复 plugin checker no-deprecated-display 错误"
git tag 0.1.2
git push origin main
git push origin 0.1.2
```

- [ ] **Step 5: 创建 GitHub release 上传三产物**

```bash
gh release create 0.1.2 dist/main.js manifest.json dist/styles.css \
  --title "0.1.2" \
  --notes "修复 Obsidian plugin checker 报告的 no-deprecated-display 错误,设置面板迁移到声明式 API。"
```

- [ ] **Step 6: 等待 plugin checker 自动审核**

在 GitHub release 页面或 community.obsidian.md 查看 Review。
Expected: Source code 段无 Error,只有原有的 Warning/Recommendation(>5MB / fs / 等,这些不阻塞)。

---

## Self-Review

### Spec 覆盖检查

| Spec 要求 | 对应 Task |
|---|---|
| 删除 `display()` | Task 5 Step 3 |
| 实现 `getSettingDefinitions()` | Task 5 Step 2 |
| `setControlValue` override | Task 2 |
| `getControlValue` override | Task 2 |
| 嵌套 key 处理 | Task 1(测试)+ Task 2(实现) |
| `visible: () => boolean` 条件渲染 | Task 5(Embedding / Context length 各处) |
| `SettingDefinitionAction`(获取推荐 / 恢复默认) | Task 5 |
| `SettingDefinitionRender`(API Key hint / Prompt Overrides) | Task 4 + Task 5 |
| `SettingDefinitionEmpty`(Prompt Overrides 说明段) | Task 5 buildPromptOverrideItems |
| `SettingDefinitionPage` + `SettingPage`(Diagnostics) | Task 3 + Task 5 |
| `this.update()` 替代 `this.display()` | Task 2 setControlValue 末尾 |
| Sentence case 修复 | Task 5(heading 用 "Chat model" / "API base URL" 等) |
| 副作用分发(rebuildLLM 等) | Task 2 setControlValue |
| 0.1.2 发版验证 | Task 7 |

### Placeholder 扫描

无 TBD / TODO / "implement later"。每个 step 都有完整代码块或具体命令。

### Type 一致性

- `getControlValue(key: string): unknown` — Task 2 与 spec 一致
- `setControlValue(key: string, value: unknown): Promise<void>` — Task 2 与 spec 一致
- `DiagnosticsSettingPage.display(): void` — Task 3 与 spec 修正后一致
- `renderChatSecretHint(app, plugin): (setting, group) => void` — Task 4 与 spec 一致
- `renderPromptOverrideSection(tab, plugin, meta): (setting, group) => void` — Task 4 修正后与 Task 5 调用一致(传入 SettingTab 引用)
- `SettingGroupItem[]` 返回类型 — Task 5 与 obsidian.d.ts:6414 一致

### 风险点

1. **Task 5 Step 4 删 imports 容易漏删 / 错删** — 实施时跑 `npm run build` 验证,TypeScript 会报未使用或缺失的 import
2. **`tab.update()` 在 prompt-override-render.ts 内调用** — 已修正:wrapper 函数接收 SettingTab 实例 `tab` 作为参数,调 `tab.update()`(SettingTab 实例方法,见 obsidian.d.ts:6591)。**不要**用 `plugin.app.setting.update()` — 那是 Setting 模态框,不是 SettingTab
3. **Sentence case 规则可能对中文 heading 仍报警告** — spec 已说明规则对中文不强制,但若 lint 仍报,评估是否需要 `// eslint-disable-next-line obsidianmd/ui/sentence-case`(注意:`no-deprecated-display` 类规则不允许 disable,但 `sentence-case` 不在禁止 disable 名单)
4. **手动验证步骤多** — Task 6 Step 5 有 23 项,实施时若发现部分项不工作,逐项修正并在 commit message 记录

---

## 后续 spec 影响(跨 spec 审查发现)

**本 plan 完成后,以下 pending plan 需要重写对应 Task 才能执行:**

### P-I18N-IMPL(i18n 基础设施)

[plans/2026-06-14-ratel-i18n-implementation.md](2026-06-14-ratel-i18n-implementation.md) Task 7 "src/settings.ts 改造" 假设 `display()` 仍存在,直接改 `display()` 内部插入 General 分组。本 plan 完成后该假设失效。

**重写方向**:
- Step 4 "在 `display()` 顶部插入 General 分组" → 改为"在 `getSettingDefinitions()` 返回数组开头插入 General group"
- Step 5 "把 `display()` 内所有剩余硬编码字符串替换为 `tNow(...)`" → 改为"把 `getSettingDefinitions()` 内所有 name/desc 字符串替换为 `tNow(...)` 调用"
- 多处 `this.display()` 重渲染 → 改为 `this.update()`(已在本 plan Task 2 的 `setControlValue` 中统一处理,无需 i18n plan 单独处理)

### P-MEMORY-UI(记忆系统 UI)

[plans/2026-07-05-memory-system-ui.md](2026-07-05-memory-system-ui.md) Task 1 Step 3 写"在 `RatelVaultSettingTab.display()` 方法末尾追加「记忆」设置区域",直接 `new Setting(containerEl)`。本 plan 完成后该假设失效。

**重写方向**:
- Step 3 改为"在 `getSettingDefinitions()` 返回数组末尾(Developer group 之前)追加 Memory group,含 6 个 toggle/number control"
- 6 个设置项用 `control: { type: 'toggle' / 'number' }` 声明式表达,删除 `new Setting(containerEl)` 命令式代码
- 注意 `memoryStorageLimitMB` 等数值字段用 `control: { type: 'number', min: 1, max: 1000 }`,无需手动 parseInt 校验

**这两个 plan 启动前必须重写,不要直接执行。**

### 其他 spec / plan

- **S-MEMORY 的 P-MEMORY-LOGIC**:不涉及 settings.ts,无影响
- **S-RAG-ARCH**:已实施,无影响
- **archive 中的 spec**:已归档,无影响
