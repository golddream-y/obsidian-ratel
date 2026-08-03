# P-SETTINGS-SYNC — Settings 读入口统一 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 `settings$` 只读快照统一常驻 UI 对 Settings 的读取，消除「设置改了、抽屉/gate/Memory 页脚不刷新」。

**Architecture:** 新建 `src/ui/settings-store.ts`：`publishSettingsSnapshot` 浅拷贝嵌套字段后写入 `settings$` 并 `settingsRevision+1`。`loadSettings`/`saveSettings` 只调 publish（禁止再并列 `bumpSettingsRevision`）。`saveSettings` 扇出 `contextUsage.maxTokens`。ChatView / MemoryPanel 展示改订 `$settings`；Context Length 写路径用 `applyContextLengthPreset`（若 PR #2 未合入则本 plan 内补齐）。

**Tech Stack:** TypeScript / Svelte 5 store / Vitest

**Spec:** [S-SETTINGS-SYNC](../specs/2026-08-03-settings-sync-design.md)

## Global Constraints

- 测试 `it(...)` 中文：`行为 - 条件 - 期望结果`
- 文件头 / 导出注释按 AGENTS.md 中文规范
- **禁止**深层 Proxy；**禁止** store 模块 `import` `main`
- `saveSettings` 成功路径：**只** `publishSettingsSnapshot`（内含 revision+1），不得再调 `bumpSettingsRevision` 导致 +2
- `.svelte` 展示路径禁止裸 `plugin.settings.`（事件回调 / Modal 打开瞬间 / TS 命令式读取除外）
- 用户可见字符串：本 plan **无新增** UI 文案；不必改 i18n
- 基线分支：`main`；若 PR #2 仍未合入，Task 1 必须落地写路径

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/ui/tokens/context-length-presets.ts` | 补 `applyContextLengthPreset`（若 main 尚无） |
| `src/settings.ts` | `setControlValue('contextLengthPreset')` 走 apply（若尚无） |
| `tests/ui/tokens/context-length-presets.test.ts` | apply 单测（若尚无） |
| `src/ui/settings-store.ts` | **新建** clone / publish / settings$ / resetForTests |
| `src/ui/settings-revision.ts` | 保留 export；JSDoc 标明生产路径用 publish |
| `tests/ui/settings-store.test.ts` | **新建** 快照隔离 / revision / 嵌套拷贝 |
| `src/main.ts` | load/save 挂钩 publish；扇出 maxTokens |
| `src/ui/chat/ChatView.svelte` | 芯片 / embed / gate / maxTokens 订 `$settings` |
| `src/ui/memory-panel/MemoryPanel.svelte` | 页脚订 `$settings.memoryStorageLimitMB` |
| `docs/superpowers/STATUS.md` | plan In Progress → Completed |

---

### Task 1: Context Length 写路径（若 PR #2 未合入）

**Files:**
- Modify: `src/ui/tokens/context-length-presets.ts`
- Modify: `src/settings.ts`（`setControlValue`）
- Test: `tests/ui/tokens/context-length-presets.test.ts`

- [ ] **Step 1: 检查是否已有 `applyContextLengthPreset`**

```bash
rg -n "applyContextLengthPreset" src/ui/tokens/context-length-presets.ts src/settings.ts
```

Expected: 若已有且 `setControlValue` 已接线 → **跳过本 Task 全部后续 Step**，直接 Task 2。  
若无 → 继续 Step 2。

- [ ] **Step 2: 写失败测试（追加到现有 describe）**

```typescript
import { applyContextLengthPreset } from '../../../src/ui/tokens/context-length-presets';

it('applyContextLengthPreset - 切到 1M - 同步写入 chatModelMaxTokens', () => {
	const s = { contextLengthPreset: '256k' as const, chatModelMaxTokens: 256_000 };
	applyContextLengthPreset(s, '1M');
	expect(s.contextLengthPreset).toBe('1M');
	expect(s.chatModelMaxTokens).toBe(1_048_576);
});

it('applyContextLengthPreset - 切到 custom - 保留当前 token 数', () => {
	const s = { contextLengthPreset: '256k' as const, chatModelMaxTokens: 256_000 };
	applyContextLengthPreset(s, 'custom');
	expect(s.contextLengthPreset).toBe('custom');
	expect(s.chatModelMaxTokens).toBe(256_000);
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
npx vitest run tests/ui/tokens/context-length-presets.test.ts
```

Expected: FAIL（`applyContextLengthPreset is not a function`）

- [ ] **Step 4: 实现 `applyContextLengthPreset` 并接线 `setControlValue`**

在 `context-length-presets.ts` 追加：

```typescript
/**
 * 设置页下拉切换 Context Length 时同步写入 settings。
 *
 * @param settings - 可变 settings 片段
 * @param preset - 新的预设 id
 */
export function applyContextLengthPreset(
	settings: { contextLengthPreset: ContextLengthPresetId; chatModelMaxTokens: number },
	preset: ContextLengthPresetId,
): void {
	settings.contextLengthPreset = preset;
	// 关键路径:下拉只写 preset 时抽屉上限不更新 — 必须同步 token
	if (preset !== 'custom') {
		settings.chatModelMaxTokens = presetToTokens(preset);
	}
}
```

在 `settings.ts` import `applyContextLengthPreset`，`setControlValue` 增加分支（在 `chatPreset` 分支旁）：

```typescript
} else if (key === 'contextLengthPreset') {
	// 修复:下拉只写 preset 时 chatModelMaxTokens 仍是旧值
	applyContextLengthPreset(this.plugin.settings, value as ContextLengthPresetId);
} else {
```

- [ ] **Step 5: 跑测试确认通过并提交**

```bash
npx vitest run tests/ui/tokens/context-length-presets.test.ts
```

Expected: PASS

```bash
git add src/ui/tokens/context-length-presets.ts src/settings.ts tests/ui/tokens/context-length-presets.test.ts
git commit -m "fix(settings): Context Length 预设同步 chatModelMaxTokens"
```

---

### Task 2: `settings-store` 核心 API（TDD）

**Files:**
- Create: `src/ui/settings-store.ts`
- Create: `tests/ui/settings-store.test.ts`
- Modify: `src/ui/settings-revision.ts`（JSDoc + 可选 re-export）

- [ ] **Step 1: 写失败测试**

```typescript
/**
 * @file tests/ui/settings-store.test.ts
 * @description settings$ 快照发布 — 隔离 / revision / 嵌套拷贝
 * @module tests/ui/settings-store
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { DEFAULT_SETTINGS } from '../../src/settings';
import {
	settings$,
	publishSettingsSnapshot,
	resetSettingsStoreForTests,
	cloneSettingsSnapshot,
} from '../../src/ui/settings-store';
import { settingsRevision } from '../../src/ui/settings-revision';

describe('settings-store', () => {
	beforeEach(() => {
		resetSettingsStoreForTests();
	});

	it('publishSettingsSnapshot - 修改源对象后 - 已发布快照不被原地篡改', () => {
		const live = { ...DEFAULT_SETTINGS, chatModel: 'model-a' };
		publishSettingsSnapshot(live);
		const snap1 = get(settings$);
		live.chatModel = 'model-b';
		expect(snap1.chatModel).toBe('model-a');
		expect(get(settings$).chatModel).toBe('model-a');
	});

	it('publishSettingsSnapshot - 连续两次 - settingsRevision 各 +1 且无 double bump', () => {
		const before = get(settingsRevision);
		publishSettingsSnapshot({ ...DEFAULT_SETTINGS });
		expect(get(settingsRevision)).toBe(before + 1);
		publishSettingsSnapshot({ ...DEFAULT_SETTINGS, chatModel: 'x' });
		expect(get(settingsRevision)).toBe(before + 2);
	});

	it('cloneSettingsSnapshot - 改 toolPermissions 源 - 快照内权限表独立', () => {
		const live = {
			...DEFAULT_SETTINGS,
			toolPermissions: { ...DEFAULT_SETTINGS.toolPermissions, read_note: 'ask' as const },
		};
		const snap = cloneSettingsSnapshot(live);
		live.toolPermissions.read_note = 'allow';
		expect(snap.toolPermissions.read_note).toBe('ask');
	});

	it('cloneSettingsSnapshot - 改 promptOverrides 源 - 快照独立', () => {
		const live = {
			...DEFAULT_SETTINGS,
			promptOverrides: { 'agent.identity': 'A' },
		};
		const snap = cloneSettingsSnapshot(live);
		live.promptOverrides['agent.identity'] = 'B';
		expect(snap.promptOverrides['agent.identity']).toBe('A');
	});
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run tests/ui/settings-store.test.ts
```

Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/ui/settings-store.ts`**

```typescript
/**
 * @file src/ui/settings-store.ts
 * @description Settings 只读快照 store — 常驻 UI 订阅入口（S-SETTINGS-SYNC）
 * @module ui/settings-store
 * @depends svelte/store, settings(类型与 DEFAULT_SETTINGS)
 */

import { writable, type Readable } from 'svelte/store';
import { DEFAULT_SETTINGS, type RatelVaultSettings } from '../settings';
import { settingsRevision } from './settings-revision';

function cloneSettingsSnapshot(settings: RatelVaultSettings): Readonly<RatelVaultSettings> {
	const base = { ...settings };
	base.toolPermissions = { ...settings.toolPermissions };
	base.promptOverrides = { ...settings.promptOverrides };
	// 关键路径:MCP 合入后若存在数组字段则拷贝；main 无这些键时跳过
	const ext = settings as RatelVaultSettings & {
		mcpServers?: unknown[];
		mcpApprovedSpawns?: unknown[];
	};
	if (Array.isArray(ext.mcpServers)) {
		(base as typeof ext).mcpServers = [...ext.mcpServers];
	}
	if (Array.isArray(ext.mcpApprovedSpawns)) {
		(base as typeof ext).mcpApprovedSpawns = [...ext.mcpApprovedSpawns];
	}
	return base;
}

const settingsStore = writable<Readonly<RatelVaultSettings>>(cloneSettingsSnapshot(DEFAULT_SETTINGS));

/** 常驻 UI 只读订阅；禁止把返回对象当可变 settings 写回 */
export const settings$: Readable<Readonly<RatelVaultSettings>> = {
	subscribe: settingsStore.subscribe,
};

export { cloneSettingsSnapshot };

/**
 * 发布 settings 快照并递增 settingsRevision。
 * saveSettings / loadSettings 成功路径唯一入口；禁止再并列 bumpSettingsRevision。
 */
export function publishSettingsSnapshot(settings: RatelVaultSettings): void {
	settingsStore.set(cloneSettingsSnapshot(settings));
	settingsRevision.update((n) => n + 1);
}

/** 测试专用：恢复默认快照与 revision=0 */
export function resetSettingsStoreForTests(): void {
	settingsStore.set(cloneSettingsSnapshot(DEFAULT_SETTINGS));
	settingsRevision.set(0);
}
```

更新 `settings-revision.ts` 的 `bumpSettingsRevision` JSDoc：

```typescript
/**
 * 仅递增版本号，**不**更新 settings$。
 * 生产路径请用 `publishSettingsSnapshot`（saveSettings 已挂钩）。
 * 保留本函数供旧测试 / 过渡订阅。
 */
export function bumpSettingsRevision(): void {
	settingsRevision.update((n) => n + 1);
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run tests/ui/settings-store.test.ts tests/ui/settings-revision.test.ts
```

Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/ui/settings-store.ts src/ui/settings-revision.ts tests/ui/settings-store.test.ts
git commit -m "feat(settings): 新增 settings$ 只读快照 store"
```

---

### Task 3: `main.ts` 挂钩 publish + 扇出 maxTokens

**Files:**
- Modify: `src/main.ts`（`loadSettings` / `saveSettings` import）

- [ ] **Step 1: 替换 import 与 save/load 挂钩**

将：

```typescript
import { bumpSettingsRevision } from './ui/settings-revision';
```

改为：

```typescript
import { publishSettingsSnapshot } from './ui/settings-store';
import { getEffectiveChatModelMaxTokens } from './utils/context-window';
```

（若仍需 `bumpAppearance`，保留原 appearance import。）

`loadSettings` 末尾（normalize 全部完成后）追加：

```typescript
publishSettingsSnapshot(this.settings);
```

`saveSettings` 将：

```typescript
bumpSettingsRevision();
bumpAppearance();
```

替换为：

```typescript
publishSettingsSnapshot(this.settings);
// 关键路径:扇出上下文上限，抽屉即使漏订 settings$ 也不易陈旧
this.userStatus.patchContextUsage({
	maxTokens: getEffectiveChatModelMaxTokens(this.settings),
});
bumpAppearance();
```

确认文件中**无**其它生产路径调用 `bumpSettingsRevision()`。

- [ ] **Step 2: 静态检查**

```bash
rg -n "bumpSettingsRevision" src/main.ts
rg -n "publishSettingsSnapshot" src/main.ts
```

Expected: `main.ts` 无 `bumpSettingsRevision`；有 `publishSettingsSnapshot` 两处（load + save）。

- [ ] **Step 3: 跑相关单测**

```bash
npx vitest run tests/ui/settings-store.test.ts tests/ui/settings-revision.test.ts tests/ui/tokens/context-length-presets.test.ts
```

Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/main.ts
git commit -m "feat(settings): load/save 发布 settings$ 并扇出 maxTokens"
```

---

### Task 4: ChatView 迁移到 `$settings`

**Files:**
- Modify: `src/ui/chat/ChatView.svelte`

- [ ] **Step 1: 改 import**

将 `settingsRevision` import 改为：

```typescript
import { settings$ } from '../settings-store';
```

（删除对 `settings-revision` 的 import，除非文件别处仍用。）

- [ ] **Step 2: 改 derived / effect**

```typescript
const hasKey = $derived.by(() => {
	void keyTick;
	void $settings$;
	return hasChatApiKey(plugin.app, plugin.settings);
});
const gate = $derived.by(() => {
	void keyTick;
	// 关键路径:Base/预设变更必须立刻重算是否需要 Key，不能只靠聚焦 keyTick
	const s = $settings$;
	return evaluateChatSendGate(s, $statusStore, { hasChatApiKey: hasKey });
});

const modelName = $derived($settings$.chatModel);
const embedKind = $derived($settings$.embedProvider);

// 扇出已在 saveSettings；此处订 $settings$ 保证未走 save 的测试路径也能对齐
$effect(() => {
	plugin.userStatus.patchContextUsage({
		maxTokens: getEffectiveChatModelMaxTokens($settings$),
	});
});
```

注意：Svelte 5 对 store 的自动订阅变量名若 export 为 `settings$`，脚本内使用 `$settings$`（与现有 `$statusStore` 同模式）。若与本地命名冲突，可：

```typescript
import { settings$ as settingsStore } from '../settings-store';
// 然后 $settingsStore.chatModel
```

plan 验收以「芯片 / gate / maxTokens 随 publish 更新」为准，命名选不冲突的一种并在文件内统一。

`resetComposerForNewSession` / `send` 内 `getEffectiveChatModelMaxTokens` 可继续 `plugin.settings`（事件瞬间读）或改 `$settings$` 当前值；推荐 `get(settings$)` 或 `plugin.settings`（save 后二者一致）。保持 `plugin.settings` 亦可。

- [ ] **Step 3: grep 守卫（ChatView）**

```bash
rg -n "plugin\.settings\.(chatModel|embedProvider|chatApiBase|chatModelMaxTokens)" src/ui/chat/ChatView.svelte
rg -n "settingsRevision" src/ui/chat/ChatView.svelte
```

Expected: 展示用 derived **不再** `void $settingsRevision` + 裸读上述字段；`settingsRevision` 字符串不出现。事件路径（send/compose）允许保留 `plugin.settings`。

- [ ] **Step 4: 提交**

```bash
git add src/ui/chat/ChatView.svelte
git commit -m "feat(chat): 芯片/gate/上下文上限改订 settings$"
```

---

### Task 5: MemoryPanel 页脚 + 全库展示路径 grep

**Files:**
- Modify: `src/ui/memory-panel/MemoryPanel.svelte`

- [ ] **Step 1: 订 settings$ 显示上限**

```typescript
import { settings$ as settingsStore } from '../settings-store';
```

页脚改为：

```svelte
{$t('memory.panel.totalSize')}: {formatBytes(totalSize)} / {$settingsStore.memoryStorageLimitMB} MB
```

（按 ChatView 同一 store 订阅命名约定。）

外观 `syncAppearance` 仍可读 `plugin.settings`（由 `appearanceRevision` 回调触发，属事件瞬间读，符合 spec 例外）。

- [ ] **Step 2: 全库 grep 验收清单**

```bash
rg -n "plugin\.settings\.(chatModel|embedProvider|memoryStorageLimitMB|chatModelMaxTokens|chatApiBase)" src/ui --glob '*.svelte'
```

Expected 允许：
- `MemoryPanel` / `ChatView` 的 `syncAppearance` 读 `uiColorScheme` / `uiAccent`（非本清单字段）
- 本清单字段在 `.svelte` **展示表达式**中应来自 `$settingsStore` / `$settings$`

不允许：模板或 `$derived` 里裸 `plugin.settings.memoryStorageLimitMB` / `chatModel` 等。

- [ ] **Step 3: 跑相关单测**

```bash
npx vitest run tests/ui/settings-store.test.ts tests/ui/settings-revision.test.ts tests/ui/tokens/context-length-presets.test.ts tests/ui/chat-send-gate.test.ts
```

Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/ui/memory-panel/MemoryPanel.svelte
git commit -m "feat(memory): 存储上限展示改订 settings$"
```

---

### Task 6: STATUS 收尾

**Files:**
- Modify: `docs/superpowers/STATUS.md`

- [ ] **Step 1: 将 P-SETTINGS-SYNC 标为 Completed（执行结束时）**

在「实施 Plan」表确保有一行：

```markdown
| P-SETTINGS-SYNC | [2026-08-03-settings-sync.md](plans/2026-08-03-settings-sync.md) | ✅ Completed | S-SETTINGS-SYNC | settings$ 读入口;扇出 maxTokens;Chat/Memory/gate |
```

执行开始时先改为 `🔄 In Progress` 并写分支名；全部 Task 完成后再改 Completed。

- [ ] **Step 2: 提交**

```bash
git add docs/superpowers/STATUS.md
git commit -m "docs(status): P-SETTINGS-SYNC Completed"
```

---

## 自审（对照 S-SETTINGS-SYNC）

| Spec 要求 | 对应 Task |
|-----------|-----------|
| `settings$` + publish + 禁止 double bump | Task 2–3 |
| 嵌套 toolPermissions / promptOverrides；mcp 字段可选 | Task 2 |
| load/save publish；扇出 maxTokens | Task 3 |
| applyContextLengthPreset | Task 1 |
| Chat 芯片 / gate / maxTokens | Task 4 |
| Memory 页脚 | Task 5 |
| grep 守卫 | Task 5 Step 2 |
| 不改 appearanceRevision / UserStatus 模型 | 全局约束；Task 3 仅扇出 maxTokens |
| 测试 | Task 1–2、5 |

**已知不在本期：** ESLint 自定义规则、ADR 正文、MCP 专用 UI（合入后嵌套拷贝已预留）。

---

## 验收手测（执行者本机）

1. 设置 → 上下文长度改 `1M` → 开抽屉：分母为 `1,048,576`。  
2. 设置 → Chat Base 在云 API 与 `http://localhost:11434` 间切换 → **不聚焦输入框**，硬拦/可发送状态立刻变。  
3. 打开记忆 Modal → 改 `memoryStorageLimitMB` → 页脚分母更新（可关开 Modal 或保持打开若已订 store）。  
4. 改外观色 → 仍即时生效（appearance 链未回归）。
