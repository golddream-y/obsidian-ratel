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
| S-RAG-ROADMAP | [2026-06-13-rag-enhancement-roadmap-design.md](specs/2026-06-13-rag-enhancement-roadmap-design.md) | **Superseded** | 2026-06-13 | 已被 S-RAG-ARCH + 架构文档取代 |
| S-RAG-ARCH | [2026-06-14-ratel-rag-architecture.md](specs/2026-06-14-ratel-rag-architecture.md) | Active | 2026-06-14 | 最终 RAG 架构(取代 S-RAG-ROADMAP 中的初步想法) |
| S-W3-HYBRID | [2026-06-26-ratel-w3-hybrid-search-design.md](specs/2026-06-26-ratel-w3-hybrid-search-design.md) | Active | 2026-06-26 | W3 切片:vectra 内置混合搜索 + 轻量意图分类器 + 引用 [1][2] + search.result UI 卡片(取代 P-W3-IMPL 设计假设) |
| S-W4-RAG-ENHANCEMENT | [2026-06-26-ratel-w4-rag-enhancement-design.md](specs/2026-06-26-ratel-w4-rag-enhancement-design.md) | Active | 2026-06-26 | W4 切片:Query Rewrite + RRF 多查询融合 + 百炼 Reranker + Indexer subagent(依赖 S-W3-HYBRID 完成) |
| S-I18N | [2026-06-14-ratel-i18n-design.md](specs/2026-06-14-ratel-i18n-design.md) | Draft | 2026-06-14 | i18n 基础设施:中英文切换,settings.ts + ChatView + 命令 + Notice 全覆盖 |
| S-DEFENSIVE | [2026-06-14-ratel-defensive-programming-design.md](specs/2026-06-14-ratel-defensive-programming-design.md) | Draft | 2026-06-14 | 防御性编程:反应式 Settings Proxy + Svelte 5 svelte-check + ChatView mount 单测,根治「改 key 不生效」「let 隐式 prop」「new Component 单参」3 类反复 bug |
| S-VAULT-TOOLS | [2026-06-26-vault-file-tools-design.md](specs/2026-06-26-vault-file-tools-design.md) | Active | 2026-06-26 | Vault 基础文件操作工具集:grep/glob/list_files(只读) + write_note/append_note/edit_note/delete_note(写入),补齐精确搜索与 CRUD 能力 |
| S-PROMPTS | [2026-06-26-ratel-prompts-design.md](specs/2026-06-26-ratel-prompts-design.md) | Active | 2026-06-26 | LLM 提示词中文统一 registry + Composer 动态注入 + section 级 promptOverrides;检索外框不可删 |
| S-CHAT-UI | [2026-06-26-ratel-chat-ui-redesign-design.md](specs/2026-06-26-ratel-chat-ui-redesign-design.md) | Active | 2026-06-26 | Chat UI 重设计:底部 StatusLine + 抽屉 Drawer + 斜杠命令 + 图片上传预留 + Notice 迁移 |
| S-MD-MERMAID | [2026-06-27-ratel-streaming-markdown-mermaid-design.md](specs/2026-06-27-ratel-streaming-markdown-mermaid-design.md) | Active | 2026-06-27 | 流式 Markdown + Mermaid 渲染:marked.js + DOMPurify + highlight.js + mermaid v11,独立 MarkdownView.svelte 组件,rAF 节流 |


---

## 实施 Plan(任务拆解)

| ID | 文件 | 状态 | 分支 | 启动 | 完成 | 所属 Spec |
|---|---|---|---|---|---|---|
| P-W3-IMPL | [2026-06-13-ratel-w3-implementation.md](plans/2026-06-13-ratel-w3-implementation.md) | **Superseded** | — | — | — | ~~S-RAG-ARCH (W3 切片)~~ → S-W3-HYBRID |
| P-W4-IMPL | [2026-06-13-ratel-w4-implementation.md](plans/2026-06-13-ratel-w4-implementation.md) | **Superseded** | — | — | — | ~~S-RAG-ARCH (W4 切片)~~ → S-W4-RAG-ENHANCEMENT |
| **P-W3-HYBRID** | [2026-06-26-ratel-w3-hybrid-implementation.md](plans/2026-06-26-ratel-w3-hybrid-implementation.md) | ✅ Completed | main | 2026-06-26 | 2026-06-26 | S-W3-HYBRID |
| **P-W4-RAG** | [2026-06-26-ratel-w4-rag-implementation.md](plans/2026-06-26-ratel-w4-rag-implementation.md) | ✅ Completed | main | 2026-06-26 | 2026-06-26 | S-W4-RAG-ENHANCEMENT |
| P-W3-TEST | [2026-06-14-ratel-w3-test-plan.md](plans/2026-06-14-ratel-w3-test-plan.md) | ⏳ Pending | — | — | — | S-TEST-ARCH (W3 计划) |
| P-W4-TEST | [2026-06-14-ratel-w4-test-plan.md](plans/2026-06-14-ratel-w4-test-plan.md) | ⏳ Pending | — | — | — | S-TEST-ARCH (W4 计划) |
| P-I18N-IMPL | [2026-06-14-ratel-i18n-implementation.md](plans/2026-06-14-ratel-i18n-implementation.md) | ⏳ Pending | — | — | — | S-I18N |
| **P-VAULT-TOOLS** | [2026-06-26-ratel-vault-tools-implementation.md](plans/2026-06-26-ratel-vault-tools-implementation.md) | ✅ Completed | feat/vault-tools | 2026-06-24 | 2026-06-24 | S-VAULT-TOOLS |
| **P-PROMPTS** | [2026-06-26-ratel-prompts-implementation.md](plans/2026-06-26-ratel-prompts-implementation.md) | ⏳ Pending | — | — | — | S-PROMPTS |
| **P-CHAT-UI** | [2026-06-26-ratel-chat-ui-redesign.md](plans/2026-06-26-ratel-chat-ui-redesign.md) | ✅ Completed | feat/chat-ui | 2026-06-26 | 2026-06-27 | S-CHAT-UI |
| **P-MD-MERMAID** | [2026-06-27-ratel-streaming-markdown-mermaid-implementation.md](plans/2026-06-27-ratel-streaming-markdown-mermaid-implementation.md) | ✅ Completed | feat/markdown-mermaid | 2026-06-27 | 2026-06-27 | S-MD-MERMAID |

> **Superseded 说明**:
> - P-W3-IMPL(2026-06-13)基于"手动两路搜索 + RRF"设计,审查发现 vectra 已内置 `isBm25` 混合搜索,设计前提不成立。改由 [S-W3-HYBRID](specs/2026-06-26-ratel-w3-hybrid-search-design.md) 重新设计,新 plan 见 [P-W3-HYBRID](plans/2026-06-26-ratel-w3-hybrid-implementation.md)。
> - P-W4-IMPL(2026-06-13)需与 W3 新架构对齐(RRF 在 W4 才有真实用途 — 多查询融合)。改由 [S-W4-RAG-ENHANCEMENT](specs/2026-06-26-ratel-w4-rag-enhancement-design.md) 重新设计,新 plan 见 [P-W4-RAG](plans/2026-06-26-ratel-w4-rag-implementation.md)。

---

## 状态图例

- ⏳ **Pending** — Plan 已创建,未启动
- 🔄 **In Progress** — 已开始执行,subagent-driven-development 进行中
- ✅ **Completed** — 所有任务完成,测试通过,分支已合并或待合并
- 📦 **Archived** — 已实施完成并归档(主表已不出现此状态,只用于归档文件内部标注与「已取代 / 归档」区汇总)
- ⛔ **Blocked** — 无法推进,需要人工介入
- 🚫 **Abandoned** — 中途停止,备注里写明原因

> 📦 Archived 不再作为主表的状态值,出现在主表的项都应继续推进(Completed 是「即将归档」的临时态)。归档后从主表**移除**。

---

## Future execution queue(按顺序)

1. ~~合并 `test/w1-backfill` → main~~(本批已随 W2 合并捎带 — 实际上 W1 work 全部进了主分支)
2. ~~合并 `test/w2-backfill` → main~~ ✅(commit `3a3cb9f`)
3. ~~P-W3-IMPL~~ → **Superseded**,改由 S-W3-HYBRID 衍生新 plan → **P-W3-HYBRID**(已生成,⏳ Pending)
4. ~~**P-W3-HYBRID**~~(W3 实现 plan) ✅(2026-06-26 完成,9 tasks,275/275 测试通过)
5. P-W3-TEST(W3 测试计划,需基于 S-W3-HYBRID 新架构重写)
6. ~~P-W4-IMPL~~ → **Superseded**,改由 S-W4-RAG-ENHANCEMENT 衍生新 plan → **P-W4-RAG**(已生成,⏳ Pending)
7. ~~**P-W4-RAG**~~(W4 实现 plan) ✅(2026-06-26 完成,9 tasks,309/309 测试通过)
8. P-W4-TEST(W4+ 测试计划,需基于 S-W4-RAG-ENHANCEMENT 新架构重写)
9. 在 Obsidian 里手动 E2E 验证(M3 里程碑)
10. ~~合并 `chore/translate-comments-to-chinese` → main~~(本批已捎带,中文注释已随 W2 合并进主分支)
11. **P-PROMPTS**(提示词 registry + 全中文迁移;**应先于 P-VAULT-TOOLS**)
12. ~~**P-VAULT-TOOLS**~~(Vault 文件工具集) ✅(2026-06-24,328 tests)
13. **P-CHAT-UI**(Chat UI 重设计:底部 StatusLine + 抽屉 + 斜杠命令 + 图片上传预留 + ChatView.svelte Svelte 5 迁移;11 tasks,关联 S-CHAT-UI)
14. **后续:** 修 `svelte-eslint-parser` 配置,让 `npx eslint src/` 覆盖 `*.svelte` 文件

---

## 已归档(2026-06-14 一批)

> 已实施完成的 spec / plan 不再列在主表。具体 spec / plan 文件、关联 plan、执行日志见 `archive/<id>/` 子目录。归档流程详见 AGENTS.md § 文档归档流程。

| ID | 归档目录 | 归档日期 |
|---|---|---|
| S-ARCH-001 | [archive/S-ARCH-001/](archive/S-ARCH-001/) | 2026-06-14 |
| S-MODEL-001 | [archive/S-MODEL-001/](archive/S-MODEL-001/) | 2026-06-14 |
| S-TEST-ARCH | [archive/S-TEST-ARCH/](archive/S-TEST-ARCH/) | 2026-06-14 |
| P-DOCS-CN | [archive/P-DOCS-CN/](archive/P-DOCS-CN/) | 2026-06-14 |
| S-RAG-LOOP | [archive/S-RAG-LOOP/](archive/S-RAG-LOOP/) | 2026-06-17 |
| S-KEYCHAIN | [archive/S-KEYCHAIN/](archive/S-KEYCHAIN/) | 2026-06-26 |
| S-INIT-INDEX | [archive/S-INIT-INDEX/](archive/S-INIT-INDEX/) | 2026-06-26 |
| S-DIAG | [archive/S-DIAG/](archive/S-DIAG/) | 2026-06-26 |
| S-FEEDBACK | [archive/S-FEEDBACK/](archive/S-FEEDBACK/) | 2026-06-26 |

---

## 架构决策记录(ADR)

> **目录:** [`docs/adr/`](../adr/)
> **命名:** `ADR-NNN` 编号(单调递增),文件 `YYYY-MM-DD-<slug>.md`
> **格式:** Nygard 经典结构(Status / 背景 / 根因 / 调研范围 / 决策 / 备选 / 后果 / 关键决策点 / 安全与隐私 / 实施计划 / 参考),中文主体(AGENTS.md § 文档与注释规范)
> **安全:** 任何 API key / token 在 ADR 中必须以 `<REDACTED-XXX>` 占位,**完整密钥永久不进 git**

| ID | 文件 | 状态 | 日期 | 概要 |
|---|---|---|---|---|
| ADR-001 | [2026-06-14-ratel-cors-strategy.md](../adr/2026-06-14-ratel-cors-strategy.md) | Draft | 2026-06-14 | LLM 端点 CORS 处理策略:阶段 1 引入 `chatTransport` 字段在 `fetch` / `requestUrl` 间切换(后者绕 CORS 失流式);阶段 2 留 SDK header 清理占位;阶段 3 暂缓本地代理 |

