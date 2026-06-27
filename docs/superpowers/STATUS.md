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
| S-DEFENSIVE | [2026-06-14-ratel-defensive-programming-design.md](specs/2026-06-14-ratel-defensive-programming-design.md) | Draft | 2026-06-14 | 防御性编程:反应式 Settings Proxy + Svelte 5 svelte-check + ChatView mount 单测,根治「改 key 不生效」「let 隐式 prop」「new Component 单参」3 类反复 bug |
| S-PROMPTS | [2026-06-26-ratel-prompts-design.md](specs/2026-06-26-ratel-prompts-design.md) | Active | 2026-06-26 | LLM 提示词中文统一 registry + Composer 动态注入 + section 级 promptOverrides;检索外框不可删 |

---

## 实施 Plan(任务拆解)

| ID | 文件 | 状态 | 所属 Spec | 备注 |
|---|---|---|---|---|
| P-I18N-IMPL | [2026-06-14-ratel-i18n-implementation.md](plans/2026-06-14-ratel-i18n-implementation.md) | ⏳ Pending | S-I18N | — |
| P-PROMPTS | [2026-06-26-ratel-prompts-implementation.md](plans/2026-06-26-ratel-prompts-implementation.md) | ⏳ Pending | S-PROMPTS | **下一步优先实施** |

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

1. **P-PROMPTS**(提示词 registry + 全中文迁移)— 下一步优先实施
2. **P-I18N-IMPL**(i18n 基础设施:中英文切换)
3. 修 `svelte-eslint-parser` 配置,让 `npx eslint src/` 覆盖 `*.svelte` 文件
4. 在 Obsidian 里手动 E2E 验证(M3 里程碑)

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
