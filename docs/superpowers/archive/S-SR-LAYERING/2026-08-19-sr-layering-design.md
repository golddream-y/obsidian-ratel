# S-SR-LAYERING — 记忆与 Skill 分层注入 + 统一注入管理器 + 使用统计

## 背景

PRD §7.5「自我改进」要求分层注入（SR-02）与使用反馈（SR-03）。现状调研发现四块差距：

1. **注入管道碎片化** — 动态注入散在 ContextManager 的 5 个 setter（env / memory / skills / searchResults / skillInstructions）+ agentLoop 显式调用点，无统一抽象；全局预算（`memoryContextTotalLimitKB`）没有执行点。
2. **记忆注入两极** — global.md 全量注入（20KB 硬编码截断，settings 的 `memoryInjectLimitKB` 未消费）；topics 记忆只有模型主动调 `search_memory` 才能进上下文，用户问「我的月度目标在哪」时模型可能想不起来要去查。
3. **Skill 注入无保护** — Discovery 段无差别截断 50 个（不按相关性）；激活后 instructions 全文写入 Session.messages，无单条上限，巨型 Skill 可吃光上下文。
4. **无使用统计** — Skill 只有 enable/disable，用户不知道哪个真在被用。

参考 agentlearn 机制调研结论：知识分层注入（pinned 恒注入 + 其余按查询混合检索）对笔记 Agent 有双重收益（省上下文 + 核心约定永不被检索噪声挤掉）；统计验证/A/B/自动退役不适合个人库流量，用「使用次数可见」替代。

## 目标

- **G1 统一注入管理器（PromptInjector）** — 所有动态段注册为注入源，统一组装、统一预算裁剪；TS 枚举集中管理。
- **G2 记忆分层** — global.md 段落级 pinned 恒注入（RoutineContract 事实源）；topics 按当前查询自动检索 top-K 摘要注入；三个已定义未消费的 settings 限制字段全部接线。
- **G3 Skill 分层** — Discovery 按 tags+关键词相关性排序；instructions 单条截断保护；i18n description locale fallback。
- **G4 使用统计** — Skill 激活次数、记忆 topics 自动注入命中次数，管理面板可见。
- **G5 架构文档同步** — 新 ADR-016 + `docs/architecture/` 相关章节统一调整。

## 非目标

- 不做统计 A/B 验证、eval 数据集、效果率自动退役（PRD §7.5 非目标）
- 不做教训沉淀闭环（SR-01，依赖洞察收件箱，另行立项）
- 不做第三方注入源扩展 API（注入源注册是内部机制，不对外承诺）
- 不做 `[skill-off]` 历史消息清理（属上下文裁剪域，S-CTX-TRIM 已覆盖相关机制）
- 不做 Skill instructions 选段注入（激活语义就是全文生效，选段改变行为）
- 不做记忆冲突检测引擎（沿用 PRD「展示来源，不静默猜测」）

## 详细设计

### 1. 统一注入管理器 PromptInjector

**位置**：`src/prompts/injection/`

```
src/prompts/injection/
├── ids.ts        # 注入源 ID 枚举(集中管理,AGENTS.md 枚举规范)
└── injector.ts   # PromptInjector 类(InjectionSource 接口 + 组装 + 预算兜底)
```

> 注入源实例不单独建文件:env/memory/skills 三源的 build 闭包在 ContextManager 构造时内联注册(读自身字段),避免为三个单行 getter 造三个文件。

**枚举集中管理（ids.ts）** — 遵循 AGENTS.md「枚举与 ID 集中管理」规范：登记表需求用 `as const` 元组 + 类型推导（强类型枚举惯用法，零运行时产物，esbuild 友好），不用 TS `enum`：

```typescript
/** 全部注入源 ID;新增源必须在此登记 */
export const INJECTION_SOURCE_IDS = [
  'env',    // 本地时间等环境行
  'memory', // 记忆 global + topics top-K
  'skills', // Skill Discovery 段
] as const;

export type InjectionSourceId = (typeof INJECTION_SOURCE_IDS)[number];
```

> searchResults 不入枚举:它是消息数组路径(`pruneSearchBlocks` 逐条 push,非单段 system 文本),
> 塞进单段枚举会改变 LLM 消息结构。保持既有路径,ADR-016 记录该取舍。

**注入源接口（injector.ts）**：

```typescript
interface InjectionSource {
  id: InjectionSourceId;
  /** 构建本段内容;返回 null 表示本段缺席 */
  build(): string | null;
  /** 本段字节预算硬上限(未设 = 不限);超出时尾部截断 + 告警 — 兜底,源内部应先自限 */
  ownBudgetBytes?: number;
}
```

**职责边界**：
- **源负责构建**（有状态；refresh 时机不变——main.ts `ask()` 启动、agentLoop 每轮、activate/deactivate_skill 后，由既有调用点触发源内部状态更新）
- **管理器负责组装 + 预算** — `ContextManager.toMessages()` 改为从 injector 拉取各段；预算裁剪在此唯一执行点
- **迁移路径** — env / memory / skills 三个 setter 签名不变（外部调用点 main.ts / agent-loop.ts 零改动），内部改为写对应 source 的状态；`toMessages()` 从「读自身字段」改为 `injector.buildSections()`。**不经 injector**：`appendSkillInstructions` / `appendSkillSupersede` 写入的是历史消息（Session.messages，ADR-012 语义），不是动态 system 段，仅按 §3 加截断保护

**裁剪框架**：injector 提供统一的「预算 + 优先级」裁剪机制。当前仅 memory 源挂全局预算（`memoryContextTotalLimitKB`，语义即「基础+动态记忆合计」，不外溢到其他源）；skills 源用自身条目上限。memory 源内超预算时依次执行，直到回到预算内：

1. pinned 段永不砍
2. topics top-K 条目从尾条往上砍
3. global.md 非 pinned 段截断（保留段头）

**与静态段的关系**：`sections.ts` 注册表继续管静态段（zone: `static`），injector 管动态段（zone: `dynamic`）——补齐 S-PROMPTS 留下的另一半；`agent.skills` 等 dynamic section 的模板仍走 `resolveSection()`，injector 只管「内容构建与预算」，模板解析不重复造。

### 2. 记忆分层（memory 源内部）

**global.md 段落级 pinned**：
- 标记形态：标题行后缀 `## 偏好 [pinned]`（正则 `/\[pinned\]\s*$/` 识别；事实源就在正文，用户手编直观，无独立数据结构）
- pinned 段落恒注入、不参与截断——即 PRD RoutineContract 的事实源（日记位置、月度目标、常用位置等工作契约）
- 非 pinned 段落合走 `memoryInjectLimitKB` 预算（替换 composer.ts 硬编码的 20KB）
- 解析失败（无标记）= 全部按非 pinned 处理，向后兼容现有 global.md

**topics 自动检索注入**：
- 时机：每次 `ask()` 组装上下文时，用当前用户消息做一次本地 embedding → 记忆 vectra 索引 hybridSearch → top-K（默认 K=3，settings 可调）
- 注入内容：主题名 + index.md 摘要行，**不是全文**——模型要细节仍调 `search_memory`，自动注入与按需检索不重复供给
- 位置：memory system prompt 内新增「相关记忆」子段，与 globalContent 同块，共用 retrieval wrapper（防 prompt injection）
- 命中即计数（G4 统计口径）
- 用户消息为空或 embedding 失败时静默跳过，不阻断 ask

**settings 接线**（三个字段从「已定义未消费」转为生效）：

| 字段 | 生效点 | 默认值 |
|---|---|---|
| `memoryInjectLimitKB` | global.md 非 pinned 段落预算 | 20 |
| `memoryDynamicLimitKB` | search_memory 返回截断（替换 search-memory.ts 硬编码 30KB） | 30 |
| `memoryContextTotalLimitKB` | injector 内 memory 源全局预算（基础+动态合计） | 50（settings.ts 现有默认） |

新增 setting：`memoryTopicsAutoInjectK`（默认 3，0 = 关闭自动注入）。

### 3. Skill 分层（skills 源 + 激活路径）

**Discovery 段粗筛**：
- `composeDiscovery()` 按 tags 与用户消息关键词匹配打分排序，再截断到 50——装的 Skill 多了按相关性保留，不再按列表顺序随机丢
- 顺手修 i18n：description 取值走 `manifest.i18n.description[locale]` → 顶层 `description` fallback（v1 遗留）

**instructions 单条上限**：
- `activate_skill` 注入时单条截断（默认 8KB 常量，尾注「已截断，完整内容可查看 SKILL.md」）
- 激活路径（写入 Session.messages）不动语义，只加截断保护

### 4. 使用统计

**Skill 侧**：
- 口径：`activate_skill` 工具成功执行 +1
- 落盘：插件数据目录独立 JSON（`.ratel/skill-stats.json` 或等效），**不进 settings/data.json**（避免每次激活都写主配置）
- 展示：SkillManageModal 列表加「使用 N 次」列

**记忆侧**：
- 口径：topics 自动注入命中 +1（search_memory 手动检索不计）
- 落盘：同一统计文件
- 展示：MemoryPanel 主题列表显示命中次数

**不做**衰减、自动退役、趋势图——只给计数。

### 5. i18n 与权限

- 新增用户可见字符串全部走 i18n（zh/en 同步）：设置项名称与描述（`memoryTopicsAutoInjectK`）、SkillManageModal 列头、MemoryPanel 列头、截断尾注（面向 LLM 的除外）
- 无新工具、无权限变更；`activate_skill` 既有权限链路不变

## 影响面

**新增文件**：
- `src/prompts/injection/ids.ts` / `injector.ts`（注入源不单独建文件,build 闭包在 ContextManager 构造时内联注册,见 §1）
- `src/core/usage-stats.ts`（使用统计存储）
- `docs/adr/2026-08-19-layered-injection.md`（ADR-016）

**修改文件**：
- `src/core/context-manager.ts` — setter 内部改走 injector；`toMessages()` 从 injector 拉段
- `src/prompts/composer.ts` — 20KB 硬编码改消费 settings；「相关记忆」子段模板
- `src/core/memory-store.ts` — pinned 段落解析；topics 检索供注入
- `src/skills/skill-activator.ts` — Discovery 相关性排序 + i18n fallback
- `src/tools/activate-skill.ts` — instructions 截断 + 统计计数
- `src/tools/search-memory.ts` — 30KB 硬编码改消费 settings
- `src/settings.ts` — 新增 `memoryTopicsAutoInjectK`
- `src/ui/skills/SkillManageModal.ts` — 使用次数列
- `src/ui/memory-panel/MemoryPanel.svelte` — 命中次数
- `src/i18n/zh.ts` / `en.ts` / `types.ts` — 新 key
- `src/main.ts` — 注入源装配（refresh 时机不变）

**架构文档统一调整（G5，用户明确要求）**：
- `docs/architecture/agent/prompt-management.md` — 补「动态注入管理器」一节：injector 与 sections 注册表的 static/dynamic 分工、注入源清单、裁剪顺序
- `docs/architecture/agent/context-manager.md` — 注入流程图更新（5 setter → injector 状态写入；toMessages 拉取路径）
- `docs/architecture/agent/capability-surface.md` — Skill 注入小节更新（Discovery 相关性排序、单条截断、使用统计）
- `docs/architecture/overview.md` — 若有注入相关描述则同步（无则不动）
- ADR-016 记录三个决策：① 段落级 pinned 标记 vs 独立 contract 数据结构（选前者：事实源单一、手编直观）② 统一注入管理器 vs 继续 setter 堆叠（选前者：全局预算需要唯一执行点）③ 注入源 ID 用 `as const` 元组而非 TS `enum`（esbuild 运行时产物与 isolatedModules 坑，理由见 AGENTS.md 枚举规范）；另记 searchResults 不入注入源枚举的取舍（消息数组路径，非单段 system 文本）

**风险**：
- toMessages 行为变化影响所有会话 — 靠既有 1191 测试 + 新增注入层单测兜底
- topics 自动注入每轮多一次 embedding 调用（本地 ONNX Worker，毫秒级，可接受；失败静默跳过）
- pinned 标记被用户误删 — 降级为普通段落，无功能损坏

## 参考

- PRD §7.5 自我改进、§8.5、§11 SR-01~03、§14.1、§17、§18（本次会话已写入）
- agentlearn.dev 机制调研（失败沉淀 / 分层注入 / 有效性追踪的取舍结论）
- S-PROMPTS（sections 注册表，静态段管理）；ADR-012（skill 激活写入 Session.messages）
- S-SKILL-UX / P-SKILL-UX-V2（SkillManageModal 现状）
- 调研基线：`src/core/context-manager.ts`（5 setter）、`src/prompts/composer.ts:280`（20KB 硬编码）、`src/tools/search-memory.ts:19`（30KB 硬编码）、`src/skills/skill-registry.ts`（激活全文注入）
