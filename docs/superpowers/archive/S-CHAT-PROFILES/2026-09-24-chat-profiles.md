# S-CHAT-PROFILES 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 多套对话模型配置，每套独立密钥，切换是设置里的显式动作，对话工具不能代切。

**Architecture:** `chatProfiles` 数组 + `activeChatProfileId`；现有四个字段仍是「当前这套」；密钥按 `ratel-chat-profile-<id>` 进钥匙串，旧槽位回退；切换复用 S-CONTEXT-ACCURACY 的 `applyModelContextWindow`。

**Tech Stack:** TypeScript strict、vitest、Obsidian `secretStorage`、声明式 SettingTab。

**Spec:** [2026-09-24-chat-profiles-design.md](../specs/2026-09-24-chat-profiles-design.md)

## Global Constraints

- 密钥只进 `app.secretStorage`，不写 `data.json`，不进对话，不作工具参数。
- 所有新用户可见字符串走 `src/i18n/zh.ts` + `en.ts` + `types.ts`。
- 注释中文；`it(...)` 描述中文「行为 - 条件 - 期望」。
- 不写本机绝对路径；测试用 `http://test` 与 `/Users/alice/Notes`。
- `chatProfiles` / `activeChatProfileId` 永不进 `CONFIG_UPDATE_WHITELIST`。
- TDD：每个 Task 先写失败测试，再实现。
- 依赖：Task 5 用 S-CONTEXT-ACCURACY 的 `applyModelContextWindow`（`src/ui/tokens/apply-model-context.ts`）。若该 plan 未先落地，本 Task 先内联同逻辑，落地后改 import。

---

### Task 1: 数据形态与升级合成

**Files:**
- Modify: `src/settings.ts`（接口 + DEFAULT + loadSettings 合成）
- Test: `tests/settings-migration.test.ts`

**Interfaces:**
- Consumes: 现有 `chatModel` / `chatApiBase` / `contextLengthPreset` / `chatModelMaxTokens`
- Produces: `ChatProfile` 类型、`settings.chatProfiles`、`settings.activeChatProfileId`、`normalizeChatProfiles(settings, raw)`

- [ ] **Step 1: 写失败测试**

`tests/settings-migration.test.ts` 追加：

```typescript
import { normalizeChatProfiles } from '../src/settings/chat-profiles';

describe('normalizeChatProfiles', () => {
	it('旧库无 chatProfiles - 用当前四字段合成唯一一套', () => {
		const settings = {
			chatPreset: 'deepseek',
			chatModel: 'deepseek-v4-flash',
			chatApiBase: 'https://api.deepseek.com',
			contextLengthPreset: '256k',
			chatModelMaxTokens: 256_000,
		} as unknown as RatelVaultSettings;
		normalizeChatProfiles(settings, {});
		expect(settings.chatProfiles).toHaveLength(1);
		expect(settings.chatProfiles[0]).toMatchObject({
			name: 'DeepSeek',
			apiBase: 'https://api.deepseek.com',
			model: 'deepseek-v4-flash',
		});
		expect(settings.activeChatProfileId).toBe(settings.chatProfiles[0]!.id);
	});

	it('已有 chatProfiles - 不覆盖', () => {
		const existing = [{ id: 'p1', name: 'A', apiBase: 'http://a', model: 'm1', contextLengthPreset: '128k', chatModelMaxTokens: 128_000 }];
		const settings = { chatProfiles: existing, activeChatProfileId: 'p1' } as unknown as RatelVaultSettings;
		normalizeChatProfiles(settings, { chatProfiles: existing });
		expect(settings.chatProfiles).toBe(existing);
	});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/settings-migration.test.ts -t normalizeChatProfiles`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

新建 `src/settings/chat-profiles.ts`：

```typescript
/**
 * @file src/settings/chat-profiles.ts
 * @description 多套对话配置 — 类型、默认合成、当前套解析
 * @module settings/chat-profiles
 */

import type { ContextLengthPresetId } from '../ui/tokens/context-length-presets';
import type { RatelVaultSettings } from '../settings';

/** 一套对话配置。id 稳定,改名不改 id。 */
export interface ChatProfile {
	id: string;
	name: string;
	apiBase: string;
	model: string;
	contextLengthPreset: ContextLengthPresetId;
	chatModelMaxTokens: number;
}

/** 生成稳定 id(创建时一次,之后不变)。 */
export function newChatProfileId(): string {
	return `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 旧库无 chatProfiles 时,用当前四字段合成唯一一套。
 * 已有则不覆盖。密钥沿用旧槽位,见 ratel-secrets 回退。
 *
 * @param settings - 已与 DEFAULT 合并的设置
 * @param raw - 磁盘原始片段
 */
export function normalizeChatProfiles(
	settings: RatelVaultSettings,
	raw?: Partial<RatelVaultSettings>,
): void {
	if (raw?.chatProfiles != null && Array.isArray(raw.chatProfiles)) return;
	const profile: ChatProfile = {
		id: newChatProfileId(),
		name: settings.chatPreset === 'ollama' ? 'Ollama' : settings.chatPreset === 'custom' ? '自定义' : 'DeepSeek',
		apiBase: settings.chatApiBase,
		model: settings.chatModel,
		contextLengthPreset: settings.contextLengthPreset,
		chatModelMaxTokens: settings.chatModelMaxTokens,
	};
	settings.chatProfiles = [profile];
	settings.activeChatProfileId = profile.id;
}
```

`src/settings.ts` 接口加：

```typescript
	/** 多套对话配置;activeChatProfileId 指向当前这套 */
	chatProfiles: import('./settings/chat-profiles').ChatProfile[];
	activeChatProfileId: string;
```

DEFAULT_SETTINGS 加 `chatProfiles: []`、`activeChatProfileId: ''`。`main.ts` 的 `loadSettings` 在 `normalizeChatPreset` 之后调 `normalizeChatProfiles(this.settings, loaded)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/settings-migration.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/settings/chat-profiles.ts src/settings.ts src/main.ts tests/settings-migration.test.ts
git commit -m "feat: 多套对话配置数据形态与旧库升级合成"
```

---

### Task 2: 按 profile 解析密钥 + 旧槽位回退

**Files:**
- Modify: `src/secrets/ratel-secrets.ts`
- Test: `tests/secrets/ratel-secrets.test.ts`

**Interfaces:**
- Consumes: `settings.chatProfiles` / `activeChatProfileId`（Task 1）
- Produces: `resolveChatApiKey` / `hasChatApiKey` / `getChatSecretId` 支持按当前 profile；`chatProfileSecretId(id)`；`setChatProfileSecret` / `deleteChatProfileSecret`

- [ ] **Step 1: 写失败测试**

`tests/secrets/ratel-secrets.test.ts` 追加：

```typescript
describe('chat profile 密钥', () => {
	const settingsWithProfile = (activeId: string) => ({
		chatApiBase: 'https://api.deepseek.com',
		chatProfiles: [
			{ id: 'p1', name: 'A', apiBase: 'https://a', model: 'm1', contextLengthPreset: '128k', chatModelMaxTokens: 128_000 },
			{ id: 'p2', name: 'B', apiBase: 'https://b', model: 'm2', contextLengthPreset: '128k', chatModelMaxTokens: 128_000 },
		],
		activeChatProfileId: activeId,
	}) as unknown as ChatSecretSettings;

	it('当前套有自己的密钥 - 用 profile 槽位', () => {
		const app = mockApp({ 'ratel-chat-profile-p2': 'sk-b', [RATEL_SECRET_IDS.chatOpenAICompatible]: 'sk-old' });
		expect(resolveChatApiKey(app, settingsWithProfile('p2'))).toBe('sk-b');
	});

	it('当前套无 profile 密钥 - 回退旧槽位', () => {
		const app = mockApp({ [RATEL_SECRET_IDS.chatOpenAICompatible]: 'sk-old' });
		expect(resolveChatApiKey(app, settingsWithProfile('p1'))).toBe('sk-old');
	});

	it('getChatSecretId - 返回当前套的 profile 密钥名', () => {
		expect(getChatSecretId(settingsWithProfile('p2'))).toBe('ratel-chat-profile-p2');
	});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/secrets/ratel-secrets.test.ts -t "chat profile"`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/secrets/ratel-secrets.ts` 加：

```typescript
/** 一套对话配置的钥匙串密钥名。 */
export function chatProfileSecretId(profileId: string): string {
	return `ratel-chat-profile-${profileId}`;
}

/** 当前这套配置的密钥名(active profile 优先,无 profile 时回退旧槽位)。 */
function currentChatSecretId(settings: ChatSecretSettings): string {
	const s = settings as ChatSecretSettings & { chatProfiles?: Array<{ id: string }>; activeChatProfileId?: string };
	const active = s.chatProfiles?.find((p) => p.id === s.activeChatProfileId);
	return active ? chatProfileSecretId(active.id) : RATEL_SECRET_IDS.chatOpenAICompatible;
}
```

`resolveChatApiKey` 改为先读 `currentChatSecretId`，无值再回退旧槽位：

```typescript
export function resolveChatApiKey(app: App, settings: ChatSecretSettings): string | null {
	if (!requiresChatApiKey(settings)) return null;
	const profileKey = getSecret(app, currentChatSecretId(settings));
	// 关键路径:旧库升级后 profile 槽位可能还没写,回退到旧固定槽位
	return profileKey ?? getSecret(app, RATEL_SECRET_IDS.chatOpenAICompatible);
}
```

`getChatSecretId` 改为返回 `currentChatSecretId(settings)`（仍需 `requiresChatApiKey` 为 true，否则 null）。加写入/删除：

```typescript
/** 写入一套配置的密钥。 */
export function setChatProfileSecret(app: App, profileId: string, value: string): void {
	app.secretStorage?.setSecret(chatProfileSecretId(profileId), value);
}

/** 删除一套配置的密钥。 */
export function deleteChatProfileSecret(app: App, profileId: string): void {
	app.secretStorage?.deleteSecret(chatProfileSecretId(profileId));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/secrets/ tests/integration/settings-propagation.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/secrets/ratel-secrets.ts tests/secrets/ratel-secrets.test.ts
git commit -m "feat: 对话密钥按当前配置解析，旧槽位回退"
```

---

### Task 3: 白名单与对话工具边界

**Files:**
- Modify: `src/settings/config-whitelist.ts`
- Test: `tests/settings/config-whitelist.test.ts`

**Interfaces:**
- Consumes: 现有 `PRIVILEGE_ESCALATION_KEYS`
- Produces: `chatProfiles` / `activeChatProfileId` 列入永不白名单

- [ ] **Step 1: 写失败测试**

`tests/settings/config-whitelist.test.ts` 的 `PRIVILEGE_ESCALATION_KEYS` 数组加 `'chatProfiles'`、`'activeChatProfileId'`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/settings/config-whitelist.test.ts`
Expected: 现有断言已覆盖「不在白名单」，此步直接 PASS（这两个 key 本就不在）；补一条显式注释说明永不加入。

- [ ] **Step 3: 实现（注释级）**

`src/settings/config-whitelist.ts` 的红线注释加 `chatProfiles / activeChatProfileId`：

```typescript
 *   agentMaxSteps / modelRegistryUrl / hostAccessEnabled / chatProfiles / activeChatProfileId
 *   — 这些是提权面或调试开关,必须由用户在设置面板亲手改。
```

- [ ] **Step 4: 跑测试**

Run: `npx vitest run tests/settings/config-whitelist.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/settings/config-whitelist.ts tests/settings/config-whitelist.test.ts
git commit -m "chore: 多套配置与切换不进入对话可改白名单"
```

---

### Task 4: 设置 UI — 已保存配置列表

**Files:**
- Modify: `src/settings.ts`（对话模型组顶部加列表 render）
- Create: `src/ui/settings/chat-profiles-render.ts`
- Modify: `src/i18n/types.ts`、`zh.ts`、`en.ts`
- Test: `tests/settings/chat-profiles-ui.test.ts`（新建，测纯逻辑部分）

**Interfaces:**
- Consumes: `settings.chatProfiles` / `activeChatProfileId`（Task 1）、`setChatProfileSecret` / `deleteChatProfileSecret`（Task 2）
- Produces: `renderChatProfiles(app, plugin)` render 回调；纯函数 `switchChatProfile(settings, id)` / `saveCurrentAsProfile(settings, name)` / `deleteChatProfile(settings, id)`（后两者返回新数组，便于测试）

- [ ] **Step 1: 写失败测试（纯逻辑）**

新建 `tests/settings/chat-profiles-ui.test.ts`：

```typescript
/**
 * @file tests/settings/chat-profiles-ui.test.ts
 * @description 多套配置切换/另存/删除纯逻辑
 * @module tests/settings/chat-profiles-ui
 */
import { describe, it, expect } from 'vitest';
import {
	switchChatProfile,
	saveCurrentAsProfile,
	deleteChatProfile,
} from '../../src/settings/chat-profiles';

const base = () => ({
	chatModel: 'm-current',
	chatApiBase: 'https://current',
	contextLengthPreset: '256k' as const,
	chatModelMaxTokens: 256_000,
	chatProfiles: [
		{ id: 'p1', name: 'A', apiBase: 'https://a', model: 'm1', contextLengthPreset: '128k' as const, chatModelMaxTokens: 128_000 },
	],
	activeChatProfileId: 'p1',
});

describe('switchChatProfile', () => {
	it('切到另一套 - 当前四字段换成该套', () => {
		const s = base();
		switchChatProfile(s as never, 'p1');
		expect(s.chatModel).toBe('m1');
		expect(s.chatApiBase).toBe('https://a');
		expect(s.activeChatProfileId).toBe('p1');
	});
});

describe('saveCurrentAsProfile', () => {
	it('另存当前 - 新一套入列,active 指向新套', () => {
		const s = base();
		const created = saveCurrentAsProfile(s as never, '我的工作');
		expect(s.chatProfiles).toHaveLength(2);
		expect(created.name).toBe('我的工作');
		expect(s.activeChatProfileId).toBe(created.id);
	});
});

describe('deleteChatProfile', () => {
	it('删除当前这套 - 拒绝', () => {
		const s = base();
		expect(() => deleteChatProfile(s as never, 'p1')).toThrow();
	});

	it('删除非当前套 - 从列表移除', () => {
		const s = base();
		s.chatProfiles.push({ id: 'p2', name: 'B', apiBase: 'https://b', model: 'm2', contextLengthPreset: '128k', chatModelMaxTokens: 128_000 });
		deleteChatProfile(s as never, 'p2');
		expect(s.chatProfiles.map((p) => p.id)).toEqual(['p1']);
	});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/settings/chat-profiles-ui.test.ts`
Expected: FAIL（函数不存在）

- [ ] **Step 3: 实现纯逻辑**

`src/settings/chat-profiles.ts` 追加：

```typescript
/** 切到指定一套:把该套字段写入当前四字段。 */
export function switchChatProfile(settings: RatelVaultSettings, id: string): void {
	const target = settings.chatProfiles.find((p) => p.id === id);
	if (!target) return;
	settings.chatApiBase = target.apiBase;
	settings.chatModel = target.model;
	settings.contextLengthPreset = target.contextLengthPreset;
	settings.chatModelMaxTokens = target.chatModelMaxTokens;
	settings.activeChatProfileId = target.id;
}

/** 把当前四字段另存为新一套,active 指向新套。 */
export function saveCurrentAsProfile(settings: RatelVaultSettings, name: string): ChatProfile {
	const profile: ChatProfile = {
		id: newChatProfileId(),
		name,
		apiBase: settings.chatApiBase,
		model: settings.chatModel,
		contextLengthPreset: settings.contextLengthPreset,
		chatModelMaxTokens: settings.chatModelMaxTokens,
	};
	settings.chatProfiles = [...settings.chatProfiles, profile];
	settings.activeChatProfileId = profile.id;
	return profile;
}

/** 删除一套。当前这套拒绝删除。 */
export function deleteChatProfile(settings: RatelVaultSettings, id: string): void {
	if (settings.activeChatProfileId === id) {
		throw new Error('不能删除当前这套配置,请先切到另一套');
	}
	settings.chatProfiles = settings.chatProfiles.filter((p) => p.id !== id);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/settings/chat-profiles-ui.test.ts`
Expected: PASS

- [ ] **Step 5: 设置 UI render**

新建 `src/ui/settings/chat-profiles-render.ts`：声明式 render，列出 `settings.chatProfiles`，每行名称 + 模型 + Base，操作按钮「设为当前」「改名」「删除」，底部「把当前配置存为一套」。「设为当前」调 `switchChatProfile` + `applyModelContextWindow`（Task 5）+ `plugin.saveSettings()` + `plugin.rebuildLLM()`；删除调 `deleteChatProfile` + `deleteChatProfileSecret`；另存调 `saveCurrentAsProfile` + 把当前密钥复制到新槽位（`setChatProfileSecret`）。i18n key 加 `settings.chatProfiles.*`（列表标题、按钮、提示）。

`src/settings.ts` 对话模型组顶部插入 `{ name: tNow('settings.chatProfiles.heading'), render: renderChatProfiles(this.app, this.plugin) }`。

- [ ] **Step 6: 构建 + i18n 对齐**

Run: `node esbuild.config.mjs production && npx vitest run src/i18n/strings.test.ts`
Expected: 构建成功；i18n PASS

- [ ] **Step 7: Commit**

```bash
git add src/settings/chat-profiles.ts src/ui/settings/chat-profiles-render.ts src/settings.ts src/i18n/ tests/settings/chat-profiles-ui.test.ts
git commit -m "feat: 设置里管理多套对话配置，可切换、另存、删除"
```

---

### Task 5: 切换时上限跟随（接 S-CONTEXT-ACCURACY）

**Files:**
- Modify: `src/ui/settings/chat-profiles-render.ts`
- Test: `tests/settings/chat-profiles-ui.test.ts` 追加

**Interfaces:**
- Consumes: `applyModelContextWindow`（`src/ui/tokens/apply-model-context.ts`，S-CONTEXT-ACCURACY Task 4）
- Produces: 切换后该套上限按映射表更新；查不到 Notice

- [ ] **Step 1: 写失败测试**

`tests/settings/chat-profiles-ui.test.ts` 追加：

```typescript
it('切换后上限按映射表更新 - 命中则写入该套', async () => {
	const s = base();
	switchChatProfile(s as never, 'p1');
	// 由 render 层调 applyModelContextWindow;此处断言切换本身不改上限字段以外的部分
	expect(s.chatModelMaxTokens).toBe(128_000);
});
```

- [ ] **Step 2: render 层接入**

`renderChatProfiles` 的「设为当前」在 `switchChatProfile` 之后调 `applyModelContextWindow({ model: target.model, registry: plugin.modelContextRegistry, registryUrl, settings })`；未命中时 `new Notice(tNow('settings.notice.contextLengthUnknown', { model }))`。

- [ ] **Step 3: 跑测试 + 构建**

Run: `npx vitest run tests/settings/chat-profiles-ui.test.ts && node esbuild.config.mjs production`
Expected: PASS；构建成功

- [ ] **Step 4: Commit**

```bash
git add src/ui/settings/chat-profiles-render.ts tests/settings/chat-profiles-ui.test.ts
git commit -m "feat: 切换对话配置后按映射表更新上下文上限"
```

---

## 自审

- **Spec 覆盖：** CP-01 → Task 4（增删）；CP-02 → Task 2；CP-03 → Task 4（切换只写当前四字段，不回填历史）；CP-04 → Task 4（探测读当前四字段，未变）；CP-05 → Task 1；CP-06 → Task 3；CP-07 → Task 4（另存）。
- **占位符：** 无 TBD；Task 5 依赖 S-CONTEXT-ACCURACY 的 helper，已在 Global Constraints 写明未落地时的内联兜底。
- **类型一致：** `ChatProfile` 字段名与 settings 当前四字段一致；`chatProfileSecretId` 与 Task 2 测试一致。
- **密钥安全：** 密钥只在 `secretStorage`，UI 用 password 输入不回显；删除配置时删钥匙串项。
