# Spec 与 Plan 状态追踪表

> **用途:** `docs/superpowers/` 下所有 spec / plan 的唯一事实源。每当新建 spec / plan、状态变化、执行完成时更新。
>
> **维护规则:** 下列情况必须更新本文件:
> 1. 新建 spec(状态:Draft → Active)
> 2. 从 spec 衍生 plan(状态:Pending)
> 3. plan 开始执行(状态:In Progress)
> 4. plan 执行完成(状态:Completed / Blocked / Abandoned)
> 5. spec 被取代(链接替代者)
>
> **Owner 约定:** 文件创建者必须在同一次提交里更新本表。

---

## 活跃 Spec(设计 / 架构文档)

| ID | 文件 | 状态 | 创建日期 | 备注 |
|---|---|---|---|---|
| S-RAG-ARCH | [2026-06-14-ratel-rag-architecture.md](specs/2026-06-14-ratel-rag-architecture.md) | Active | 2026-06-14 | 最终 RAG 架构(取代 S-RAG-ROADMAP 中的初步想法) |
| S-I18N | [2026-06-14-ratel-i18n-design.md](specs/2026-06-14-ratel-i18n-design.md) | Draft | 2026-06-14 | i18n 基础设施:中英文切换,settings.ts + ChatView + 命令 + Notice 全覆盖 |
| S-MEMORY | [2026-07-05-memory-system-design.md](specs/2026-07-05-memory-system-design.md) | Active | 2026-07-05 | 用户记忆系统:两层架构(全局 + 主题),独立索引,工具驱动,容量可控 |
| S-SETTINGS-DECLARATIVE | [2026-07-05-settings-declarative-migration-design.md](specs/2026-07-05-settings-declarative-migration-design.md) | Active | 2026-07-05 | 设置面板声明式迁移:删除 display(),改用 getSettingDefinitions();解除 0.1.1 发版阻塞 |
| P-SETTINGS-DECLARATIVE | [2026-07-05-settings-declarative-migration.md](plans/2026-07-05-settings-declarative-migration.md) | Pending | 2026-07-05 | S-SETTINGS-DECLARATIVE 的实现 plan,7 个 task:TDD 测试 → override → 子页面 → render wrapper → 重写 getSettingDefinitions → 验证 → 发版 0.1.2 |

---

## 实施 Plan(任务拆解)

| ID | 文件 | 状态 | 所属 Spec | 备注 |
|---|---|---|---|---|
| P-I18N-IMPL | [2026-06-14-ratel-i18n-implementation.md](plans/2026-06-14-ratel-i18n-implementation.md) | ⏳ Pending | S-I18N | ⚠️ Task 7 假设 `display()` 存在,P-SETTINGS-DECLARATIVE 完成后需重写(改为改 `getSettingDefinitions()`) |
| P-MEMORY-LOGIC | [2026-07-05-memory-system-logic.md](plans/2026-07-05-memory-system-logic.md) | ⏳ Pending | S-MEMORY | 核心逻辑:MemoryStore + 3 个工具 + ContextManager 注入（先于 P-MEMORY-UI） |
| P-MEMORY-UI | [2026-07-05-memory-system-ui.md](plans/2026-07-05-memory-system-ui.md) | ⏳ Pending | S-MEMORY | UI+设置:记忆面板 + 6 个设置项（依赖 P-MEMORY-LOGIC);⚠️ Task 1 假设 `display()` 存在,P-SETTINGS-DECLARATIVE 完成后需重写 |

---

## 状态图例

- ⏳ **Pending** — Plan 已创建,未启动
- 🔄 **In Progress** — 已开始执行,subagent-driven-development 进行中
- ✅ **Completed** — 所有任务完成,测试通过,分支已合并或待合并(即将归档的临时态)
- 📦 **Archived** — 已实施完成并归档(主表已不出现此状态,只用于归档文件内部标注与「已取代 / 归档」区汇总)
- ⛔ **Blocked** — 无法推进,需要人工介入
- 🚫 **Abandoned** — 中途停止,备注里写明原因

> 📦 Archived 不再作为主表的状态值,出现在主表的项都应继续推进(Completed 是「即将归档」的临时态)。归档后从主表**移除**。

---

## Future execution queue(按顺序)

1. **P-I18N-IMPL**(i18n 基础设施:中英文切换)
2. 在 Obsidian 里手动 E2E 验证(M3 里程碑)

---

## 已归档

> 已实施完成的 spec / plan 不再列在主表。具体 spec / plan 文件、关联 plan、执行日志见 `archive/<id>/` 子目录。归档流程详见 AGENTS.md § 文档归档流程。

| ID | 归档目录 | 归档日期 | 备注 |
|---|---|---|---|
| S-ARCH-001 | [archive/S-ARCH-001/](archive/S-ARCH-001/) | 2026-06-14 | — |
| S-MODEL-001 | [archive/S-MODEL-001/](archive/S-MODEL-001/) | 2026-06-14 | — |
| S-TEST-ARCH | [archive/S-TEST-ARCH/](archive/S-TEST-ARCH/) | 2026-06-14 | 含 P-W3-TEST / P-W4-TEST(Superseded) |
| P-DOCS-CN | [archive/P-DOCS-CN/](archive/P-DOCS-CN/) | 2026-06-14 | — |
| S-RAG-LOOP | [archive/S-RAG-LOOP/](archive/S-RAG-LOOP/) | 2026-06-17 | — |
| S-KEYCHAIN | [archive/S-KEYCHAIN/](archive/S-KEYCHAIN/) | 2026-06-26 | — |
| S-INIT-INDEX | [archive/S-INIT-INDEX/](archive/S-INIT-INDEX/) | 2026-06-26 | — |
| S-DIAG | [archive/S-DIAG/](archive/S-DIAG/) | 2026-06-26 | — |
| S-FEEDBACK | [archive/S-FEEDBACK/](archive/S-FEEDBACK/) | 2026-06-26 | — |
| S-RAG-ROADMAP | [archive/S-RAG-ARCH/](archive/S-RAG-ARCH/) | 2026-06-27 | Superseded,归入 S-RAG-ARCH |
| S-W3-HYBRID | [archive/S-W3-HYBRID/](archive/S-W3-HYBRID/) | 2026-06-27 | 含 P-W3-IMPL(Superseded) |
| S-W4-RAG-ENHANCEMENT | [archive/S-W4-RAG-ENHANCEMENT/](archive/S-W4-RAG-ENHANCEMENT/) | 2026-06-27 | 含 P-W4-IMPL(Superseded) |
| S-VAULT-TOOLS | [archive/S-VAULT-TOOLS/](archive/S-VAULT-TOOLS/) | 2026-06-27 | — |
| S-CHAT-UI | [archive/S-CHAT-UI/](archive/S-CHAT-UI/) | 2026-06-27 | — |
| S-MD-MERMAID | [archive/S-MD-MERMAID/](archive/S-MD-MERMAID/) | 2026-06-27 | — |
| S-INDEX-BLOCK | [archive/S-INDEX-BLOCK/](archive/S-INDEX-BLOCK/) | 2026-06-27 | — |
| S-DEFENSIVE | [archive/S-DEFENSIVE/](archive/S-DEFENSIVE/) | 2026-06-27 | Abandoned,未实施;G3 svelte-check 串 build 已独立落地 |
| S-MSG-STREAM | [archive/S-MSG-STREAM/](archive/S-MSG-STREAM/) | 2026-07-04 | Chat 消息流重构;17 commits 合并,453 tests |
| S-DOCS-V1 | [archive/S-DOCS-V1/](archive/S-DOCS-V1/) | 2026-07-04 | 文档体系 v1;7 Task,中英双语 README |
| S-CONTEXT-WINDOW | [archive/S-CONTEXT-WINDOW/](archive/S-CONTEXT-WINDOW/) | 2026-07-04 | LiteLLM 映射 + Context Length 预设;7 Task;⚠️ 实施代码仍在 `feat/s-context-window` 分支待合并 |
| S-INDEX-STARTUP | [archive/S-INDEX-STARTUP/](archive/S-INDEX-STARTUP/) | 2026-07-04 | smart reindex 启动路径;8 Task + 6 缺口修复 |
| S-PROMPTS | [archive/S-PROMPTS/](archive/S-PROMPTS/) | 2026-07-04 | Prompt Registry + 全中文默认值 + section 覆盖 + 热替换;10 Task;12 commits squash 为 1;ADR-008 |
| S-CLEANUP-1 | [archive/S-CLEANUP-1/](archive/S-CLEANUP-1/) | 2026-07-05 | 杂项缺失修复与技术债清理;24 Task(1-16 前序会话,17-24 本会话);squash 合并 commit `3590b23` |
