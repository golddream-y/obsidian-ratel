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
| S-SKILL | [2026-07-06-skill-mechanism-design.md](specs/2026-07-06-skill-mechanism-design.md) | Active | 2026-07-06 | Skill 机制;激活注入见 ADR-012;S-SKILL-UX 已归档(结论并入本 spec 语境);P-SKILL-2 pending |
| S-TASK | [2026-08-19-agent-task-store.md](specs/2026-08-19-agent-task-store.md) | Active | 2026-08-19 | Agent 任务机制(task_plan/落盘恢复/GC/全局单活);从 S-EVOLUTION Phase C 摘出,通用基建独立排期;plan 待写 |


---

## 实施 Plan(任务拆解)

| ID | 文件 | 状态 | 所属 Spec | 备注 |
|---|---|---|---|---|
| P-SKILL-2-EXECUTION | [2026-08-19-skill-execution.md](plans/2026-08-19-skill-execution.md) | 🔄 In Progress | S-SKILL | references+scripts 沙箱;运行时定案 ADR-017(Worker+vm 双层,JS-only);分支 feat/p-skill-2-execution;8 Task 并行波次执行 |

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

1. **S-TASK**(task_plan / 落盘恢复 / GC)— spec 已定,plan 待写
2. **P-SKILL-2-EXECUTION** — plan 已就绪(ADR-017 定案),待启动执行
3. 候选(无 spec,重启时新开):update_frontmatter / Write Gate / append_to_daily(S-EVOLUTION 写侧,见 archive/S-EVOLUTION/)  


---

## 已归档

见 [ARCHIVE.md](ARCHIVE.md) — 含按月统计图与全部归档记录(60 条 / 55 目录)。
