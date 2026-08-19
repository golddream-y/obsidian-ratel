# ADR-016:分层注入与统一注入管理器

**状态**:Accepted  
**日期**:2026-08-19  
**关联**:
- [S-SR-LAYERING](../superpowers/specs/2026-08-19-sr-layering-design.md)(本 ADR 实现的 spec)
- [ADR-012](2026-07-23-skill-activation-claude-aligned.md)(Skill 激活走会话消息路径,本 ADR 保持不变)
- PRD §7.5(使用统计只做计数展示,不做自动治理)

---

## Context(背景)

动态 system 段(env / memory / skills)散在 ContextManager 三个 setter + agentLoop 显式调用点,没有统一的预算执行点:

- **global.md 全量注入** — 20KB 硬编码截断,无段落级优先级;核心约束与普通补充一视同仁
- **topics 记忆只能被动召回** — 模型须主动调 `search_memory` 才进入上下文,与当前提问的相关性靠模型自觉
- **Skill Discovery 无差别截断 50 个** — 与当前提问无关的技能挤占清单前排
- **instructions 无单条上限** — 单个超长 SKILL.md 激活即挤占大量上下文
- settings 的三个存量 memory 限制字段(`memoryInjectLimitKB` / `memoryDynamicLimitKB` / `memoryContextTotalLimitKB`)已定义未消费;`memoryTopicsAutoInjectK`(top-K 自动注入条数)为本次新增

---

## Decision(决策)

### 1. 段落级 pinned 标记,不建独立 contract 数据结构

global.md 标题行后缀 `[pinned]` 即恒注入不截断。事实源单一、用户手编直观;独立 contract 结构会与正文失配,不采纳。

### 2. 统一注入管理器 PromptInjector,不继续 setter 堆叠

注入源 ID 用 `as const` 元组集中登记(`src/prompts/injection/ids.ts` 的 `INJECTION_SOURCE_IDS`);源负责构建,管理器负责组装与预算兜底。全局预算需要唯一执行点,继续堆 setter 只会稀释责任。

### 3. 注入源 ID 不用 TS enum

`as const` 元组零运行时产物(esbuild 友好)、类型与值一份声明;`const enum` 跨文件在 isolatedModules 下退化(规范见 AGENTS.md「枚举与 ID 集中管理」)。

### 4. searchResults 不入注入源枚举

它是消息数组路径(`pruneSearchBlocks` 逐条 push),塞进单段枚举会改变 LLM 消息结构;保持既有路径。

### 5. 裁剪顺序

memory 源内超总预算时:pinned 永不砍 → relatedTopics 尾条往上砍 → normal 段减半,循环直到回到预算;只剩 pinned 时接受超出(极端情况)。

### 6. 验证靠用户审阅不靠统计

使用统计只做计数展示,不做 A/B、eval、自动退役(PRD §7.5 非目标;个人库流量撑不起统计置信度)。

---

## Consequences(后果)

**正面**:

- 全部动态段有唯一组装出口与预算兜底,新增动态段只登记 ID + 实现源,不改 toMessages
- 记忆有段落级优先级:pinned 核心约束永不丢,topics 与当前提问相关时主动可见
- settings 的三个存量 memory 限制字段真正被消费、预算可调;另新增 `memoryTopicsAutoInjectK` 控制 topics 自动注入条数

**负面 / 风险**:

- `[pinned]` 是文本约定,标题行写错后缀静默降级为 normal 段(管理面板可查)
- 统计只做展示,「该不该删这条记忆 / 技能」仍靠人判断(有意为之,见决策 6)

**影响面**:

- ContextManager setter 外部签名不变(仅 `setMemoryContext` 追加可选 `layering` 参数),`main.ts` / `agent-loop.ts` 既有调用点零改动
- `appendSkillInstructions` / `appendSkillSupersede` 走历史消息路径(ADR-012),不经 injector,仅加 8KB 截断与计数
- 使用统计落 `pluginDir/usage-stats.json`(不进 data.json、不进 vault);skills 按 `manifest.name`、memoryTopics 按 topic name 计数,管理面板可见

---

## 参考

- `src/prompts/injection/injector.ts`(PromptInjector 与 ownBudgetBytes 兜底截断)
- `src/prompts/injection/ids.ts`(注入源 ID 集中登记)
- `src/prompts/composer.ts`(memory 分层与裁剪顺序)
- [S-SR-LAYERING spec](../superpowers/specs/2026-08-19-sr-layering-design.md)
