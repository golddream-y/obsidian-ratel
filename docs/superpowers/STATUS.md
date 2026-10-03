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
| S-TOOL-CONTRACT | [2026-10-03-tool-contract-design.md](specs/2026-10-03-tool-contract-design.md) | Active | 2026-10-03 | 工具 JSON 契约、说明去重、失败分类与历史投影；P-TOOL-CONTRACT Pending，未启动修复 |
| S-COMPACT-V3 | [2026-10-01-compact-v3-design.md](specs/2026-10-01-compact-v3-design.md) | Active | 2026-10-01 | 压缩重设计。P1 计划已写，未开工 |
| S-MODEL-CATALOG | [2026-09-28-model-catalog-design.md](specs/2026-09-28-model-catalog-design.md) | Active | 2026-09-28 | 供应商名单；按供应商+模型 id 查窗口和单次输出。列表与密钥改名仍在工作区 |
| S-CHAT-PROFILES | [2026-09-24-chat-profiles-design.md](specs/2026-09-24-chat-profiles-design.md) | Active | 2026-09-24 | 多套配置与顶栏菜单已落地。设置页「设为当前」尚未改调共用函数 |


---

## 实施 Plan(任务拆解)

| ID | 文件 | 状态 | 所属 Spec | 备注 |
|---|---|---|---|---|
| P-TOOL-CONTRACT | [2026-10-03-tool-contract.md](plans/2026-10-03-tool-contract.md) | In Progress | S-TOOL-CONTRACT | develop；按用户要求合并为三个 subagent 工作包执行；基线已备份 |
| P-COMPACT-V3-P1 | [2026-10-01-compact-v3-p1.md](plans/2026-10-01-compact-v3-p1.md) | In Progress | S-COMPACT-V3 | 三路并行：feat/compact-p1-measure、feat/compact-p1-offload、feat/compact-p1-diag。完成后合回 |
| P-MODEL-CATALOG | [2026-09-28-model-catalog.md](plans/2026-09-28-model-catalog.md) | Completed | S-MODEL-CATALOG | 已合入 develop。列表与密钥改名仍在工作区，尚未提交 |
| P-CHAT-PROFILE-MENU | [2026-09-27-chat-profile-menu.md](plans/2026-09-27-chat-profile-menu.md) | Completed | S-CHAT-PROFILES | 顶栏菜单，提交 29069b9。设置页「设为当前」尚未改调共用函数 |
| P-CHAT-PROFILES | [2026-09-24-chat-profiles.md](plans/2026-09-24-chat-profiles.md) | Completed | S-CHAT-PROFILES | 已合 develop（merge a0c0a09）。设置页「设为当前」尚未改调共用函数 |

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

1. 候选(无 spec,重启时新开):update_frontmatter / Write Gate / append_to_daily(S-EVOLUTION 写侧,见 archive/S-EVOLUTION/)
2. 候选(无 spec):skill-script-sandbox 心跳用例 fake-timers 化 — 存量时序 flake(300ms 真定时器赛跑,P-VISION-1 审查期间实证 base/HEAD 均间歇失败)


---

## 已归档

见 [ARCHIVE.md](ARCHIVE.md) — 含按月统计图与全部归档记录(81 条 / 68 目录)。
