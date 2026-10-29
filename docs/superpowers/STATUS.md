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
| S-INDEX-RESTART | [2026-10-29-index-restart.md](specs/2026-10-29-index-restart.md) | Active | 2026-10-29 | 源码 ccd63bc 已完成并经两阶段复审；全量 2152 测试通过；已快进合入 develop（ac2de85），合并后构建及 2152 测试通过，未发布／未归档 |
| S-RETRIEVAL-QUALITY | [2026-10-20-retrieval-quality.md](specs/2026-10-20-retrieval-quality.md) | Active | 2026-10-20 | 已实现（代码 8e82abc、fd63107）：分块改 token 预算并真正生效、结构前缀、精排支持专用模型与对话模型双来源及候选不足跳过；分块大小改为档位选择并显示实际生效值；升级触发一次全量重建。2026-10-28 随 [1.2.0](https://github.com/golddream-y/obsidian-ratel/releases/tag/1.2.0) 发布（caaeff2），待归档 |
| S-MULTIFORMAT-FILES | [2026-10-13-multiformat-files-design.md](specs/2026-10-13-multiformat-files-design.md) | Draft | 2026-10-13 | 技术候选；退回目标与需求讨论，未确认范围，不作为实施依据 |
| S-MARKETING-VIDEO | [2026-10-11-marketing-video-design.md](specs/2026-10-11-marketing-video-design.md) | Active | 2026-10-11 | 长期宣传工程；Remotion 独立依赖、双语首片和首页素材；尚未实施 |
| S-COMPACT-V3 | [2026-10-01-compact-v3-design.md](specs/2026-10-01-compact-v3-design.md) | Active | 2026-10-01 | 压缩重设计。P1 已合入（5761c19、e588efe、546df2d）；2026-10-11 复核：P5 砍除、P2 前置复测+output 真值、P3 对齐 Goal/约束会话化；P1F 已完成（64db02a、e33f1a3，随 1.1.0 发版）；P2~P4 未启动 |


---

## 实施 Plan(任务拆解)

| ID | 文件 | 状态 | 所属 Spec | 备注 |
|---|---|---|---|---|
| P-INDEX-RESTART | [2026-10-29-index-restart.md](plans/2026-10-29-index-restart.md) | Completed | S-INDEX-RESTART | codex/fix-index-restart（ccd63bc），两阶段复审及文档同步完成；2152 测试通过，lint 无错误，类型基线无新增；已合入 develop（ac2de85），合并后 build 与 2152 测试通过，待发布 |
| P-RETRIEVAL-QUALITY | [2026-10-20-retrieval-quality.md](plans/2026-10-20-retrieval-quality.md) | Completed | S-RETRIEVAL-QUALITY | 7 个任务已实施：token 计数器、chunker 预算与前缀、参数贯通、chunkerVersion 重建、对话模型精排、开关与来源、验收。2026-10-28 随 1.2.0 发布（caaeff2）；发版前全量 2112 测试通过，[发布 CI](https://github.com/golddream-y/obsidian-ratel/actions/runs/40681329495) 成功，三个附件摘要与本地验证产物一致；待归档 |
| P-COMPACT-V3-P1F | [2026-10-11-compact-v3-p1f.md](plans/2026-10-11-compact-v3-p1f.md) | Completed | S-COMPACT-V3 | feat-compact-fixes（64db02a、e33f1a3），随 1.1.0 发版；apply_patch 入 R2 登记表 + 字段按工具登记；母 spec 仍 Active，暂留 plans/ |
| P-MARKETING-VIDEO | [2026-10-11-marketing-video.md](plans/2026-10-11-marketing-video.md) | Pending | S-MARKETING-VIDEO | 规划完成；先安装官方 Skill 和独立工程，再准备素材与首片 |
| P-COMPACT-V3-P1 | [2026-10-01-compact-v3-p1.md](plans/2026-10-01-compact-v3-p1.md) | Completed | S-COMPACT-V3 | 已合入 develop（5761c19、e588efe、546df2d）。母 spec 仍活跃，P2 未写 |

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

见 [ARCHIVE.md](ARCHIVE.md) — 含按月统计图与全部归档记录(95 条 / 85 目录)。
