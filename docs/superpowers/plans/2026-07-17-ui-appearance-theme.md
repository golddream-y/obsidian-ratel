# Ratel 外观 Tab Implementation Plan(P-UI-APPEARANCE)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 设置新增「外观」Tab:Material 强调色预设 + 亮暗 auto/显式;预览卡为主体;改完立即作用到已打开 Ratel 视图。

**Architecture:** 预设表与 `applyRatelAppearance(root, { uiColorScheme, uiAccent })` 纯函数写 `data-ratel-*`;CSS 用 attribute 选择器覆盖 token。`appearanceRevision` store 在 `saveSettings` 后 bump,Chat/记忆根订阅后重 apply。外观 Tab 用声明式 `render:` 画预览+分段+色块,与 Chat 共用 apply。

**Tech Stack:** TypeScript(strict)、Vitest、Svelte 5 store、Obsidian 声明式 Settings、`styles.css`

## Global Constraints

- Spec:[S-UI-APPEARANCE](../specs/2026-07-17-ui-appearance-theme.md)
- 禁止改 `document.body` 全局主题变量
- 用户可见字符串必须 i18n(`settings.appearance.*` / `settings.tabs.appearance`)
- 默认无「重启 Obsidian」文案;热更新为硬要求
- 不擅自 `git commit`(除非用户明确要求)
- 验证:`npx vitest run <单文件>`;若 SIGKILL 则用 esbuild/node harness

---

## File Map

| 文件 | 职责 |
|------|------|
| Create: `src/ui/appearance/appearance-presets.ts` | Material 预设 id、hex、列表;`UiAccentId` / `UiColorScheme` |
| Create: `src/ui/appearance/apply-ratel-appearance.ts` | 写 dataset + class;`clear` follow/auto |
| Create: `src/ui/appearance/appearance-store.ts` | `appearanceRevision` writable + `bumpAppearance()` |
| Create: `src/ui/appearance/appearance-settings-render.ts` | 外观 Tab 预览卡 + 分段 + 色块 DOM |
| Create: `src/ui/appearance/normalize-appearance-settings.ts` | loadSettings 归一 |
| Modify: `styles.css` | `[data-ratel-accent=…]` / `[data-ratel-scheme=…]` 规则 |
| Modify: `src/settings.ts` | 字段、DEFAULT、Tab、`render` 接线 |
| Modify: `src/main.ts` | `loadSettings` 调 normalize;`saveSettings` 后 bump |
| Modify: `src/i18n/types.ts` `zh.ts` `en.ts` | Tab + 外观文案 |
| Modify: `src/ui/chat/ChatView.svelte` | 根 class + onMount/订阅 apply |
| Modify: `src/ui/memory-panel/MemoryPanel.svelte` | 同上 |
| Test: `tests/ui/appearance/appearance-presets.test.ts` | |
| Test: `tests/ui/appearance/apply-ratel-appearance.test.ts` | |
| Test: `tests/ui/appearance/normalize-appearance-settings.test.ts` | |

---

### Task 1: 预设表 + 类型

**Files:**
- Create: `src/ui/appearance/appearance-presets.ts`
- Test: `tests/ui/appearance/appearance-presets.test.ts`

**Interfaces:**
- Produces:
  - `export type UiColorScheme = 'auto' | 'light' | 'dark'`
  - `export type UiAccentId = 'follow' | 'red' | 'purple' | 'indigo' | 'blue' | 'teal' | 'green' | 'orange' | 'pink'`
  - `export interface AppearancePreset { id: Exclude<UiAccentId, 'follow'>; hex: string; materialName: string }`
  - `export const APPEARANCE_PRESETS: readonly AppearancePreset[]`
  - `export function isUiAccentId(v: unknown): v is UiAccentId`
  - `export function isUiColorScheme(v: unknown): v is UiColorScheme`
  - `export function hexForAccent(id: UiAccentId): string | null` — `follow` → `null`

- [ ] **Step 1: 写失败测试**

```ts
/**
 * @file tests/ui/appearance/appearance-presets.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
	APPEARANCE_PRESETS,
	hexForAccent,
	isUiAccentId,
	isUiColorScheme,
} from '../../../src/ui/appearance/appearance-presets';

describe('appearance-presets', () => {
	it('APPEARANCE_PRESETS - 含 8 个 Material 500 - 与表一致', () => {
		expect(APPEARANCE_PRESETS).toHaveLength(8);
		expect(hexForAccent('teal')).toBe('#009688');
		expect(hexForAccent('red')).toBe('#F44336');
		expect(hexForAccent('follow')).toBeNull();
	});

	it('isUiAccentId - 非法值 - false', () => {
		expect(isUiAccentId('teal')).toBe(true);
		expect(isUiAccentId('follow')).toBe(true);
		expect(isUiAccentId('magenta')).toBe(false);
	});

	it('isUiColorScheme - auto/light/dark - 仅合法', () => {
		expect(isUiColorScheme('auto')).toBe(true);
		expect(isUiColorScheme('system')).toBe(false);
	});
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `npx vitest run tests/ui/appearance/appearance-presets.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现预设表**

```ts
/**
 * @file src/ui/appearance/appearance-presets.ts
 * @description Material 强调色预设与外观字段类型
 * @module ui/appearance/appearance-presets
 */

export type UiColorScheme = 'auto' | 'light' | 'dark';

export type UiAccentId =
	| 'follow'
	| 'red'
	| 'purple'
	| 'indigo'
	| 'blue'
	| 'teal'
	| 'green'
	| 'orange'
	| 'pink';

export interface AppearancePreset {
	id: Exclude<UiAccentId, 'follow'>;
	/** Material Design 500 */
	hex: string;
	materialName: string;
}

export const APPEARANCE_PRESETS: readonly AppearancePreset[] = [
	{ id: 'red', hex: '#F44336', materialName: 'Red' },
	{ id: 'purple', hex: '#9C27B0', materialName: 'Purple' },
	{ id: 'indigo', hex: '#3F51B5', materialName: 'Indigo' },
	{ id: 'blue', hex: '#2196F3', materialName: 'Blue' },
	{ id: 'teal', hex: '#009688', materialName: 'Teal' },
	{ id: 'green', hex: '#4CAF50', materialName: 'Green' },
	{ id: 'orange', hex: '#FF9800', materialName: 'Orange' },
	{ id: 'pink', hex: '#E91E63', materialName: 'Pink' },
] as const;

const ACCENT_SET = new Set<string>(['follow', ...APPEARANCE_PRESETS.map((p) => p.id)]);
const SCHEME_SET = new Set<string>(['auto', 'light', 'dark']);

export function isUiAccentId(v: unknown): v is UiAccentId {
	return typeof v === 'string' && ACCENT_SET.has(v);
}

export function isUiColorScheme(v: unknown): v is UiColorScheme {
	return typeof v === 'string' && SCHEME_SET.has(v);
}

export function hexForAccent(id: UiAccentId): string | null {
	if (id === 'follow') return null;
	return APPEARANCE_PRESETS.find((p) => p.id === id)?.hex ?? null;
}
```

- [ ] **Step 4: 跑测确认通过**

Run: `npx vitest run tests/ui/appearance/appearance-presets.test.ts`
Expected: PASS

---

### Task 2: applyRatelAppearance + CSS 规则

**Files:**
- Create: `src/ui/appearance/apply-ratel-appearance.ts`
- Modify: `styles.css`(文件末尾追加)
- Test: `tests/ui/appearance/apply-ratel-appearance.test.ts`

**Interfaces:**
- Consumes: `UiColorScheme`, `UiAccentId` from presets
- Produces:
  - `export const RATEL_APPEARANCE_ROOT_CLASS = 'ratel-appearance-root'`
  - `export function applyRatelAppearance(root: HTMLElement, opts: { uiColorScheme: UiColorScheme; uiAccent: UiAccentId }): void`

- [ ] **Step 1: 写失败测试**

```ts
/**
 * @file tests/ui/appearance/apply-ratel-appearance.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
	applyRatelAppearance,
	RATEL_APPEARANCE_ROOT_CLASS,
} from '../../../src/ui/appearance/apply-ratel-appearance';

describe('applyRatelAppearance', () => {
	it('apply - teal + dark - 写入 dataset 与 class', () => {
		const el = document.createElement('div');
		applyRatelAppearance(el, { uiColorScheme: 'dark', uiAccent: 'teal' });
		expect(el.classList.contains(RATEL_APPEARANCE_ROOT_CLASS)).toBe(true);
		expect(el.dataset.ratelScheme).toBe('dark');
		expect(el.dataset.ratelAccent).toBe('teal');
	});

	it('apply - auto + follow - 清除强制 dataset', () => {
		const el = document.createElement('div');
		applyRatelAppearance(el, { uiColorScheme: 'light', uiAccent: 'blue' });
		applyRatelAppearance(el, { uiColorScheme: 'auto', uiAccent: 'follow' });
		expect(el.dataset.ratelScheme).toBeUndefined();
		expect(el.dataset.ratelAccent).toBeUndefined();
		expect(el.classList.contains(RATEL_APPEARANCE_ROOT_CLASS)).toBe(true);
	});
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `npx vitest run tests/ui/appearance/apply-ratel-appearance.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 apply**

```ts
/**
 * @file src/ui/appearance/apply-ratel-appearance.ts
 * @description 在 Ratel 视图根上挂载外观 dataset(供 CSS 覆盖 token)
 * @module ui/appearance/apply-ratel-appearance
 */

import type { UiAccentId, UiColorScheme } from './appearance-presets';

export const RATEL_APPEARANCE_ROOT_CLASS = 'ratel-appearance-root';

/**
 * 将亮暗/强调色选择写到根节点。auto/follow 时移除对应 data 属性,交还 Obsidian 继承。
 */
export function applyRatelAppearance(
	root: HTMLElement,
	opts: { uiColorScheme: UiColorScheme; uiAccent: UiAccentId },
): void {
	root.classList.add(RATEL_APPEARANCE_ROOT_CLASS);
	if (opts.uiColorScheme === 'auto') {
		delete root.dataset.ratelScheme;
	} else {
		root.dataset.ratelScheme = opts.uiColorScheme;
	}
	if (opts.uiAccent === 'follow') {
		delete root.dataset.ratelAccent;
	} else {
		root.dataset.ratelAccent = opts.uiAccent;
	}
}
```

- [ ] **Step 4: 在 `styles.css` 末尾追加规则**

对每个非 follow 预设(用真实 hex):

```css
/* --- Ratel 外观(S-UI-APPEARANCE):仅 .ratel-appearance-root --- */
.ratel-appearance-root[data-ratel-accent="red"] {
	--interactive-accent: #F44336;
	--interactive-accent-hover: color-mix(in srgb, #F44336 85%, white);
	--text-accent: #F44336;
	--ratel-cite: #F44336;
}
/* purple / indigo / blue / teal / green / orange / pink 同理,hex 与 APPEARANCE_PRESETS 一致 */

.ratel-appearance-root[data-ratel-scheme="light"] {
	--background-primary: #ffffff;
	--background-primary-alt: #fcfcfc;
	--background-secondary: #f6f6f6;
	--background-secondary-alt: #fafafa;
	--background-modifier-border: #e0e0e0;
	--text-normal: #222222;
	--text-muted: #5a5a5a;
	--text-faint: #ababab;
	color-scheme: light;
}

.ratel-appearance-root[data-ratel-scheme="dark"] {
	--background-primary: #1e1e1e;
	--background-primary-alt: #212121;
	--background-secondary: #262626;
	--background-secondary-alt: #242424;
	--background-modifier-border: #363636;
	--text-normal: #dadada;
	--text-muted: #999999;
	--text-faint: #666666;
	color-scheme: dark;
}
```

注释写明:数值对齐 Obsidian 文档 light/dark base 语义,仅作用于 Ratel 根。

- [ ] **Step 5: 跑测确认通过**

Run: `npx vitest run tests/ui/appearance/apply-ratel-appearance.test.ts`
Expected: PASS

---

### Task 3: settings 字段归一 + DEFAULT + loadSettings

**Files:**
- Create: `src/ui/appearance/normalize-appearance-settings.ts`
- Modify: `src/settings.ts` — `RatelVaultSettings`、`DEFAULT_SETTINGS`
- Modify: `src/main.ts` — `loadSettings` 调用 normalize
- Test: `tests/ui/appearance/normalize-appearance-settings.test.ts`

**Interfaces:**
- Consumes: `isUiAccentId`, `isUiColorScheme`
- Produces:
  - `export function normalizeAppearanceSettings(settings: RatelVaultSettings): void`
  - Settings 新字段:`uiColorScheme: UiColorScheme`,`uiAccent: UiAccentId`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, type RatelVaultSettings } from '../../../src/settings';
import { normalizeAppearanceSettings } from '../../../src/ui/appearance/normalize-appearance-settings';

describe('normalizeAppearanceSettings', () => {
	it('normalize - 缺字段或非法 - 回落 auto/follow', () => {
		const s = { ...DEFAULT_SETTINGS } as RatelVaultSettings;
		delete (s as Partial<RatelVaultSettings>).uiAccent;
		delete (s as Partial<RatelVaultSettings>).uiColorScheme;
		(s as { uiAccent?: string }).uiAccent = 'nope';
		(s as { uiColorScheme?: string }).uiColorScheme = 'system';
		normalizeAppearanceSettings(s);
		expect(s.uiAccent).toBe('follow');
		expect(s.uiColorScheme).toBe('auto');
	});
});
```

- [ ] **Step 2: 跑测确认失败**

- [ ] **Step 3: 实现 normalize + 改 settings / main**

`normalize-appearance-settings.ts`:

```ts
import type { RatelVaultSettings } from '../../settings';
import { isUiAccentId, isUiColorScheme } from './appearance-presets';

export function normalizeAppearanceSettings(settings: RatelVaultSettings): void {
	if (!isUiColorScheme(settings.uiColorScheme)) {
		settings.uiColorScheme = 'auto';
	}
	if (!isUiAccentId(settings.uiAccent)) {
		settings.uiAccent = 'follow';
	}
}
```

在 `RatelVaultSettings` 与 `DEFAULT_SETTINGS` 增加:

```ts
uiColorScheme: 'auto',
uiAccent: 'follow',
```

类型从 `appearance-presets` 导入(或在 settings 再 export 别名,避免循环:normalize 从 settings 取类型,settings 只写字面量联合亦可 — **推荐 settings 字段类型直接 import 自 presets**)。

`main.ts` `loadSettings` 在 `normalizeChatPreset` 之后调用:

```ts
normalizeAppearanceSettings(this.settings);
```

- [ ] **Step 4: 跑测确认通过**

Run: `npx vitest run tests/ui/appearance/normalize-appearance-settings.test.ts`

---

### Task 4: appearanceRevision store + 视图热更新

**Files:**
- Create: `src/ui/appearance/appearance-store.ts`
- Modify: `src/main.ts` — `saveSettings` 末尾 `bumpAppearance()`
- Modify: `src/ui/chat/ChatView.svelte` — 根节点 class + apply + 订阅
- Modify: `src/ui/memory-panel/MemoryPanel.svelte` — 同上

**Interfaces:**
- Produces:
  - `export const appearanceRevision: Writable<number>`
  - `export function bumpAppearance(): void`

- [ ] **Step 1: 实现 store**

```ts
/**
 * @file src/ui/appearance/appearance-store.ts
 * @description 外观变更版本号 — 视图订阅后重跑 applyRatelAppearance
 */
import { writable } from 'svelte/store';

export const appearanceRevision = writable(0);

export function bumpAppearance(): void {
	appearanceRevision.update((n) => n + 1);
}
```

- [ ] **Step 2: saveSettings 后 bump**

`main.ts` `saveSettings`:

```ts
async saveSettings() {
	await this.saveData(this.settings);
	bumpAppearance();
}
```

(若现有 `saveSettings` 有其它逻辑,保留并在成功写入后 bump。)

- [ ] **Step 3: ChatView.svelte**

根 `.ratel-chat` 增加 class 绑定或始终带 `ratel-appearance-root`(apply 会 add)。

在 `<script>`:

```ts
import { onMount, onDestroy } from 'svelte';
import { applyRatelAppearance } from '../appearance/apply-ratel-appearance';
import { appearanceRevision } from '../appearance/appearance-store';

let chatRoot: HTMLElement | undefined;
let unsub: (() => void) | undefined;

function syncAppearance() {
	if (!chatRoot) return;
	applyRatelAppearance(chatRoot, {
		uiColorScheme: plugin.settings.uiColorScheme,
		uiAccent: plugin.settings.uiAccent,
	});
}

onMount(() => {
	syncAppearance();
	unsub = appearanceRevision.subscribe(() => syncAppearance());
});
onDestroy(() => unsub?.());
```

模板根:`<div class="ratel-chat" bind:this={chatRoot}>`(若已有根 div,只加 `bind:this`)。

- [ ] **Step 4: MemoryPanel.svelte**

对 `.ratel-memory-panel` 同样 `bind:this` + `onMount`/`appearanceRevision` + `applyRatelAppearance`。`plugin` 需已能读 `settings`(现有 props 若无,从现有注入方式取 — 读组件 props;若只有 adapter,则增加 `getSettings: () => Pick<…>` 或传入 `plugin`)。

**关键路径:** 若 MemoryPanel 当前无 `plugin` 引用,在 `MemoryPanelView.ts` mount props 增加 `getAppearance: () => ({ uiColorScheme, uiAccent })`。

- [ ] **Step 5: 手测清单(写入 PR/自测注释即可)**

1. 打开 Chat,改外观强调色 → 侧栏 cite/按钮立即变(不关叶)  
2. `auto` 下改 Obsidian 亮暗 → Ratel 跟随  
3. 显式 `dark` 时 Obsidian 为 light → Ratel 仍暗  

---

### Task 5: i18n + 外观 Tab 主体(预览/分段/色块)

**Files:**
- Modify: `src/i18n/types.ts` — `SettingsStrings` 增 key  
- Modify: `src/i18n/zh.ts` `en.ts`  
- Create: `src/ui/appearance/appearance-settings-render.ts`  
- Modify: `src/settings.ts` — `SettingsUiTab` 含 `'appearance'`;顶栏按钮;group + `render`

**Interfaces:**
- Produces:
  - `export function renderAppearanceSettings(containerEl: HTMLElement, tab: RatelVaultSettingTab): void`
  - 内部写 settings → `plugin.saveSettings()` → `applyRatelAppearance(previewRoot)`(save 已 bump,预览也可直接 apply)

- [ ] **Step 1: i18n keys(中英都要写全)**

至少:

| key | zh |
|-----|-----|
| `settings.tabs.appearance` | 外观 |
| `settings.appearance.heading` | 外观 |
| `settings.appearance.previewLabel` | 预览 |
| `settings.appearance.scheme.name` | 颜色模式 |
| `settings.appearance.scheme.auto` | 跟随 Obsidian |
| `settings.appearance.scheme.light` | 浅色 |
| `settings.appearance.scheme.dark` | 深色 |
| `settings.appearance.accent.name` | 强调色 |
| `settings.appearance.accent.follow` | 跟随 |
| `settings.appearance.accent.red` … `pink` | 红/紫/靛/蓝/青/绿/橙/粉(或 Material 英文名,中英表各自合适即可) |
| `settings.appearance.hint` | 仅影响 Ratel 面板,不会改笔记区和其它插件。 |
| `settings.appearance.status.followScheme` | 跟随 Obsidian |
| `settings.appearance.status.light` | 浅色 |
| `settings.appearance.status.dark` | 深色 |
| `settings.appearance.preview.body` | 这是预览正文,引用会跟强调色。 |
| `settings.appearance.preview.citePath` | 示例笔记.md |
| `settings.appearance.preview.send` | 发送 |

`types.ts` 的 `SettingsStrings` 同步加字段。

- [ ] **Step 2: 实现 `renderAppearanceSettings`**

结构要求(对齐 spec §4.5):

1. 外层 `div.ratel-appearance-settings`  
2. **预览卡** `div.ratel-appearance-preview` — 先 `applyRatelAppearance`;内含词标、正文含 `[1]` 样式按钮、cite-chip、假输入壳、状态行  
3. **颜色模式** 三个 `button`(role=radio / aria-pressed),点击:`settings.uiColorScheme = …`;`await saveSettings()`;`refreshPreview()`  
4. **强调色** `follow` + `APPEARANCE_PRESETS` 色块按钮(`style.background = hex` 或 data 属性),选中加 `is-selected`  
5. muted 说明行 = `settings.appearance.hint`  

禁止本 Tab 用两个普通 dropdown 作为主控件。

预览状态行文案拼接 scheme 状态 + accent 显示名(`tNow`).

- [ ] **Step 3: settings.ts 接线**

```ts
export type SettingsUiTab = 'chat' | 'index' | 'agent' | 'appearance' | 'advanced';
```

顶栏 tabs 数组在 `agent` 与 `advanced` 之间插入:

```ts
{ id: 'appearance', labelKey: 'settings.tabs.appearance' },
```

增加 `appearanceCls` / `appearanceVisible`,以及 group:

```ts
{
  type: 'group',
  heading: tNow('settings.appearance.heading'),
  cls: appearanceCls,
  visible: appearanceVisible,
  items: [{
    name: tNow('settings.appearance.previewLabel'),
    searchable: true,
    render: (setting) => {
      const el = setting.settingEl;
      el.empty();
      renderAppearanceSettings(el, this);
    },
  }],
},
```

`renderAppearanceSettings` 需要 `tab.plugin` 与必要时 `tab.refreshDomState`(通常 save 后预览本地 apply 即可,不必整页 update)。

- [ ] **Step 4: 最小样式**

可在 `styles.css` 增加:

```css
.ratel-appearance-preview { border: 1px solid var(--background-modifier-border); border-radius: 8px; padding: 12px; margin-bottom: 12px; }
.ratel-appearance-scheme { display: flex; gap: 6px; margin: 8px 0; }
.ratel-appearance-swatches { display: flex; flex-wrap: wrap; gap: 8px; }
.ratel-appearance-swatch { width: 28px; height: 28px; border-radius: 6px; border: 2px solid transparent; cursor: pointer; }
.ratel-appearance-swatch.is-selected { border-color: var(--text-normal); }
```

- [ ] **Step 5: 手动打开设置 → 外观,确认预览与 Chat 同步变色**

---

### Task 6: STATUS + 自检清单

**Files:**
- Modify: `docs/superpowers/STATUS.md` — `P-UI-APPEARANCE` → Completed(执行结束后);执行中先 In Progress

- [ ] **Step 1: 执行开始时** STATUS 登记 plan In Progress + 分支名  
- [ ] **Step 2: 对照 spec §7 验收清单逐项勾**  
- [ ] **Step 3: 确认无「重启 Obsidian」默认文案**(`rg "重启 Obsidian" src`)  
- [ ] **Step 4: 全量或相关 vitest**  

Run: `npx vitest run tests/ui/appearance tests/adapters/llm-deepseek.test.ts`  
(appearance 相关必须绿)

---

## Spec coverage(自审)

| Spec 要求 | Task |
|-----------|------|
| 第五 Tab 外观 | T5 |
| `uiColorScheme` / `uiAccent` + data.json | T3 |
| Material 8 色 + follow | T1 |
| apply + 不碰 body | T2 |
| 即时生效 / store bump | T4 |
| 预览卡主体 UI | T5 |
| i18n | T5 |
| 归一旧 data.json | T3 |
| 无默认重启文案 | T6 检查 |
| 记忆面板作用面 | T4 |
| 诊断根 | 设置内诊断仍跟 Obsidian 外壳;预览在外观 Tab 已覆盖。若诊断 page 独立全屏且需强调色,T4 可对 `diagnostics` 根补一次 apply — **可选**,不阻塞 v1 |

## Placeholder scan

无 TBD;hex 与 spec 表一致;函数名 `applyRatelAppearance` / `bumpAppearance` / `normalizeAppearanceSettings` 全文统一。
