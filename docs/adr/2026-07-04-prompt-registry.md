# ADR-008:Prompt Registry 设计决策

**状态**:Accepted
**日期**:2026-07-04

---

## Context(背景)

S-PROMPTS 之前,Ratel Vault 的提示词散落在 4 个核心模块:

- `context-manager.ts` 持有 `BASE_PROMPT`、`RAG_PROMPT`、`VAULT_TOOLS_GUIDE_ZH`、`RAG_PROMPT_WITH_TOOLS` 4 个英文常量
- `intent-classifier.ts` 持有 `INTENT_PROMPT_TEMPLATE` 英文模板
- `query-rewriter.ts` 持有 `REWRITE_PROMPT_TEMPLATE` 英文模板
- 9 个工具的 `definition.description` 内联硬编码在 `src/tools/*.ts` 中

这套散落式设计带来 4 个问题:

1. **语言不一致** — agent 系统提示词是英文,但工具描述部分是中文(`VAULT_TOOLS_GUIDE_ZH`),LLM 收到的混合语言 prompt 上下文不优雅
2. **无法自定义** — 用户无法覆盖任何一段提示词,即便用户场景有特殊需求(如"我有自己的标签体系,要求 read_note 不剥离 frontmatter")
3. **改一处要动 4 处** — 比如把"Ratel"改名为"Vault Rat",需要分别改 4 个文件,易遗漏
4. **工具描述双源** — RAG 工具引导文案(`VAULT_TOOLS_GUIDE_ZH`)与 function calling 的 `tool.definition.description` 各自维护,容易漂移

---

## Decision(决策)

引入 `src/prompts/` 子系统作为提示词的**单一装配入口**,所有 LLM 可见文本(system prompt、工具 description、检索外框)统一由 Composer 组装。

### 设计要点

#### 1. Section 作为 override 最小单元

提示词被切成 24 个 `PromptSectionId`(如 `agent.base`、`tool.read_note.description`、`search_results.wrapper`),每个 section 是用户可独立覆盖的最小单元。

```typescript
export type OverrideMap = Partial<Record<PromptSectionId, string>>;
```

用户在设置面板勾选「使用自定义」即可为该 section 写入自定义文本,未覆盖的 section 用 `defaults/zh.ts` 中的默认值。

#### 2. Composer 是唯一的装配 API

`composer.ts` 提供 4 个装配函数,所有 LLM 可见文本必须经此出口:

- `composeAgentSystem(intent, ctx, overrides)` — 拼 agent 系统提示词(`direct` / `rag`)
- `composeInternalMessages(kind, ctx, overrides)` — 拼内部 LLM 消息(`intent` / `rewrite`)
- `composeToolDefinitions(overrides, names)` — 拼 9 个工具的 `ToolDefinition`(description 走 Composer)
- `formatSearchResultsBlock(results, overrides)` — 包检索结果外框

`ContextManager`、`classifyIntent`、`rewriteQuery`、`main.ts registerTools`、`syncToolDefinitions` 5 个消费方都调这 4 个函数,不再自己拼字符串。

#### 3. 工具 description 单源

工具引导文案(`formatToolGuideList`)与 function calling schema(`composeToolDefinitions`)都从 `tool-schemas.ts` 拿骨架、从 `defaults/zh.ts` 的 `tool.*.description` section 拿描述文本,保证 RAG 引导与 schema 完全一致,不会漂移。

#### 4. 检索外框不可覆盖(注入防御)

`SEARCH_RESULTS_WRAPPER_PREFIX` / `SUFFIX` 是硬编码常量,不在 `listEditableSections()` 中暴露,用户无法通过 `promptOverrides` 覆盖。这是 **prompt injection 防御** — 用户自定义的 section 文本可能被 LLM 误读为指令,但检索外框必须是「数据容器」而非「指令容器」。

#### 5. 占位符引擎

`interpolate.ts` 提供简单的 `{{var}}` 占位符替换,在 composer 中按需使用(如 `{{tools}}` 注入工具列表、`{{intent}}` 注入意图)。`validatePlaceholders()` 在设置面板保存前校验自定义文本是否包含所有必需占位符,缺失时给出警告但不阻止保存(允许用户临时写半段)。

#### 6. 热替换

`ToolRegistry.updateDefinition(name, def)` 允许在运行时替换工具的 definition,`main.ts` 的 `syncToolDefinitions()` 在 `saveSettings()` 末尾调用,让用户在设置面板改完提示词后,无需重启插件即可生效。

### 不采纳

- **用 i18n 框架替代 section 注册表** — i18n 解决「同一内容多语言切换」,但本场景需求是「中文为默认 + 用户级 section 覆盖」,不需要运行时切换语言包,自定义注册表更轻量
- **将工具 description 留在 `src/tools/*.ts`** — 会让 RAG 引导与 schema 双源,漂移不可避免
- **检索外框也可覆盖** — prompt injection 风险高于用户自定义收益,不值得
- **完全 JSON 化提示词** — 用户在 textarea 写 markdown 比 JSON 转义更直观

---

## Consequences(后果)

**正面**:

- 全中文 prompt 统一,LLM 收到的上下文语言一致
- 用户可在设置面板覆盖任意 section(`agent.base` / `tool.read_note.description` 等),满足定制化需求
- 工具描述单源,RAG 引导与 schema 不再漂移
- 新增工具只需在 `tool-schemas.ts` + `defaults/zh.ts` 各加一行,Composer 自动接线
- 检索外框硬编码,保证注入防御基线

**负面**:

- `src/prompts/` 新增 7 个文件,代码体积增加(约 600 行)
- 用户自定义提示词后,默认升级可能行为变化(用户写的 section 不会自动跟随默认值更新)
- 24 个 section 元数据表是约定,新增 section 需要同时改 4 处(`PromptSectionId` 类型、`ZH_DEFAULTS`、`SECTION_META`、`listEditableSections` 自动覆盖)

**影响面**:

- 新增 `src/prompts/` 子系统(`types.ts` / `sections.ts` / `defaults/zh.ts` / `interpolate.ts` / `tool-schemas.ts` / `composer.ts` / `index.ts`)
- `src/core/context-manager.ts` — 删除 4 个英文 prompt 常量,改用 `ContextManagerDeps` 注入 getter
- `src/core/intent-classifier.ts` / `query-rewriter.ts` — 删除英文 prompt 模板,改用 `composeInternalMessages`
- `src/tools/*.ts`(9 个)— 删除内联 `definition.description`,改为构造时注入
- `src/tool-registry.ts` — 新增 `updateDefinition()` 热替换方法
- `src/settings.ts` — 新增 `promptOverrides: OverrideMap` 字段 + 设置面板「提示词(高级)」section
- `src/main.ts` — 5 处接线(`registerTools` / `ContextManager` / `classifyIntent` / `rewriteQuery` / `saveSettings`)
- `styles.css` — 新增 4 个 `ratel-prompt-*` CSS 类

---

## 参考

- `src/prompts/composer.ts`(Composer 装配 API)
- `src/prompts/sections.ts`(24 个 section 元数据注册表)
- `src/prompts/defaults/zh.ts`(中文默认值)
- `docs/superpowers/specs/2026-06-26-ratel-prompts-design.md`(S-PROMPTS 设计 spec)
- `docs/superpowers/plans/2026-06-26-ratel-prompts-implementation.md`(P-PROMPTS 实施 plan)
