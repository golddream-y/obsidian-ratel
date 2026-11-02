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
| S-ADAPTIVE-INDEX | [2026-11-02-adaptive-indexing.md](specs/2026-11-02-adaptive-indexing.md) | Active | 2026-11-02 | BUG-1-INDEX-PERF-001；[总体架构](../architecture/proposals/2026-11-02-index-runtime.md)与 spec 自审通过，已补 grant/ticket、Vault 轻量代理及只读模式契约；2026-11-02 确定交付目标「索引期间 Obsidian 能正常使用」，M1 线程与可靠性、M2 自适应后置，验收分正确性/流畅度/效率三组；关联 P-ADAPTIVE-INDEX，未开始实现 |
| S-INDEX-RELIABILITY | [2026-10-31-index-reliability.md](specs/2026-10-31-index-reliability.md) | Active | 2026-10-31 | BUG-1-INDEX-001 后续设计；Agent 自审通过，复跑 7 项均关闭；不等待用户设计确认，实施先验证 T0 存储可行性 |
| S-RETRIEVAL-QUALITY | [2026-10-20-retrieval-quality.md](specs/2026-10-20-retrieval-quality.md) | Active | 2026-10-20 | 已实现（代码 8e82abc、fd63107）：分块改 token 预算并真正生效、结构前缀、精排支持专用模型与对话模型双来源及候选不足跳过；分块大小改为档位选择并显示实际生效值；升级触发一次全量重建。2026-10-28 随 [1.2.0](https://github.com/golddream-y/obsidian-ratel/releases/tag/1.2.0) 发布（caaeff2），待归档 |
| S-MULTIFORMAT-FILES | [2026-10-13-multiformat-files-design.md](specs/2026-10-13-multiformat-files-design.md) | Draft | 2026-10-13 | 技术候选；退回目标与需求讨论，未确认范围，不作为实施依据 |
| S-MARKETING-VIDEO | [2026-10-11-marketing-video-design.md](specs/2026-10-11-marketing-video-design.md) | Active | 2026-10-11 | 长期宣传工程；Remotion 独立依赖、双语首片和首页素材；尚未实施 |
| S-COMPACT-V3 | [2026-10-01-compact-v3-design.md](specs/2026-10-01-compact-v3-design.md) | Active | 2026-10-01 | 压缩重设计。P1 已合入（5761c19、e588efe、546df2d）；2026-10-11 复核：P5 砍除、P2 前置复测+output 真值、P3 对齐 Goal/约束会话化；P1F 已完成（64db02a、e33f1a3，随 1.1.0 发版）；P2~P4 未启动 |


---

## 实施 Plan(任务拆解)

| ID | 文件 | 状态 | 所属 Spec | 备注 |
|---|---|---|---|---|
| P-ADAPTIVE-INDEX | [2026-11-02-adaptive-indexing.md](plans/2026-11-02-adaptive-indexing.md) | Pending | S-ADAPTIVE-INDEX | 计划整体自审通过，3 阻断/3 影响修订后原 6 项复跑关闭；2026-11-02 收敛交付范围：M0 方向验证（T0 真线程与大批提交）→ M1（T-REL 可靠性缺口收口 → T1～T6 → T9 三区分验收）→ M2 后置（T7、T8、T10 自适应与速度模式）；新增 T-REL 承接派生清单恢复、配置切换、flush 一致性等旧债并逐项映射，原计划记录不改；T0 已实测通过（载体由 Node 线程改为常驻 Blob Web Worker，Worker 内 fs 可写读；证据 plans/2026-11-02-adaptive-indexing-t0-evidence.md）；T1 协议与宿主已实现（16 用例），T2 及之后未开始；存储故障/性能未验证 |
| P-INDEX-RELIABILITY | [2026-10-31-index-reliability.md](plans/2026-10-31-index-reliability.md) | In Progress | S-INDEX-RELIABILITY | 2026-10-31 在 feat/index-reliability 执行：T0～T8 已执行完毕，T8 有一项未闭环、一项未验证（证据：plans/2026-10-31-index-reliability-t{0,1-t2,3,4,5,6,7,8a,8b1,8b2}-evidence.md）；2026-11-02 发布准备全量 297 文件 / 2812 passed / 18 skipped，lint 0 error / 23 warnings、生产构建及产物门禁通过；用户已于 2026-11-02 审阅发布说明后明确授权“发”，并要求全部提交；[1.3.0 已正式交付](https://github.com/golddream-y/obsidian-ratel/releases/tag/1.3.0)，发布提交 d4d2717；[CI 41326442427](https://github.com/golddream-y/obsidian-ratel/actions/runs/41326442427) 成功，三份附件摘要与本地生产构建一致，三份来源签名验证通过；剩余验收不视为通过，plan 保持 In Progress；tsc 241 条、相对本轮修改前新增 0（typecheck 仍未通过）；升级有效且未变化的旧索引零重复嵌入已达成；真实 ONNX 用例由 RATEL_ONNX 门控、默认套件不跑真实推理；前序审查问题已有修复记录，但 T8 性能验收阻断仍未关闭；**T8 checkbox 4 未闭环（小库档性能未达标，需用户在「优化存储 / 修订门槛」间裁定）**、checkbox 6 未验证（无 GUI 驱动，已留 11 项清单）；后续修复进行中：旧后端缺清单时保留完成记录并严格核验恢复，API 检索处理器已补接线，只读配置身份不符时失败关闭；生产协调器的派生清单恢复、旧配置独立搜索、性能与 Sandbox 验收仍待完成；上述遗留已由 P-ADAPTIVE-INDEX 的 T-REL 与 T9 承接（见其「遗留项承接映射」），本计划记录保留不改写 |
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

见 [ARCHIVE.md](ARCHIVE.md) — 含按月统计图与全部归档记录(96 条 / 86 目录)。
