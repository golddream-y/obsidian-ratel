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
| S-I18N | [2026-06-14-ratel-i18n-design.md](specs/2026-06-14-ratel-i18n-design.md) | 🚫 Superseded | 2026-06-14 | 已被 S-I18N-V2 取代;估算 key 数严重不足(50 vs 300),覆盖类别不全(3 vs 10) |
| S-SKILL | [2026-07-06-skill-mechanism-design.md](specs/2026-07-06-skill-mechanism-design.md) | Active | 2026-07-06 | Skill 机制(agentskills.io 兼容):三源加载 + Discovery/Active + 2 工具(执行层 P-SKILL-2/3 仍 pending) |
| S-BASIC-ENV | [2026-07-14-agent-basic-env-design.md](specs/2026-07-14-agent-basic-env-design.md) | Active | 2026-07-14 | Agent 基础环境感知:时间注入 + active note + daily/recent/outline |
| S-SETTINGS-TAB | [2026-07-15-settings-tab-readme-design.md](specs/2026-07-15-settings-tab-readme-design.md) | Active | 2026-07-15 | 设置四 Tab 改版 + README 场景/特性；默认模型 deepseek-v4-flash |

---

## 实施 Plan(任务拆解)

| ID | 文件 | 状态 | 所属 Spec | 备注 |
|---|---|---|---|---|
| P-I18N-IMPL | [2026-06-14-ratel-i18n-implementation.md](plans/2026-06-14-ratel-i18n-implementation.md) | 🚫 Superseded | S-I18N | 已被 P-I18N-V2-IMPL 取代 |
| P-BASIC-ENV | [2026-07-14-agent-basic-env.md](plans/2026-07-14-agent-basic-env.md) | ✅ Completed | S-BASIC-ENV | Phase1+2 已落地（main，待 commit） |
| P-SKILL-2-EXECUTION | — | ⏳ Pending | S-SKILL | references+scripts:沙箱+权限+read_skill_reference/run_skill_script 工具;依赖 P-SKILL-1-CORE(已归档);plan 待写 |
| P-SKILL-3-UI | — | ⏳ Pending | S-SKILL | settings 面板+chat 状态显示+预置示例 skills;依赖 P-SKILL-1-CORE(已归档);plan 待写 |

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

1. **P-SETTINGS-TAB**(S-SETTINGS-TAB)— 设置四 Tab + README 场景/特性；spec 已 Active，待审后写 plan
2. **P-SKILL-2-EXECUTION**(S-SKILL 执行)— 沙箱安全风险高;依赖 P-SKILL-1-CORE(已归档);plan 待写
3. **P-SKILL-3-UI**(S-SKILL UI)— 可与 P-SKILL-2 并行;i18n 基础设施已就绪;plan 待写

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
| S-SETTINGS-DECLARATIVE | [archive/S-SETTINGS-DECLARATIVE/](archive/S-SETTINGS-DECLARATIVE/) | 2026-07-05 | 设置面板声明式迁移;4 commits;release 0.1.2 已上架 |
| S-RAG-ARCH | [archive/S-RAG-ARCH/](archive/S-RAG-ARCH/) | 2026-07-05 | 最终 RAG 架构设计文档;实施通过 W3/W4 等多个 plan 完成 |
| S-I18N-V2 | [archive/S-I18N-V2/](archive/S-I18N-V2/) | 2026-07-06 | i18n V2 全量实现;14 namespace ~340 key;12 commit squash 为 2 |
| S-MEMORY (P-MEMORY-LOGIC) | [archive/S-MEMORY/](archive/S-MEMORY/) | 2026-07-06 | 用户记忆核心逻辑;8 Task + 2 Critical/4 Important 修复;spec 已归档(P-MEMORY-UI 也完成) |
| S-MEMORY (P-MEMORY-UI) | [archive/S-MEMORY/](archive/S-MEMORY/) | 2026-07-06 | 记忆管理面板 + 6 设置项;5 Task + 1 Critical/2 Important/1 Minor 修复;33 i18n key |
| S-SKILL (P-SKILL-1-CORE) | [archive/S-SKILL/](archive/S-SKILL/) | 2026-07-06 | Skill 机制基础层;7 Task + 31 测试;7 commits squash 为 1 (`d9dc98d`);ADR-009;spec 仍 Active(P-SKILL-2/3 未实施) |
| S-CHAT-UI-V2 (P-CHAT-UI-1) | [archive/S-CHAT-UI-V2/](archive/S-CHAT-UI-V2/) | 2026-07-07 | Chat UI 打磨;9 Task + user-guide 同步;10 commit squash 为 1 (`d93328d`);662 tests |
