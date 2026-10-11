# S-MODEL-CATALOG 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对话模型页用 models.dev 名单选供应商和模型，窗口与单次输出按供应商 id + 模型 id 精确填写。

**Architecture:** 纯函数负责过滤和精确查找。缓存类只负责拉取与 7 天文件缓存，不在 `onload` 调用。`syncChatWindow` 改为读这份缓存，不再按模型名模糊查 LiteLLM。`providerId` 记在每一套配置上。设置页下拉只消费上述函数。

**Tech Stack:** TypeScript、Vitest、Obsidian `requestUrl`、现有 `Setting` 下拉。

**基线:** 从 `feat-chat-setup` 开分支。`develop` 还没有 `windowUserSet` 和当前套展开区，不要在 `develop` 上直接改。

**Spec:** [2026-09-28-model-catalog-design.md](../specs/2026-09-28-model-catalog-design.md)

## Global Constraints

- 不改五个顶栏、当前套展开结构、二级页、密钥槽位、顶栏菜单、嵌入与重排。
- 单次输出只显示，不写入 `data.json`，不传给请求的 `max_tokens`。
- 不把名单 JSON 打进 `main.js`。不在 `onload` 拉取。对话发送不拉取。
- 名单请求不带库内容、不带密钥。
- 不编造 `api` 为空的供应商地址。原型里 OpenAI / Anthropic 的地址作废。
- 本地 Ollama（`providerId === 'ollama'`）与名单里的 `ollama-cloud` 不是同一家。
- 窗口数字不得大于本次查到的 `limit.context`。查不到才手填，并清空上一模型的上限。
- 文案走 i18n（`zh.ts`、`en.ts`、`types.ts`）。注释中文。
- 高级「模型映射表」页和 `ModelContextRegistry` 保留，对话窗口不再读它。

---

### Task 1: 名单纯函数

**Files:**
- Create: `src/settings/model-catalog.ts`
- Test: `tests/settings/model-catalog.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `MODELS_DEV_URL = 'https://models.dev/api.json'`
  - `LOCAL_PROVIDER_OLLAMA = 'ollama'`
  - `LOCAL_PROVIDER_CUSTOM = 'custom'`
  - `CatalogLimits = { context: number; output: number }`
  - `CatalogProviderRow = { id: string; name: string; api: string | null }`
  - `lookupCatalogLimits(catalog, providerId, modelId): CatalogLimits | undefined`
  - `listCatalogProviders(catalog): CatalogProviderRow[]`
  - `listCatalogModels(catalog, providerId): string[]`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from 'vitest';
import {
	listCatalogModels,
	listCatalogProviders,
	lookupCatalogLimits,
	type ModelsDevCatalog,
} from '../../src/settings/model-catalog';

const catalog: ModelsDevCatalog = {
	deepseek: {
		id: 'deepseek',
		name: 'DeepSeek',
		api: 'https://api.deepseek.com',
		models: {
			'deepseek-v4-flash': {
				id: 'deepseek-v4-flash',
				limit: { context: 1_000_000, output: 393_216 },
				tool_call: true,
				status: 'deprecated',
			},
			'image-only': {
				id: 'image-only',
				limit: { context: 0, output: 0 },
				tool_call: false,
			},
		},
	},
	reseller: {
		id: 'reseller',
		name: 'Reseller',
		api: 'https://reseller.example/v1',
		models: {
			'deepseek-v4-flash': {
				id: 'deepseek-v4-flash',
				limit: { context: 524_288, output: 8_192 },
				tool_call: true,
			},
		},
	},
	openai: {
		id: 'openai',
		name: 'OpenAI',
		api: '',
		models: {
			'gpt-5.4': {
				id: 'gpt-5.4',
				limit: { context: 1_050_000, output: 128_000 },
				tool_call: true,
			},
		},
	},
};

describe('lookupCatalogLimits', () => {
	it('lookupCatalogLimits - 同一模型 id 两家供应商 - 窗口不同', () => {
		expect(lookupCatalogLimits(catalog, 'deepseek', 'deepseek-v4-flash')).toEqual({
			context: 1_000_000,
			output: 393_216,
		});
		expect(lookupCatalogLimits(catalog, 'reseller', 'deepseek-v4-flash')?.context).toBe(524_288);
	});

	it('lookupCatalogLimits - 供应商或模型不存在 - 返回 undefined', () => {
		expect(lookupCatalogLimits(catalog, 'deepseek', 'missing')).toBeUndefined();
		expect(lookupCatalogLimits(catalog, 'nope', 'deepseek-v4-flash')).toBeUndefined();
	});

	it('lookupCatalogLimits - context 为 0 - 视为未命中', () => {
		expect(lookupCatalogLimits(catalog, 'deepseek', 'image-only')).toBeUndefined();
	});
});

describe('listCatalogModels', () => {
	it('listCatalogModels - deprecated 且 tool_call - 仍列出', () => {
		expect(listCatalogModels(catalog, 'deepseek')).toEqual(['deepseek-v4-flash']);
	});

	it('listCatalogModels - context 为 0 或不能调工具 - 不列出', () => {
		expect(listCatalogModels(catalog, 'deepseek')).not.toContain('image-only');
	});
});

describe('listCatalogProviders', () => {
	it('listCatalogProviders - api 空串 - api 为 null', () => {
		const openai = listCatalogProviders(catalog).find((row) => row.id === 'openai');
		expect(openai).toEqual({ id: 'openai', name: 'OpenAI', api: null });
	});

	it('listCatalogProviders - 按 name 排序 - DeepSeek 在 OpenAI 前', () => {
		const ids = listCatalogProviders(catalog).map((row) => row.id);
		expect(ids.indexOf('deepseek')).toBeLessThan(ids.indexOf('openai'));
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/settings/model-catalog.test.ts`

Expected: FAIL，找不到 `src/settings/model-catalog`。

- [ ] **Step 3: Write minimal implementation**

```typescript
/**
 * @file src/settings/model-catalog.ts
 * @description models.dev 名单的类型、精确查表与下拉过滤（无 IO）
 * @module settings/model-catalog
 */

/** models.dev 全量名单地址 */
export const MODELS_DEV_URL = 'https://models.dev/api.json';

/** 本地 Ollama，不在名单里 */
export const LOCAL_PROVIDER_OLLAMA = 'ollama';

/** 自定义地址，不在名单里 */
export const LOCAL_PROVIDER_CUSTOM = 'custom';

export interface CatalogLimits {
	context: number;
	output: number;
}

export interface CatalogProviderRow {
	id: string;
	name: string;
	api: string | null;
}

export interface ModelsDevModel {
	id: string;
	limit?: { context?: number; output?: number };
	tool_call?: boolean;
	status?: string;
}

export interface ModelsDevProvider {
	id: string;
	name?: string;
	api?: string | null;
	models?: Record<string, ModelsDevModel>;
}

export type ModelsDevCatalog = Record<string, ModelsDevProvider>;

/**
 * 按供应商 id + 模型 id 精确取窗口和单次输出。
 *
 * @param catalog - 已解析的名单
 * @param providerId - 供应商 id
 * @param modelId - 模型 id
 * @returns context 大于 0 时返回；output 缺省或非正数时为 0。未命中返回 undefined
 */
export function lookupCatalogLimits(
	catalog: ModelsDevCatalog,
	providerId: string,
	modelId: string,
): CatalogLimits | undefined {
	const model = catalog[providerId]?.models?.[modelId];
	const context = model?.limit?.context;
	if (typeof context !== 'number' || context <= 0) return undefined;
	const output = model?.limit?.output;
	return {
		context,
		output: typeof output === 'number' && output > 0 ? output : 0,
	};
}

/**
 * 下拉用的模型 id：窗口大于 0 且 tool_call 为真。不因 status 隐藏。
 *
 * @param catalog - 已解析的名单
 * @param providerId - 供应商 id
 * @returns 排序后的模型 id
 */
export function listCatalogModels(catalog: ModelsDevCatalog, providerId: string): string[] {
	const models = catalog[providerId]?.models ?? {};
	return Object.values(models)
		.filter((model) => (model.limit?.context ?? 0) > 0 && model.tool_call === true && model.id)
		.map((model) => model.id)
		.sort((a, b) => a.localeCompare(b));
}

/**
 * 下拉用的供应商。空 api 记为 null，调用方不得编造地址。
 * 跳过 id 为 ollama / custom 的记录，避免和内置两项重复。
 *
 * @param catalog - 已解析的名单
 * @returns 按 name 排序的行
 */
export function listCatalogProviders(catalog: ModelsDevCatalog): CatalogProviderRow[] {
	const rows: CatalogProviderRow[] = [];
	for (const provider of Object.values(catalog)) {
		if (!provider?.id) continue;
		if (provider.id === LOCAL_PROVIDER_OLLAMA || provider.id === LOCAL_PROVIDER_CUSTOM) continue;
		const api = typeof provider.api === 'string' ? provider.api.trim() : '';
		rows.push({
			id: provider.id,
			name: provider.name?.trim() || provider.id,
			api: api || null,
		});
	}
	rows.sort((a, b) => a.name.localeCompare(b.name, 'en'));
	return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/settings/model-catalog.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/settings/model-catalog.ts tests/settings/model-catalog.test.ts
git commit -m "$(cat <<'EOF'
feat: 按供应商和模型 id 查窗口

同一模型 id 在不同供应商下窗口不同，模糊匹配模型名会写错上限。

EOF
)"
```

---

### Task 2: 名单缓存

**Files:**
- Create: `src/settings/model-catalog-cache.ts`
- Test: `tests/settings/model-catalog-cache.test.ts`
- Modify: `src/utils/gitignore-writer.ts`
- Modify: `src/main.ts`（在 `modelContextRegistry` 旁构造，不在 `onload` 里 `ensureCatalog`）
- Modify: `src/settings/settings-apply.ts`（`SettingApplier` 增加可选字段）

**Interfaces:**
- Consumes: `MODELS_DEV_URL`、`ModelsDevCatalog`（Task 1）
- Produces:
  - `ModelsDevCatalogCache.ensureCatalog(): Promise<ModelsDevCatalog | null>`
  - 插件字段 `modelsDevCatalog: ModelsDevCatalogCache`
  - `SettingApplier.modelsDevCatalog?: { ensureCatalog(): Promise<ModelsDevCatalog | null> }`
  - gitignore 行 `models-dev.json`、`models-dev.meta.json`

- [ ] **Step 1: Write the failing test**

用临时目录和假的 `requestUrl`。覆盖：首次拉取写入缓存；7 天内不再请求；拉取失败时用过期缓存；无缓存且失败时返回 null；超过 8MB 丢弃。

```typescript
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MODELS_DEV_URL } from '../../src/settings/model-catalog';
import { ModelsDevCatalogCache } from '../../src/settings/model-catalog-cache';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), 'models-dev-'));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const body = JSON.stringify({
	deepseek: {
		id: 'deepseek',
		name: 'DeepSeek',
		api: 'https://api.deepseek.com',
		models: {},
	},
});

describe('ModelsDevCatalogCache', () => {
	it('ensureCatalog - 无缓存 - 拉取并写入插件目录', async () => {
		const dir = await tempDir();
		let calls = 0;
		const cache = new ModelsDevCatalogCache(dir, async () => {
			calls += 1;
			return { status: 200, text: body } as never;
		});
		const catalog = await cache.ensureCatalog();
		expect(catalog?.deepseek?.id).toBe('deepseek');
		expect(calls).toBe(1);
		const saved = await readFile(path.join(dir, 'models-dev.json'), 'utf-8');
		expect(saved).toContain('deepseek');
		await cache.ensureCatalog();
		expect(calls).toBe(1);
	});

	it('ensureCatalog - 拉取失败且有过期缓存 - 返回旧名单', async () => {
		const dir = await tempDir();
		await writeFile(path.join(dir, 'models-dev.json'), body, 'utf-8');
		await writeFile(
			path.join(dir, 'models-dev.meta.json'),
			JSON.stringify({ fetchedAt: Date.now() - 8 * 24 * 60 * 60 * 1000, sourceUrl: MODELS_DEV_URL }),
			'utf-8',
		);
		const cache = new ModelsDevCatalogCache(dir, async () => {
			throw new Error('offline');
		});
		const catalog = await cache.ensureCatalog();
		expect(catalog?.deepseek?.name).toBe('DeepSeek');
	});

	it('ensureCatalog - 无缓存且拉取失败 - 返回 null', async () => {
		const dir = await tempDir();
		const cache = new ModelsDevCatalogCache(dir, async () => ({ status: 500, text: '' }) as never);
		expect(await cache.ensureCatalog()).toBeNull();
	});

	it('ensureCatalog - 正文超过 8MB - 丢弃且不写缓存', async () => {
		const dir = await tempDir();
		const cache = new ModelsDevCatalogCache(dir, async () => ({ status: 200, text: 'x'.repeat(8 * 1024 * 1024 + 1) }) as never);
		expect(await cache.ensureCatalog()).toBeNull();
	});
});
```

`utimes` 若未使用，删掉该 import。假 `requestUrl` 只需 `status` 与 `text`。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/settings/model-catalog-cache.test.ts`

Expected: FAIL，找不到 `ModelsDevCatalogCache`。

- [ ] **Step 3: Write minimal implementation**

新建 `src/settings/model-catalog-cache.ts`，结构对齐 `src/ui/tokens/model-context-registry.ts` 的 `ensureRegistry` / `readCacheIfFresh` / `readCacheIgnoringTtl` / `fetchAndParse` / `writeCache`，改成下面这些常量与解析：

- 文件名 `models-dev.json`、`models-dev.meta.json`
- TTL `7 * 24 * 60 * 60 * 1000`
- 最大正文 `8 * 1024 * 1024`（名单约 4.7MB，沿用映射表的 3MB 会把合法响应丢掉）
- URL 固定 `MODELS_DEV_URL`，没有用户自定义地址，也没有第二镜像
- `fetchAndParse` 成功条件：HTTP 2xx、长度未超限、`JSON.parse` 得到非数组对象
- 拉取失败且无缓存：返回 `null`，打 `devLogger.warn`
- 写入用临时文件再 `rename`

`gitignore-writer.ts` 的 `RATEL_GITIGNORE_LINES` 在映射表两行后面追加：

```typescript
	'models-dev.json',
	'models-dev.meta.json',
```

`src/main.ts` 在 `new ModelContextRegistry(pluginDir)` 下一行：

```typescript
this.modelsDevCatalog = new ModelsDevCatalogCache(pluginDir);
```

类字段声明与 `modelContextRegistry` 并列。不要在 `onload` 调用 `ensureCatalog`。

`SettingApplier` 增加：

```typescript
modelsDevCatalog?: { ensureCatalog(): Promise<import('./model-catalog').ModelsDevCatalog | null> };
```

用文件顶的 import 代替 inline import，避免重复。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/settings/model-catalog-cache.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/settings/model-catalog-cache.ts tests/settings/model-catalog-cache.test.ts src/utils/gitignore-writer.ts src/main.ts src/settings/settings-apply.ts
git commit -m "$(cat <<'EOF'
feat: 打开设置时缓存模型名单

名单约 4.7MB，不打进插件包，启动时也不拉取。

EOF
)"
```

---

### Task 3: 配置上的供应商与精确窗口

**Files:**
- Modify: `src/settings/chat-profiles.ts`
- Modify: `src/settings/settings-apply.ts`
- Modify: `src/ui/chat/activate-chat-profile.ts`
- Modify: `src/ui/settings/chat-profiles-render.ts`（只改 `syncChatWindow` 的调用参数，下拉留给 Task 4）
- Test: `tests/settings/chat-profiles-ui.test.ts`
- Test: `tests/settings-apply.test.ts`

**Interfaces:**
- Consumes: `lookupCatalogLimits`、`ModelsDevCatalog`、`ModelsDevCatalogCache.ensureCatalog`、`LOCAL_PROVIDER_OLLAMA`、`LOCAL_PROVIDER_CUSTOM`
- Produces:
  - `ChatProfile.providerId: string`
  - `migrateChatProviderIds(settings): void`
  - `ChatWindowSyncDeps = { catalog: ModelsDevCatalog | null; clearOnMiss: boolean }`
  - `ChatWindowSyncResult` 增加 `output?: number`
  - `applySettingValue(plugin, 'chatProvider', providerId)`

- [ ] **Step 1: Write the failing test**

在 `tests/settings/chat-profiles-ui.test.ts` 把 `makeRegistry` 换成名单夹具。`syncChatWindow` 的 deps 改为 `{ catalog, clearOnMiss }`。新增：

```typescript
it('syncChatWindow - 同一模型 id 不同 providerId - 写入各自窗口', async () => {
	const settings = base();
	settings.chatProfiles[0]!.providerId = 'deepseek';
	settings.chatModel = 'deepseek-v4-flash';
	const catalog = {
		deepseek: {
			id: 'deepseek',
			models: { 'deepseek-v4-flash': { id: 'deepseek-v4-flash', limit: { context: 1_000_000, output: 393_216 }, tool_call: true } },
		},
		reseller: {
			id: 'reseller',
			models: { 'deepseek-v4-flash': { id: 'deepseek-v4-flash', limit: { context: 524_288, output: 8192 }, tool_call: true } },
		},
	};
	await syncChatWindow(settings, { catalog, clearOnMiss: true });
	expect(settings.chatModelMaxTokens).toBe(1_000_000);
	settings.chatProfiles[0]!.providerId = 'reseller';
	settings.chatProfiles[0]!.windowUserSet = false;
	const second = await syncChatWindow(settings, { catalog, clearOnMiss: true });
	expect(second.tokens).toBe(524_288);
	expect(second.output).toBe(8192);
	expect(settings.chatModelMaxTokens).toBe(524_288);
});

it('syncChatWindow - windowUserSet 且供应商模型未变 - 不覆盖窗口但仍返回 output', async () => {
	const settings = base();
	settings.chatProfiles[0]!.providerId = 'deepseek';
	settings.chatProfiles[0]!.windowUserSet = true;
	settings.chatModel = 'deepseek-v4-flash';
	settings.chatModelMaxTokens = 131_072;
	const catalog = {
		deepseek: {
			id: 'deepseek',
			models: { 'deepseek-v4-flash': { id: 'deepseek-v4-flash', limit: { context: 1_000_000, output: 393_216 }, tool_call: true } },
		},
	};
	const result = await syncChatWindow(settings, { catalog, clearOnMiss: true });
	expect(result.skipped).toBe(true);
	expect(settings.chatModelMaxTokens).toBe(131_072);
	expect(result.output).toBe(393_216);
});

it('migrateChatProviderIds - 无 providerId - 只推断 deepseek、ollama、custom', () => {
	const settings = base();
	settings.chatProfiles = [
		{ id: 'a', name: 'D', apiBase: 'https://api.deepseek.com', model: 'deepseek-v4-flash', contextLengthPreset: 'custom', chatModelMaxTokens: 1 },
		{ id: 'b', name: 'O', apiBase: 'http://localhost:11434/v1', model: 'llama3.2', contextLengthPreset: 'custom', chatModelMaxTokens: 1 },
		{ id: 'c', name: 'X', apiBase: 'https://api.openai.com/v1', model: 'gpt-5.4', contextLengthPreset: 'custom', chatModelMaxTokens: 1 },
	];
	migrateChatProviderIds(settings);
	expect(settings.chatProfiles.map((p) => p.providerId)).toEqual(['deepseek', 'ollama', 'custom']);
});
```

`base()` 里现有 profile 补 `providerId: 'custom'`，否则旧断言在迁移后对不上。

在 `tests/settings-apply.test.ts` 新增。该文件的宿主工厂是 `mockApplier()`，给它加上 `modelsDevCatalog`。`DEFAULT_SETTINGS` 若还没有 `chatProfiles[0]`，在用例里先放一条带 `providerId` 的套，并把 `activeChatProfileId` 指过去。

```typescript
it('chatProvider - 名单供应商 api 为空 - 清空地址且不编造', async () => {
	const p = mockApplier();
	p.settings.chatApiBase = 'https://api.deepseek.com';
	p.settings.chatProfiles[0]!.providerId = 'deepseek';
	p.settings.chatProfiles[0]!.apiBase = 'https://api.deepseek.com';
	p.modelsDevCatalog = {
		ensureCatalog: async () => ({
			openai: { id: 'openai', name: 'OpenAI', api: '', models: {} },
		}),
	};
	await applySettingValue(p, 'chatProvider', 'openai');
	expect(p.settings.chatProfiles[0]!.providerId).toBe('openai');
	expect(p.settings.chatApiBase).toBe('');
});

it('chatProvider - 有 api - 写入该地址并清 windowUserSet', async () => {
	const p = mockApplier();
	p.settings.chatProfiles[0]!.windowUserSet = true;
	p.settings.chatProfiles[0]!.providerId = 'custom';
	p.modelsDevCatalog = {
		ensureCatalog: async () => ({
			alibaba: {
				id: 'alibaba',
				name: 'Alibaba',
				api: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
				models: {
					'qwen-flash': { id: 'qwen-flash', limit: { context: 1_000_000, output: 32_768 }, tool_call: true },
				},
			},
		}),
	};
	p.settings.chatModel = 'qwen-flash';
	await applySettingValue(p, 'chatProvider', 'alibaba');
	expect(p.settings.chatApiBase).toBe('https://dashscope-intl.aliyuncs.com/compatible-mode/v1');
	expect(p.settings.chatProfiles[0]!.windowUserSet).toBe(false);
	expect(p.settings.chatModelMaxTokens).toBe(1_000_000);
});
```


- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/settings/chat-profiles-ui.test.ts tests/settings-apply.test.ts`

Expected: FAIL，`migrateChatProviderIds` 不存在，或 `syncChatWindow` 仍要求 `registry`。

- [ ] **Step 3: Write minimal implementation**

`ChatProfile` 增加：

```typescript
/**
 * 供应商 id。名单内用 models.dev 的 id；本地为 ollama；其余为 custom。
 * 旧 data.json 无此字段，由 migrateChatProviderIds 补上。
 */
providerId?: string;
```

`migrateChatProviderIds`：已有 `providerId` 的跳过；否则 `providerId = inferChatProvider(profile.apiBase)`。`normalizeChatProfiles` 在 `raw.chatProfiles` 已是数组时会立刻 `return`，迁移必须写在这个 `return` 之前，对已有每一套都跑。新合成的那套在写入 `settings.chatProfiles` 时带上 `providerId`。

`saveCurrentAsProfile` 从源套复制 `providerId`。

`syncChatWindow` 的 deps 改为 `{ catalog, clearOnMiss }`。查找键是活跃套的 `providerId`（缺省当 `custom`）加 `settings.chatModel`：

- `windowUserSet` 为真：不改 `chatModelMaxTokens`，`skipped: true`。若精确命中，仍把 `output` 放进返回值。
- 命中：用 `applyContextRecommendation(limits.context)` 写当前字段和活跃套，返回 `tokens` 与 `output`。
- 未命中且 `clearOnMiss`：写成 `custom` / `0`，与现在一样。
- 未命中且不 `clearOnMiss`：不改设置。

删除 `syncChatWindow` 对 `lookupModelContext` 的调用。`lookupModelContext` 若没有剩余调用方，删掉该函数和 `ModelContextLookup` 上只为它服务的引用；`ModelContextRegistry` 本身留着给映射表页。

`applySettingValue` 在 `chatPreset` 分支之前处理 `chatProvider`：

- 写入活跃套 `providerId`，并 `windowUserSet = false`。
- `ollama`：仍走 `applyChatPreset(settings, 'ollama')`，地址和模型用现有预设。
- `custom`：`chatPreset = 'custom'`，地址清空，模型名保留。
- 其他 id：从 `await plugin.modelsDevCatalog.ensureCatalog()` 取该供应商的 `api`。非空则写入 `chatApiBase` 和活跃套 `apiBase`；空则两边都写成 `''`。不改模型名。`chatPreset` 仅当 id 为 `deepseek` 时写 `deepseek`，否则写 `custom`（旧枚举装不下 `alibaba` 这类 id）。
- 然后 `rebuildLLM()`，再 `syncChatWindow(..., { catalog, clearOnMiss: true })`。

`chatModel` 分支改为：清 `windowUserSet` 后用名单 `syncChatWindow`，不再用 `modelContextRegistry`。`chatModelMaxTokens` 的钳制改为 `lookupCatalogLimits`；没有名单或未命中时不钳、仍记 `windowUserSet`。

现有 `chatPreset` 分支里的 `syncChatWindow` 同样改成传入 `catalog`。签名改完后这一支不能再留 `registry` / `registryUrl`。`tests/settings-apply.test.ts` 里靠 `modelContextRegistry` 按模型名写出窗口的 `chatPreset` 用例，改成挂 `modelsDevCatalog`，或预期为查不到并清空。不要让 LiteLLM 的模型名 mock 继续决定窗口。

`activate-chat-profile.ts` 和 `chat-profiles-render.ts` 里现有的 `syncChatWindow` 调用改成先 `ensureCatalog()`，再传入 `catalog`。`clearOnMiss` 保持原样：切换套为 `true`，展开区只展示时为 `false`。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/settings/chat-profiles-ui.test.ts tests/settings-apply.test.ts tests/settings/model-catalog.test.ts`

Expected: PASS。若 `settings-apply` 里旧的 `chatPreset` 用例仍用 `modelContextRegistry` 查窗口，把那些用例的预期改成「窗口来自名单」；没有 `modelsDevCatalog` 时查不到并按 `clearOnMiss` 清空，不要让旧 mock 的模型名映射继续决定窗口。

- [ ] **Step 5: Commit**

```bash
git add src/settings/chat-profiles.ts src/settings/settings-apply.ts src/ui/chat/activate-chat-profile.ts src/ui/settings/chat-profiles-render.ts tests/settings/chat-profiles-ui.test.ts tests/settings-apply.test.ts
git commit -m "$(cat <<'EOF'
feat: 对话窗口按供应商和模型 id 填写

旧配置没有供应商时只按地址分成 DeepSeek、本地 Ollama 或自定义。

EOF
)"
```

---

### Task 4: 设置页下拉与单次输出

**Files:**
- Modify: `src/ui/settings/chat-profiles-render.ts`（`renderProfileDetail`、`renderProfileWindow`）
- Modify: `src/i18n/zh.ts`
- Modify: `src/i18n/en.ts`
- Modify: `src/i18n/types.ts`
- Test: `tests/settings/chat-profiles-ui.test.ts` 不测 DOM。本任务用 i18n 键存在性测试，若已有 `src/i18n/strings.test.ts` 会因缺键失败，补上键即可。

**Interfaces:**
- Consumes: `listCatalogProviders`、`listCatalogModels`、`LOCAL_PROVIDER_OLLAMA`、`LOCAL_PROVIDER_CUSTOM`、`applySettingValue(..., 'chatProvider', id)`、`syncChatWindow` 的 `output`
- Produces: 展开区的提供商下拉、模型下拉或手填、窗口说明、单次输出一行

- [ ] **Step 1: Write the failing test**

在 `src/i18n/strings.test.ts` 已有的键集合断言旁，不新造框架。若该文件是「zh/en 键一致」，新键加进两边就会过。另外在 `tests/settings/model-catalog.test.ts` 不重复测 UI。

本步先改 `renderProfileDetail` 之前，在 `strings.test.ts` 里没有需手写的新用例。改为先写一个纯函数，把「当前模型不在下拉里就视为手填」从渲染里拆出来，便于测：

`src/settings/model-catalog.ts` 追加：

测试：

```typescript
it('modelPickValue - 不在过滤列表 - 返回手填标记', () => {
	expect(modelPickValue(['deepseek-v4-flash'], 'deepseek-v4-flash')).toBe('deepseek-v4-flash');
	expect(modelPickValue(['deepseek-v4-flash'], 'my-model')).toBe('__hand');
	expect(modelPickValue([], 'llama3.2')).toBe('__hand');
});
```

`modelPickValue` 与常量 `CATALOG_MODEL_HAND = '__hand'` 放在 Task 1 的模块里。本任务先写这个失败测试。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/settings/model-catalog.test.ts`

Expected: FAIL，`modelPickValue` 未导出。

- [ ] **Step 3: Write minimal implementation**

```typescript
/** 下拉里的「手填」选项值，不会是合法模型 id */
export const CATALOG_MODEL_HAND = '__hand';

/**
 * 当前模型在过滤列表里就选中它，否则选手填。
 *
 * @param modelIds - listCatalogModels 的结果
 * @param current - 这一套已保存的模型 id
 * @returns 下拉 value
 */
export function modelPickValue(modelIds: readonly string[], current: string): string {
	return modelIds.includes(current) ? current : CATALOG_MODEL_HAND;
}
```

`renderProfileDetail` 里替换提供商和模型两段：

1. `const catalog = await plugin.modelsDevCatalog.ensureCatalog()`。渲染函数本身是同步的，与现有窗口行一样：先画出提供商下拉的加载态，异步回来后若容器仍在 DOM 里再填充。容器已被设置页拆掉则直接 return。
2. 提供商选项 = `listCatalogProviders(catalog ?? {})`，再追加 `ollama`、`custom`。显示名用供应商 `name`；后两项用 i18n `settings.chatPreset.ollama` 与 `settings.chatPreset.custom`。
3. `catalog === null` 时选项只有 `ollama` 和 `custom`，描述用 `settings.chatProfiles.catalogMissing`。
4. `onChange` 调用 `applySettingValue(plugin, 'chatProvider', value)` 然后 `saveSettings`。
5. 地址：`ollama`、`custom`，或名单行的 `api === null` 时显示可编辑框，写入仍走 `chatApiBase`。`api` 非空时不放输入框，用 `setDesc` 显示该地址。
6. 模型：`ollama` 与 `custom` 保持现在的文本框。名单供应商用下拉，选项为 `listCatalogModels` 加 `CATALOG_MODEL_HAND`。值为 `modelPickValue`。选中具体 id 时 `applySettingValue(plugin, 'chatModel', id)`。选中手填时再显示文本框，变更时同样走 `chatModel`。

`renderProfileWindow`：`result.output > 0` 时在描述末尾加一行 `tNow('settings.chatProfiles.window.output', { tokens })`。`windowUserSet` 分支也要查一次（`syncChatWindow` 在 skipped 时已返回 `output`），有则加同一行。

i18n 三处同时加：

| key | zh | en |
|---|---|---|
| `settings.chatProfiles.catalogMissing` | 名单没装上。现在只能选本地 Ollama 或自定义。 | The model list is unavailable. Only local Ollama and custom are shown. |
| `settings.chatProfiles.model.hand` | 手填 | Other |
| `settings.chatProfiles.window.output` | 单次输出上限 {tokens} | Output limit {tokens} |
| `settings.chatProfiles.window.userSetHint` | 供应商和模型不变时不会被查表盖掉。改了其中一项会重新查。 | This cap stays while the provider and model stay the same. Changing either looks it up again. |
| `settings.chatProfiles.window.loading` | 正在查名单… | Looking up the model list… |
| `settings.chatProfiles.window.foundHint` | 数字来自 models.dev，按供应商和模型一起查。 | Figures come from models.dev, matched by provider and model. |

`types.ts` 里与这些键相邻的字符串类型一并加上。不要留只存在于 zh 的键。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/settings/model-catalog.test.ts src/i18n/strings.test.ts tests/settings/chat-profiles-ui.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/settings/model-catalog.ts src/ui/settings/chat-profiles-render.ts src/i18n/zh.ts src/i18n/en.ts src/i18n/types.ts tests/settings/model-catalog.test.ts
git commit -m "$(cat <<'EOF'
feat: 设置里按供应商列出模型

地址只在名单没有给出时才让人填，单次输出单独显示一行。

EOF
)"
```

---

## 自审

| Spec | 任务 |
|---|---|
| MC-01 缓存、失败用旧文件、无缓存时只剩本地与自定义 | Task 2、Task 4 |
| MC-02 提供商下拉与 `providerId` | Task 3、Task 4 |
| MC-03 有 `api` 只读，无 `api` 清空且不编造 | Task 3 测试、Task 4 不渲染输入框 |
| MC-04 过滤与手填；本地无下拉 | Task 1、Task 4 |
| MC-05 精确键、两行数字、未命中清空 | Task 1、Task 3 |
| MC-06 `windowUserSet` | Task 3 |
| MC-07 旧套只推断三类 | Task 3 |
| 不把 output 写入请求或 data.json | Task 3 只把 `output` 放在返回值，Task 4 只显示 |
| 不改二级页与映射表页 | 无任务去改那些文件 |

未纳入：改 ADR-007、README 隐私说明。留到这条分支收尾时再问。
