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
| S-ECOSYSTEM | [2026-08-20-ecosystem-management-design.md](specs/2026-08-20-ecosystem-management-design.md) | Active | 2026-08-20 | 插件生态管理(PRD 支柱 C):商店探索/安装/配置/更新/回滚;EcosystemChange 变更日志为核心;需 ADR-018(网络出站扩展);plan 待写 |
| S-VISION | [2026-08-20-vision-image-messages.md](specs/2026-08-20-vision-image-messages.md) | Active | 2026-08-20 | 图片消息真正发给模型;P-VISION-1 已合入 develop(squash)。spec **v1.4**:附件外置 + 远端 `chatVisionEnabled`(默认关,OpenAI `image_url`) + localhost Ollama `images[]`;待归档 |
| S-GOAL | [2026-08-22-agent-goal-mode.md](specs/2026-08-22-agent-goal-mode.md) | Active | 2026-08-22 | Agent 目标模式;取代 S-TASK;spec **v1.3** + P-GOAL-1 Pending(指示器:底栏 StatusBarItem、去 emoji、停止≠挂起、继续 chip 唯一目标、GoalCreateModal、撤权=设置页或 pause) |


---

## 实施 Plan(任务拆解)

| ID | 文件 | 状态 | 所属 Spec | 备注 |
|---|---|---|---|---|
| P-GOAL-1 | [2026-08-22-agent-goal-mode.md](plans/2026-08-22-agent-goal-mode.md) | Pending | S-GOAL | 8 Task;对齐 spec v1.3 五面 UI;偏差见 plan |
| P-VISION-1 | [2026-08-20-vision-image-messages.md](plans/2026-08-20-vision-image-messages.md) | ✅ Completed | S-VISION | 已 squash 合入 develop;远端视觉走 OpenAI image_url;发送即清预览;CHANGELOG Unreleased + user-guide §3.1 已写。README 英/中功能清单是否加「带图提问」待确认归档时一并处理 |

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

1. **S-GOAL**(goal 模式)— spec **v1.3** + P-GOAL-1 已定,待启动实施;成果沉淀 v1 用现有 `write_note` 对话确认,不依赖写侧
2. 候选(无 spec,重启时新开):update_frontmatter / Write Gate / append_to_daily(S-EVOLUTION 写侧,见 archive/S-EVOLUTION/)  
3. S-ECOSYSTEM(差异化主打,动工前先确认商店审核口径 + 立 ADR-018)
4. 候选(无 spec):skill-script-sandbox 心跳用例 fake-timers 化 — 存量时序 flake(300ms 真定时器赛跑,P-VISION-1 审查期间实证 base/HEAD 均间歇失败)


---

## 已归档

见 [ARCHIVE.md](ARCHIVE.md) — 含按月统计图与全部归档记录(65 条 / 56 目录)。
