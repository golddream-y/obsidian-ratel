# Spec 与 Plan 状态追踪表(活跃项)

> **用途:** `docs/superpowers/` 下所有**活跃** spec / plan 的唯一事实源。每当新建 spec / plan、状态变化、执行完成时更新。
>
> **维护规则:** 下列情况必须更新本文件:
> 1. 新建 spec(状态:Draft → Active)
> 2. 从 spec 衍生 plan(状态:Pending)
> 3. plan 开始执行(状态:In Progress)
> 4. plan 执行完成(状态:Completed / Blocked / Abandoned)
> 5. spec 被取代(链接替代者)
>
> **归档:** 完成归档 / 废弃 / 被取代的项从本表移除,登记到 [ARCHIVE.md](ARCHIVE.md)(含统计图与按月索引)。
>
> **Owner 约定:** 文件创建者必须在同一次提交里更新本表。

---

## 活跃 Spec(设计 / 架构文档)

| ID | 文件 | 状态 | 创建日期 | 备注 |
|---|---|---|---|---|
| S-ECOSYSTEM | [2026-08-20-ecosystem-management-design.md](specs/2026-08-20-ecosystem-management-design.md) | Active | 2026-08-20 | 2026-09-21 社区插件底座:search/install/**update**/卸/status/日志/回滚/`configure_plugin`;ADR-018 已立;EC-09 官方设置引导不做;架构 [host/ecosystem.md](../architecture/host/ecosystem.md) |
| S-LLM-RETRY | [2026-09-09-llm-chat-retry.md](specs/2026-09-09-llm-chat-retry.md) | Active | 2026-09-09 | 策略随 0.7.1 发版;UI 见 S-LLM-RETRY-UI;MCP curl 不在范围 |
| S-LLM-RETRY-UI | [2026-09-11-llm-retry-status-design.md](specs/2026-09-11-llm-retry-status-design.md) | Active | 2026-09-11 | 已合入 develop；打字行 connecting + 三条文案；与 S-LLM-RETRY 一并待归档 |
| S-PLUGIN-PROFILE | [2026-09-10-plugin-profile-design.md](specs/2026-09-10-plugin-profile-design.md) | Active | 2026-09-10 | 2026-09-21 与执行层同交付:schema+示例+匹配+草稿;写入硬依赖 `configure_plugin`;架构 [host/plugin-profile.md](../architecture/host/plugin-profile.md) |
| S-HOST-ACCESS | [2026-09-11-host-access-design.md](specs/2026-09-11-host-access-design.md) | Active | 2026-09-11 | 库外文件+宿主命令:设置总闸默认关,开后走安全/自动/危险且视为破坏性;解析 Skill 另开 spec |


---

## 实施 Plan(任务拆解)

| ID | 文件 | 状态 | 所属 Spec | 备注 |
|---|---|---|---|---|
| P-ECOSYSTEM-1 | [2026-09-18-ecosystem-first-slice.md](plans/2026-09-18-ecosystem-first-slice.md) | Completed | S-ECOSYSTEM | 已合入 `v9`;ADR-018 + denylist + search/install。余量见 P-ECOSYSTEM-2 |
| P-ECOSYSTEM-2 | [2026-09-21-ecosystem-base.md](plans/2026-09-21-ecosystem-base.md) | Pending | S-ECOSYSTEM + S-PLUGIN-PROFILE | 社区插件底座:卸/升/配/日志/档案;7 Task 四波;TDD |
| P-LLM-RETRY-UI | [2026-09-14-llm-retry-ui.md](plans/2026-09-14-llm-retry-ui.md) | Completed | S-LLM-RETRY-UI | 拣自 feat/p-llm-retry-ui 合入 develop；打字行 connecting + 三条文案 |

---

## 状态图例

- ⏳ **Pending** — Plan 已创建,未启动
- 🔄 **In Progress** — 已开始执行,subagent-driven-development 进行中
- ✅ **Completed** — 所有任务完成,测试通过,分支已合并或待合并(即将归档的临时态)
- 📦 **Archived** — 已实施完成并归档(主表已不出现此状态,记录见 [ARCHIVE.md](ARCHIVE.md))
- ⛔ **Blocked** — 无法推进,需要人工介入
- 🚫 **Abandoned** — 中途停止,备注里写明原因

> 📦 Archived 不再作为主表的状态值,出现在主表的项都应继续推进(Completed 是「即将归档」的临时态)。归档后从主表**移除**,记录转入 [ARCHIVE.md](ARCHIVE.md)。

---

## Future execution queue(按顺序)

1. **S-LLM-RETRY + S-LLM-RETRY-UI** — 策略与打字行均已落地,两份 spec 一并待归档
2. 候选(无 spec,重启时新开):update_frontmatter / Write Gate / append_to_daily(S-EVOLUTION 写侧,见 archive/S-EVOLUTION/)
3. **P-ECOSYSTEM-2**（S-ECOSYSTEM + S-PLUGIN-PROFILE 底座;含 EC-03）
4. 候选(无 spec):skill-script-sandbox 心跳用例 fake-timers 化 — 存量时序 flake(300ms 真定时器赛跑,P-VISION-1 审查期间实证 base/HEAD 均间歇失败)
5. S-HOST-ACCESS — 库外访问总闸;不插队;文档解析另开 spec


---

## 已归档

见 [ARCHIVE.md](ARCHIVE.md) — 含按月统计图与全部归档记录(74 条 / 63 目录)。
