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
| S-ADAPTIVE-INDEX | [2026-11-02-adaptive-indexing.md](specs/2026-11-02-adaptive-indexing.md) | Active | 2026-11-02 | BUG-1-INDEX-PERF-001；[总体架构](../architecture/proposals/2026-11-02-index-runtime.md)与 spec 自审通过；2026-11-02 确定交付目标「索引期间 Obsidian 能正常使用」，M1 线程与可靠性、M2 自适应后置，验收分正确性/流畅度/效率三组；关联 P-ADAPTIVE-INDEX，**M1 代码已完成，宿主验收待执行** |
| S-SHARDED-INDEX | [2026-11-04-sharded-index.md](specs/2026-11-04-sharded-index.md) | Confirmed | 2026-11-04 | BUG-1-INDEX-PERF-001 后续；分片向量索引（按路径哈希路由，片数自适应 8–64），解决 231 MB `index.json` 整份重写导致的写入放大与主线程点击卡顿；替代 S-ADAPTIVE-INDEX 的「单份 `index.json`」存储前提；**不做物理合并**，查询为片内扫描 + 跨片 k 路归并；**已实现**：分片写入、旧单份一次性迁移、跨片归并、会话与两条装配路径均已落地（11826cc、217c7e2、a5d39aa、7f10197、3f756d7、e0c7bd9），2026-11-05 收尾修复分片代际已提交状态与清库形状；100 篇档写量 363.6 KB / 100 次（同负载单份布局 2691 KB）；设计状态保持 Confirmed，待用户最终验收 |
| S-STATUS-DRAWER-LAYOUT | [2026-11-06-status-drawer-layout-design.md](specs/2026-11-06-status-drawer-layout-design.md) | Active | 2026-11-06 | 状态抽屉索引区版面收敛：进度数据去重、三层视觉权重、两处进度条统一；用户选定「A + 局部视觉统一」，已实现并验证，待 Sandbox 目视确认 |
| S-INDEX-RELIABILITY | [2026-10-31-index-reliability.md](specs/2026-10-31-index-reliability.md) | Active | 2026-10-31 | BUG-1-INDEX-001 后续设计；Agent 自审通过，复跑 7 项均关闭；不等待用户设计确认，实施先验证 T0 存储可行性 |
| S-RETRIEVAL-QUALITY | [2026-10-20-retrieval-quality.md](specs/2026-10-20-retrieval-quality.md) | Active | 2026-10-20 | 已实现（代码 8e82abc、fd63107）：分块改 token 预算并真正生效、结构前缀、精排支持专用模型与对话模型双来源及候选不足跳过；分块大小改为档位选择并显示实际生效值；升级触发一次全量重建。2026-10-28 随 [1.2.0](https://github.com/golddream-y/obsidian-ratel/releases/tag/1.2.0) 发布（caaeff2），待归档 |
| S-MULTIFORMAT-FILES | [2026-10-13-multiformat-files-design.md](specs/2026-10-13-multiformat-files-design.md) | Draft | 2026-10-13 | 技术候选；退回目标与需求讨论，未确认范围，不作为实施依据 |
| S-MARKETING-VIDEO | [2026-10-11-marketing-video-design.md](specs/2026-10-11-marketing-video-design.md) | Active | 2026-10-11 | 长期宣传工程；Remotion 独立依赖、双语首片和首页素材；尚未实施 |
| S-COMPACT-V3 | [2026-10-01-compact-v3-design.md](specs/2026-10-01-compact-v3-design.md) | Active | 2026-10-01 | 压缩重设计。P1 已合入（5761c19、e588efe、546df2d）；2026-10-11 复核：P5 砍除、P2 前置复测+output 真值、P3 对齐 Goal/约束会话化；P1F 已完成（64db02a、e33f1a3，随 1.1.0 发版）；P2~P4 未启动 |


---

## 实施 Plan(任务拆解)

| ID | 文件 | 状态 | 所属 Spec | 备注 |
|---|---|---|---|---|
| P-ADAPTIVE-INDEX | [2026-11-02-adaptive-indexing.md](plans/2026-11-02-adaptive-indexing.md) | In Progress | S-ADAPTIVE-INDEX | 2026-11-02 收敛交付范围并开工：M0 方向验证（T0）完成——Node 线程不可用，载体改为常驻 Blob Web Worker（Worker 内 fs 可写读）。T1 协议/宿主、T2 票据桥、T3 载体与**索引会话全量迁入线程**（分块、文件日志、清单、Vectra、提交、查询、恢复、按向量检索）已落地；T4 查询仲裁（嵌入仲裁器查询优先，端到端验证查询插到剩余索引批次之前）、T5 崩溃生命周期（`restart()` + 协调器按「线程已退出」类错误重启重试，每轮上界 2 次）、T6 模型批次公平（按批拆分、同级先进先出、队列上限拒绝、单批失败隔离）已完成；T-REL 全部关闭：派生清单恢复纯模块并接入后端、迁移侧与清单改走共享落盘、原子存储 `upsertFile` 改走共享落盘、配置身份守卫接进装配与生命周期、缺口 D 澄清为**非缺陷**（跨配置复用向量在数学上不成立，见 plans/2026-11-02-adaptive-indexing-cutover.md）。生产切换：`settings.indexThreadMode`（默认 false）可启用线程装配，失败自动回落主线程，检索侧用委派门 + 候选来源保证回落仍可检索。**T9 尚未验收（唯一阻塞：宿主流畅度读数）**：正确性有 Node 用例（含关闭重开后仍可检索），效率有基准（线程 76.9 ms/篇 vs 主线程 85.4 ms/篇，主包 15.5 MB），**流畅度缺宿主读数**——实验命令已改为调试构建加载后自动采集，需在预览库重载一次；进度见 plans/2026-11-02-adaptive-indexing-progress.md；预览库链接当前指向生产构建（未启用线程模式）；按用户要求**未安装生产库**，待 spec 内容全部完成后统一验证 |
| P-SHARDED-INDEX | [2026-11-04-sharded-index.md](plans/2026-11-04-sharded-index.md) | Completed | S-SHARDED-INDEX | 分片写 + 跨片 k 路归并、不做物理合并；7 个任务 + 收尾回归修复（Task 8）全部完成；合并提交范围 11826cc..e0c7bd9（路由、适配器、跨片查询、迁移、会话装配、两条装配路径共 6 条）与收尾 fix/test 两条；2026-11-05 全量 vitest 331 files / 3068 tests passed、0 failed，tsc 0，eslint 0，100 篇档分片写量 363.6 KB / 100 次 / 单次最大 9.5 KB；待归档 |
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
