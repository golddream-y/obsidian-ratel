# S-SR-LAYERING 实施计划(记忆与 Skill 分层注入 + 统一注入管理器 + 使用统计)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 PRD §7.5 分层注入(SR-02)与使用反馈(SR-03):PromptInjector 统一注入管理器、global.md 段落级 pinned、topics top-K 自动注入、Skill Discovery 相关性排序 + instructions 截断、使用统计、三个 settings 限制字段接线、ADR-016 与架构文档。

**Architecture:** 注入源 ID 用 `as const` 元组集中登记(AGENTS.md 枚举规范);ContextManager 三个动态 setter(env/memory/skills)内部改走 PromptInjector,外部签名零变化;记忆分层在 composer 纯函数内实现(pinned 恒留 + normal 预算 + relatedTopics 块 + 总预算裁剪);Skill 激活路径(ADR-012 Session.messages)只加截断与计数,不经 injector。

**Tech Stack:** TypeScript(strict)、vitest、Svelte 5(MemoryPanel)、esbuild。

**Spec:** [docs/superpowers/specs/2026-08-19-sr-layering-design.md](../specs/2026-08-19-sr-layering-design.md)

---

## 文件结构

```
新增:
  src/prompts/injection/ids.ts          # 注入源 ID 登记(as const 元组)
  src/prompts/injection/injector.ts     # InjectionSource 接口 + PromptInjector + truncateUtf8Bytes
  src/core/usage-stats.ts               # 使用统计存储(usage-stats.json 读写)
  docs/adr/2026-08-19-layered-injection.md  # ADR-016
  tests/prompts/injection.test.ts
  tests/prompts/composer-memory-layering.test.ts
  tests/core/usage-stats.test.ts
  tests/skills/skill-activator-ranking.test.ts

修改:
  src/core/context-manager.ts           # setter 内部接 injector;toMessages 拉段
  src/prompts/composer.ts               # composeMemorySystemPrompt 分层选项
  src/prompts/defaults/zh.ts            # memory.systemPrompt 模板加 {{relatedTopics}}
  src/prompts/sections.ts               # placeholders 登记 relatedTopics
  src/prompts/index.ts                  # barrel 导出 injection
  src/core/memory-store.ts              # splitGlobalSections 纯函数
  src/tools/search-memory.ts            # 30KB 硬编码改消费 settings
  src/tools/activate-skill.ts           # 8KB 截断 + 统计
  src/skills/skill-activator.ts         # 相关性排序 + i18n fallback
  src/core/agent-loop.ts                # composeDiscovery 传 query
  src/settings.ts                       # memoryTopicsAutoInjectK + declarative 项
  src/i18n/zh.ts / en.ts / types.ts     # 新 key
  src/main.ts                           # 装配 usageStats + relatedTopics 检索
  src/ui/skills/SkillManageModal.ts     # 使用次数
  src/ui/memory-panel/MemoryPanel.svelte # 命中次数
  docs/architecture/agent/prompt-management.md / context-manager.md / capability-surface.md
```

---

## Task 1: 注入层骨架(ids + injector + ContextManager 接线)

**Files:**
- Create: `src/prompts/injection/ids.ts`
- Create: `src/prompts/injection/injector.ts`
- Modify: `src/prompts/index.ts`(barrel)
- Modify: `src/core/context-manager.ts`
- Test: `tests/prompts/injection.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/prompts/injection.test.ts
import { describe, it, expect } from 'vitest';
import { INJECTION_SOURCE_IDS, type InjectionSourceId } from '../../src/prompts/injection/ids';
import { PromptInjector, truncateUtf8Bytes } from '../../src/prompts/injection/injector';

describe('INJECTION_SOURCE_IDS', () => {
	it('登记表 - 含 env/memory/skills 三源且无重复', () => {
		expect([...INJECTION_SOURCE_IDS]).toEqual(['env', 'memory', 'skills']);
		expect(new Set(INJECTION_SOURCE_IDS).size).toBe(INJECTION_SOURCE_IDS.length);
	});
});

describe('PromptInjector', () => {
	it('buildSections - 按注册序组装且跳过 null 段', () => {
		const inj = new PromptInjector();
		inj.register({ id: 'env', build: () => '现在时间 10:00' });
		inj.register({ id: 'memory', build: () => null });
		inj.register({ id: 'skills', build: () => '## 可用技能' });
		const secs = inj.buildSections();
		expect(secs.map((s) => s.id)).toEqual(['env', 'skills']);
		expect(secs[0]!.content).toContain('10:00');
	});

	it('register - 重复 id 抛错', () => {
		const inj = new PromptInjector();
		inj.register({ id: 'env', build: () => 'a' });
		expect(() => inj.register({ id: 'env', build: () => 'b' })).toThrow();
	});

	it('ownBudgetBytes - 超预算尾部截断', () => {
		const inj = new PromptInjector();
		inj.register({ id: 'memory', build: () => 'x'.repeat(3000), ownBudgetBytes: 1024 });
		const [sec] = inj.buildSections();
		expect(Buffer.byteLength(sec!.content, 'utf-8')).toBe(1024);
	});
});

describe('truncateUtf8Bytes', () => {
	it('中文按 UTF-8 字节截断 - 不超过上限', () => {
		const text = '忆'.repeat(2000); // 每字 3 字节,共 6000
		const out = truncateUtf8Bytes(text, 3000);
		expect(Buffer.byteLength(out, 'utf-8')).toBeLessThanOrEqual(3000);
	});

	it('未超限 - 原样返回', () => {
		expect(truncateUtf8Bytes('abc', 100)).toBe('abc');
	});
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/prompts/injection.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 ids.ts**

```typescript
/**
 * @file src/prompts/injection/ids.ts
 * @description 注入源 ID 集中登记表 — 动态 prompt 段的唯一清单(S-SR-LAYERING)
 * @module prompts/injection/ids
 */

/**
 * 全部注入源 ID;新增动态 system 段必须在此登记,禁止调用点裸字符串。
 *
 * 设计要点(为什么不用 TS enum,见 AGENTS.md「枚举与 ID 集中管理」):
 * - as const 元组零运行时产物(esbuild 友好);const enum 跨文件在 isolatedModules 下退化。
 * - 一份声明同时得到可遍历的值清单与字面量联合类型;enum 的类型/值是两份维护。
 * - searchResults 不入此表:它是消息数组路径(pruneSearchBlocks 逐条 push),非单段 system 文本。
 */
export const INJECTION_SOURCE_IDS = [
	'env', // 本地时间等环境行
	'memory', // 记忆 global + topics top-K(S-SR-LAYERING)
	'skills', // Skill Discovery 段
] as const;

export type InjectionSourceId = (typeof INJECTION_SOURCE_IDS)[number];
```

- [ ] **Step 4: 实现 injector.ts**

```typescript
/**
 * @file src/prompts/injection/injector.ts
 * @description PromptInjector — 动态注入段的统一组装器与预算执行点(S-SR-LAYERING)
 * @module prompts/injection/injector
 * @depends prompts/injection/ids
 */

import type { InjectionSourceId } from './ids';

/** 注入源接口 — 每个动态 system 段实现一份,向 PromptInjector 注册 */
export interface InjectionSource {
	id: InjectionSourceId;
	/** 构建本段内容;返回 null 表示本段缺席(不注入) */
	build(): string | null;
	/** 本段字节预算硬上限(未设 = 不限);超出尾部截断 — 兜底,源内部应先自限 */
	ownBudgetBytes?: number;
}

/** 组装产物 — 注入源 id + 最终文本 */
export interface InjectedSection {
	id: InjectionSourceId;
	content: string;
}

/**
 * 按 UTF-8 字节做尾部截断 — 供 injector 兜底与各注入路径复用。
 *
 * 关键路径:中文每字 3 字节,字符串 length 判断会漏;必须 Buffer.byteLength。
 * 截断可能切到字符中间,解码时产生替换符,不影响 LLM 阅读。
 */
export function truncateUtf8Bytes(text: string, maxBytes: number): string {
	const byteLength = Buffer.byteLength(text, 'utf-8');
	if (byteLength <= maxBytes) return text;
	return Buffer.from(text, 'utf-8').subarray(0, maxBytes).toString('utf-8');
}

/**
 * 统一注入管理器 — 动态 system 段的唯一组装出口。
 *
 * 设计要点:
 * - 源负责构建(有状态,由 ContextManager 既有 setter 写状态);管理器负责组装与预算兜底。
 * - 静态段(zone: static)仍走 sections.ts 注册表;injector 只管动态段,模板解析不重复造。
 * - 预算裁剪的主体在源内部(如 composer 的 memory 分层);ownBudgetBytes 是最后防线。
 */
export class PromptInjector {
	private sources = new Map<InjectionSourceId, InjectionSource>();

	/** 登记注入源;id 重复视为编码错误,直接抛错 */
	register(source: InjectionSource): void {
		if (this.sources.has(source.id)) {
			throw new Error(`注入源重复注册: ${source.id}`);
		}
		this.sources.set(source.id, source);
	}

	/** 按注册序组装;null/空串段跳过,超 ownBudgetBytes 尾部截断 */
	buildSections(): InjectedSection[] {
		const out: InjectedSection[] = [];
		for (const source of this.sources.values()) {
			const content = source.build();
			if (content === null || content === '') continue;
			const bounded = source.ownBudgetBytes !== undefined
				? truncateUtf8Bytes(content, source.ownBudgetBytes)
				: content;
			out.push({ id: source.id, content: bounded });
		}
		return out;
	}
}
```

- [ ] **Step 5: 运行测试通过**

Run: `npx vitest run tests/prompts/injection.test.ts`
Expected: PASS(6 个用例)

- [ ] **Step 6: barrel 导出**

在 `src/prompts/index.ts` 追加:

```typescript
export * from './injection/ids';
export * from './injection/injector';
```

- [ ] **Step 7: ContextManager 接线(不改外部签名)**

在 `src/core/context-manager.ts`:

7a. import 区加:

```typescript
import { PromptInjector } from '../prompts/injection/injector';
```

7b. 类字段区(与既有 `private envContextLine` 等声明并列)加:

```typescript
/** 统一注入管理器 — env/memory/skills 三段唯一组装出口(S-SR-LAYERING) */
private readonly injector = new PromptInjector();
```

7c. constructor 末尾注册三源(build 读自身既有字段,refresh 时机不变):

```typescript
// 关键路径(S-SR-LAYERING):动态段统一走 injector;setter 签名不变,仅内部状态写入。
this.injector.register({ id: 'env', build: () => this.envContextLine || null });
this.injector.register({ id: 'memory', build: () => this.memorySystemPrompt || null });
this.injector.register({ id: 'skills', build: () => this.skillsDiscovery || null });
```

7d. `toMessages()` 中替换原三个 if 块(`if (this.envContextLine) ...` 到 `if (this.skillsDiscovery) ...`)为:

```typescript
// 关键路径(S-SR-LAYERING):动态段从 injector 拉取;顺序 env → memory → skills 与原实现一致。
for (const section of this.injector.buildSections()) {
	messages.push({ role: 'system', content: section.content });
}
```

- [ ] **Step 8: 全量回归**

Run: `npx vitest run`
Expected: 全部 PASS(既有 context-manager 系列测试零改动通过 — 注入顺序与内容不变)

- [ ] **Step 9: Commit**

```bash
git add src/prompts/injection/ src/prompts/index.ts src/core/context-manager.ts tests/prompts/injection.test.ts
git commit -m "feat: PromptInjector 统一注入管理器 — 动态段集中组装与预算兜底(S-SR-LAYERING)"
```

---

## Task 2: 记忆分层解析与 composer 预算(pinned + settings 接线)

**Files:**
- Modify: `src/core/memory-store.ts`(splitGlobalSections)
- Modify: `src/prompts/composer.ts`(composeMemorySystemPrompt 分层选项)
- Modify: `src/prompts/defaults/zh.ts`、`src/prompts/sections.ts`(relatedTopics 占位符)
- Modify: `src/tools/search-memory.ts`(消费 memoryDynamicLimitKB)
- Test: `tests/prompts/composer-memory-layering.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/prompts/composer-memory-layering.test.ts
import { describe, it, expect } from 'vitest';
import { composeMemorySystemPrompt } from '../../src/prompts/composer';
import { splitGlobalSections } from '../../src/core/memory-store';

const GLOBAL = `---
memory_type: global
updated: 2026-08-19T00:00:00.000Z
---

## 偏好 [pinned]
- 日记在 03_Daily/

## 当前项目
- ${'很长的项目说明。'.repeat(2000)}

## 关键决策 [pinned]
- 用 Obsidian`;
const KB = 1024;

describe('splitGlobalSections', () => {
	it('pinned 标记 - 段落完整进 pinned 桶', () => {
		const { pinned, normal } = splitGlobalSections(GLOBAL);
		expect(pinned).toContain('## 偏好');
		expect(pinned).toContain('日记在 03_Daily');
		expect(pinned).toContain('## 关键决策');
		expect(pinned).not.toContain('当前项目');
		expect(normal).toContain('当前项目');
	});

	it('无 pinned 标记 - 全部进 normal(向后兼容)', () => {
		const { pinned } = splitGlobalSections('## 偏好\n- 内容');
		expect(pinned).toBe('');
	});
});

describe('composeMemorySystemPrompt 分层', () => {
	it('pinned 段 - 超预算也完整保留', () => {
		const text = composeMemorySystemPrompt(GLOBAL, [], {}, {
			injectLimitBytes: 1 * KB,
			totalLimitBytes: 64 * KB,
			relatedTopics: [],
		});
		expect(text).toContain('日记在 03_Daily');
		expect(text).toContain('用 Obsidian');
	});

	it('normal 段 - 超 injectLimitBytes 截断', () => {
		const text = composeMemorySystemPrompt(GLOBAL, [], {}, {
			injectLimitBytes: 2 * KB,
			totalLimitBytes: 64 * KB,
			relatedTopics: [],
		});
		expect(text).not.toContain('很长的项目说明。'.repeat(2000));
	});

	it('relatedTopics 非空 - 注入相关记忆块', () => {
		const text = composeMemorySystemPrompt('## 偏好\n- a', [], {}, {
			injectLimitBytes: 20 * KB,
			totalLimitBytes: 64 * KB,
			relatedTopics: [{ name: 'obsidian', summary: '用户的 Obsidian 偏好' }],
		});
		expect(text).toContain('与当前问题可能相关');
		expect(text).toContain('obsidian');
		expect(text).toContain('用户的 Obsidian 偏好');
	});

	it('relatedTopics 为空 - 不出现空标题', () => {
		const text = composeMemorySystemPrompt('## 偏好\n- a', [], {}, {
			injectLimitBytes: 20 * KB,
			totalLimitBytes: 64 * KB,
			relatedTopics: [],
		});
		expect(text).not.toContain('与当前问题可能相关');
	});

	it('总预算超限 - 先砍 related 尾条再缩 normal,pinned 不动', () => {
		const text = composeMemorySystemPrompt(GLOBAL, [], {}, {
			injectLimitBytes: 20 * KB,
			totalLimitBytes: 2 * KB, // 极小总预算
			relatedTopics: [
				{ name: 't1', summary: 's1' },
				{ name: 't2', summary: 's2' },
			],
		});
		expect(text).toContain('日记在 03_Daily'); // pinned 永不砍
		expect(Buffer.byteLength(text, 'utf-8')).toBeLessThanOrEqual(2 * KB + 2 * KB); // 总长受控(允许 wrapper 模板开销)
		expect(text).not.toContain('s2'); // related 尾条先被砍
	});

	it('不传 options - 兼容旧行为(20KB 截断全文)', () => {
		const text = composeMemorySystemPrompt('## 偏好\n- a', [], {});
		expect(text).toContain('## 偏好');
	});
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/prompts/composer-memory-layering.test.ts`
Expected: FAIL(splitGlobalSections 未导出;options 参数不存在)

- [ ] **Step 3: memory-store.ts 加 splitGlobalSections**

在 `src/core/memory-store.ts` 模块级(类定义外)导出纯函数:

```typescript
/** splitGlobalSections 的返回结构 — pinned 与 normal 两桶正文 */
export interface GlobalSections {
	/** 带 [pinned] 标记的段落全文(标题 + 正文,按出现顺序拼接) */
	pinned: string;
	/** 其余内容(frontmatter + 非 pinned 段落),沿用全文注入的既有行为 */
	normal: string;
}

/** 识别段落标题行尾 [pinned] 标记;如 `## 偏好 [pinned]` */
const PINNED_HEADING_REGEX = /^(#{1,6}\s+.+?)\s+\[pinned\]\s*$/;

/**
 * 拆分 global.md 为 pinned / normal 两桶(S-SR-LAYERING 分层注入)。
 *
 * 关键路径:
 * - 事实源就在正文里 — 用户手编 `[pinned]` 后缀即生效,无独立 contract 数据结构(ADR-016 ①)。
 * - 标记被误删时该段降级进 normal 桶,无功能损坏(向后兼容)。
 * - frontmatter 归 normal 桶 — 现状即全文注入,不改变既有行为。
 *
 * @param content - global.md 全文
 * @returns 两桶正文;pinned 为空串表示无任何标记段落
 */
export function splitGlobalSections(content: string): GlobalSections {
	const lines = content.split('\n');
	const pinnedParts: string[] = [];
	const normalParts: string[] = [];
	let inPinned = false;
	for (const line of lines) {
		if (line.startsWith('#')) {
			inPinned = PINNED_HEADING_REGEX.test(line);
		}
		// 关键路径:frontmatter(--- 围栏)与无标题前导行都归 normal。
		(inPinned ? pinnedParts : normalParts).push(line);
	}
	return { pinned: pinnedParts.join('\n').trim(), normal: normalParts.join('\n').trim() };
}
```

- [ ] **Step 4: composer.ts 改造 composeMemorySystemPrompt**

在 `src/prompts/composer.ts`:

4a. import 区加:

```typescript
import { splitGlobalSections } from '../core/memory-store';
import { truncateUtf8Bytes } from './injection/injector';
```

4b. 函数上方加接口与常量:

```typescript
/** 分层注入选项 — 由 main.ask() 按 settings 换算后传入(S-SR-LAYERING) */
export interface MemoryLayeringOptions {
	/** global.md 非 pinned 段落注入预算(字节;settings.memoryInjectLimitKB) */
	injectLimitBytes: number;
	/** 基础 + 动态记忆合计预算(字节;settings.memoryContextTotalLimitKB) */
	totalLimitBytes: number;
	/** topics 自动检索命中(已按相关性排序);空数组 = 不注入相关块 */
	relatedTopics: Array<{ name: string; summary: string }>;
}
```

4c. 函数签名与主体替换(保留 JSDoc,更新参数说明):

```typescript
export function composeMemorySystemPrompt(
	globalContent: string,
	indexEntries: Array<{ name: string; summary: string }>,
	overrides: OverrideMap,
	options?: MemoryLayeringOptions,
): string {
	if (!globalContent.trim()) return '';

	const template = resolveSection('memory.systemPrompt', overrides);
	const topicList = indexEntries
		.map((e) => `- ${e.name}: ${e.summary}`)
		.join('\n') || '(暂无主题记忆)';

	// 关键路径(S-SR-LAYERING):无 options 走旧路径(20KB 截断全文),既有调用与测试零改动。
	if (!options) {
		const legacy = truncateUtf8Bytes(globalContent, 20 * 1024);
		const body = interpolate(template, { globalContent: legacy, topicList, relatedTopics: '' });
		return `${getSearchResultsWrapperPrefix()}\n\n${body}\n\n${getSearchResultsWrapperSuffix()}`;
	}

	// --- 分层路径:pinned 恒留 + normal 预算 + related 块 + 总预算裁剪 ---
	const { pinned, normal } = splitGlobalSections(globalContent);
	let related = [...options.relatedTopics];
	let normalText = truncateUtf8Bytes(normal, options.injectLimitBytes);

	// 关键路径(ADR-016 裁剪顺序):总预算超限时先砍 related 尾条,再缩 normal;pinned 永不砍。
	const assemble = (relatedList: Array<{ name: string; summary: string }>, normalPart: string): string => {
		const relatedBlock = relatedList.length > 0
			? `与当前问题可能相关的主题记忆:\n${relatedList.map((r) => `- ${r.name}: ${r.summary}`).join('\n')}\n\n`
			: '';
		const globalBlock = [pinned, normalPart].filter((s) => s.length > 0).join('\n\n');
		return interpolate(template, { globalContent: globalBlock, topicList, relatedTopics: relatedBlock });
	};

	let body = assemble(related, normalText);
	while (Buffer.byteLength(body, 'utf-8') > options.totalLimitBytes) {
		if (related.length > 0) {
			related.pop(); // 1) related 尾条往上砍
		} else if (Buffer.byteLength(normalText, 'utf-8') > 0) {
			normalText = truncateUtf8Bytes(normalText, Math.floor(Buffer.byteLength(normalText, 'utf-8') / 2)); // 2) normal 减半
		} else {
			break; // 3) 只剩 pinned + 模板 — pinned 永不砍,接受超出(极端情况,见 ADR-016)
		}
		body = assemble(related, normalText);
	}

	return `${getSearchResultsWrapperPrefix()}\n\n${body}\n\n${getSearchResultsWrapperSuffix()}`;
}
```

> 注:模板 `{{globalContent}}` 在分层路径下收到的是「pinned + 截断后 normal」拼接;`{{relatedTopics}}` 收到完整块(含标题)或空串,模板中该占位符独占一行位置。

- [ ] **Step 5: 模板与登记更新**

5a. `src/prompts/defaults/zh.ts` 的 `'memory.systemPrompt'` 模板,在 `{{globalContent}}` 之后、topicList 段之前插入一行:

```typescript
'memory.systemPrompt': `以下是关于用户的已知信息:
{{globalContent}}
{{relatedTopics}}
用户已建立以下主题记忆,当对话涉及相关领域时,请先用 search_memory 查询:
{{topicList}}

触发规则:
- 用户询问某技术栈/项目/领域的偏好、决策或历史 → 先调 search_memory 再回答
- 用户说"记住 X" → 调 remember(涉及个人/全局偏好用 type=global,涉及特定技术/领域用 type=topic)
- 用户说"忘掉 X" → 调 forget_memory
- 不确定是否需要记忆时 → 宁可多查一次`,
```

> relatedTopics 为空串时该行是空行(无害);非空时块自带末尾空行,行首不重复标题。

5b. `src/prompts/sections.ts` 中 id 为 `memory.systemPrompt` 的 section,`placeholders` 数组加 `'relatedTopics'`(在 `'globalContent'` 之后)。同时更新该 section 的 `description`(走 tNow 的 promptLabel 不变,仅 placeholders 数组)。

- [ ] **Step 6: search-memory.ts 消费 settings**

6a. 工厂签名加第 4 参,`MAX_RETURN_BYTES` 常量删除:

```typescript
export function createSearchMemoryTool(
	memoryStore: MemoryStore,
	embeddingPort: EmbeddingPort,
	definition: ToolDefinition,
	/** 单次返回字节上限 — settings.memoryDynamicLimitKB * 1024(S-SR-LAYERING 接线) */
	maxReturnBytes: number,
): Tool {
```

6b. `truncateResults(results)` 调用处改 `truncateResults(results, maxReturnBytes)`;函数签名同步:

```typescript
function truncateResults(results: MemorySearchResult[], maxBytes: number): MemorySearchResult[] {
	let totalBytes = 0;
	const truncated: MemorySearchResult[] = [];
	for (const r of results) {
		const entryBytes = Buffer.byteLength(r.text, 'utf-8') + Buffer.byteLength(r.docId, 'utf-8');
		if (truncated.length > 0 && totalBytes + entryBytes > maxBytes) break;
		truncated.push(r);
		totalBytes += entryBytes;
	}
	return truncated;
}
```

6c. `src/main.ts:455` 装配处改:

```typescript
createSearchMemoryTool(
	this.memoryStore,
	this.embedding,
	toolDefMap.get('search_memory')!,
	this.settings.memoryDynamicLimitKB * 1024,
),
```

6d. 既有 `tests/tools/` 下若有 search-memory 相关测试引用旧签名,同步补第 4 参(30 * 1024)。

- [ ] **Step 7: 运行测试通过 + 全量回归**

Run: `npx vitest run tests/prompts/composer-memory-layering.test.ts && npx vitest run`
Expected: 新用例 PASS;全量 PASS

- [ ] **Step 8: Commit**

```bash
git add src/core/memory-store.ts src/prompts/composer.ts src/prompts/defaults/zh.ts src/prompts/sections.ts src/tools/search-memory.ts src/main.ts tests/prompts/composer-memory-layering.test.ts
git commit -m "feat: global.md 段落级 pinned 恒注入 + 记忆预算接线 settings(S-SR-LAYERING)"
```

---

## Task 3: topics 自动注入(ask() 检索 + memoryTopicsAutoInjectK)

**Files:**
- Modify: `src/settings.ts`(新字段 + declarative 项)
- Modify: `src/core/context-manager.ts`(setMemoryContext 第 3 参)
- Modify: `src/main.ts`(ask() 检索 + 传参)
- Modify: `src/i18n/zh.ts`、`en.ts`、`types.ts`
- Test: `tests/core/memory-topics-auto-inject.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/core/memory-topics-auto-inject.test.ts
import { describe, it, expect } from 'vitest';
import { ContextManager } from '../../src/core/context-manager';

/** 最小 deps 桩 — getOverrides/getTools 返回空,记忆段直接由 setMemoryContext 决定 */
function makeCtx(): ContextManager {
	return new ContextManager(
		{
			load: async () => undefined,
			save: async () => undefined,
		} as never,
		{ getOverrides: () => ({}), getTools: () => [] },
		// 关键路径:第 3 参 maxHistoryTokens 必传(来自 tailBudget;测试给固定小值即可)
		206_400,
	);
}

describe('setMemoryContext 分层参数', () => {
	it('传 layering - relatedTopics 块进入 system 消息', () => {
		const ctx = makeCtx();
		ctx.setMemoryContext('## 偏好\n- a', [], {}, {
			injectLimitBytes: 20 * 1024,
			totalLimitBytes: 64 * 1024,
			relatedTopics: [{ name: 'obsidian', summary: '偏好' }],
		});
		const msgs = ctx.toMessages('direct');
		const memoryMsg = msgs.find((m) => m.content.includes('关于用户的已知信息'));
		expect(memoryMsg).toBeDefined();
		expect(memoryMsg!.content).toContain('obsidian');
	});

	it('不传 layering - 兼容旧行为', () => {
		const ctx = makeCtx();
		ctx.setMemoryContext('## 偏好\n- a', [], {});
		const msgs = ctx.toMessages('direct');
		expect(msgs.some((m) => m.content.includes('## 偏好'))).toBe(true);
	});
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/core/memory-topics-auto-inject.test.ts`
Expected: FAIL(setMemoryContext 不接受第 4 参)

- [ ] **Step 3: settings.ts 加字段**

3a. 接口区(`memoryContextTotalLimitKB` 之后)加:

```typescript
// 关键路径(S-SR-LAYERING):topics 自动注入条数;0 = 关闭,默认 3。
memoryTopicsAutoInjectK: number;
```

3b. 默认值区(`memoryContextTotalLimitKB: 50,` 之后)加:

```typescript
memoryTopicsAutoInjectK: 3,
```

3c. declarative 面板 memory 组 items(`contextTotalLimit` 项之后)加:

```typescript
{
	name: tNow('memory.settings.topicsAutoInject.name'),
	desc: tNow('memory.settings.topicsAutoInject.desc'),
	control: { type: 'number', key: 'memoryTopicsAutoInjectK', min: 0, max: 10 },
},
```

- [ ] **Step 4: ContextManager.setMemoryContext 加第 4 参**

签名与实现(替换 [src/core/context-manager.ts:309](../../src/core/context-manager.ts) 既有实现):

```typescript
setMemoryContext(
	globalContent: string,
	indexEntries: TopicIndexEntry[],
	overrides?: Parameters<typeof composeMemorySystemPrompt>[2],
	layering?: MemoryLayeringOptions,
): void {
	// 关键路径(S-SR-LAYERING):layering 由 main.ask() 按 settings + 当前消息检索结果换算;
	// 不传时 composeMemorySystemPrompt 走旧路径(20KB 截断全文)。
	this.memorySystemPrompt = composeMemorySystemPrompt(
		globalContent,
		indexEntries,
		overrides ?? this.deps.getOverrides(),
		layering,
	);
}
```

同时 import:`import type { MemoryLayeringOptions } from '../prompts/composer';`

> **main.ts 调用点适配**:原调用 `ctx.setMemoryContext(globalContent, indexEntries)` 改为传 4 参(Step 5)。既有其他调用点(若有)传 overrides 保持第 3 参,行为不变。

- [ ] **Step 5: main.ts ask() 检索 relatedTopics**

替换 `main.ts` ask() 中记忆加载块([src/main.ts:1325-133](../../src/main.ts) 附近):

```typescript
try {
	const globalContent = this.memoryStore.readGlobal();
	const indexEntries = this.memoryStore.readIndex();
	if (globalContent.trim()) {
		// 关键路径(S-SR-LAYERING):topics 自动检索 — 当前用户消息 embed 一次,
		// 命中的主题只注入「名称 + 摘要」,全文仍走 search_memory(两种供给不重复)。
		let relatedTopics: Array<{ name: string; summary: string }> = [];
		const K = this.settings.memoryTopicsAutoInjectK;
		if (K > 0 && message.trim()) {
			try {
				const vectors = await this.embedding.embed([message]);
				const queryVector = vectors[0];
				if (queryVector) {
					const hits = await this.memoryStore.searchIndex(message, queryVector, K);
					const summaryByName = new Map(indexEntries.map((e) => [e.name, e.summary]));
					for (const hit of hits) {
						const name = hit.docId.replace(/^topics\//, '').replace(/\.md$/, '');
						const summary = summaryByName.get(name);
						if (summary !== undefined) {
							relatedTopics.push({ name, summary });
							// 统计口径:自动注入命中才计数,search_memory 手动检索不计。
							this.usageStats.bumpMemoryTopic(name);
						}
					}
				}
			} catch (embedErr) {
				// 修复:检索失败静默降级为无相关主题,不阻断会话(spec §2)。
				devLogger.warn('memory', 'topics 自动注入检索失败,降级为无相关主题', embedErr);
			}
		}
		ctx.setMemoryContext(globalContent, indexEntries, this.settings.promptOverrides, {
			injectLimitBytes: this.settings.memoryInjectLimitKB * 1024,
			totalLimitBytes: this.settings.memoryContextTotalLimitKB * 1024,
			relatedTopics,
		});
	}
} catch (err) {
	devLogger.error('memory', '记忆加载失败,会话继续无记忆注入', err);
}
```

> `this.usageStats` 在 Task 4 实现;本 Task 先写 `this.usageStats.bumpMemoryTopic(name)` 调用,Task 4 落地类与装配后 typecheck 才通过 — **两个 Task 在同一分支连续执行**,若单跑本 Task,typecheck 会报 usageStats 缺失,属预期中间态,以 vitest 为准。

- [ ] **Step 6: i18n keys**

`src/i18n/types.ts` memory settings namespace 加:

```typescript
topicsAutoInject: {
	name: string;
	desc: string;
};
```

`src/i18n/zh.ts`:

```typescript
topicsAutoInject: {
	name: '自动注入相关主题数',
	desc: '每轮提问自动检索最相关的主题记忆(名称+摘要)注入对话;0 表示关闭。完整内容仍由 AI 按需查询。',
},
```

`src/i18n/en.ts`:

```typescript
topicsAutoInject: {
	name: 'Auto-inject related topics',
	desc: 'Automatically retrieve the most relevant topic memories (name + summary) into each conversation; 0 disables. Full content is still fetched on demand by the AI.',
},
```

- [ ] **Step 7: 运行测试 + 全量回归**

Run: `npx vitest run tests/core/memory-topics-auto-inject.test.ts && npx vitest run`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/settings.ts src/core/context-manager.ts src/main.ts src/i18n/ tests/core/memory-topics-auto-inject.test.ts
git commit -m "feat: topics 记忆按当前提问自动检索注入 top-K(S-SR-LAYERING)"
```

---

## Task 4: Skill 分层 + 使用统计存储

**Files:**
- Create: `src/core/usage-stats.ts`
- Modify: `src/skills/skill-activator.ts`(排序 + i18n fallback)
- Modify: `src/tools/activate-skill.ts`(截断 + 计数)
- Modify: `src/core/agent-loop.ts`(composeDiscovery 传 query)
- Modify: `src/main.ts`(usageStats 装配 + activate 工具传 stats)
- Test: `tests/core/usage-stats.test.ts`、`tests/skills/skill-activator-ranking.test.ts`

- [ ] **Step 1: 写失败测试(usage-stats)**

```typescript
// tests/core/usage-stats.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageStatsStore } from '../../src/core/usage-stats';

function tmpStore(): { store: UsageStatsStore; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), 'ratel-stats-'));
	return { store: new UsageStatsStore(join(dir, 'usage-stats.json')), dir };
}

describe('UsageStatsStore', () => {
	it('bumpSkill - 计数累加并落盘可重读', () => {
		const { store, dir } = tmpStore();
		store.bumpSkill('writer');
		store.bumpSkill('writer');
		store.bumpSkill('reader');
		const reloaded = new UsageStatsStore(join(dir, 'usage-stats.json'));
		expect(reloaded.getAll().skills['writer']).toBe(2);
		expect(reloaded.getAll().skills['reader']).toBe(1);
		rmSync(dir, { recursive: true, force: true });
	});

	it('bumpMemoryTopic - 独立命名空间', () => {
		const { store, dir } = tmpStore();
		store.bumpMemoryTopic('obsidian');
		expect(store.getAll().memoryTopics['obsidian']).toBe(1);
		expect(store.getAll().skills).toEqual({});
		rmSync(dir, { recursive: true, force: true });
	});

	it('损坏 JSON - 重置为空不抛错', () => {
		const { store, dir } = tmpStore();
		require('node:fs').writeFileSync(join(dir, 'usage-stats.json'), '{broken', 'utf-8');
		expect(store.getAll().skills).toEqual({});
		rmSync(dir, { recursive: true, force: true });
	});
});
```

> vitest ESM 下不用 require — 该用例改 `import { writeFileSync } from 'node:fs'` 顶部导入后直调 `writeFileSync(...)`。

- [ ] **Step 2: 实现 usage-stats.ts**

```typescript
/**
 * @file src/core/usage-stats.ts
 * @description 使用统计存储 — Skill 激活与记忆 topics 自动注入命中计数(S-SR-LAYERING SR-03)
 * @module core/usage-stats
 * @depends node:fs, logging/dev-logger
 */

import * as fs from 'node:fs';
import { devLogger } from '../logging/dev-logger';

/** 统计数据形态 — 两个命名空间:skills / memoryTopics */
export interface UsageStatsData {
	skills: Record<string, number>;
	memoryTopics: Record<string, number>;
}

const EMPTY: UsageStatsData = { skills: {}, memoryTopics: {} };

/**
 * 使用统计存储 — pluginDir/usage-stats.json 读写。
 *
 * 设计要点:
 * - 不进 settings/data.json:每次激活都重写主配置会污染保存节奏(spec §4)。
 * - 不进 vault/.ratel:统计非用户笔记内容,与 .memory-index 同域放 pluginDir。
 * - 只给计数,不做衰减/退役/趋势(PRD §7.5 非目标)。
 */
export class UsageStatsStore {
	private data: UsageStatsData = { skills: {}, memoryTopics: {} };

	/** @param filePath - 统计文件绝对路径(pluginDir/usage-stats.json) */
	constructor(private filePath: string) {
		this.data = this.readFromDisk();
	}

	getAll(): UsageStatsData {
		return this.data;
	}

	bumpSkill(name: string): void {
		this.bump('skills', name);
	}

	bumpMemoryTopic(name: string): void {
		this.bump('memoryTopics', name);
	}

	private bump(namespace: 'skills' | 'memoryTopics', name: string): void {
		const bucket = this.data[namespace];
		bucket[name] = (bucket[name] ?? 0) + 1;
		this.flush();
	}

	/** 读盘;损坏时重置为空并告警(统计可丢,不可断会话) */
	private readFromDisk(): UsageStatsData {
		try {
			if (!fs.existsSync(this.filePath)) return { skills: {}, memoryTopics: {} };
			const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
			if (typeof parsed !== 'object' || parsed === null) return { skills: {}, memoryTopics: {} };
			const obj = parsed as Partial<UsageStatsData>;
			return {
				skills: obj.skills && typeof obj.skills === 'object' ? obj.skills : {},
				memoryTopics: obj.memoryTopics && typeof obj.memoryTopics === 'object' ? obj.memoryTopics : {},
			};
		} catch (err) {
			devLogger.warn('stats', 'usage-stats.json 损坏,统计已重置', err);
			return { ...EMPTY, skills: {}, memoryTopics: {} };
		}
	}

	/** 关键路径:同步写 — 文件极小(几行计数)、bump 频率低,不值得引入防抖复杂度 */
	private flush(): void {
		try {
			fs.writeFileSync(this.filePath, JSON.stringify(this.data), 'utf-8');
		} catch (err) {
			devLogger.warn('stats', 'usage-stats.json 写入失败,仅内存计数', err);
		}
	}
}
```

- [ ] **Step 3: 运行 usage-stats 测试通过**

Run: `npx vitest run tests/core/usage-stats.test.ts`
Expected: PASS

- [ ] **Step 4: 写失败测试(skill-activator 排序 + 截断)**

```typescript
// tests/skills/skill-activator-ranking.test.ts
import { describe, it, expect } from 'vitest';
import { SkillRegistry } from '../../src/skills/skill-registry';
import { SkillActivator } from '../../src/skills/skill-activator';
import type { Skill } from '../../src/skills/types';

function fakeSkill(name: string, description: string, tags: string[] = []): Skill {
	return {
		manifest: { name, description, enabled: true, activation: 'auto', tags, version: '1.0.0' },
		instructions: 'do things',
		dir: `/fake/${name}`,
		source: 'builtin',
		warnings: [],
	} as unknown as Skill;
}

describe('SkillActivator 相关性排序', () => {
	it('query 命中 tags/description - 相关 skill 排前', () => {
		const registry = new SkillRegistry();
		registry.reload(
			[
				fakeSkill('aaa-writer', '写作技能', []),
				fakeSkill('zzz-daily', '日记与晨间笔记', ['daily-note']),
			],
			[],
		);
		const activator = new SkillActivator(registry);
		const text = activator.composeDiscovery({}, '帮我写今天的 daily note');
		const writerIdx = text.indexOf('aaa-writer');
		const dailyIdx = text.indexOf('zzz-daily');
		expect(dailyIdx).toBeGreaterThanOrEqual(0);
		expect(writerIdx).toBeGreaterThanOrEqual(0);
		expect(dailyIdx).toBeLessThan(writerIdx);
	});

	it('无 query - 保持注册序(稳定排序兜底)', () => {
		const registry = new SkillRegistry();
		registry.reload([fakeSkill('aaa', 'a', []), fakeSkill('bbb', 'b', [])], []);
		const text = new SkillActivator(registry).composeDiscovery({});
		expect(text.indexOf('aaa')).toBeLessThan(text.indexOf('bbb'));
	});

	it('i18n fallback - locale 命中取 localized,缺失回退顶层', () => {
		const registry = new SkillRegistry();
		registry.reload(
			[fakeSkill('bilingual', 'top-level desc', [])],
			[],
		);
		// 注:i18n.description 在 manifest 上;fakeSkill 未带 → 断言回退顶层
		const text = new SkillActivator(registry).composeDiscovery({});
		expect(text).toContain('top-level desc');
	});
});

describe('activate_skill instructions 截断', () => {
	it('超 8KB - 截断并加尾注', async () => {
		const registry = new SkillRegistry();
		const big = fakeSkill('big', '大技能');
		big.instructions = 'x'.repeat(9 * 1024);
		registry.reload([big], []);
		const appended: Array<[string, string]> = [];
		const { createActivateSkillTool } = await import('../../src/tools/activate-skill');
		const tool = createActivateSkillTool(
			registry,
			{ name: 'activate_skill', description: '', parameters: { type: 'object', properties: {} } },
			{ hasInSession: () => false, appendToSession: (n, b) => appended.push([n, b]) },
		);
		await tool.execute({ name: 'big' });
		const [, body] = appended[0]!;
		expect(Buffer.byteLength(body, 'utf-8')).toBeLessThanOrEqual(8 * 1024 + 200); // 8KB + 尾注
		expect(body).toContain('SKILL.md');
	});

	it('未超限 - 原样注入无尾注', async () => {
		const registry = new SkillRegistry();
		const small = fakeSkill('small', '小技能');
		small.instructions = 'short';
		registry.reload([small], []);
		const appended: Array<[string, string]> = [];
		const { createActivateSkillTool } = await import('../../src/tools/activate-skill');
		const tool = createActivateSkillTool(
			registry,
			{ name: 'activate_skill', description: '', parameters: { type: 'object', properties: {} } },
			{ hasInSession: () => false, appendToSession: (n, b) => appended.push([n, b]) },
		);
		await tool.execute({ name: 'small' });
		expect(appended[0]![1]).toBe('short');
	});
});
```

> SkillRegistry.reload 签名以 [src/skills/skill-registry.ts](../../src/skills/skill-registry.ts) 实测为准:若 reload(skills, warnings) 之外还需 applyEnabledOverrides,按现有 tests/skills 或 tests/core/context-manager-skills.test.ts 的桩模式对齐;fakeSkill 的必填字段以 `src/skills/types.ts` 的 `Skill` 接口为准,缺啥补啥。

- [ ] **Step 5: 实现 activator 排序 + i18n fallback**

`src/skills/skill-activator.ts`:

5a. import 加:

```typescript
import { get } from 'svelte/store';
import { langStore } from '../i18n';
```

5b. `composeDiscovery` 签名与排序逻辑替换:

```typescript
composeDiscovery(overrides: OverrideMap, query?: string): string {
	const discovered = this.registry.getDiscovered();
	if (discovered.length === 0) return '';

	// 关键路径(S-SR-LAYERING):按 tags/描述与当前提问的相关性排序后再截断 —
	// 装几十个 skill 时不再按列表顺序随机丢。v1 局限:空格分词,中文整句命中率低,
	// 未命中时稳定排序退回字母序(尽力而为,不影响功能)。
	const terms = (query ?? '')
		.toLowerCase()
		.split(/\s+/)
		.filter((t) => t.length >= 2);
	const scored = discovered
		.map((s) => ({ s, score: this.scoreSkill(s, terms) }))
		.sort((a, b) => b.score - a.score || a.s.manifest.name.localeCompare(b.s.manifest.name))
		.map((x) => x.s);

	const limited = scored.slice(0, SkillActivator.MAX_DISCOVERY_SKILLS);
	const skillList = limited
		.map((s) => `- ${s.manifest.name}: ${this.resolveDescription(s)}`)
		.join('\n');

	const template = resolveSection('agent.skills', overrides);
	return interpolate(template, { skillList });
}

/** 相关性打分:tag 命中 +2(强信号),名称/描述包含 +1 */
private scoreSkill(skill: Skill, terms: string[]): number {
	const text = `${skill.manifest.name} ${skill.manifest.description}`.toLowerCase();
	let score = 0;
	for (const term of terms) {
		if (skill.manifest.tags?.some((tag) => tag.toLowerCase().includes(term))) score += 2;
		if (text.includes(term)) score += 1;
	}
	return score;
}
```

5c. `resolveDescription` 实现 i18n fallback(v1 遗留):

```typescript
private resolveDescription(skill: Skill): string {
	// 关键路径(S-SR-LAYERING):i18n.description 命中当前语言取 localized,缺失回退顶层。
	const locale = get(langStore);
	return skill.manifest.i18n?.description?.[locale] ?? skill.manifest.description;
}
```

> 若 `SkillManifest['i18n']` 当前类型不含 description 索引签名,在 `src/skills/types.ts` 的 i18n 字段补 `description?: Record<string, string>`。

- [ ] **Step 6: activate-skill.ts 截断 + 计数**

```typescript
// 常量区
// 关键路径(S-SR-LAYERING):单条 skill instructions 注入上限 8KB —
// 巨型 SKILL.md 不再全文吃掉上下文;截断加尾注指引模型回查源文件。
const MAX_SKILL_INSTRUCTIONS_BYTES = 8 * 1024;
const TRUNCATION_NOTE = '\n\n(已截断:内容超出注入上限,完整做法请查看 SKILL.md 原文)';

/** 统计回调 — 由 main 注入;单测可不传 */
export interface SkillUsageStats {
	bumpSkill: (name: string) => void;
}
```

工厂签名加第 4 参 `stats?: SkillUsageStats`,execute 内 `appendToSession` 调用处替换:

```typescript
const raw = skill.instructions;
const body = Buffer.byteLength(raw, 'utf-8') > MAX_SKILL_INSTRUCTIONS_BYTES
	? truncateUtf8Bytes(raw, MAX_SKILL_INSTRUCTIONS_BYTES) + TRUNCATION_NOTE
	: raw;
sessionHooks?.appendToSession(skill.manifest.name, body);
stats?.bumpSkill(skill.manifest.name);
```

import 加:`import { truncateUtf8Bytes } from '../prompts/injection/injector';`

- [ ] **Step 7: agent-loop + main 装配**

7a. `src/core/agent-loop.ts:92`:

```typescript
ctx.setSkillsContext(skillActivator.composeDiscovery(ctx.getOverrides(), req.message), '');
```

7b. `src/main.ts` — **ask() 内两处** composeDiscovery 调用都传 `message`:

- L1318(`setSkillsContext` 处,实际注入路径):

```typescript
ctx.setSkillsContext(
	this.skillActivator.composeDiscovery(this.settings.promptOverrides, message),
	'',
);
```

- L1306(`getSkillsDiscovery` deps 回调处):

```typescript
getSkillsDiscovery: () =>
	this.skillActivator.composeDiscovery(this.settings.promptOverrides, message),
```

> 注:deps.getSkillsDiscovery 当前未被 ContextManager 消费(死回调),但两处同步改,防止将来死代码复活后行为不一致。

7c. `src/main.ts` — usageStats 装配:

- 类字段:`usageStats: UsageStatsStore;`(import `./core/usage-stats`)
- onload 装配区(记忆系统块附近):`this.usageStats = new UsageStatsStore(path.join(pluginDir, 'usage-stats.json'));`
- `createActivateSkillTool(...)` 装配处([src/main.ts:470](../../src/main.ts))追加第 4 参:`this.usageStats,`

- [ ] **Step 8: 运行测试 + 全量回归**

Run: `npx vitest run tests/skills/skill-activator-ranking.test.ts tests/core/usage-stats.test.ts && npx vitest run`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/core/usage-stats.ts src/skills/skill-activator.ts src/skills/types.ts src/tools/activate-skill.ts src/core/agent-loop.ts src/main.ts tests/core/usage-stats.test.ts tests/skills/skill-activator-ranking.test.ts
git commit -m "feat: Skill Discovery 相关性排序 + instructions 8KB 截断 + 使用统计存储(S-SR-LAYERING)"
```

---

## Task 5: 统计 UI 展示 + i18n

**Files:**
- Modify: `src/ui/skills/SkillManageModal.ts`
- Modify: `src/ui/memory-panel/MemoryPanel.svelte`
- Modify: `src/i18n/zh.ts`、`en.ts`、`types.ts`

- [ ] **Step 1: i18n keys**

`src/i18n/types.ts`:skillManage namespace 加 `usedTimes: string;`(带 {count});memory panel namespace 加 `usedTimes: string;`(带 {count})。

`src/i18n/zh.ts`:

```typescript
// modal.skillManage 下
usedTimes: '使用 {count} 次',
// memory.panel 下
usedTimes: '命中 {count} 次',
```

`src/i18n/en.ts`:

```typescript
// modal.skillManage 下
usedTimes: 'Used {count} times',
// memory.panel 下
usedTimes: 'Hit {count} times',
```

- [ ] **Step 2: SkillManageModal 使用次数**

`renderSkillRow` 的 desc 拼接处([src/ui/skills/SkillManageModal.ts:112-115](../../src/ui/skills/SkillManageModal.ts))追加:

```typescript
const usedCount = this.plugin.usageStats.getAll().skills[name] ?? 0;
const desc =
	tNow(`skill.source.${source}`) +
	(skill.manifest.version ? ` · v${skill.manifest.version}` : '') +
	` · ${tNow('modal.skillManage.usedTimes', { count: usedCount })}` +
	(source === 'builtin' ? ` · ${tNow('modal.skillManage.builtinReadonly')}` : '');
```

- [ ] **Step 3: MemoryPanel 命中次数**

`src/ui/memory-panel/MemoryPanel.svelte` 主题 summary 行(L478 附近):

```svelte
<summary>📂 {topic.name}
	<span class="ratel-memory-summary">{topic.summary}</span>
	<span class="ratel-memory-summary">{$t('memory.panel.usedTimes', { count: plugin.usageStats.getAll().memoryTopics[topic.name] ?? 0 })}</span>
</summary>
```

- [ ] **Step 4: 构建 + 回归**

Run: `npx vitest run && npm run build`
Expected: 测试全 PASS;build 0 error(允许既有 17 个 Svelte legacy warning)

- [ ] **Step 5: Commit**

```bash
git add src/ui/skills/SkillManageModal.ts src/ui/memory-panel/MemoryPanel.svelte src/i18n/
git commit -m "feat: 技能与记忆管理面板显示使用/命中次数(S-SR-LAYERING SR-03)"
```

---

## Task 6: ADR-016 + 架构文档统一调整

**Files:**
- Create: `docs/adr/2026-08-19-layered-injection.md`
- Modify: `docs/architecture/agent/prompt-management.md`
- Modify: `docs/architecture/agent/context-manager.md`
- Modify: `docs/architecture/agent/capability-surface.md`

- [ ] **Step 1: 写 ADR-016**

```markdown
# ADR-016: 分层注入与统一注入管理器

日期: 2026-08-19 · 状态: 已接受 · 关联: S-SR-LAYERING / PRD §7.5

## 背景

动态 system 段(env/memory/skills)散在 ContextManager 三个 setter + agentLoop 显式调用点,
无统一预算执行点;global.md 全量注入(20KB 硬编码);topics 记忆只能靠模型主动调
search_memory 进入上下文;Skill Discovery 无差别截断 50 个;instructions 无单条上限。
settings 的三个 memory 限制字段已定义未消费。

## 决策

1. **段落级 pinned 标记,不建独立 contract 数据结构** — global.md 标题行后缀 `[pinned]`
   即恒注入不截断(RoutineContract 事实源)。事实源单一、用户手编直观;独立结构会与正文失配。
2. **统一注入管理器 PromptInjector,不继续 setter 堆叠** — 注入源 ID 用 `as const` 元组
   集中登记(ids.ts);源负责构建,管理器负责组装与预算兜底;全局预算需要唯一执行点。
3. **注入源 ID 不用 TS enum** — as const 元组零运行时产物(esbuild 友好)、类型与值一份声明;
   const enum 跨文件在 isolatedModules 下退化(规范见 AGENTS.md「枚举与 ID 集中管理」)。
4. **searchResults 不入注入源枚举** — 它是消息数组路径(pruneSearchBlocks 逐条 push),
   塞进单段枚举会改变 LLM 消息结构;保持既有路径。
5. **裁剪顺序** — memory 源内超总预算时:pinned 永不砍 → relatedTopics 尾条往上砍 →
   normal 段减半,直到回到预算;只剩 pinned 时接受超出(极端情况)。
6. **验证靠用户审阅不靠统计** — 使用统计只做计数展示,不做 A/B、eval、自动退役
   (PRD §7.5 非目标;个人库流量撑不起统计置信度)。

## 后果

- ContextManager setter 外部签名不变,main.ts / agent-loop.ts 调用点零改动。
- `appendSkillInstructions` / `appendSkillSupersede` 走历史消息路径(ADR-012),不经 injector,
  仅加 8KB 截断与计数。
- 使用统计落 pluginDir/usage-stats.json(不进 data.json、不进 vault)。
```

- [ ] **Step 2: prompt-management.md 补「动态注入管理器」节**

读现有结构后在 sections 注册表小节之后插入(正文措辞可按文档风格微调,要点不变):

```markdown
## 动态注入管理器(PromptInjector)

静态段(zone: static)走 sections 注册表;动态段(zone: dynamic)由 `src/prompts/injection/` 统一管理:

- **ID 登记**:`ids.ts` 的 `INJECTION_SOURCE_IDS`(as const 元组,AGENTS.md 枚举规范)— env / memory / skills。
  searchResults 不入表:消息数组路径,非单段 system 文本。
- **职责**:源负责构建(状态由 ContextManager 既有 setter 写入,refresh 时机不变);
  PromptInjector 负责组装与 ownBudgetBytes 兜底截断。
- **记忆分层**(memory 源内部):global.md `## 标题 [pinned]` 段恒注入;其余段落走
  memoryInjectLimitKB;topics 按当前提问检索 top-K(memoryTopicsAutoInjectK)注入名称+摘要;
  总预算 memoryContextTotalLimitKB 超限时裁剪顺序:pinned → relatedTopics 尾条 → normal 减半。
- **Skill 分层**(skills 源 + 激活路径):Discovery 按 tags/描述与当前提问相关性排序后截断 50;
  activate_skill 注入单条上限 8KB(超限截断加尾注);激活指令写 Session.messages(ADR-012),不经 injector。
```

- [ ] **Step 3: context-manager.md 更新注入流程**

读文件,把「setter 存字段 → toMessages 逐段 push」的描述改为「setter 写状态 → toMessages 从
PromptInjector.buildSections() 拉段」;补一句:env/memory/skills 三源注册于 ContextManager 构造期,
注入顺序与历史实现一致。

- [ ] **Step 4: capability-surface.md 更新 Skill 注入小节**

读文件,Skill 注入相关小节补三点:Discovery 相关性排序(query 传入 composeDiscovery)、
instructions 8KB 截断、激活计数(pluginDir/usage-stats.json,管理面板可见)。

- [ ] **Step 5: Commit**

```bash
git add docs/adr/2026-08-19-layered-injection.md docs/architecture/
git commit -m "docs: ADR-016 分层注入决策 + 架构文档注入管理器统一调整(S-SR-LAYERING)"
```

---

## 自审记录

**Spec 覆盖**:G1 injector(Task 1)、G2 记忆分层 + settings 三字段接线(Task 2/3;memoryDynamicLimitKB 在 Task 2 Step 6)、G3 Skill 分层含 i18n fallback(Task 4)、G4 统计(Task 4/5)、G5 ADR + 架构文档(Task 6)。spec「影响面」清单全部有对应 Task。

**Placeholder 扫描**:无 TBD/TODO;文档类 Task(6)给要点 + 插入位置,属文档编辑指令而非代码占位。

**类型一致性**:`InjectionSourceId`(ids.ts)↔ `InjectionSource.id`(injector.ts)↔ register 调用一致;`MemoryLayeringOptions` 在 composer.ts 定义、context-manager.ts / main.ts 引用一致;`UsageStatsStore.bumpSkill/bumpMemoryTopic/getAll` 与 activate-skill.ts(`SkillUsageStats.bumpSkill`)、main.ts、UI 调用一致;`truncateUtf8Bytes` 复用自 injection/injector,不重复实现。

**已知偏差(spec 层面已修正或 plan 内说明)**:
- 统计文件从 spec 草案的 `.ratel/skill-stats.json` 改为 `pluginDir/usage-stats.json` — 非用户笔记内容不进 vault(spec 写「或等效」,理由入 ADR-016)。
- `memoryContextTotalLimitKB` 默认 50 以 settings.ts 现有值为准(spec 已修正)。
- Task 3 引用 `this.usageStats` 早于 Task 4 定义 — 两 Task 须同分支连续执行,vitest 不受影响,typecheck 中间态不完整属预期。
- SkillRegistry/Skill 桩字段以实测接口为准(fakeSkill 用 `as unknown as Skill` 兜底,缺字段按 types.ts 补)。
