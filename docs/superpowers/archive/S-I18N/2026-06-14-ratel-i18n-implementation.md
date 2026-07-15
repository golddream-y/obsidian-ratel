# i18n 中英文切换 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Ratel Vault 插件加中英文界面切换,用户可在设置面板选 `auto` / `中文` / `English`,瞬时生效;覆盖设置面板、Chat 侧栏、命令名、Notice 文本。

**Architecture:** 单一 i18n 模块,`Strings` interface 集中定义 key 形状,zh / en 翻译表都 `const x: Strings = {...}` —— TypeScript 编译期强制两表同形。运行时用 svelte/store `derived` 暴露 `t`(Svelte 模板 `$t('key')` 自动跟随),另给非 Svelte 代码提供 `tNow(key)` 便利函数。消费者只改三处:`src/settings.ts`、`src/main.ts`、`src/ui/ChatView.svelte`。

**Tech Stack:** TypeScript strict、svelte 5 (svelte/store `writable` / `derived` / `get`)、vitest 单元测试。

**Spec:** [2026-06-14-ratel-i18n-design.md](../specs/2026-06-14-ratel-i18n-design.md)

---

## Task 1: 类型模块 `src/i18n/types.ts`

**Files:**
- Create: `src/i18n/types.ts`

- [ ] **Step 1: 创建文件**

路径 `src/i18n/types.ts`,完整内容:

```ts
/**
 * @file src/i18n/types.ts
 * @description 全部用户可见字符串的 key 集合 — zh / en 必须满足此形状
 * @module i18n/types
 *
 * 关键路径:
 * - 加新 key 必须同时改 types.ts / zh.ts / en.ts,任一遗漏编译期就报错。
 * - 翻译值统一为 string,动态内容用 `{name}` 占位由 t() 的 vars 替换;
 *   这样翻译表保持 JSON 可序列化,将来想迁到 .json 文件零成本。
 * - key 命名 `域.子域.用途` 三段式,避免翻译表变成一锅粥。
 */

export type Lang = 'zh' | 'en';
export type LangPreference = 'auto' | Lang;

/**
 * 翻译表形状。
 *
 * 设计要点:
 * - 全部 value 为 string;参数化文本(Notice 索引状态之类)走 `{key}` 占位。
 * - 任何新增条目必须三处同步:`types.ts`(本文件) + `zh.ts` + `en.ts`,
 *   TypeScript 编译会强制两表满足接口。
 */
export interface Strings {
	// ==================== Settings 面板 — 通用 ====================
	'settings.title.general': string;
	'settings.field.language': string;
	'settings.field.language.desc': string;
	'settings.option.auto': string;
	'settings.option.zh': string;
	'settings.option.en': string;

	// ==================== Settings 面板 — Chat ====================
	'settings.title.chat': string;
	'settings.field.chatModel': string;
	'settings.field.chatModel.desc': string;
	'settings.field.chatApiKey': string;
	'settings.field.chatApiKey.desc': string;
	'settings.field.chatApiBase': string;
	'settings.field.chatApiBase.desc': string;

	// ==================== Settings 面板 — Embedding ====================
	'settings.title.embedding': string;
	'settings.field.embedProvider': string;
	'settings.field.embedProvider.desc': string;
	'settings.option.embedProvider.local': string;
	'settings.option.embedProvider.api': string;
	'settings.field.embedLocalModel': string;
	'settings.field.embedLocalModel.desc': string;
	'settings.field.embedApiBase': string;
	'settings.field.embedApiBase.desc': string;
	'settings.field.embedApiKey': string;
	'settings.field.embedApiKey.desc': string;
	'settings.field.embedApiModel': string;
	'settings.field.embedApiModel.desc': string;

	// ==================== Settings 面板 — Reranker ====================
	'settings.title.reranker': string;
	'settings.field.rerankerProvider': string;
	'settings.field.rerankerProvider.desc': string;
	'settings.option.rerankerProvider.cohere': string;
	'settings.option.rerankerProvider.jina': string;
	'settings.option.rerankerProvider.siliconflow': string;
	'settings.option.rerankerProvider.custom': string;
	'settings.field.rerankerApiBase': string;
	'settings.field.rerankerApiBase.desc': string;
	'settings.field.rerankerApiKey': string;
	'settings.field.rerankerApiKey.desc': string;
	'settings.field.rerankerModel': string;
	'settings.field.rerankerModel.desc': string;

	// ==================== Settings 面板 — Indexing ====================
	'settings.title.indexing': string;
	'settings.field.chunkSize': string;
	'settings.field.chunkSize.desc': string;
	'settings.field.chunkOverlap': string;
	'settings.field.chunkOverlap.desc': string;
	'settings.field.autoIndex': string;
	'settings.field.autoIndex.desc': string;

	// ==================== Settings 面板 — Link Suggestions ====================
	'settings.title.linkSuggestions': string;
	'settings.field.autoSuggestLinks': string;
	'settings.field.autoSuggestLinks.desc': string;
	'settings.field.linkConfidenceThreshold': string;
	'settings.field.linkConfidenceThreshold.desc': string;

	// ==================== Chat 侧栏 ====================
	'chat.you': string;
	'chat.ratel': string;
	'chat.placeholder': string;
	'chat.thinking': string;
	'chat.send': string;
	'chat.errorPrefix': string;

	// ==================== Notice ====================
	'notice.indexNotReady': string;
	'notice.indexStatus': string;        // 含 `{n}` `{when}` 占位

	// ==================== 命令 ====================
	'cmd.askVault': string;
	'cmd.showIndexStatus': string;
}

export type StringKey = keyof Strings;
```

- [ ] **Step 2: 验证编译**

```bash
cd /Users/golddream/code/git-public/Ratel-CLI
npx tsc --noEmit -p tsconfig.json
```

预期:无错误(纯类型文件,不产出运行时代码)。

- [ ] **Step 3: 提交**

```bash
git add src/i18n/types.ts
git commit -m "feat(i18n): add Strings interface + Lang / LangPreference types"
```

---

## Task 2: 英文翻译表 `src/i18n/en.ts`

**Files:**
- Create: `src/i18n/en.ts`

- [ ] **Step 1: 创建文件**

路径 `src/i18n/en.ts`,完整内容:

```ts
/**
 * @file src/i18n/en.ts
 * @description 英文翻译表 — 满足 src/i18n/types.ts 的 Strings 接口
 * @module i18n/en
 */

import type { Strings } from './types';

export const en: Strings = {
	// ==================== Settings 面板 — 通用 ====================
	'settings.title.general': 'General',
	'settings.field.language': 'Language',
	'settings.field.language.desc': 'Interface language. Auto follows your system locale.',
	'settings.option.auto': 'Auto',
	'settings.option.zh': '中文',
	'settings.option.en': 'English',

	// ==================== Settings 面板 — Chat ====================
	'settings.title.chat': 'Chat Model',
	'settings.field.chatModel': 'Model',
	'settings.field.chatModel.desc': 'Chat model identifier',
	'settings.field.chatApiKey': 'API Key',
	'settings.field.chatApiKey.desc': 'Chat model API key',
	'settings.field.chatApiBase': 'API Base URL',
	'settings.field.chatApiBase.desc': 'Chat model API base URL',

	// ==================== Settings 面板 — Embedding ====================
	'settings.title.embedding': 'Embedding Model',
	'settings.field.embedProvider': 'Provider',
	'settings.field.embedProvider.desc': 'Local uses built-in ONNX model (zero-config). API uses OpenAI-compatible endpoint (Ollama/SiliconFlow/etc).',
	'settings.option.embedProvider.local': 'Local (built-in)',
	'settings.option.embedProvider.api': 'API (external)',
	'settings.field.embedLocalModel': 'Model',
	'settings.field.embedLocalModel.desc': 'Local ONNX model identifier (from HuggingFace Xenova/ namespace)',
	'settings.field.embedApiBase': 'API Base URL',
	'settings.field.embedApiBase.desc': 'Embedding API base URL (Ollama: http://localhost:11434/v1)',
	'settings.field.embedApiKey': 'API Key',
	'settings.field.embedApiKey.desc': 'Embedding API key (leave empty for Ollama)',
	'settings.field.embedApiModel': 'Model',
	'settings.field.embedApiModel.desc': 'Embedding model identifier',

	// ==================== Settings 面板 — Reranker ====================
	'settings.title.reranker': 'Reranker (Optional)',
	'settings.field.rerankerProvider': 'Provider',
	'settings.field.rerankerProvider.desc': 'Reranker API provider. Auto-enabled when API Key is set.',
	'settings.option.rerankerProvider.cohere': 'Cohere',
	'settings.option.rerankerProvider.jina': 'Jina',
	'settings.option.rerankerProvider.siliconflow': 'SiliconFlow',
	'settings.option.rerankerProvider.custom': 'Custom',
	'settings.field.rerankerApiBase': 'API Base URL',
	'settings.field.rerankerApiBase.desc': 'Reranker API base URL',
	'settings.field.rerankerApiKey': 'API Key',
	'settings.field.rerankerApiKey.desc': 'Reranker API key. Leave empty to disable reranking.',
	'settings.field.rerankerModel': 'Model',
	'settings.field.rerankerModel.desc': 'Reranker model identifier',

	// ==================== Settings 面板 — Indexing ====================
	'settings.title.indexing': 'Indexing',
	'settings.field.chunkSize': 'Chunk size (tokens)',
	'settings.field.chunkSize.desc': 'Number of tokens per chunk',
	'settings.field.chunkOverlap': 'Chunk overlap (tokens)',
	'settings.field.chunkOverlap.desc': 'Overlap between chunks',
	'settings.field.autoIndex': 'Auto index',
	'settings.field.autoIndex.desc': 'Automatically re-index on file changes',

	// ==================== Settings 面板 — Link Suggestions ====================
	'settings.title.linkSuggestions': 'Link Suggestions',
	'settings.field.autoSuggestLinks': 'Auto suggest links',
	'settings.field.autoSuggestLinks.desc': 'Automatically suggest links after writing',
	'settings.field.linkConfidenceThreshold': 'Confidence threshold',
	'settings.field.linkConfidenceThreshold.desc': 'Minimum similarity to suggest a link',

	// ==================== Chat 侧栏 ====================
	'chat.you': 'You',
	'chat.ratel': 'Ratel',
	'chat.placeholder': 'Ask about your vault...',
	'chat.thinking': 'Thinking...',
	'chat.send': 'Send',
	'chat.errorPrefix': 'Error: ',

	// ==================== Notice ====================
	'notice.indexNotReady': 'Index not available yet',
	'notice.indexStatus': 'Index: {n} docs, last: {when}',

	// ==================== 命令 ====================
	'cmd.askVault': 'Ask vault',
	'cmd.showIndexStatus': 'Show index status',
};
```

- [ ] **Step 2: 验证编译**

```bash
npx tsc --noEmit -p tsconfig.json
```

预期:无错误(Strings 接口已强制每个 key 都存在)。

- [ ] **Step 3: 提交**

```bash
git add src/i18n/en.ts
git commit -m "feat(i18n): add English translation table"
```

---

## Task 3: 中文翻译表 `src/i18n/zh.ts`

**Files:**
- Create: `src/i18n/zh.ts`

- [ ] **Step 1: 创建文件**

路径 `src/i18n/zh.ts`,完整内容(所有 key 顺序与 en.ts 一一对应,便于逐行 diff):

```ts
/**
 * @file src/i18n/zh.ts
 * @description 中文翻译表 — 满足 src/i18n/types.ts 的 Strings 接口
 * @module i18n/zh
 *
 * 关键路径:key 顺序与 en.ts 完全对应,便于后续翻译协作时 diff 检查漏译。
 */

import type { Strings } from './types';

export const zh: Strings = {
	// ==================== Settings 面板 — 通用 ====================
	'settings.title.general': '通用',
	'settings.field.language': '界面语言',
	'settings.field.language.desc': '界面显示语言。Auto 跟随系统 locale。',
	'settings.option.auto': '自动',
	'settings.option.zh': '中文',
	'settings.option.en': 'English',

	// ==================== Settings 面板 — Chat ====================
	'settings.title.chat': '聊天模型',
	'settings.field.chatModel': '模型',
	'settings.field.chatModel.desc': '聊天模型标识',
	'settings.field.chatApiKey': 'API Key',
	'settings.field.chatApiKey.desc': '聊天模型 API 密钥',
	'settings.field.chatApiBase': 'API Base URL',
	'settings.field.chatApiBase.desc': '聊天模型 API 基础 URL',

	// ==================== Settings 面板 — Embedding ====================
	'settings.title.embedding': 'Embedding 模型',
	'settings.field.embedProvider': 'Provider',
	'settings.field.embedProvider.desc': '本地使用内置 ONNX 模型(零配置);API 使用 OpenAI 兼容端点(Ollama / SiliconFlow 等)。',
	'settings.option.embedProvider.local': '本地(内置)',
	'settings.option.embedProvider.api': 'API(外部)',
	'settings.field.embedLocalModel': '模型',
	'settings.field.embedLocalModel.desc': '本地 ONNX 模型标识(来自 HuggingFace Xenova/ 命名空间)',
	'settings.field.embedApiBase': 'API Base URL',
	'settings.field.embedApiBase.desc': 'Embedding API 基础 URL(Ollama:http://localhost:11434/v1)',
	'settings.field.embedApiKey': 'API Key',
	'settings.field.embedApiKey.desc': 'Embedding API 密钥(Ollama 留空)',
	'settings.field.embedApiModel': '模型',
	'settings.field.embedApiModel.desc': 'Embedding 模型标识',

	// ==================== Settings 面板 — Reranker ====================
	'settings.title.reranker': 'Reranker(可选)',
	'settings.field.rerankerProvider': 'Provider',
	'settings.field.rerankerProvider.desc': 'Reranker API 提供方。设置 API Key 即启用。',
	'settings.option.rerankerProvider.cohere': 'Cohere',
	'settings.option.rerankerProvider.jina': 'Jina',
	'settings.option.rerankerProvider.siliconflow': 'SiliconFlow',
	'settings.option.rerankerProvider.custom': '自定义',
	'settings.field.rerankerApiBase': 'API Base URL',
	'settings.field.rerankerApiBase.desc': 'Reranker API 基础 URL',
	'settings.field.rerankerApiKey': 'API Key',
	'settings.field.rerankerApiKey.desc': 'Reranker API 密钥。留空即关闭 Reranker。',
	'settings.field.rerankerModel': '模型',
	'settings.field.rerankerModel.desc': 'Reranker 模型标识',

	// ==================== Settings 面板 — Indexing ====================
	'settings.title.indexing': '索引',
	'settings.field.chunkSize': '分块大小(tokens)',
	'settings.field.chunkSize.desc': '每个分块的 token 数',
	'settings.field.chunkOverlap': '分块重叠(tokens)',
	'settings.field.chunkOverlap.desc': '相邻分块之间的重叠 token 数',
	'settings.field.autoIndex': '自动索引',
	'settings.field.autoIndex.desc': '文件变更时自动重建索引',

	// ==================== Settings 面板 — Link Suggestions ====================
	'settings.title.linkSuggestions': '链接建议',
	'settings.field.autoSuggestLinks': '自动建议链接',
	'settings.field.autoSuggestLinks.desc': '写入笔记后自动建议相关链接',
	'settings.field.linkConfidenceThreshold': '置信度阈值',
	'settings.field.linkConfidenceThreshold.desc': '建议链接的最低相似度',

	// ==================== Chat 侧栏 ====================
	'chat.you': '你',
	'chat.ratel': 'Ratel',
	'chat.placeholder': '问问你的 vault…',
	'chat.thinking': '思考中…',
	'chat.send': '发送',
	'chat.errorPrefix': '错误:',

	// ==================== Notice ====================
	'notice.indexNotReady': '索引尚未就绪',
	'notice.indexStatus': '索引:{n} 篇,最后更新:{when}',

	// ==================== 命令 ====================
	'cmd.askVault': '向 vault 提问',
	'cmd.showIndexStatus': '显示索引状态',
};
```

- [ ] **Step 2: 验证编译**

```bash
npx tsc --noEmit -p tsconfig.json
```

预期:无错误(两表同形,接口已强制对齐)。

- [ ] **Step 3: 提交**

```bash
git add src/i18n/zh.ts
git commit -m "feat(i18n): add Chinese translation table"
```

---

## Task 4: 翻译表完整性测试 `src/i18n/strings.test.ts`

**Files:**
- Create: `src/i18n/strings.test.ts`

- [ ] **Step 1: 写测试**

路径 `src/i18n/strings.test.ts`,完整内容:

```ts
/**
 * @file src/i18n/strings.test.ts
 * @description 验证 zh / en 翻译表 key 完全一致,值非空
 * @module i18n/strings.test
 *
 * 关键路径:
 * - key 对齐 + 值非空,是 i18n 的最基础不变量;
 *   谁加新 key 漏了另一边,这里会直接红。
 * - 编译期断言(末尾的 `const _zh: Strings = zh`)也会拦住,
 *   测试运行前就报错 —— 两道防线。
 */

import { describe, it, expect } from 'vitest';
import { en } from '../en';
import { zh } from '../zh';
import type { Strings } from '../types';

describe('i18n 翻译表', () => {
	it('zh 和 en 拥有完全相同的 key 集合', () => {
		expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
	});

	it('所有翻译值都是非空字符串', () => {
		// 关键路径:UI 渲染时若遇到空串,Obsidian 会显示一个空白分组,排查很费事。
		const all: Record<string, string> = { ...en, ...zh };
		for (const [k, v] of Object.entries(all)) {
			expect(typeof v, `key=${k}`).toBe('string');
			expect(v.length, `key=${k} 应非空`).toBeGreaterThan(0);
		}
	});
});

// 编译期断言:zh / en 都满足 Strings 接口。改 types.ts 加新 key,
// 这里两条 type 注释直接报错,自动拦住"只在一侧加 key"。
const _zh: Strings = zh;
const _en: Strings = en;
void _zh;
void _en;
```

- [ ] **Step 2: 跑测试,确认通过**

```bash
npx vitest run src/i18n/strings.test.ts
```

预期:2 个 test 全绿。

- [ ] **Step 3: 提交**

```bash
git add src/i18n/strings.test.ts
git commit -m "test(i18n): verify zh / en key alignment + non-empty values"
```

---

## Task 5: 运行时测试 `src/i18n/index.test.ts`(RED)

**Files:**
- Create: `src/i18n/index.test.ts`

- [ ] **Step 1: 写测试(此时 `index.ts` 还不存在,import 会失败)**

路径 `src/i18n/index.test.ts`,完整内容:

```ts
/**
 * @file src/i18n/index.test.ts
 * @description 验证 i18n 运行时:detectLang / applyLangPreference / tNow / t 反应式 store
 * @module i18n/index.test
 *
 * 关键路径:
 * - 每个 describe 用 beforeEach 把 currentLang 重置为 'en',避免测试间污染。
 * - navigator 是全局对象,测试里用 Object.defineProperty 替换;afterEach 还原。
 * - 测 vars 替换时只看子串包含,不严格等 —— 避免 i18n 措辞微调时测试无故红。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';
import { currentLang, t, tNow, applyLangPreference, detectLang } from '../index';
import type { StringKey } from '../types';

/** 临时改写 navigator.language,afterEach 还原。 */
function setNavLanguage(lang: string | undefined) {
	const value = lang === undefined ? undefined : { language: lang };
	Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}

describe('detectLang', () => {
	const originalNav = (globalThis as { navigator?: unknown }).navigator;
	afterEach(() => {
		Object.defineProperty(globalThis, 'navigator', { value: originalNav, configurable: true, writable: true });
	});

	it('中文 locale 全部判 zh', () => {
		for (const l of ['zh', 'zh-CN', 'zh-TW', 'zh-Hans']) {
			setNavLanguage(l);
			expect(detectLang()).toBe('zh');
		}
	});

	it('其他 locale 回退 en', () => {
		for (const l of ['en', 'en-US', 'ja', 'fr', '']) {
			setNavLanguage(l);
			expect(detectLang()).toBe('en');
		}
	});

	it('navigator 不可用时回退 en', () => {
		setNavLanguage(undefined);
		expect(detectLang()).toBe('en');
	});
});

describe('applyLangPreference', () => {
	beforeEach(() => currentLang.set('en'));

	it("'auto' 走 detectLang", () => {
		setNavLanguage('zh-CN');
		applyLangPreference('auto');
		expect(get(currentLang)).toBe('zh');
	});

	it("'zh' / 'en' 直接生效,忽略 navigator", () => {
		setNavLanguage('zh-CN');
		applyLangPreference('en');
		expect(get(currentLang)).toBe('en');

		setNavLanguage('en-US');
		applyLangPreference('zh');
		expect(get(currentLang)).toBe('zh');
	});
});

describe('tNow(非反应式取字符串)', () => {
	beforeEach(() => currentLang.set('en'));

	it('返回当前语言的字符串', () => {
		currentLang.set('zh');
		expect(tNow('chat.you' as StringKey)).toBe('你');
		currentLang.set('en');
		expect(tNow('chat.you' as StringKey)).toBe('You');
	});

	it('vars 替换 {key} 占位', () => {
		const out = tNow('notice.indexStatus' as StringKey, { n: 5, when: '2026-06-14' });
		expect(out).toContain('5');
		expect(out).toContain('2026-06-14');
	});

	it('vars 多余 / 缺失的 key 静默忽略(不抛错)', () => {
		// 关键路径:翻译表常迭代,严格校验会拖慢节奏;占位符缺失就字面量保留。
		expect(() => tNow('chat.you' as StringKey, { x: 1 } as Record<string, string | number>)).not.toThrow();
	});
});

describe('t 反应式 store', () => {
	it('currentLang 变化时 t 重新发射(新函数读新 lang)', () => {
		const fns: Array<(key: StringKey, vars?: Record<string, string | number>) => string> = [];
		const unsub = t.subscribe((f) => fns.push(f));
		currentLang.set('zh');
		currentLang.set('en');
		unsub();
		expect(fns.length).toBeGreaterThanOrEqual(3); // 初始 + 两次 set
		const last = fns[fns.length - 1]!;
		expect(last('chat.you' as StringKey)).toBe('You');
	});
});
```

- [ ] **Step 2: 跑测试,确认 RED(import 失败)**

```bash
npx vitest run src/i18n/index.test.ts
```

预期:FAIL —— `Failed to resolve import "../index" from ... Does the file exist?`

- [ ] **Step 3: 不提交(继续 Task 6)**

---

## Task 6: 运行时模块 `src/i18n/index.ts`(GREEN)

**Files:**
- Create: `src/i18n/index.ts`

- [ ] **Step 1: 实现**

路径 `src/i18n/index.ts`,完整内容:

```ts
/**
 * @file src/i18n/index.ts
 * @description i18n 运行时 — store / t / tNow / detectLang / applyLangPreference
 * @module i18n
 * @depends svelte/store, ./types, ./en, ./zh
 *
 * 设计要点:
 * - currentLang 是 `writable<Lang>`;t 是 `derived(currentLang, ...)`,
 *   当前 lang 改变时重新发射一个"读取该 lang 的 t 函数"。
 * - Svelte 模板里写 `$t('key')` 利用 svelte/store 自动订阅,store 变即重渲染。
 * - 非 Svelte 代码(main.ts / settings.ts)用 tNow 一次性取值,无需订阅。
 * - vars 占位用 `{key}` 简单 String.replace,非正则 —— 翻译表保持 JSON 可序列化。
 */

import { writable, derived, get, type Readable } from 'svelte/store';
import { en } from './en';
import { zh } from './zh';
import type { Lang, LangPreference, Strings } from './types';

export type { Lang, LangPreference, StringKey } from './types';
export type { Strings } from './types';

/** t 函数签名:key 必填,vars 可选(用于 {key} 占位替换)。 */
export type TFunction = (key: keyof Strings, vars?: Record<string, string | number>) => string;

const _currentLang = writable<Lang>('en');

/** 当前语言(Svelte store)。Svelte 模板里用 $currentLang 订阅。 */
export const currentLang: Readable<Lang> = { subscribe: _currentLang.subscribe };

/** 反应式 t:currentLang 变就重新发射一个读新 lang 的 t 函数。 */
export const t: Readable<TFunction> = derived(_currentLang, ($lang) => {
	const table = $lang === 'zh' ? zh : en;
	return (key, vars) => {
		let s = table[key];
		if (vars) {
			for (const [k, v] of Object.entries(vars)) {
				s = s.replace(`{${k}}`, String(v));
			}
		}
		return s;
	};
});

/** 检测系统 locale;'zh' / 'zh-CN' / 'zh-TW' / 'zh-Hans' 都算中文,其他回退 'en'。 */
export function detectLang(): Lang {
	const raw = (typeof navigator !== 'undefined' ? navigator.language : 'en').toLowerCase();
	return raw.startsWith('zh') ? 'zh' : 'en';
}

/** 把 'auto' 解析后写入 currentLang;显式 'zh' / 'en' 直接用。 */
export function applyLangPreference(pref: LangPreference): void {
	_currentLang.set(pref === 'auto' ? detectLang() : pref);
}

/** 非反应式便利函数:给 main.ts / settings.ts 一次性取字符串(无需订阅 store)。 */
export function tNow(key: keyof Strings, vars?: Record<string, string | number>): string {
	return get(t)(key, vars);
}
```

- [ ] **Step 2: 跑测试,确认 GREEN**

```bash
npx vitest run src/i18n/
```

预期:5 个 describe 全绿(`strings.test` 2 + `index.test` 4 = 6 个 it),无失败。

- [ ] **Step 3: 全量测试确认无回归**

```bash
npm test
```

预期:103 现有 + 6 新增 = 109 全绿。

- [ ] **Step 4: 提交**

```bash
git add src/i18n/index.ts src/i18n/index.test.ts
git commit -m "feat(i18n): add runtime — currentLang store, t, tNow, detectLang, applyLangPreference"
```

---

## Task 7: `src/settings.ts` 改造

**Files:**
- Modify: `src/settings.ts`(全文件)
- Test: 手动验证(在 Obsidian 中打开设置面板确认字段显示正确)

- [ ] **Step 1: 加 import**

在 `src/settings.ts` 顶部,原 `import { App, PluginSettingTab, Setting } from 'obsidian';` 之后,新增:

```ts
import { tNow, applyLangPreference } from './i18n';
import type { LangPreference } from './i18n/types';
```

- [ ] **Step 2: `RatelVaultSettings` 接口加 `language` 字段**

在 `// Chat` 那组字段之前(放在最顶部,作为 "General" 概念),修改:

旧:
```ts
export interface RatelVaultSettings {
	// Chat
	chatModel: string;
```

新:
```ts
export interface RatelVaultSettings {
	// General
	language: LangPreference;

	// Chat
	chatModel: string;
```

- [ ] **Step 3: `DEFAULT_SETTINGS` 加 `language: 'auto'`**

旧:
```ts
export const DEFAULT_SETTINGS: RatelVaultSettings = {
	chatModel: 'deepseek-chat',
```

新:
```ts
export const DEFAULT_SETTINGS: RatelVaultSettings = {
	language: 'auto',

	chatModel: 'deepseek-chat',
```

- [ ] **Step 4: `display()` 顶部插入 General 分组**

在 `display(): void {` 方法体第一行 `const { containerEl } = this;` 之后,`containerEl.empty();` 之前,插入 General 分组(注意:`empty()` 之前或之后都行,选之前更直观):

实际修改:把 `display()` 方法体开头改成:

```ts
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// ==================== General ====================
		containerEl.createEl('h2', { text: tNow('settings.title.general') });

		new Setting(containerEl)
			.setName(tNow('settings.field.language'))
			.setDesc(tNow('settings.field.language.desc'))
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						auto: tNow('settings.option.auto'),
						zh: tNow('settings.option.zh'),
						en: tNow('settings.option.en'),
					})
					.setValue(this.plugin.settings.language)
					.onChange(async (value: string) => {
						const pref = value as LangPreference;
						this.plugin.settings.language = pref;
						await this.plugin.saveSettings();
						// 关键路径:applyLangPreference 写 store,display() 重建 UI;
						// 二者顺序:store 先,display 后 —— 这样重建时 tNow 读新 lang。
						applyLangPreference(pref);
						this.display();
					}),
			);

		// ==================== Chat ====================
		containerEl.createEl('h2', { text: tNow('settings.title.chat') });
```

(原文件中 `// ==================== Chat ====================` 段开头的 `containerEl.createEl('h2', { text: 'Chat Model' });` 那行要删掉,因为我们已经在上面加过。)

- [ ] **Step 5: 把 `display()` 内所有剩余硬编码字符串替换为 `tNow(...)`**

具体替换(每行一个,全文件):

| 旧 | 新 |
|---|---|
| `text: 'Chat Model'` | `text: tNow('settings.title.chat')` (已在 Step 4 处理) |
| `setName('Model')`(Chat 段) | `setName(tNow('settings.field.chatModel'))` |
| `setDesc('Chat model identifier')` | `setDesc(tNow('settings.field.chatModel.desc'))` |
| `setName('API Key')`(Chat 段) | `setName(tNow('settings.field.chatApiKey'))` |
| `setDesc('Chat model API key')` | `setDesc(tNow('settings.field.chatApiKey.desc'))` |
| `setName('API Base URL')`(Chat 段) | `setName(tNow('settings.field.chatApiBase'))` |
| `setDesc('Chat model API base URL')` | `setDesc(tNow('settings.field.chatApiBase.desc'))` |
| `text: 'Embedding Model'` | `text: tNow('settings.title.embedding')` |
| `setName('Provider')`(Embedding 段) | `setName(tNow('settings.field.embedProvider'))` |
| `setDesc('Local uses built-in ONNX model ...')` | `setDesc(tNow('settings.field.embedProvider.desc'))` |
| `addOptions({ local: 'Local (built-in)', api: 'API (external)' })` | `addOptions({ local: tNow('settings.option.embedProvider.local'), api: tNow('settings.option.embedProvider.api') })` |
| `setName('Model')`(embedLocal 段) | `setName(tNow('settings.field.embedLocalModel'))` |
| `setDesc('Local ONNX model identifier ...')` | `setDesc(tNow('settings.field.embedLocalModel.desc'))` |
| `setName('API Base URL')`(embedApi 段) | `setName(tNow('settings.field.embedApiBase'))` |
| `setDesc('Embedding API base URL ...')` | `setDesc(tNow('settings.field.embedApiBase.desc'))` |
| `setName('API Key')`(embedApi 段) | `setName(tNow('settings.field.embedApiKey'))` |
| `setDesc('Embedding API key ...')` | `setDesc(tNow('settings.field.embedApiKey.desc'))` |
| `setName('Model')`(embedApi 段) | `setName(tNow('settings.field.embedApiModel'))` |
| `setDesc('Embedding model identifier')` | `setDesc(tNow('settings.field.embedApiModel.desc'))` |
| `text: 'Reranker (Optional)'` | `text: tNow('settings.title.reranker')` |
| `setName('Provider')`(Reranker 段) | `setName(tNow('settings.field.rerankerProvider'))` |
| `setDesc('Reranker API provider ...')` | `setDesc(tNow('settings.field.rerankerProvider.desc'))` |
| `addOptions({ cohere: 'Cohere', jina: 'Jina', siliconflow: 'SiliconFlow', custom: 'Custom' })` | `addOptions({ cohere: tNow('settings.option.rerankerProvider.cohere'), jina: tNow('settings.option.rerankerProvider.jina'), siliconflow: tNow('settings.option.rerankerProvider.siliconflow'), custom: tNow('settings.option.rerankerProvider.custom') })` |
| `setName('API Base URL')`(Reranker 段) | `setName(tNow('settings.field.rerankerApiBase'))` |
| `setDesc('Reranker API base URL')` | `setDesc(tNow('settings.field.rerankerApiBase.desc'))` |
| `setName('API Key')`(Reranker 段) | `setName(tNow('settings.field.rerankerApiKey'))` |
| `setDesc('Reranker API key. Leave empty ...')` | `setDesc(tNow('settings.field.rerankerApiKey.desc'))` |
| `setName('Model')`(Reranker 段) | `setName(tNow('settings.field.rerankerModel'))` |
| `setDesc('Reranker model identifier')` | `setDesc(tNow('settings.field.rerankerModel.desc'))` |
| `text: 'Indexing'` | `text: tNow('settings.title.indexing')` |
| `setName('Chunk size (tokens)')` | `setName(tNow('settings.field.chunkSize'))` |
| `setDesc('Number of tokens per chunk')` | `setDesc(tNow('settings.field.chunkSize.desc'))` |
| `setName('Chunk overlap (tokens)')` | `setName(tNow('settings.field.chunkOverlap'))` |
| `setDesc('Overlap between chunks')` | `setDesc(tNow('settings.field.chunkOverlap.desc'))` |
| `setName('Auto index')` | `setName(tNow('settings.field.autoIndex'))` |
| `setDesc('Automatically re-index on file changes')` | `setDesc(tNow('settings.field.autoIndex.desc'))` |
| `text: 'Link Suggestions'` | `text: tNow('settings.title.linkSuggestions')` |
| `setName('Auto suggest links')` | `setName(tNow('settings.field.autoSuggestLinks'))` |
| `setDesc('Automatically suggest links after writing')` | `setDesc(tNow('settings.field.autoSuggestLinks.desc'))` |
| `setName('Confidence threshold')` | `setName(tNow('settings.field.linkConfidenceThreshold'))` |
| `setDesc('Minimum similarity to suggest a link')` | `setDesc(tNow('settings.field.linkConfidenceThreshold.desc'))` |

注意:`setPlaceholder(...)` 的 placeholder 串保持英文 —— 它们是给 input 的示例,跟随接口风格,不在 i18n 范围(v1)。

- [ ] **Step 6: 验证编译**

```bash
npx tsc --noEmit -p tsconfig.json
```

预期:无错误。

- [ ] **Step 7: 验证构建**

```bash
npm run build
```

预期:成功产出 `dist/main.js` + `dist/worker.js`,无报错。

- [ ] **Step 8: 提交**

```bash
git add src/settings.ts
git commit -m "feat(i18n): integrate language switch into settings panel"
```

---

## Task 8: `src/main.ts` 改造

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: 加 import**

在 `import path from 'path';` 之后,新增:

```ts
import { tNow, applyLangPreference } from './i18n';
```

- [ ] **Step 2: `onload` 启动时应用语言**

在 `onload` 方法体 `await this.loadSettings();` 之后,`// ==================== 适配器装配 ====================` 之前,新增一行:

```ts
		// 关键路径:settings.language 决定 currentLang 初始值;
		// 后续切换由 settings.ts 的 Language 下拉 onChange 触发。
		applyLangPreference(this.settings.language);
```

- [ ] **Step 3: 命令名本地化**

旧:
```ts
		this.addCommand({
			id: 'ask-vault',
			name: 'Ask vault',
```

新:
```ts
		this.addCommand({
			id: 'ask-vault',
			name: tNow('cmd.askVault'),
```

旧:
```ts
		this.addCommand({
			id: 'index-status',
			name: 'Show index status',
```

新:
```ts
		this.addCommand({
			id: 'index-status',
			name: tNow('cmd.showIndexStatus'),
```

- [ ] **Step 4: Notice 本地化**

旧:
```ts
				if (response.type === 'index.status.result') {
					new Notice(`Index: ${response.payload.totalDocs} docs, last: ${new Date(response.payload.lastIndexTime).toLocaleString()}`);
				} else {
					new Notice('Index not available yet');
				}
```

新:
```ts
				if (response.type === 'index.status.result') {
					new Notice(tNow('notice.indexStatus', {
						n: response.payload.totalDocs,
						when: new Date(response.payload.lastIndexTime).toLocaleString(),
					}));
				} else {
					new Notice(tNow('notice.indexNotReady'));
				}
```

- [ ] **Step 5: 验证编译 + 构建**

```bash
npx tsc --noEmit -p tsconfig.json && npm run build
```

预期:无错误。

- [ ] **Step 6: 提交**

```bash
git add src/main.ts
git commit -m "feat(i18n): localize command names + notices in main.ts"
```

---

## Task 9: `src/ui/ChatView.svelte` 改造

**Files:**
- Modify: `src/ui/ChatView.svelte`

- [ ] **Step 1: 加 import**

在 `<script lang="ts">` 块最顶部,`import type RatelVaultPlugin from '../main';` 之后,新增:

```ts
	import { currentLang, t } from '../i18n';
```

- [ ] **Step 2: 替换 `catch` 里的错误前缀**

旧:
```ts
		} catch (err) {
			assistantMsg.content += '\n\n⚠ Error: ' + (err instanceof Error ? err.message : String(err));
			messages = [...messages];
		}
```

新:
```ts
		} catch (err) {
			// 关键路径:错误内容(err.message)保留英文,v1 不翻译 LLM / 工具原始错误。
			assistantMsg.content += '\n\n⚠ ' + $t('chat.errorPrefix') + (err instanceof Error ? err.message : String(err));
			messages = [...messages];
		}
```

旧(`for await` 里 case 'error'):
```ts
				case 'error':
					assistantMsg.content += '\n\n⚠ Error: ' + event.payload.message;
					messages = [...messages];
					break;
```

新:
```ts
				case 'error':
					assistantMsg.content += '\n\n⚠ ' + $t('chat.errorPrefix') + event.payload.message;
					messages = [...messages];
					break;
```

- [ ] **Step 3: 替换模板内硬编码字符串**

旧:
```svelte
		{#each messages as msg}
			<div class="ratel-message ratel-{msg.role}">
				<div class="ratel-role">{msg.role === 'user' ? 'You' : 'Ratel'}</div>
				<div class="ratel-content">{msg.content}</div>
			</div>
		{/each}
		{#if isRunning && messages[messages.length - 1]?.content === ''}
			<div class="ratel-typing">Thinking...</div>
		{/if}
```

新:
```svelte
		{#each messages as msg}
			<div class="ratel-message ratel-{msg.role}">
				<div class="ratel-role">{msg.role === 'user' ? $t('chat.you') : $t('chat.ratel')}</div>
				<div class="ratel-content">{msg.content}</div>
			</div>
		{/each}
		{#if isRunning && messages[messages.length - 1]?.content === ''}
			<div class="ratel-typing">{$t('chat.thinking')}</div>
		{/if}
```

旧:
```svelte
		<textarea
			bind:value={input}
			on:keydown={handleKeydown}
			placeholder="Ask about your vault..."
			disabled={isRunning}
			rows="2"
		></textarea>
		<button on:click={sendMessage} disabled={isRunning || !input.trim()}>
			Send
		</button>
```

新:
```svelte
		<textarea
			bind:value={input}
			on:keydown={handleKeydown}
			placeholder={$t('chat.placeholder')}
			disabled={isRunning}
			rows="2"
		></textarea>
		<button on:click={sendMessage} disabled={isRunning || !input.trim()}>
			{$t('chat.send')}
		</button>
```

- [ ] **Step 4: 验证编译 + 构建**

```bash
npx tsc --noEmit -p tsconfig.json && npm run build
```

预期:无错误。

- [ ] **Step 5: 提交**

```bash
git add src/ui/ChatView.svelte
git commit -m "feat(i18n): localize ChatView strings via \$t"
```

---

## Task 10: 文档更新 `docs/contributing/how-to-test.md`

**Files:**
- Modify: `docs/contributing/how-to-test.md`

- [ ] **Step 1: 在 § 4.1(切换 Embedding Provider)之前插入 § 4.0 切换语言**

找到 `### 4.1 切换 Embedding Provider`,在它之前插入新段:

```markdown
### 4.0 切换语言

`Settings` → `Ratel` → `General` → `Language`:

- `Auto`:跟随 `navigator.language`,zh 开头判中文,否则英文(默认)
- `中文` / `English`:显式选

**关键路径验证:**

| 检查项 | 预期 |
|---|---|
| 切到中文后所有分组标题变中文 | "聊天模型" / "Embedding 模型" / "索引" / "链接建议" |
| 切到中文后所有 setName / setDesc 变中文 | "模型" / "API Key" / "分块大小(tokens)" 等 |
| 切到中文后 Chat 侧栏变中文 | placeholder "问问你的 vault…",Send 按钮 "发送" |
| 切到中文后旧 chat 消息 | 保留原状(已发消息的字面内容不变,只 role 标签 "你/Ratel" 刷新) |
| 切到中文后命令面板里命令名 | **不更新** —— addCommand 是 onload 一次性注册;要看到中文命令名需 toggle 插件或重启 Obsidian |

**已知限制**:命令名是 onload 时一次性调 `tNow(...)` 注册的;settings / Chat 侧栏 / Notice 都靠反应式 store 自动重渲染,但命令面板的描述是 Obsidian 框架缓存的。改语言后:① 在 Settings 面板点 "Reload app" 一次,或 ② 关闭再启用插件,或 ③ 重启 Obsidian —— 任选其一即可。
```

- [ ] **Step 2: 验证渲染(markdown 语法)**

```bash
# 本地直接 cat 看就行;没有专门的 lint
cat docs/contributing/how-to-test.md | head -100
```

预期:新段落在 § 4.1 之前。

- [ ] **Step 3: 提交**

```bash
git add docs/contributing/how-to-test.md
git commit -m "docs: add i18n test scenario + command name reload limitation"
```

---

## Task 11: 最终验证

**Files:** 无(仅跑命令)

- [ ] **Step 1: 全量测试**

```bash
npm test
```

预期:109 个 test 全绿(103 现有 + 6 新增 i18n)。

- [ ] **Step 2: lint**

```bash
npm run lint
```

预期:无新增错误(`*.svelte` 已知 parser 缺失不在范围)。

- [ ] **Step 3: 类型检查**

```bash
npx tsc --noEmit -p tsconfig.json
```

预期:无错误。

- [ ] **Step 4: 构建**

```bash
npm run build
```

预期:`dist/main.js` + `dist/worker.js` 成功产出。

- [ ] **Step 5: 在 Obsidian 里手动跑一遍**

按 `docs/contributing/how-to-test.md` 的场景 2(聊天侧栏)+ 场景 4(状态命令)+ 新增的 § 4.0(语言切换)各跑一次:

- 打开 Obsidian → Sandbox vault → 启用 Ratel
- 控制台应看到 `Ratel loaded`
- 命令面板 → "Show index status" → Notice 应是 "索引尚未就绪"(中文)或 "Index not available yet"(英文)
- 设置面板 → 切到中文 → 切到 English → 切回 Auto,观察所有字段实时刷新
- ribbon 唤起侧栏 → placeholder / Send 按钮跟随语言变
- 已知限制验证:命令名在切语言后**不更新** —— toggle 插件一次再观察

预期:全部表现如测试手册所述。

- [ ] **Step 6: 更新 STATUS.md**

打开 `docs/superpowers/STATUS.md`,在 `## 实施 Plan(任务拆解)` 表格末尾加一行:

```markdown
| P-I18N-IMPL | [2026-06-14-ratel-i18n-implementation.md](plans/2026-06-14-ratel-i18n-implementation.md) | ⏳ Pending | — | — | — | S-I18N |
```

(实际 commit 时把状态改为 ✅ Completed + commit hash。)

在 `## 活跃 Spec` 表格 S-I18N 行,把状态从 `Draft` 改为 `Active`。

- [ ] **Step 7: 提交(若 Step 6 改了文件)**

```bash
git add docs/superpowers/STATUS.md
git commit -m "docs: mark S-I18N active + P-I18N-IMPL completed in STATUS"
```

---

## 自审

- ✅ Spec 覆盖:§ 4.1 → Task 1;§ 4.2 → Task 2/3;§ 4.3 → Task 6;§ 4.4 settings → Task 7;main.ts → Task 8;ChatView → Task 9;§ 4.6 → Task 4/5;§ 4.7 边界 → 散在各 Task 的实现注释;§ 5.1 新增文件 → Task 1-6;§ 5.2 修改文件 → Task 7-9;§ 5.3 文档 → Task 10 + Task 11 Step 6;§ 5.4 依赖 → 无 Task 需要;§ 5.5 测试 → Task 4/5/6/11
- ✅ 占位扫描:无 TBD / TODO
- ✅ 类型一致:`currentLang` / `t` / `tNow` / `applyLangPreference` / `detectLang` / `Lang` / `LangPreference` / `StringKey` / `Strings` 在各 Task 中名字一致
- ✅ 关键路径注释:在 settings.ts / main.ts / ChatView.svelte 的关键改动处都标了 `// 关键路径:`
