# P-KEYCHAIN Implementation Plan — Obsidian 钥匙串 API Key 存储

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Chat / Embed / Rerank(百炼) 的 API Key 从 `data.json` 明文迁出,统一经 Obsidian SecretStorage 读取;设置页展示固定 `ratel-*` 密钥名与配置状态;本地内置模型与本地 Ollama 免 Key。

**Architecture:** 新建 `src/secrets/ratel-secrets.ts` 集中端点分类、`isLocalHost`、固定 `RATEL_SECRET_IDS` 与 `resolve*/has*` 函数;`main.ts` 在 `rebuildLLM` / `rebuildEmbeddingAdapter` 时解析钥匙串;设置页用 `renderSecretHint` 替代密码框;`chat-send-gate` 按端点类型决定硬拦。Rerank 适配器实现仍属 P-W4,本 plan 只接线密钥解析与 UI。

**Tech Stack:** TypeScript 5 + Obsidian Plugin API ≥1.11.4 (`app.secretStorage`) + Vitest。

**Spec:** [`docs/superpowers/specs/2026-06-26-ratel-keychain-design.md`](../specs/2026-06-26-ratel-keychain-design.md)

---

## 文件影响面

| 路径 | 操作 | 说明 |
|------|------|------|
| `src/secrets/ratel-secrets.ts` | 新建 | 常量 + 分类 + resolve/has |
| `src/ui/secret-hint.ts` | 新建 | 设置页密钥说明块 |
| `src/settings.ts` | 修改 | 删 Key 字段;Rerank 百炼默认;密码框 → hint |
| `src/main.ts` | 修改 | rebuild 时 resolve Key |
| `src/ui/chat-send-gate.ts` | 修改 | 端点感知硬拦 |
| `src/ui/ChatView.svelte` | 修改 | 传入 `hasChatApiKey` |
| `src/core/feedback-controller.ts` | 修改 | `getSettings` 类型瘦身 |
| `src/ui/diagnostics/llm-test.ts` | 修改 | 钥匙串状态 |
| `src/ui/diagnostics/embedding-test.ts` | 修改 | 同上 |
| `src/ui/diagnostics/rerank-placeholder.ts` | 修改 | 百炼 + 钥匙串状态 |
| `manifest.json` | 修改 | `minAppVersion: 1.11.4` |
| `tests/secrets/ratel-secrets.test.ts` | 新建 | |
| `tests/ui/chat-send-gate.test.ts` | 修改 | |
| `tests/settings.test.ts` | 修改 | |
| `tests/settings-migration.test.ts` | 修改 | 删 Key 字段用例 |
| `tests/integration/settings-propagation.test.ts` | 修改 | mock secretStorage |
| `tests/core/feedback-controller.test.ts` | 修改 | getSettings 类型 |
| `docs/superpowers/STATUS.md` | 修改 | P-KEYCHAIN Pending |

**测试基线:** 实施前 `npm test` 记录通过数(当前约 232);每个 Task 后零回归。

**不在本 plan:** `RerankerApi` 适配器与 `search_vault` rerank 步骤(见 P-W4);本 plan 仅提供 `resolveRerankApiKey` 供后续接线。

---

## Task 1: ratel-secrets 核心模块

**Files:**
- Create: `src/secrets/ratel-secrets.ts`
- Create: `tests/secrets/ratel-secrets.test.ts`

- [ ] **Step 1.1: 写失败测试**

创建 `tests/secrets/ratel-secrets.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import {
	RATEL_SECRET_IDS,
	isLocalHost,
	classifyChatEndpoint,
	classifyEmbedEndpoint,
	requiresChatApiKey,
	requiresEmbedApiKey,
	resolveChatApiKey,
	hasChatApiKey,
	hasRerankApiKey,
} from '../../src/secrets/ratel-secrets';
import type { App } from 'obsidian';

function mockApp(secrets: Record<string, string | null>): App {
	return {
		secretStorage: {
			getSecret: (id: string) => secrets[id] ?? null,
		},
	} as unknown as App;
}

describe('ratel-secrets', () => {
	it('isLocalHost - localhost / 127.0.0.1', () => {
		expect(isLocalHost('http://localhost:11434/v1')).toBe(true);
		expect(isLocalHost('127.0.0.1:8080')).toBe(true);
		expect(isLocalHost('https://api.deepseek.com')).toBe(false);
	});

	it('Chat 远端 - 需要 openai-compatible 密钥', () => {
		expect(classifyChatEndpoint({ chatApiBase: 'https://api.deepseek.com' })).toBe('openai-compatible');
		expect(requiresChatApiKey({ chatApiBase: 'https://api.deepseek.com' })).toBe(true);
	});

	it('Chat localhost Ollama - 免 Key', () => {
		expect(classifyChatEndpoint({ chatApiBase: 'http://localhost:11434/v1' })).toBe('ollama-local');
		expect(requiresChatApiKey({ chatApiBase: 'http://localhost:11434/v1' })).toBe(false);
	});

	it('Embed local - builtin 免 Key', () => {
		expect(classifyEmbedEndpoint({ embedProvider: 'local', embedApiBase: '' })).toBe('builtin');
		expect(requiresEmbedApiKey({ embedProvider: 'local', embedApiBase: '' })).toBe(false);
	});

	it('Embed API 远端 - 需要密钥', () => {
		expect(
			classifyEmbedEndpoint({ embedProvider: 'api', embedApiBase: 'https://api.siliconflow.cn/v1' }),
		).toBe('openai-compatible');
		expect(requiresEmbedApiKey({ embedProvider: 'api', embedApiBase: 'https://api.siliconflow.cn/v1' })).toBe(
			true,
		);
	});

	it('resolveChatApiKey - 从钥匙串读取', () => {
		const app = mockApp({ [RATEL_SECRET_IDS.chatOpenAICompatible]: 'sk-test' });
		const key = resolveChatApiKey(app, { chatApiBase: 'https://api.deepseek.com' });
		expect(key).toBe('sk-test');
		expect(hasChatApiKey(app, { chatApiBase: 'https://api.deepseek.com' })).toBe(true);
	});

	it('hasRerankApiKey - 百炼', () => {
		const app = mockApp({ [RATEL_SECRET_IDS.rerankBailian]: 'dash-key' });
		expect(hasRerankApiKey(app)).toBe(true);
	});
});
```

- [ ] **Step 1.2: 跑测试确认失败**

Run: `npm test -- tests/secrets/ratel-secrets.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 1.3: 实现 ratel-secrets.ts**

创建 `src/secrets/ratel-secrets.ts`:

```typescript
/**
 * @file src/secrets/ratel-secrets.ts
 * @description Obsidian 钥匙串 API Key 解析 — 固定 ratel-* 密钥名 + 端点分类
 * @module secrets/ratel-secrets
 * @depends obsidian
 */

import type { App } from 'obsidian';

export const RATEL_SECRET_IDS = {
	chatOpenAICompatible: 'ratel-chat-openai-compatible',
	chatOllama: 'ratel-chat-ollama',
	embedOpenAICompatible: 'ratel-embed-openai-compatible',
	embedOllama: 'ratel-embed-ollama',
	rerankBailian: 'ratel-rerank-bailian',
} as const;

export type EndpointAuthKind = 'builtin' | 'ollama-local' | 'openai-compatible' | 'rerank-bailian';

export interface ChatSecretSettings {
	chatApiBase: string;
}

export interface EmbedSecretSettings {
	embedProvider: 'local' | 'api';
	embedApiBase: string;
}

/** 解析 hostname 是否为本地 Ollama — 缺协议时补 http:// */
export function isLocalHost(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl.includes('://') ? baseUrl : `http://${baseUrl}`);
		return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
	} catch {
		return false;
	}
}

export function classifyChatEndpoint(settings: ChatSecretSettings): EndpointAuthKind {
	return isLocalHost(settings.chatApiBase) ? 'ollama-local' : 'openai-compatible';
}

export function classifyEmbedEndpoint(settings: EmbedSecretSettings): EndpointAuthKind {
	if (settings.embedProvider === 'local') return 'builtin';
	if (isLocalHost(settings.embedApiBase)) return 'ollama-local';
	return 'openai-compatible';
}

export function requiresChatApiKey(settings: ChatSecretSettings): boolean {
	return classifyChatEndpoint(settings) === 'openai-compatible';
}

export function requiresEmbedApiKey(settings: EmbedSecretSettings): boolean {
	return classifyEmbedEndpoint(settings) === 'openai-compatible';
}

function getSecret(app: App, id: string): string | null {
	const value = app.secretStorage?.getSecret?.(id);
	return value && value.trim() ? value.trim() : null;
}

export function resolveChatApiKey(app: App, settings: ChatSecretSettings): string | null {
	if (!requiresChatApiKey(settings)) return null;
	return getSecret(app, RATEL_SECRET_IDS.chatOpenAICompatible);
}

export function hasChatApiKey(app: App, settings: ChatSecretSettings): boolean {
	return !requiresChatApiKey(settings) || !!resolveChatApiKey(app, settings);
}

export function resolveEmbedApiKey(app: App, settings: EmbedSecretSettings): string | null {
	if (!requiresEmbedApiKey(settings)) return null;
	return getSecret(app, RATEL_SECRET_IDS.embedOpenAICompatible);
}

export function hasEmbedApiKey(app: App, settings: EmbedSecretSettings): boolean {
	return !requiresEmbedApiKey(settings) || !!resolveEmbedApiKey(app, settings);
}

export function resolveRerankApiKey(app: App): string | null {
	return getSecret(app, RATEL_SECRET_IDS.rerankBailian);
}

export function hasRerankApiKey(app: App): boolean {
	return !!resolveRerankApiKey(app);
}

/** 设置页:当前上下文需要的密钥 ID,无需 Key 时返回 null */
export function getChatSecretId(settings: ChatSecretSettings): string | null {
	return requiresChatApiKey(settings) ? RATEL_SECRET_IDS.chatOpenAICompatible : null;
}

export function getEmbedSecretId(settings: EmbedSecretSettings): string | null {
	return requiresEmbedApiKey(settings) ? RATEL_SECRET_IDS.embedOpenAICompatible : null;
}

export function getRerankSecretId(): string {
	return RATEL_SECRET_IDS.rerankBailian;
}
```

- [ ] **Step 1.4: 跑测试确认通过**

Run: `npm test -- tests/secrets/ratel-secrets.test.ts`
Expected: PASS

- [ ] **Step 1.5: 提交**

```bash
git add src/secrets/ratel-secrets.ts tests/secrets/ratel-secrets.test.ts
git commit -m "feat(secrets): 新增 Obsidian 钥匙串 API Key 解析模块"
```

---

## Task 2: manifest minAppVersion

**Files:**
- Modify: `manifest.json`

- [ ] **Step 2.1: 更新 minAppVersion**

```json
"minAppVersion": "1.11.4"
```

- [ ] **Step 2.2: build 确认无破坏**

Run: `npm run build`
Expected: 0 errors

- [ ] **Step 2.3: 提交**

```bash
git add manifest.json
git commit -m "chore: minAppVersion 升至 1.11.4 以使用 SecretStorage"
```

---

## Task 3: settings 结构 + Rerank 百炼默认

**Files:**
- Modify: `src/settings.ts`
- Modify: `tests/settings.test.ts`
- Modify: `tests/settings-migration.test.ts`

- [ ] **Step 3.1: 更新 RatelVaultSettings**

删除字段:
- `chatApiKey`, `embedApiKey`, `rerankerApiKey`, `rerankerProvider`

更新 `DEFAULT_SETTINGS`:
```typescript
rerankerApiBase: 'https://dashscope.aliyuncs.com/compatible-api/v1',
rerankerModel: 'qwen3-rerank',
```

- [ ] **Step 3.2: 更新 tests/settings.test.ts**

- `REQUIRED_FIELDS` 去掉四个 Key/Provider 字段
- 删除 `expect(typeof DEFAULT_SETTINGS.chatApiKey)...` 等断言
- 断言 `DEFAULT_SETTINGS` 不含 `chatApiKey` / `embedApiKey` / `rerankerApiKey`

- [ ] **Step 3.3: 更新 tests/settings-migration.test.ts**

- `部分字段被 raw 覆盖` 用例改为 `chunkSize` 等非 Key 字段
- 删除 `chatApiKey: 'sk-test'` 相关断言

- [ ] **Step 3.4: 跑测试**

Run: `npm test -- tests/settings.test.ts tests/settings-migration.test.ts`
Expected: PASS (settings.ts 密码框暂留,仅类型变更可能仍编译 — 下一步删 UI)

- [ ] **Step 3.5: 提交**

```bash
git add src/settings.ts tests/settings.test.ts tests/settings-migration.test.ts
git commit -m "refactor(settings): 移除明文 API Key 字段,Rerank 默认百炼"
```

---

## Task 4: secret-hint 设置页 UI

**Files:**
- Create: `src/ui/secret-hint.ts`
- Modify: `src/settings.ts`

- [ ] **Step 4.1: 实现 renderSecretHint**

创建 `src/ui/secret-hint.ts`:

```typescript
import type { App } from 'obsidian';
import { Setting } from 'obsidian';
import { hasChatApiKey, hasEmbedApiKey, hasRerankApiKey } from '../secrets/ratel-secrets';

/** 需要钥匙串时 — 展示固定密钥名 + 状态 */
export function renderSecretHint(
	containerEl: HTMLElement,
	app: App,
	opts: { secretId: string; hasKey: boolean },
): void {
	new Setting(containerEl)
		.setName('API 密钥')
		.setDesc(
			`请在 Obsidian「设置 → 钥匙串」中添加名称为「${opts.secretId}」的密钥(名称必须完全一致)。` +
				'密钥不会写入插件配置,也不会随库同步到其他设备。',
		)
		.addExtraButton((btn) => {
			btn.setIcon('copy').setTooltip('复制密钥名').onClick(() => {
				void navigator.clipboard.writeText(opts.secretId);
			});
		});
	const status = containerEl.createDiv({ cls: 'ratel-secret-status' });
	status.setText(opts.hasKey ? '状态: ✅ 已配置' : '状态: ⚠️ 未配置');
}

/** 无需 Key 时 — 简短说明 */
export function renderNoKeyNeeded(containerEl: HTMLElement, message: string): void {
	new Setting(containerEl)
		.setName('API 密钥')
		.setDesc(message);
}
```

- [ ] **Step 4.2: settings.ts 替换三处密码框**

Chat 段 — `rebuildLLM` 的 onChange 保留在 Model/Base 上;删除 API Key `addText`:

```typescript
import { renderSecretHint, renderNoKeyNeeded } from './ui/secret-hint';
import {
	getChatSecretId,
	getEmbedSecretId,
	getRerankSecretId,
	hasChatApiKey,
	hasEmbedApiKey,
	hasRerankApiKey,
	requiresChatApiKey,
	requiresEmbedApiKey,
} from './secrets/ratel-secrets';

// Chat 段末尾:
const chatSecretId = getChatSecretId(this.plugin.settings);
if (chatSecretId) {
	renderSecretHint(containerEl, this.app, {
		secretId: chatSecretId,
		hasKey: hasChatApiKey(this.app, this.plugin.settings),
	});
} else {
	renderNoKeyNeeded(containerEl, '当前为本地 Ollama,无需 API Key。');
}

// Embed api 分支: 同理 getEmbedSecretId / hasEmbedApiKey
// Embed local 分支: renderNoKeyNeeded(..., '当前为内置本地 Embedding,无需 API Key。')

// Rerank 段: 删除 Provider 下拉与 API Key 框;保留 Base + Model;末尾:
renderSecretHint(containerEl, this.app, {
	secretId: getRerankSecretId(),
	hasKey: hasRerankApiKey(this.app),
});
// 补充 setDesc: 未配置密钥时 Rerank 自动关闭
```

Rerank 标题改为 `Reranker (百炼,可选)` 或等价中文。

- [ ] **Step 4.3: build + test**

Run: `npm run build && npm test`
Expected: 编译通过;若有失败来自 main/chat-send-gate 引用旧字段 — Task 5/6 修复

- [ ] **Step 4.4: 提交**

```bash
git add src/ui/secret-hint.ts src/settings.ts
git commit -m "feat(settings): 钥匙串说明块替代 API Key 密码框"
```

---

## Task 5: main.ts 运行时解析

**Files:**
- Modify: `src/main.ts`
- Modify: `tests/integration/settings-propagation.test.ts`

- [ ] **Step 5.1: rebuildLLM / rebuildEmbeddingAdapter 改用钥匙串**

```typescript
import { resolveChatApiKey, resolveEmbedApiKey } from './secrets/ratel-secrets';

rebuildLLM(): void {
	this.llm = new DeepSeekLLM({
		apiBase: this.settings.chatApiBase,
		apiKey: resolveChatApiKey(this.app, this.settings) ?? '',
		model: this.settings.chatModel,
	});
}

rebuildEmbeddingAdapter(): void {
	// ...
	this.embedding = new EmbeddingApi({
		apiBase: this.settings.embedApiBase,
		apiKey: resolveEmbedApiKey(this.app, this.settings) ?? '',
		// ...
	});
}
```

`onload` 内首次构造 LLM 处同样改为 `resolveChatApiKey`(若与 `rebuildLLM` 重复则统一调 `rebuildLLM()`)。

- [ ] **Step 5.2: 更新 settings-propagation 测试**

mock `plugin.app.secretStorage.getSecret`;测「钥匙串值变更 + rebuildLLM → config 含新 key」:

```typescript
const secrets: Record<string, string> = {};
const plugin = {
	app: { secretStorage: { getSecret: (id: string) => secrets[id] ?? null } },
	settings: { ...DEFAULT_SETTINGS },
	rebuildLLM() { /* 捕获 llm config */ },
};
secrets['ratel-chat-openai-compatible'] = 'sk-new';
plugin.rebuildLLM();
expect(capturedApiKey).toBe('sk-new');
```

删除对 `settings.chatApiKey` 赋值的用例;Embed 同理用 `ratel-embed-openai-compatible`。

- [ ] **Step 5.3: 跑相关测试**

Run: `npm test -- tests/integration/settings-propagation.test.ts`
Expected: PASS

- [ ] **Step 5.4: 提交**

```bash
git add src/main.ts tests/integration/settings-propagation.test.ts
git commit -m "feat(main): LLM/Embedding 从 Obsidian 钥匙串解析 API Key"
```

---

## Task 6: chat-send-gate + ChatView

**Files:**
- Modify: `src/ui/chat-send-gate.ts`
- Modify: `src/ui/ChatView.svelte`
- Modify: `tests/ui/chat-send-gate.test.ts`

- [ ] **Step 6.1: 更新 chat-send-gate**

```typescript
import { requiresChatApiKey, type ChatSecretSettings } from '../secrets/ratel-secrets';

export function evaluateChatSendGate(
	settings: ChatSecretSettings,
	status: UserStatusSnapshot,
	opts: { hasChatApiKey: boolean },
): ChatSendGateResult {
	if (requiresChatApiKey(settings) && !opts.hasChatApiKey) {
		return {
			canSend: false,
			hardBlockReason: '请先在 Obsidian 钥匙串配置 Chat API 密钥',
		};
	}
	// ... 软拦逻辑不变
}
```

- [ ] **Step 6.2: 更新测试**

```typescript
import { requiresChatApiKey } from '../../src/secrets/ratel-secrets';

it('OpenAI 兼容且无 Key - 硬拦', () => {
	const settings = { chatApiBase: 'https://api.deepseek.com' };
	const r = evaluateChatSendGate(settings, DEFAULT_USER_STATUS, { hasChatApiKey: false });
	expect(r.canSend).toBe(false);
	expect(r.hardBlockReason).toContain('钥匙串');
});

it('本地 Ollama 无 Key - 可发送', () => {
	const r = evaluateChatSendGate(
		{ chatApiBase: 'http://localhost:11434/v1' },
		DEFAULT_USER_STATUS,
		{ hasChatApiKey: false },
	);
	expect(r.canSend).toBe(true);
});
```

- [ ] **Step 6.3: ChatView.svelte**

```typescript
import { hasChatApiKey } from '../secrets/ratel-secrets';

$: hasKey = hasChatApiKey(plugin.app, plugin.settings);
$: gate = evaluateChatSendGate(plugin.settings, statusSnap, { hasChatApiKey: hasKey });
```

- [ ] **Step 6.4: 跑测试**

Run: `npm test -- tests/ui/chat-send-gate.test.ts`
Expected: PASS

- [ ] **Step 6.5: 提交**

```bash
git add src/ui/chat-send-gate.ts src/ui/ChatView.svelte tests/ui/chat-send-gate.test.ts
git commit -m "fix(chat): 发送门禁按端点类型判断,本地 Ollama 免 Key"
```

---

## Task 7: FeedbackController + 诊断页

**Files:**
- Modify: `src/core/feedback-controller.ts`
- Modify: `tests/core/feedback-controller.test.ts`
- Modify: `src/ui/diagnostics/llm-test.ts`
- Modify: `src/ui/diagnostics/embedding-test.ts`
- Modify: `src/ui/diagnostics/rerank-placeholder.ts`

- [ ] **Step 7.1: FeedbackController getSettings 类型**

```typescript
getSettings: () => { embedProvider: 'local' | 'api'; embedApiBase: string; chatApiBase: string };
```

`main.ts` 传入处去掉 Key 字段(若 body 未使用 Key 可不改逻辑)。

- [ ] **Step 7.2: llm-test.ts**

```typescript
import { hasChatApiKey, requiresChatApiKey } from '../../secrets/ratel-secrets';

// 运行前检查:
if (requiresChatApiKey(plugin.settings) && !hasChatApiKey(plugin.app, plugin.settings)) { /* 提示 */ }

// 状态行: 不展示 Key 前缀
const keyLabel = !requiresChatApiKey(s)
	? '本地服务(无 Key)'
	: hasChatApiKey(plugin.app, s) ? '已配置' : '未配置';
```

- [ ] **Step 7.3: embedding-test.ts**

用 `hasEmbedApiKey` / `requiresEmbedApiKey` 替换 `s.embedApiKey`。

- [ ] **Step 7.4: rerank-placeholder.ts**

```typescript
import { hasRerankApiKey, getRerankSecretId } from '../../secrets/ratel-secrets';

const enabled = hasRerankApiKey(plugin.app);
container.createSpan({
	text: `百炼 Rerank | Base: ${s.rerankerApiBase} | 模型: ${s.rerankerModel} | 密钥: ${getRerankSecretId()} | 状态: ${enabled ? '已配置' : '未配置(关闭)'}`,
});
```

- [ ] **Step 7.5: 跑测试 + build**

Run: `npm test -- tests/core/feedback-controller.test.ts && npm run build`
Expected: PASS

- [ ] **Step 7.6: 提交**

```bash
git add src/core/feedback-controller.ts tests/core/feedback-controller.test.ts \
  src/ui/diagnostics/llm-test.ts src/ui/diagnostics/embedding-test.ts src/ui/diagnostics/rerank-placeholder.ts
git commit -m "refactor: 诊断页与 FeedbackController 改用钥匙串 Key 状态"
```

---

## Task 8: 全量验收 + STATUS

**Files:**
- Modify: `docs/superpowers/STATUS.md`

- [ ] **Step 8.1: 全量 CI**

Run: `npm run build && npm test && npm run lint`
Expected: 全绿

- [ ] **Step 8.2: 手动 E2E 清单**

| # | 场景 | 预期 |
|---|------|------|
| 1 | 钥匙串 `ratel-chat-openai-compatible` | Chat 可发送 |
| 2 | 删除 Chat 密钥 | 硬拦,文案含「钥匙串」 |
| 3 | `chatApiBase` → localhost Ollama | 无密钥可 Chat |
| 4 | Embedding Local | 设置显示「无需 API Key」 |
| 5 | Embedding API 远端 | 提示 `ratel-embed-openai-compatible` |
| 6 | `ratel-rerank-bailian` | Rerank 段「已配置」 |
| 7 | 复制密钥名按钮 | 剪贴板为正确 `ratel-*` 名 |

- [ ] **Step 8.3: STATUS.md**

Plan 表增加:

```markdown
| P-KEYCHAIN | [2026-06-26-ratel-keychain.md](plans/2026-06-26-ratel-keychain.md) | ✅ Completed | main | YYYY-MM-DD | YYYY-MM-DD | S-KEYCHAIN |
```

实施前登记为 `⏳ Pending` / `In Progress`;验收后改 `Completed`。

- [ ] **Step 8.4: 提交**

```bash
git add docs/superpowers/STATUS.md
git commit -m "docs: P-KEYCHAIN 完成,登记 STATUS"
```

---

## 自审

1. **Spec 覆盖:**
   - 固定 `ratel-*` 密钥名 → Task 1
   - 三类端点 + 百炼 Rerank → Task 1, 3, 4
   - 删明文 Key → Task 3, 5
   - 设置 hint UI → Task 4
   - chat-send-gate 本地 Ollama → Task 6
   - 诊断页不泄露 Key → Task 7
   - minAppVersion → Task 2

2. **Placeholder:** 无 TBD;`chatOllama` / `embedOllama` ID 在代码中保留常量,v1 不读取。

3. **依赖方向:** `secrets/*` ⊥ `user-feedback/*`;`secret-hint` 可 import `secrets`。

4. **与 P-W4 边界:** `resolveRerankApiKey` 已就绪;`main.ts` 初始化 `RerankerApi` 留给 P-W4 调用同一函数。

5. **架构文档:** `docs/architecture/host/settings.md` 等含旧 `rerankerProvider` 描述 — 本 plan 不强制同步(可 follow-up docs PR)。

---

## 执行建议

推荐 **Subagent-Driven**: Task 1 → 2 → 3 顺序执行;Task 4 依赖 3;Task 5–7 可部分并行;Task 8 最后。

每个 Task 独立 commit,便于 bisect。
