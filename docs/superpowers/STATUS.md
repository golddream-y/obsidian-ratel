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
| S-MEMORY-MODAL | [2026-07-31-memory-modal-unify-design.md](specs/2026-07-31-memory-modal-unify-design.md) | Active | 2026-07-31 | 记忆并入聊天路径;抽屉入口+MemoryModal;拆除 brain 独立视图 |
| S-CITE | [2026-07-29-cite-dual-channel-hardening-design.md](specs/2026-07-29-cite-dual-channel-hardening-design.md) | Active | 2026-07-29 | 引用双通道加固;P-CITE Completed |
| S-SKILL | [2026-07-06-skill-mechanism-design.md](specs/2026-07-06-skill-mechanism-design.md) | Active | 2026-07-06 | Skill 机制;激活注入见 ADR-012;P-SKILL-2/3 pending |
| S-SKILL-UX | — | Active | 2026-07-21 | Skill UX;对齐 ADR-010;**spec 文件缺失**(从未入库),需补写或从 STATUS 剔除 |
| S-EVOLUTION | [2026-07-15-evolution-graph-agent.md](specs/2026-07-15-evolution-graph-agent.md) | Active | 2026-07-15 | 图谱原生 Agent;P-EVO-A-READ Completed;下步 P-EVO-A-FM |

---

## 实施 Plan(任务拆解)

| ID | 文件 | 状态 | 所属 Spec | 备注 |
|---|---|---|---|---|
| P-MEMORY-MODAL | [2026-07-31-memory-modal-unify.md](plans/2026-07-31-memory-modal-unify.md) | ✅ Completed | S-MEMORY-MODAL | 分支 feat/p-memory-modal;MemoryModal+拆独立视图;5 Task |
| P-CITE | [2026-07-29-cite-dual-channel-hardening.md](plans/2026-07-29-cite-dual-channel-hardening.md) | ✅ Completed | S-CITE | 分支 feat/p-cite;注入+prompt+chip 显隐+hydrate 重建;7 Task |
| P-EVO-A-READ | [2026-07-15-evo-a-read.md](plans/2026-07-15-evo-a-read.md) | ✅ Completed | S-EVOLUTION | 分支 feat/p-evo-a-read;6 Task + final fix;730 tests;待核对是否已合 main |
| P-EVO-A-FM | — | ⏳ Pending | S-EVOLUTION | update_frontmatter;依赖 P-EVO-A-READ;plan 待写 |
| P-SKILL-2-EXECUTION | — | ⏳ Pending | S-SKILL | references+scripts 沙箱;降优先级,plan 待写 |
| P-SKILL-3-UI | — | ⏳ Pending | S-SKILL | Skill UI;降优先级,plan 待写 |

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

1. **核对 P-EVO-A-READ 合入状态**— Completed 但备注曾写待合并  
2. **P-EVO-A-FM**(update_frontmatter)— plan 待写  
3. **S-EVOLUTION Phase B**(Write Gate + open_note)— plan 待写  
4. **S-EVOLUTION Phase C**(task_plan + 沉淀)— plan 待写  
5. **P-SKILL-2-EXECUTION** / **P-SKILL-3-UI**— 降优先级;P-SKILL-3 对齐 S-SKILL-UX  

---

## 已归档

> 已实施完成的 spec / plan 不再列在主表。具体 spec / plan 文件、关联 plan、执行日志见 `archive/<id>/` 子目录。归档流程详见 AGENTS.md § 文档归档流程。

| ID | 归档目录 | 归档日期 | 备注 |
|---|---|---|---|
| S-SESSION | [archive/S-SESSION/](archive/S-SESSION/) | 2026-07-25 | 发版 0.1.13 |
| S-CHAT-UI-V3 | [archive/S-CHAT-UI-V3/](archive/S-CHAT-UI-V3/) | 2026-07-25 | 发版 0.1.8 |
| S-CHAT-TRACE | [archive/S-CHAT-TRACE/](archive/S-CHAT-TRACE/) | 2026-07-25 | 发版 0.1.9 |
| S-UI-APPEARANCE | [archive/S-UI-APPEARANCE/](archive/S-UI-APPEARANCE/) | 2026-07-25 | 发版 0.1.10 |
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
| S-SETTINGS-DECLARATIVE | [archive/S-SETTINGS-DECLARATIVE/](archive/S-SETTINGS-DECLARATIVE/) | 2026-07-05 | 设置面板声明式迁移;4 commits;release 0.1.2 已上架 |
| S-RAG-ARCH | [archive/S-RAG-ARCH/](archive/S-RAG-ARCH/) | 2026-07-05 | 最终 RAG 架构设计文档;实施通过 W3/W4 等多个 plan 完成 |
| S-I18N-V2 | [archive/S-I18N-V2/](archive/S-I18N-V2/) | 2026-07-06 | i18n V2 全量实现;14 namespace ~340 key;12 commit squash 为 2 |
| S-MEMORY (P-MEMORY-LOGIC) | [archive/S-MEMORY/](archive/S-MEMORY/) | 2026-07-06 | 用户记忆核心逻辑;8 Task + 2 Critical/4 Important 修复;spec 已归档(P-MEMORY-UI 也完成) |
| S-MEMORY (P-MEMORY-UI) | [archive/S-MEMORY/](archive/S-MEMORY/) | 2026-07-06 | 记忆管理面板 + 6 设置项;5 Task + 1 Critical/2 Important/1 Minor 修复;33 i18n key |
| S-SKILL (P-SKILL-1-CORE) | [archive/S-SKILL/](archive/S-SKILL/) | 2026-07-06 | Skill 机制基础层;7 Task + 31 测试;7 commits squash 为 1 (`d9dc98d`);ADR-009;spec 仍 Active(P-SKILL-2/3 未实施) |
| S-CHAT-UI-V2 (P-CHAT-UI-1) | [archive/S-CHAT-UI-V2/](archive/S-CHAT-UI-V2/) | 2026-07-07 | Chat UI 打磨;9 Task + user-guide 同步;10 commit squash 为 1 (`d93328d`);662 tests |
| S-SETTINGS-TAB | [archive/S-SETTINGS-TAB/](archive/S-SETTINGS-TAB/) | 2026-07-15 | 四 Tab + chatPreset + README;Tab 门控改 visible |
| S-INDEX-MANIFEST-FIX | [archive/S-INDEX-MANIFEST-FIX/](archive/S-INDEX-MANIFEST-FIX/) | 2026-07-15 | 清单迁 `.index/ratel-manifest.json`;缺清单不全量 embed |
| S-CHAT-INPUT-MENTIONS | [archive/S-CHAT-INPUT-MENTIONS/](archive/S-CHAT-INPUT-MENTIONS/) | 2026-07-15 | `/`+`@`+file-menu;策略 A |
| S-TOOL-HISTORY-400 | [archive/S-TOOL-HISTORY-400/](archive/S-TOOL-HISTORY-400/) | 2026-07-15 | compact/上送孤立 tool 对齐 |
| S-BASIC-ENV | [archive/S-BASIC-ENV/](archive/S-BASIC-ENV/) | 2026-07-15 | Phase1+2 已随 0.1.5 发版;Phase3 非目标另开 |
| S-I18N | [archive/S-I18N/](archive/S-I18N/) | 2026-07-15 | Superseded by S-I18N-V2;v1 未落地 |
