# S-CONTEXT-ACCURACY 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让上下文百分比可信：流式请求显式要 usage，真值用各步合计，上限跟随模型，界面分清估算与真值。

**Architecture:** 请求体加 `stream_options`；`message.end` 真值优先用 step 合计；换模型/切配置共用一段「按映射表写上限」；状态抽屉标注来源。

**Tech Stack:** TypeScript strict、vitest、Svelte 5（StatusDrawer）、Obsidian `requestUrl`。

**Spec:** [2026-09-24-context-accuracy-design.md](../specs/2026-09-24-context-accuracy-design.md)

## Global Constraints

- 所有新用户可见字符串走 `src/i18n/zh.ts` + `en.ts` + `types.ts`，代码里调 `tNow`，不写字面量。
- 注释中文；`it(...)` 描述中文「行为 - 条件 - 期望」。
- 不写本机绝对路径；测试用 `/Users/alice/Notes` 或 `http://test`。
- 不引入分词器依赖；估算仍是估算。
- 不改 85% 压缩阈值。
- TDD：每个 Task 先写失败测试，再实现。

---

### Task 1: 流式请求带 `stream_options.include_usage`

**Files:**
- Modify: `src/adapters/llm-openai-compat.ts`（`buildRequestBody`，约 522 行）
- Test: `tests/adapters/llm-openai-compat.test.ts`

**Interfaces:**
- Consumes: 现有 `buildRequestBody(req): Record<string, unknown>`
- Produces: 请求体含 `stream_options: { include_usage: true }`；`ChatView` 不直接消费本 Task

- [ ] **Step 1: 写失败测试**

在 `tests/adapters/llm-openai-compat.test.ts` 的 `describe('OpenAICompatLLM')` 内追加：

```typescript
it('buildRequestBody - 流式请求 - 上送 stream_options.include_usage', () => {
	const adapter = new OpenAICompatLLM({ apiBase: 'http://test', apiKey: 'sk-test', model: 'test' });
	const req: ChatRequest = { messages: [{ role: 'user', content: 'hi' }] };
	const body = (adapter as unknown as { buildRequestBody: (req: ChatRequest) => Record<string, unknown> }).buildRequestBody(req);
	expect(body.stream).toBe(true);
	expect(body.stream_options).toEqual({ include_usage: true });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/adapters/llm-openai-compat.test.ts -t include_usage`
Expected: FAIL（`stream_options` 为 undefined）

- [ ] **Step 3: 实现**

`src/adapters/llm-openai-compat.ts` `buildRequestBody` 的 body 字面量（约 522 行）：

```typescript
	const body: Record<string, unknown> = {
		model: this.config.model,
		messages,
		stream: true,
		// 关键路径:显式要 usage — DeepSeek 等端点默认不在流末尾返回 token 统计
		stream_options: { include_usage: true },
	};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/adapters/llm-openai-compat.test.ts`
Expected: PASS（含既有用例，确认无回归）

- [ ] **Step 5: Commit**

```bash
git add src/adapters/llm-openai-compat.ts tests/adapters/llm-openai-compat.test.ts
git commit -m "feat: 流式请求显式要 usage，端点支持时返回真值 token"
```

---

### Task 2: 真值写回改用各步合计

**Files:**
- Modify: `src/ui/chat/ChatView.svelte`（`message.end` 分支，约 1558 行）
- Test: `tests/ui/chat/context-usage-writeback.test.ts`（新建）

**Interfaces:**
- Consumes: `AgentEvent` 的 `message.end.payload`（`promptTokens` / `completionTokens` / `stepPromptTokens` / `stepCompletionTokens`，见 `src/types.ts`）
- Produces: 纯函数 `resolveApiUsedTokens(payload): number | undefined`，供 ChatView 与测试共用

- [ ] **Step 1: 写失败测试**

新建 `tests/ui/chat/context-usage-writeback.test.ts`：

```typescript
/**
 * @file tests/ui/chat/context-usage-writeback.test.ts
 * @description message.end 真值写回 — step 合计优先于单步
 * @module tests/ui/chat/context-usage-writeback
 */
import { describe, it, expect } from 'vitest';
import { resolveApiUsedTokens } from '../../../src/ui/chat/context-usage-writeback';

describe('resolveApiUsedTokens', () => {
	it('有 step 合计 - 用各步输入输出合计', () => {
		expect(
			resolveApiUsedTokens({
				tokens: 0,
				promptTokens: 9000,
				completionTokens: 100,
				stepPromptTokens: 30000,
				stepCompletionTokens: 400,
			}),
		).toBe(30400);
	});

	it('无 step 合计 - 回退单步 prompt+completion', () => {
		expect(
			resolveApiUsedTokens({ tokens: 0, promptTokens: 1200, completionTokens: 80 }),
		).toBe(1280);
	});

	it('无任何 usage - 返回 undefined 保留估算', () => {
		expect(resolveApiUsedTokens({ tokens: 0 })).toBeUndefined();
	});
});
```

新建 `src/ui/chat/context-usage-writeback.ts`（先放空实现让测试失败）：

```typescript
/**
 * @file src/ui/chat/context-usage-writeback.ts
 * @description message.end 真值 token 取舍 — step 合计优先
 * @module ui/chat/context-usage-writeback
 */

/** message.end payload 的最小形状 */
export type MessageEndPayload = {
	tokens: number;
	promptTokens?: number;
	completionTokens?: number;
	stepPromptTokens?: number;
	stepCompletionTokens?: number;
};

/**
 * 从 message.end 取本轮真值 token。多步工具调用时各步输入都含完整历史,
 * 取最后一步会虚高;优先用各步合计。
 *
 * @param payload - message.end 的 payload
 * @returns 真值 token;无任何 usage 时返回 undefined(调用方保留估算)
 */
export function resolveApiUsedTokens(payload: MessageEndPayload): number | undefined {
	if (payload.stepPromptTokens != null && payload.stepCompletionTokens != null) {
		return payload.stepPromptTokens + payload.stepCompletionTokens;
	}
	if (payload.promptTokens != null && payload.completionTokens != null) {
		return payload.promptTokens + payload.completionTokens;
	}
	return undefined;
}
```

- [ ] **Step 2: 跑测试确认通过（纯函数一次写对）**

Run: `npx vitest run tests/ui/chat/context-usage-writeback.test.ts`
Expected: PASS

- [ ] **Step 3: ChatView 接入**

`src/ui/chat/ChatView.svelte` 顶部 import 区加：

```typescript
import { resolveApiUsedTokens } from './context-usage-writeback';
```

`message.end` 分支（约 1558 行）改为：

```typescript
				case 'message.end':
					// 第 3 层:API 真值校准 — 多步工具调用用各步合计,不用最后一步
					const apiUsed = resolveApiUsedTokens(event.payload);
					if (apiUsed != null) {
						lastTurnApiTokens = apiUsed;
						am.tokenUsage = {
							promptTokens: event.payload.stepPromptTokens ?? event.payload.promptTokens ?? 0,
							completionTokens: event.payload.stepCompletionTokens ?? event.payload.completionTokens ?? 0,
						};
						plugin.userStatus.patchContextUsage({
							usedTokens: apiUsed,
							maxTokens: getEffectiveChatModelMaxTokens(plugin.settings),
							source: 'api',
						});
					}
					sessionDirty = true;
```

（删除原 `if (event.payload.promptTokens && event.payload.completionTokens)` 块。）

- [ ] **Step 4: 跑相关测试**

Run: `npx vitest run tests/ui/chat/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/chat/context-usage-writeback.ts src/ui/chat/ChatView.svelte tests/ui/chat/context-usage-writeback.test.ts
git commit -m "fix: 上下文真值用各步合计，不再取最后一步虚高值"
```

---

### Task 3: 状态抽屉标注估算 / API

**Files:**
- Modify: `src/ui/status/StatusDrawer.svelte`（约 143 行）
- Modify: `src/i18n/types.ts`、`src/i18n/zh.ts`、`src/i18n/en.ts`
- Test: 无需新测试（纯展示）；跑 `src/i18n/strings.test.ts` 保证 key 对齐

**Interfaces:**
- Consumes: `ContextUsage.source`（`src/user-feedback/user-status.ts`，已有 `'estimate' | 'streaming' | 'api'`）
- Produces: i18n key `status.drawer.contextSource.estimate` / `status.drawer.contextSource.api`

- [ ] **Step 1: 加 i18n key**

`src/i18n/types.ts` 在 `StatusStrings`（或对应 namespace）加：

```typescript
  'status.drawer.contextSource.estimate': string;
  'status.drawer.contextSource.api': string;
```

`src/i18n/zh.ts`：

```typescript
  'status.drawer.contextSource.estimate': '估算',
  'status.drawer.contextSource.api': 'API',
```

`src/i18n/en.ts`：

```typescript
  'status.drawer.contextSource.estimate': 'estimate',
  'status.drawer.contextSource.api': 'API',
```

- [ ] **Step 2: 跑 i18n 对齐测试**

Run: `npx vitest run src/i18n/strings.test.ts`
Expected: PASS

- [ ] **Step 3: StatusDrawer 展示**

`src/ui/status/StatusDrawer.svelte` 约 143 行，usedMax 行改为：

```svelte
		<div class="ratel-drawer-row">
			<span class="ratel-drawer-label">{$t('status.drawer.label.usedMax')}</span>
			<span class="ratel-drawer-value ratel-drawer-mono">
				{usage.usedTokens.toLocaleString()} / {usage.maxTokens.toLocaleString()} tokens
				· {usage.source === 'api' ? $t('status.drawer.contextSource.api') : $t('status.drawer.contextSource.estimate')}
			</span>
		</div>
```

- [ ] **Step 4: 构建确认无类型错**

Run: `node esbuild.config.mjs production`
Expected: 构建成功（17 条既有 Svelte warning 不新增）

- [ ] **Step 5: Commit**

```bash
git add src/ui/status/StatusDrawer.svelte src/i18n/types.ts src/i18n/zh.ts src/i18n/en.ts
git commit -m "feat: 状态抽屉标注上下文占用是估算还是 API 真值"
```

---

### Task 4: 换模型更新上限（共用 helper）

**Files:**
- Create: `src/ui/tokens/apply-model-context.ts`
- Modify: `src/settings/settings-apply.ts`（`chatModel` 分支）
- Test: `tests/ui/tokens/apply-model-context.test.ts`（新建）

**Interfaces:**
- Consumes: `ModelContextRegistry.lookupContextLength`（`src/ui/tokens/model-context-registry.ts`）、`applyContextRecommendation`（`src/ui/tokens/context-length-presets.ts`）
- Produces: `applyModelContextWindow(deps): Promise<{ applied: boolean; tokens?: number }>`，S-CHAT-PROFILES 切换配置时复用同一函数

- [ ] **Step 1: 写失败测试**

新建 `tests/ui/tokens/apply-model-context.test.ts`：

```typescript
/**
 * @file tests/ui/tokens/apply-model-context.test.ts
 * @description 换模型更新上下文上限 — 查到写入,查不到保留并报未命中
 * @module tests/ui/tokens/apply-model-context
 */
import { describe, it, expect } from 'vitest';
import { applyModelContextWindow } from '../../../src/ui/tokens/apply-model-context';

function fakeRegistry(hit: number | undefined) {
	return {
		ensureRegistry: async () => ({}),
		lookupContextLength: () => hit,
	};
}

describe('applyModelContextWindow', () => {
	it('映射表命中 - 写入推荐上限', async () => {
		const settings = { contextLengthPreset: '256k' as const, chatModelMaxTokens: 256_000 };
		const result = await applyModelContextWindow({
			model: 'deepseek-v4-flash',
			registry: fakeRegistry(128_000),
			registryUrl: 'http://test/registry.json',
			settings,
		});
		expect(result).toEqual({ applied: true, tokens: 128_000 });
		expect(settings.chatModelMaxTokens).toBe(128_000);
		expect(settings.contextLengthPreset).toBe('128k');
	});

	it('映射表未命中 - 保留旧值并报未命中', async () => {
		const settings = { contextLengthPreset: '256k' as const, chatModelMaxTokens: 256_000 };
		const result = await applyModelContextWindow({
			model: 'unknown-model',
			registry: fakeRegistry(undefined),
			registryUrl: 'http://test/registry.json',
			settings,
		});
		expect(result).toEqual({ applied: false });
		expect(settings.chatModelMaxTokens).toBe(256_000);
	});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ui/tokens/apply-model-context.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 helper**

新建 `src/ui/tokens/apply-model-context.ts`：

```typescript
/**
 * @file src/ui/tokens/apply-model-context.ts
 * @description 换模型时按映射表写上下文上限 — 设置与多配置切换共用
 * @module ui/tokens/apply-model-context
 * @depends ./model-context-registry, ./context-length-presets
 */

import { applyContextRecommendation } from './context-length-presets';
import type { ContextLengthPresetId } from './context-length-presets';

/** 写入目标 — 当前 settings 或某一套 profile,结构一致即可 */
export type ModelContextTarget = {
	contextLengthPreset: ContextLengthPresetId;
	chatModelMaxTokens: number;
};

/** 映射表最小接口 — 与 ModelContextRegistry 结构兼容,测试用 mock */
export type ModelContextLookup = {
	ensureRegistry(url: string): Promise<unknown>;
	lookupContextLength(model: string, map: unknown): number | undefined;
};

/**
 * 按模型名查映射表并写入上限。查不到保留旧值,由调用方决定是否提示。
 *
 * @param deps.model - 模型标识
 * @param deps.registry - 映射表注册中心
 * @param deps.registryUrl - 映射表 URL(空串时调用方传默认)
 * @param deps.settings - 写入目标(当前 settings 或一套 profile)
 * @returns applied=true 且带 tokens 表示已写入;applied=false 表示未命中
 */
export async function applyModelContextWindow(deps: {
	model: string;
	registry: ModelContextLookup;
	registryUrl: string;
	settings: ModelContextTarget;
}): Promise<{ applied: boolean; tokens?: number }> {
	const map = await deps.registry.ensureRegistry(deps.registryUrl);
	const tokens = map != null ? deps.registry.lookupContextLength(deps.model, map) : undefined;
	if (tokens == null) return { applied: false };
	const applied = applyContextRecommendation(tokens);
	deps.settings.contextLengthPreset = applied.preset;
	deps.settings.chatModelMaxTokens = applied.chatModelMaxTokens;
	return { applied: true, tokens };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/ui/tokens/apply-model-context.test.ts`
Expected: PASS

- [ ] **Step 5: settings-apply 在改模型时调用**

`src/settings/settings-apply.ts` 的 `SettingApplier` 接口加可选回调：

```typescript
	/** 改模型后按映射表写上限;未命中时由宿主决定提示 */
	applyModelContextWindow?(model: string): Promise<{ applied: boolean; tokens?: number }>;
```

`applySettingValue` 改为 `async`，在末尾（`chatModel` 写入后）加：

```typescript
	// 关键路径:改模型后上限跟着变;查不到保留旧值,Notice 由调用方发
	if (key === 'chatModel' && plugin.applyModelContextWindow) {
		await plugin.applyModelContextWindow(String(value));
	}
```

`applySettingValue` 签名改为 `Promise<void>`；两个调用点（`settings.ts` 的 `setControlValue`、`tools/update-app-config.ts`）相应 `await`。`settings.ts` 的 `setControlValue` 内部实现 `applyModelContextWindow`：调 `probeChatConnection` 同款 registry（`this.plugin.modelContextRegistry` + `DEFAULT_MODEL_REGISTRY_URL` 回退），未命中时 `new Notice(tNow('settings.notice.contextLengthUnknown', { model }))`。

i18n 加 `settings.notice.contextLengthUnknown`（zh：「未查到 {model} 的上下文窗口，沿用当前上限」；en：'No context window found for {model}; keeping the current limit'），并登记 `types.ts`。

- [ ] **Step 6: 跑设置与工具测试**

Run: `npx vitest run tests/settings/ tests/integration/settings-propagation.test.ts src/i18n/strings.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/ui/tokens/apply-model-context.ts src/settings/settings-apply.ts src/settings.ts src/tools/update-app-config.ts src/i18n/ tests/ui/tokens/apply-model-context.test.ts
git commit -m "feat: 改模型后按映射表更新上下文上限，查不到给提示"
```

---

## 自审

- **Spec 覆盖：** CA-01 → Task 1；CA-02 → Task 2；CA-03 → Task 3；CA-04 / CA-05 → Task 4（上限写入 + `saveSettings` 已有 `patchContextUsage({ maxTokens })` 重算）。
- **占位符：** 无 TBD / TODO；每个 Task 含完整代码与命令。
- **类型一致：** `resolveApiUsedTokens` 的 payload 形状与 `src/types.ts` 的 `message.end` 对齐；`applyModelContextWindow` 的 `ModelContextTarget` 与 settings / 未来 profile 字段名一致。
- **与 S-CHAT-PROFILES 共用：** Task 4 的 helper 即两份 spec 约定的同一段逻辑，profiles plan 直接 import，不复制。
