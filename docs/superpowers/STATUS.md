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
| S-ECOSYSTEM | [2026-08-20-ecosystem-management-design.md](specs/2026-08-20-ecosystem-management-design.md) | Active | 2026-08-20 | P-ECOSYSTEM-1 已归档;P-ECOSYSTEM-2 未收口 |
| S-PLUGIN-PROFILE | [2026-09-10-plugin-profile-design.md](specs/2026-09-10-plugin-profile-design.md) | Active | 2026-09-10 | 2026-09-21 与执行层同交付:schema+示例+匹配+草稿;写入硬依赖 `configure_plugin`;架构 [host/plugin-profile.md](../architecture/host/plugin-profile.md) |
| S-HOST-ACCESS | [2026-09-11-host-access-design.md](specs/2026-09-11-host-access-design.md) | Active | 2026-09-11 | 库外文件+宿主命令:设置总闸默认关,开后走安全/自动/危险且视为破坏性;解析 Skill 另开 spec |


---

## 实施 Plan(任务拆解)

| ID | 文件 | 状态 | 所属 Spec | 备注 |
|---|---|---|---|---|
| P-ECOSYSTEM-2 | [2026-09-21-ecosystem-base.md](plans/2026-09-21-ecosystem-base.md) | In Progress | S-ECOSYSTEM + S-PLUGIN-PROFILE | 已合入 develop，尚未发版；档案匹配与草稿未并入 |

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
2. **P-ECOSYSTEM-2** — In Progress，已合入 develop，尚未发版
4. 候选(无 spec):skill-script-sandbox 心跳用例 fake-timers 化 — 存量时序 flake(300ms 真定时器赛跑,P-VISION-1 审查期间实证 base/HEAD 均间歇失败)
5. S-HOST-ACCESS — 库外访问总闸;不插队;文档解析另开 spec


---

## 已归档

见 [ARCHIVE.md](ARCHIVE.md) — 含按月统计图与全部归档记录(77 条 / 66 目录)。
