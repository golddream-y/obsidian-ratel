# S-CONTEXT-WINDOW 实施计划(LiteLLM 映射表 + Context Length 预设下拉)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 LiteLLM 公开映射表(可配置 URL + pluginDir 缓存)为「测试连接」提供 context 推荐;设置面板改为 128k/200k/256k/1M/自定义下拉;修复钥匙串 Key 未参与探测;默认 256k 消除 StatusLine 死区。

**Architecture:** `context-length-presets.ts` 管预设常量与推荐写入;`ModelContextRegistry` 懒拉取 jsDelivr JSON(TTL 7d,原子写缓存);`probeChatConnection` 只验 LLM 连通性并调 registry 查 `max_input_tokens`;`normalizeContextLengthSettings` 在 `loadSettings` 迁移旧 data.json。

**Tech Stack:** TypeScript(strict)、vitest、Obsidian `requestUrl`/`PluginSettingTab.addDropdown`、`node:fs/promises` 缓存。

**所属 Spec:** [S-CONTEXT-WINDOW](../specs/2026-06-28-model-context-window-registry-design.md)

**关联 ADR:** [ADR-007](../../adr/2026-06-28-model-context-window-registry.md)

**建议分支:** `feat/s-context-window`

---

## 文件结构

### 新建(4)

| 文件 | 职责 |
|------|------|
| `src/ui/tokens/context-length-presets.ts` | 预设枚举、token 互转、`applyContextRecommendation` |
| `src/ui/tokens/model-context-registry.ts` | LiteLLM JSON 拉取/缓存/`lookupContextLength` |
| `tests/ui/tokens/context-length-presets.test.ts` | 预设与推荐逻辑 |
| `tests/ui/tokens/model-context-registry.test.ts` | lookup + TTL 缓存 |

### 修改(11)

| 文件 | 改动 |
|------|------|
| `src/ui/tokens/probe-model.ts` | 重写为 `probeChatConnection`;删除 `MODEL_CONTEXT_MAP` |
| `tests/ui/tokens/probe-model.test.ts` | 对齐新 API + registry mock |
| `src/settings.ts` | 新字段、迁移、`normalizeContextLengthSettings`、UI 下拉/自定义/URL |
| `src/main.ts` | 挂载 `modelContextRegistry`;`loadSettings` 调 normalize |
| `src/utils/context-window.ts` | 删除 32k 回退;用预设兜底 |
| `src/utils/gitignore-writer.ts` | 忽略 `model-context-registry*.json` |
| `tests/settings-migration.test.ts` | context length 迁移用例 |
| `docs/architecture/agent/chat.md` | §5.6 重写 |
| `docs/user-guide.md` | Context Length 文案(中英) |
| `docs/superpowers/STATUS.md` | 登记 P-CONTEXT-WINDOW |
| `src/ui/chat/ChatView.svelte` | 更新 context 相关注释 |

---

## 执行顺序与依赖

```
Task 1 context-length-presets ──┬── Task 4 settings schema + main
Task 2 model-context-registry ──┼── Task 3 probe-model (依赖 Task 2)
                                └── Task 5 settings UI (依赖 1,3,4)
Task 6 context-window + ChatView 注释 (依赖 Task 4)
Task 7 文档 (依赖 Task 5)
```

---

### Task 1: Context Length 预设模块

**Files:**
- Create: `src/ui/tokens/context-length-presets.ts`
- Create: `tests/ui/tokens/context-length-presets.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
/**
 * @file tests/ui/tokens/context-length-presets.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
	CONTEXT_LENGTH_PRESETS,
	presetToTokens,
	tokensToPreset,
	applyContextRecommendation,
} from '../../../src/ui/tokens/context-length-presets';

describe('context-length-presets', () => {
	it('presetToTokens - 256k', () => {
		expect(presetToTokens('256k')).toBe(256_000);
	});

	it('tokensToPreset - 精确命中 128k', () => {
		expect(tokensToPreset(128_000)).toBe('128k');
	});

	it('tokensToPreset - 非预设值返回 custom', () => {
		expect(tokensToPreset(131_072)).toBe('custom');
	});

	it('applyContextRecommendation - 131072 映射为 custom', () => {
		const r = applyContextRecommendation(131_072);
		expect(r.preset).toBe('custom');
		expect(r.chatModelMaxTokens).toBe(131_072);
	});

	it('applyContextRecommendation - 200000 映射为 200k', () => {
		const r = applyContextRecommendation(200_000);
		expect(r.preset).toBe('200k');
		expect(r.chatModelMaxTokens).toBe(200_000);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ui/tokens/context-length-presets.test.ts`

Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```typescript
/**
 * @file src/ui/tokens/context-length-presets.ts
 * @description Context Length 预设常量与互转 — 见 ADR-007 / S-CONTEXT-WINDOW
 * @module ui/tokens/context-length-presets
 */

export type ContextLengthPresetId = '128k' | '200k' | '256k' | '1M' | 'custom';

export const CONTEXT_LENGTH_PRESETS = {
	'128k': 128_000,
	'200k': 200_000,
	'256k': 256_000,
	'1M': 1_048_576,
} as const;

export const DEFAULT_CONTEXT_LENGTH_PRESET: Exclude<ContextLengthPresetId, 'custom'> = '256k';

export const CUSTOM_TOKEN_MIN = 4_096;
export const CUSTOM_TOKEN_MAX = 10_485_760;

export function presetToTokens(id: Exclude<ContextLengthPresetId, 'custom'>): number {
	return CONTEXT_LENGTH_PRESETS[id];
}

export function tokensToPreset(tokens: number): ContextLengthPresetId {
	for (const [id, value] of Object.entries(CONTEXT_LENGTH_PRESETS)) {
		if (tokens === value) {
			return id as Exclude<ContextLengthPresetId, 'custom'>;
		}
	}
	return 'custom';
}

export function applyContextRecommendation(tokens: number): {
	preset: ContextLengthPresetId;
	chatModelMaxTokens: number;
} {
	const preset = tokensToPreset(tokens);
	return { preset, chatModelMaxTokens: tokens };
}

/**
 * 从 chatModelMaxTokens 推断 preset(用于 loadSettings 迁移)。
 */
export function inferPresetFromTokens(
	tokens: number | undefined,
): { preset: ContextLengthPresetId; chatModelMaxTokens: number } {
	if (tokens == null || tokens <= 0) {
		return {
			preset: DEFAULT_CONTEXT_LENGTH_PRESET,
			chatModelMaxTokens: presetToTokens(DEFAULT_CONTEXT_LENGTH_PRESET),
		};
	}
	const preset = tokensToPreset(tokens);
	return { preset, chatModelMaxTokens: tokens };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ui/tokens/context-length-presets.test.ts`

Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/ui/tokens/context-length-presets.ts tests/ui/tokens/context-length-presets.test.ts
git commit -m "feat(tokens): 新增 Context Length 预设模块

128k/200k/256k/1M 常量与 applyContextRecommendation,供设置面板与测试连接推荐使用。"
```

---

### Task 2: LiteLLM 映射表 Registry

**Files:**
- Create: `src/ui/tokens/model-context-registry.ts`
- Create: `tests/ui/tokens/model-context-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
/**
 * @file tests/ui/tokens/model-context-registry.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
	ModelContextRegistry,
	lookupContextLengthInRegistry,
	REGISTRY_CACHE_FILENAME,
	REGISTRY_META_FILENAME,
} from '../../src/ui/tokens/model-context-registry';

const SAMPLE_REGISTRY = {
	sample_spec: { max_input_tokens: 1 },
	'deepseek-chat': { max_input_tokens: 131_072 },
	'deepseek/deepseek-chat': { max_input_tokens: 131_072 },
	'openai/gpt-4o': { max_input_tokens: 128_000 },
};

describe('lookupContextLengthInRegistry', () => {
	it('精确匹配 deepseek-chat', () => {
		expect(lookupContextLengthInRegistry('deepseek-chat', SAMPLE_REGISTRY)).toBe(131_072);
	});

	it('后缀匹配 deepseek/deepseek-chat', () => {
		expect(lookupContextLengthInRegistry('deepseek-chat', SAMPLE_REGISTRY)).toBe(131_072);
	});

	it('未命中返回 undefined', () => {
		expect(lookupContextLengthInRegistry('unknown', SAMPLE_REGISTRY)).toBeUndefined();
	});

	it('跳过 sample_spec', () => {
		expect(lookupContextLengthInRegistry('sample_spec', SAMPLE_REGISTRY)).toBeUndefined();
	});
});

describe('ModelContextRegistry', () => {
	let tmpDir: string;
	const mockRequestUrl = vi.fn();

	beforeEach(async () => {
		tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ratel-registry-'));
		mockRequestUrl.mockReset();
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('ensureRegistry - 缓存未过期时跳过网络', async () => {
		const meta = {
			fetchedAt: Date.now(),
			sourceUrl: 'https://example.com/map.json',
			modelCount: 2,
		};
		await writeFile(
			path.join(tmpDir, REGISTRY_CACHE_FILENAME),
			JSON.stringify(SAMPLE_REGISTRY),
			'utf-8',
		);
		await writeFile(
			path.join(tmpDir, REGISTRY_META_FILENAME),
			JSON.stringify(meta),
			'utf-8',
		);

		const registry = new ModelContextRegistry(tmpDir, mockRequestUrl);
		const map = await registry.ensureRegistry('https://example.com/map.json');
		expect(mockRequestUrl).not.toHaveBeenCalled();
		expect(map?.['deepseek-chat']?.max_input_tokens).toBe(131_072);
	});

	it('ensureRegistry - 拉取成功并写入缓存', async () => {
		mockRequestUrl.mockResolvedValueOnce({
			status: 200,
			text: JSON.stringify(SAMPLE_REGISTRY),
		});

		const registry = new ModelContextRegistry(tmpDir, mockRequestUrl);
		const map = await registry.ensureRegistry('https://example.com/map.json');
		expect(map).not.toBeNull();
		expect(lookupContextLengthInRegistry('gpt-4o', map!)).toBe(128_000);

		const cached = await readFile(path.join(tmpDir, REGISTRY_CACHE_FILENAME), 'utf-8');
		expect(JSON.parse(cached)['deepseek-chat']).toBeDefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ui/tokens/model-context-registry.test.ts`

Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

创建 `src/ui/tokens/model-context-registry.ts`,核心内容:

```typescript
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from 'obsidian';
import { devLogger } from '../../logging/dev-logger';

export const MODEL_REGISTRY_DOC_URL =
	'https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json';

export const DEFAULT_MODEL_REGISTRY_URL =
	'https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json';

export const FALLBACK_MODEL_REGISTRY_URL =
	'https://cdn.jsdelivr.net/gh/BerriAI/litellm@v1.65.4-stable/model_prices_and_context_window.json';

export const REGISTRY_CACHE_FILENAME = 'model-context-registry.json';
export const REGISTRY_META_FILENAME = 'model-context-registry.meta.json';

const REGISTRY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REGISTRY_MAX_BYTES = 3 * 1024 * 1024;

export type LiteLLMModelEntry = {
	max_input_tokens?: number;
	max_tokens?: number;
};

export type LiteLLMModelMap = Record<string, LiteLLMModelEntry>;

export type RegistryMeta = {
	fetchedAt: number;
	sourceUrl: string;
	modelCount: number;
};

type RequestUrlFn = (request: RequestUrlParam) => Promise<RequestUrlResponse>;

function readEntryTokens(entry: LiteLLMModelEntry | undefined): number | undefined {
	if (!entry) return undefined;
	const n = entry.max_input_tokens ?? entry.max_tokens;
	return typeof n === 'number' && n > 0 ? n : undefined;
}

/** 纯函数 lookup — 便于单测 */
export function lookupContextLengthInRegistry(
	model: string,
	registry: LiteLLMModelMap,
): number | undefined {
	const trimmed = model.trim();
	if (!trimmed || trimmed === 'sample_spec') return undefined;
	const lower = trimmed.toLowerCase();

	const direct = registry[trimmed] ?? registry[lower];
	const directTokens = readEntryTokens(direct);
	if (directTokens != null) return directTokens;

	let suffixBest: number | undefined;
	let prefixBestKey = '';
	let prefixBestTokens: number | undefined;

	for (const [key, entry] of Object.entries(registry)) {
		if (key === 'sample_spec') continue;
		const keyLower = key.toLowerCase();
		if (keyLower === lower || keyLower.endsWith(`/${lower}`)) {
			const t = readEntryTokens(entry);
			if (t != null) suffixBest = t;
		}
		if (keyLower.includes('/') && lower.startsWith(keyLower)) {
			if (keyLower.length > prefixBestKey.length) {
				const t = readEntryTokens(entry);
				if (t != null) {
					prefixBestKey = keyLower;
					prefixBestTokens = t;
				}
			}
		}
	}

	return suffixBest ?? prefixBestTokens;
}

export class ModelContextRegistry {
	constructor(
		private pluginDir: string,
		private fetchFn: RequestUrlFn = requestUrl,
	) {}

	private cachePath(): string {
		return path.join(this.pluginDir, REGISTRY_CACHE_FILENAME);
	}

	private metaPath(): string {
		return path.join(this.pluginDir, REGISTRY_META_FILENAME);
	}

	async ensureRegistry(sourceUrl: string): Promise<LiteLLMModelMap | null> {
		const cached = await this.readCacheIfFresh(sourceUrl);
		if (cached) return cached;

		const isDefaultSource =
			sourceUrl === DEFAULT_MODEL_REGISTRY_URL || sourceUrl === FALLBACK_MODEL_REGISTRY_URL;

		let map = await this.fetchAndParse(sourceUrl);
		if (!map && isDefaultSource && sourceUrl !== FALLBACK_MODEL_REGISTRY_URL) {
			map = await this.fetchAndParse(FALLBACK_MODEL_REGISTRY_URL);
			if (map) {
				await this.writeCache(map, FALLBACK_MODEL_REGISTRY_URL);
				return map;
			}
		}
		if (map) {
			await this.writeCache(map, sourceUrl);
			return map;
		}

		const stale = await this.readCacheIgnoringTtl();
		if (stale) {
			devLogger.warn('tokens', '映射表拉取失败,使用过期缓存');
			return stale;
		}
		return null;
	}

	lookupContextLength(model: string, registry: LiteLLMModelMap): number | undefined {
		return lookupContextLengthInRegistry(model, registry);
	}

	private async readCacheIfFresh(sourceUrl: string): Promise<LiteLLMModelMap | null> {
		try {
			const [raw, metaRaw] = await Promise.all([
				readFile(this.cachePath(), 'utf-8'),
				readFile(this.metaPath(), 'utf-8'),
			]);
			const meta = JSON.parse(metaRaw) as RegistryMeta;
			if (meta.sourceUrl !== sourceUrl) return null;
			if (Date.now() - meta.fetchedAt > REGISTRY_TTL_MS) return null;
			return JSON.parse(raw) as LiteLLMModelMap;
		} catch {
			return null;
		}
	}

	private async readCacheIgnoringTtl(): Promise<LiteLLMModelMap | null> {
		try {
			const raw = await readFile(this.cachePath(), 'utf-8');
			return JSON.parse(raw) as LiteLLMModelMap;
		} catch {
			return null;
		}
	}

	private async fetchAndParse(url: string): Promise<LiteLLMModelMap | null> {
		try {
			const response = await this.fetchFn({ url, method: 'GET', throw: false });
			if (response.status < 200 || response.status >= 300) {
				devLogger.warn('tokens', `映射表 HTTP ${response.status}: ${url}`);
				return null;
			}
			const text = response.text;
			if (text.length > REGISTRY_MAX_BYTES) {
				devLogger.warn('tokens', `映射表过大(${text.length} bytes),丢弃: ${url}`);
				return null;
			}
			const parsed = JSON.parse(text) as unknown;
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				return null;
			}
			return parsed as LiteLLMModelMap;
		} catch (err) {
			devLogger.warn('tokens', '映射表拉取/解析失败', err);
			return null;
		}
	}

	private async writeCache(map: LiteLLMModelMap, sourceUrl: string): Promise<void> {
		await mkdir(this.pluginDir, { recursive: true });
		const body = JSON.stringify(map);
		const tmp = `${this.cachePath()}.tmp`;
		const metaTmp = `${this.metaPath()}.tmp`;
		const meta: RegistryMeta = {
			fetchedAt: Date.now(),
			sourceUrl,
			modelCount: Object.keys(map).filter((k) => k !== 'sample_spec').length,
		};
		await writeFile(tmp, body, 'utf-8');
		await writeFile(metaTmp, JSON.stringify(meta), 'utf-8');
		await rename(tmp, this.cachePath());
		await rename(metaTmp, this.metaPath());
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ui/tokens/model-context-registry.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/tokens/model-context-registry.ts tests/ui/tokens/model-context-registry.test.ts
git commit -m "feat(tokens): LiteLLM 映射表拉取与本地缓存

ModelContextRegistry 7 天 TTL、jsDelivr 默认源 + pin fallback、lookupContextLength。"
```

---

### Task 3: 重构 probe-model → probeChatConnection

**Files:**
- Modify: `src/ui/tokens/probe-model.ts`
- Modify: `tests/ui/tokens/probe-model.test.ts`

- [ ] **Step 1: Replace tests (failing against new API)**

将整个 `tests/ui/tokens/probe-model.test.ts` 替换为:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequestUrl } = vi.hoisted(() => ({ mockRequestUrl: vi.fn() }));
vi.mock('obsidian', () => ({ requestUrl: mockRequestUrl }));

import { probeChatConnection } from '../../../src/ui/tokens/probe-model';
import type { ModelContextRegistry } from '../../../src/ui/tokens/model-context-registry';

function createRegistry(hit: number | undefined): ModelContextRegistry {
	return {
		ensureRegistry: vi.fn().mockResolvedValue(
			hit != null ? { 'deepseek-chat': { max_input_tokens: hit } } : {},
		),
		lookupContextLength: vi.fn((_model, reg) => reg['deepseek-chat']?.max_input_tokens),
	} as unknown as ModelContextRegistry;
}

describe('probeChatConnection', () => {
	beforeEach(() => mockRequestUrl.mockReset());

	it('401 - ok false', async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 401, text: 'unauthorized' });
		const r = await probeChatConnection({
			apiBase: 'https://api.deepseek.com',
			apiKey: 'sk-bad',
			model: 'deepseek-chat',
			registry: createRegistry(131_072),
			registryUrl: 'https://example.com/map.json',
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain('401');
	});

	it('成功 + registry 命中', async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: {} });
		const r = await probeChatConnection({
			apiBase: 'https://api.deepseek.com',
			apiKey: 'sk-test',
			model: 'deepseek-chat',
			registry: createRegistry(131_072),
			registryUrl: 'https://example.com/map.json',
		});
		expect(r).toEqual({ ok: true, recommendedTokens: 131_072, registryHit: true });
		const call = mockRequestUrl.mock.calls[0][0];
		expect(call.headers?.Authorization).toBe('Bearer sk-test');
	});

	it('成功 + registry 未命中', async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: {} });
		const registry = createRegistry(undefined);
		(registry.lookupContextLength as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
		const r = await probeChatConnection({
			apiBase: 'https://api.example.com',
			apiKey: 'sk-test',
			model: 'unknown',
			registry,
			registryUrl: 'https://example.com/map.json',
		});
		expect(r).toEqual({ ok: true, recommendedTokens: undefined, registryHit: false });
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ui/tokens/probe-model.test.ts`

Expected: FAIL — `probeChatConnection` not exported

- [ ] **Step 3: Rewrite probe-model.ts**

```typescript
/**
 * @file src/ui/tokens/probe-model.ts
 * @description Chat 连接测试 + 映射表推荐 context — 见 ADR-007
 */

import { requestUrl } from 'obsidian';
import type { ModelContextRegistry } from './model-context-registry';

export type ProbeModelResult =
	| { ok: true; recommendedTokens?: number; registryHit: boolean }
	| { ok: false; error: string };

export async function probeChatConnection(deps: {
	apiBase: string;
	apiKey: string;
	model: string;
	registry: ModelContextRegistry;
	registryUrl: string;
}): Promise<ProbeModelResult> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (deps.apiKey) {
		headers.Authorization = `Bearer ${deps.apiKey}`;
	}

	try {
		const response = await requestUrl({
			url: `${deps.apiBase}/chat/completions`,
			method: 'POST',
			headers,
			body: JSON.stringify({
				model: deps.model,
				messages: [{ role: 'user', content: 'hi' }],
				max_tokens: 1,
				stream: false,
			}),
			throw: false,
		});

		if (response.status < 200 || response.status >= 300) {
			return { ok: false, error: `API 返回 ${response.status}:连接失败或模型名无效` };
		}

		const map = await deps.registry.ensureRegistry(deps.registryUrl);
		const recommended =
			map != null
				? deps.registry.lookupContextLength(deps.model, map)
				: undefined;

		return {
			ok: true,
			recommendedTokens: recommended,
			registryHit: recommended != null,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `请求失败:${message}` };
	}
}
```

删除 `probeModelContextLength`、`MODEL_CONTEXT_MAP`、`lookupModelContext`。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ui/tokens/probe-model.test.ts`

Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/ui/tokens/probe-model.ts tests/ui/tokens/probe-model.test.ts
git commit -m "refactor(tokens): probeChatConnection 连接测试 + 映射表推荐

删除内置 MODEL_CONTEXT_MAP;连接成功时调 ModelContextRegistry 查 max_input_tokens。"
```

---

### Task 4: Settings Schema、迁移、main 挂载

**Files:**
- Modify: `src/settings.ts`
- Modify: `src/main.ts`
- Modify: `src/utils/gitignore-writer.ts`
- Modify: `tests/settings-migration.test.ts`

- [ ] **Step 1: Add failing migration tests**

在 `tests/settings-migration.test.ts` 追加:

```typescript
import {
	inferPresetFromTokens,
	presetToTokens,
	DEFAULT_CONTEXT_LENGTH_PRESET,
} from '../src/ui/tokens/context-length-presets';
import { normalizeContextLengthSettings } from '../src/settings';

describe('Context Length 迁移', () => {
	it('chatModelMaxTokens=0 → 256k', () => {
		const merged = simulateLoadSettings({ chatModelMaxTokens: 0 });
		const normalized = normalizeContextLengthSettings(merged);
		expect(normalized.contextLengthPreset).toBe('256k');
		expect(normalized.chatModelMaxTokens).toBe(256_000);
	});

	it('64000 → custom', () => {
		const merged = simulateLoadSettings({ chatModelMaxTokens: 64_000 });
		const normalized = normalizeContextLengthSettings(merged);
		expect(normalized.contextLengthPreset).toBe('custom');
		expect(normalized.chatModelMaxTokens).toBe(64_000);
	});

	it('128000 → 128k', () => {
		const merged = simulateLoadSettings({ chatModelMaxTokens: 128_000 });
		const normalized = normalizeContextLengthSettings(merged);
		expect(normalized.contextLengthPreset).toBe('128k');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/settings-migration.test.ts`

Expected: FAIL — `normalizeContextLengthSettings` not found

- [ ] **Step 3: Update settings.ts interface + DEFAULT + normalize**

在 `RatelVaultSettings` 增加:

```typescript
import type { ContextLengthPresetId } from './ui/tokens/context-length-presets';
import {
	DEFAULT_CONTEXT_LENGTH_PRESET,
	inferPresetFromTokens,
	presetToTokens,
} from './ui/tokens/context-length-presets';

// interface 内:
contextLengthPreset: ContextLengthPresetId;
modelRegistryUrl: string;
// chatModelMaxTokens 注释改为「实际上限 token」

// DEFAULT_SETTINGS:
contextLengthPreset: '256k',
chatModelMaxTokens: 256_000,
modelRegistryUrl: '',

export function normalizeContextLengthSettings(settings: RatelVaultSettings): RatelVaultSettings {
	if (settings.modelRegistryUrl == null) {
		settings.modelRegistryUrl = '';
	}
	const hasPresetField = settings.contextLengthPreset != null;
	if (!hasPresetField) {
		const inferred = inferPresetFromTokens(settings.chatModelMaxTokens);
		settings.contextLengthPreset = inferred.preset;
		settings.chatModelMaxTokens = inferred.chatModelMaxTokens;
	} else if (settings.contextLengthPreset !== 'custom') {
		settings.chatModelMaxTokens = presetToTokens(
			settings.contextLengthPreset as Exclude<ContextLengthPresetId, 'custom'>,
		);
	} else if (settings.chatModelMaxTokens <= 0) {
		const inferred = inferPresetFromTokens(0);
		settings.contextLengthPreset = inferred.preset;
		settings.chatModelMaxTokens = inferred.chatModelMaxTokens;
	}
	return settings;
}
```

- [ ] **Step 4: Wire main.ts**

```typescript
import { ModelContextRegistry } from './ui/tokens/model-context-registry';
import { normalizeContextLengthSettings } from './settings';

// class 字段:
modelContextRegistry!: ModelContextRegistry;

// onload 内 pluginDir 计算后(与 ortAssets 同级):
this.modelContextRegistry = new ModelContextRegistry(pluginDir);

// loadSettings 末尾:
normalizeContextLengthSettings(this.settings);
```

- [ ] **Step 5: gitignore-writer**

`RATEL_GITIGNORE_LINES` 追加 `'model-context-registry.json'`, `'model-context-registry.meta.json'`。

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/settings-migration.test.ts`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/settings.ts src/main.ts src/utils/gitignore-writer.ts tests/settings-migration.test.ts
git commit -m "feat(settings): Context Length schema 迁移与 ModelContextRegistry 挂载

默认 256k;normalizeContextLengthSettings 在 loadSettings 调用。"
```

---

### Task 5: 设置面板 UI

**Files:**
- Modify: `src/settings.ts` (`renderSettings` Chat 区 ~L237-280)

- [ ] **Step 1: 删除旧 Context Length 文本框块**

移除 `setDesc('...自动推断...')` 与 `addText` token 输入整段。

- [ ] **Step 2: 实现下拉 + 测试连接**

在 `renderSettings` Chat 区加入(需 import):

```typescript
import { Notice } from 'obsidian';
import {
	presetToTokens,
	CUSTOM_TOKEN_MIN,
	CUSTOM_TOKEN_MAX,
	type ContextLengthPresetId,
} from './ui/tokens/context-length-presets';
import { DEFAULT_MODEL_REGISTRY_URL } from './ui/tokens/model-context-registry';
import { probeChatConnection } from './ui/tokens/probe-model';
import {
	hasChatApiKey,
	requiresChatApiKey,
	resolveChatApiKey,
} from './secrets/ratel-secrets';
import { applyContextRecommendation } from './ui/tokens/context-length-presets';

const PRESET_OPTIONS: Record<ContextLengthPresetId, string> = {
	'128k': '128k (128,000)',
	'200k': '200k (200,000)',
	'256k': '256k (256,000)',
	'1M': '1M (1,048,576)',
	custom: '自定义',
};

new Setting(containerEl)
	.setName('Context Length')
	.setDesc('模型上下文窗口上限。测试连接可验证配置并根据公开模型库推荐数值。')
	.addDropdown((dropdown) => {
		dropdown.addOptions(PRESET_OPTIONS);
		dropdown.setValue(this.plugin.settings.contextLengthPreset);
		dropdown.onChange(async (value) => {
			const preset = value as ContextLengthPresetId;
			this.plugin.settings.contextLengthPreset = preset;
			if (preset !== 'custom') {
				this.plugin.settings.chatModelMaxTokens = presetToTokens(preset);
			}
			await this.plugin.saveSettings();
			this.display();
		});
	})
	.addButton((btn) => {
		btn.setButtonText('测试连接');
		btn.onClick(async () => {
			if (requiresChatApiKey(this.plugin.settings) && !hasChatApiKey(this.app, this.plugin.settings)) {
				new Notice('请先在钥匙串配置 Chat API 密钥', 5000);
				return;
			}
			btn.setButtonText('测试中…');
			btn.setDisabled(true);
			const registryUrl =
				this.plugin.settings.modelRegistryUrl || DEFAULT_MODEL_REGISTRY_URL;
			const result = await probeChatConnection({
				apiBase: this.plugin.settings.chatApiBase,
				apiKey: resolveChatApiKey(this.app, this.plugin.settings) ?? '',
				model: this.plugin.settings.chatModel,
				registry: this.plugin.modelContextRegistry,
				registryUrl,
			});
			btn.setButtonText('测试连接');
			btn.setDisabled(false);
			if (!result.ok) {
				new Notice(`✗ ${result.error}`, 5000);
				return;
			}
			if (result.recommendedTokens != null) {
				const applied = applyContextRecommendation(result.recommendedTokens);
				this.plugin.settings.contextLengthPreset = applied.preset;
				this.plugin.settings.chatModelMaxTokens = applied.chatModelMaxTokens;
				await this.plugin.saveSettings();
				new Notice(
					`✓ 连接成功 · 已根据模型库推荐:${result.recommendedTokens.toLocaleString()} tokens`,
					4000,
				);
			} else {
				new Notice('✓ 连接成功 · 请确认 Context Length 是否与模型文档一致', 5000);
			}
			this.display();
		});
	});

if (this.plugin.settings.contextLengthPreset === 'custom') {
	new Setting(containerEl)
		.setName('自定义 token 数')
		.setDesc(`范围 ${CUSTOM_TOKEN_MIN.toLocaleString()} – ${CUSTOM_TOKEN_MAX.toLocaleString()}`)
		.addText((text) => {
			text
				.setPlaceholder(String(CUSTOM_TOKEN_MIN))
				.setValue(String(this.plugin.settings.chatModelMaxTokens))
				.onChange(async (value) => {
					const num = parseInt(value, 10);
					if (isNaN(num) || num < CUSTOM_TOKEN_MIN || num > CUSTOM_TOKEN_MAX) {
						new Notice(`请输入 ${CUSTOM_TOKEN_MIN}–${CUSTOM_TOKEN_MAX} 之间的整数`, 4000);
						return;
					}
					this.plugin.settings.chatModelMaxTokens = num;
					await this.plugin.saveSettings();
				});
		});
}

containerEl.createEl('h3', { text: '高级' });

new Setting(containerEl)
	.setName('模型映射表 URL')
	.setDesc('留空使用 LiteLLM 默认源。可填企业镜像或 pin 版本地址。')
	.addText((text) => {
		text
			.setPlaceholder(DEFAULT_MODEL_REGISTRY_URL)
			.setValue(this.plugin.settings.modelRegistryUrl)
			.onChange(async (value) => {
				this.plugin.settings.modelRegistryUrl = value.trim();
				await this.plugin.saveSettings();
			});
	})
	.addButton((btn) => {
		btn.setButtonText('恢复默认').onClick(async () => {
			this.plugin.settings.modelRegistryUrl = '';
			await this.plugin.saveSettings();
			this.display();
		});
	});

void this.plugin.modelContextRegistry.ensureRegistry(
	this.plugin.settings.modelRegistryUrl || DEFAULT_MODEL_REGISTRY_URL,
);
```

- [ ] **Step 3: Build smoke**

Run: `npm run build`

Expected: exit 0

- [ ] **Step 4: Run full token/settings tests**

Run: `npx vitest run tests/ui/tokens tests/settings-migration.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/settings.ts
git commit -m "feat(settings): Context Length 预设下拉与测试连接推荐

下拉 128k/200k/256k/1M/自定义;钥匙串 Key;LiteLLM 映射表 URL 高级配置。"
```

---

### Task 6: context-window 简化

**Files:**
- Modify: `src/utils/context-window.ts`
- Modify: `src/ui/chat/ChatView.svelte` (注释 only)

- [ ] **Step 1: Update context-window.ts**

```typescript
import type { RatelVaultSettings } from '../settings';
import {
	CUSTOM_TOKEN_MIN,
	DEFAULT_CONTEXT_LENGTH_PRESET,
	presetToTokens,
} from '../ui/tokens/context-length-presets';

export function getEffectiveChatModelMaxTokens(
	settings: Pick<RatelVaultSettings, 'chatModelMaxTokens'>,
): number {
	const n = settings.chatModelMaxTokens;
	if (n >= CUSTOM_TOKEN_MIN) return n;
	return presetToTokens(DEFAULT_CONTEXT_LENGTH_PRESET);
}
```

删除 `DEFAULT_CHAT_MODEL_MAX_TOKENS`。

- [ ] **Step 2: ChatView.svelte 注释**

将 `未探测 chatModelMaxTokens(=0) 时仍用 32K 回退` 改为 `chatModelMaxTokens 由设置面板预设/自定义配置,见 ADR-007`。

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/core/context-manager-usage.test.ts tests/user-feedback/user-status.test.ts`

如有失败因默认 256k 变化,更新断言中 `maxTokens` 期望值。

- [ ] **Step 4: Commit**

```bash
git add src/utils/context-window.ts src/ui/chat/ChatView.svelte
git commit -m "refactor(context-window): 移除 32k 静默回退,默认 256k 兜底"
```

---

### Task 7: 文档

**Files:**
- Modify: `docs/architecture/agent/chat.md` §5.6
- Modify: `docs/user-guide.md`
- Modify: `docs/superpowers/STATUS.md`

- [ ] **Step 1: 重写 chat.md §5.6**

替换为 ADR-007 要点:LiteLLM 映射表、预设下拉、测试连接=验连通+推荐、默认 256k。

- [ ] **Step 2: 更新 user-guide.md**

中英文 DeepSeek 配置行改为:

- 中文:`Context Length 下拉选择(默认 256k),可点「测试连接」根据公开模型库推荐`
- 英文:`Context Length preset dropdown (default 256k); use Test connection for registry recommendation`

- [ ] **Step 3: STATUS.md**

在「实施 Plan」表增加:

`| P-CONTEXT-WINDOW | plans/2026-06-28-model-context-window-registry-implementation.md | ⏳ Pending | S-CONTEXT-WINDOW | — |`

- [ ] **Step 4: Commit**

```bash
git add docs/architecture/agent/chat.md docs/user-guide.md docs/superpowers/STATUS.md
git commit -m "docs: S-CONTEXT-WINDOW 架构与用户手册对齐 ADR-007"
```

---

## 最终验证

- [ ] `npx vitest run tests/ui/tokens tests/settings-migration.test.ts`
- [ ] `npm run build`
- [ ] Obsidian 手工:DeepSeek + 钥匙串 → 测试连接 → 自定义 131072;切换 256k 预设 → StatusLine 百分比变化

---

## Spec 自检(Plan 作者)

| Spec 要求 | Task |
|-----------|------|
| LiteLLM 远程 + 缓存 TTL 7d | Task 2 |
| 预设下拉 default 256k | Task 1, 4, 5 |
| 测试连接 + Key 修复 | Task 3, 5 |
| modelRegistryUrl 可配 | Task 4, 5 |
| 迁移 0→256k | Task 4 |
| 删除 32k 回退 | Task 6 |
| 文档 | Task 7 |
| Ollama /api/show | **非目标,未列入** |
| bundle 1.5MB | **非目标,未列入** |
