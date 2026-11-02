# P-ADAPTIVE-INDEX 实施进度

> 计划：[2026-11-02-adaptive-indexing.md](2026-11-02-adaptive-indexing.md) · 需求：`BUG-1-INDEX-PERF-001` · 更新：2026-11-02

本文件只登记**实际提交并跑过用例**的内容；计划里的勾选框保持未勾选，直到对应验收真正通过。生产安装与统一验证在全部 spec 内容完成后进行。

## 任务状态

| 任务 | 状态 | 已落地 | 未完成 |
| --- | --- | --- | --- |
| T0 真实宿主实验 | 完成 | Node 线程不可用、Blob Worker 具备 Node 文件能力的宿主读数；载体改为常驻 Web Worker | — |
| T1 有界协议与宿主 | 完成 | 信封/版本/grant/控制消息、载荷预算、一次性结算；常驻宿主生命周期、超时、取消、崩溃收敛、epoch 隔离（16 用例） | 未接入真实索引会话 |
| T2 提交票据桥 | 完成 | 授予、嵌套复用、撤销禁止新写、迟到授权结算（7 用例） | 未接入日志写入口 |
| T3 索引会话迁移 | **进行中** | 受限文件处理器（7 用例）、入口握手与只读守卫（6 用例）、服务循环（7 用例）、常驻装配与构建内联、反向 RPC（Worker 借宿主嵌入，22 用例）、**会话处理器**：分块 + Vectra 单文件提交/替换/删除（7 用例） | 会话已接进入口（init 后装配，只读模式不装配）；**文件日志、完成记录与清单均已可在 Worker 内读写**（写权撤销、prepare/commit、清单 load/save）；代际装配仍在主线程；Sandbox 真实链路未执行 |
| T4 查询与只读 | 部分完成 | 会话内查询（topK 校验、空库返回空命中）；线程版协调器提供同一 `IndexTaskCoordinatorPort`（5 用例） | 查询与提交的抢占尚无实测；只读模式零写入未在宿主验证 |
| T5 崩溃与生命周期 | 部分完成 | 撤销即关会话并释放写权；会话内 `session.recover` 按输入哈希重放未决事务（匹配则产出完成记录，内容已变则不重放），真实崩溃现场用例 2 个 | 进程被杀后的代际级隔离、清理重试与宿主侧重启流程未验证 |
| T6 共享模型仲裁 | 部分完成 | `EmbeddingArbiter`（6 用例）；**已接进宿主 `onCall`**：客户端按 `workload` 路由，查询走优先队列 | 真实嵌入端口（EmbeddingWorkerProxy）尚未接上；批次公平/压力降档属 M2 |
| T7～T8 自适应与模式（M2） | 未开始 | — | — |
| T9 三区分验收 | 未开始 | — | — |
| T-REL 可靠性遗留 | 部分完成 | 取消信号透传；孤立隔离事务回收；配置身份判定修复（6 用例）；迁移成本实测；派生清单恢复纯模块并已接入后端（26+58 用例）；共享落盘并已接入迁移侧与清单；**写运行时身份守卫已接线**（守卫 5 用例 + 装配接线 2 用例） | 原子存储 `upsertFile` 已改走共享落盘（含 rename 尝试记录，保持提交前/后错误分类）；跨代际复用（缺口 D）已澄清为**非缺陷**：跨配置复用向量在数学上不成立；仅「切回旧配置」存在复用机会，改为一条待验证要求（见 [生产切换与跨代际复用判断](2026-11-02-adaptive-indexing-cutover.md)） |

## 配置切换缺口（已复现）

`tests/core/index-runtime-config-switch.test.ts` 用真实磁盘复现，结论是**当前实现比设计文档宣称的弱**：

| 编号 | 现状 |
| --- | --- |
| A1 | 会话内漂移判据 `configIdentityOf` 只含 5 个字段；模型修订与嵌入文本模板变化会改配置指纹却不改身份串，同一会话内不会被判定为漂移 |
| A2 | 装配层没有「会话内配置指纹变化必须拒绝装配」的入口；同进程先后按 A、B 装配会返回第二套运行时，真正阻止混写的是「新装配接管写所有权、撤销旧 epoch」，以及生产侧 `main.ts` 的 `rejectIndexConfigDrift` |
| B2 | `GenerationActivationPublisher.publish` 自己写 `migrated`/`verifiedAt`，状态机的 `switch-not-verified` 只挡绕过发布器的直接切换；「核对完成后才切指针」实际由宿主「Ready 才订阅」保证，核心层没有独立核对证据校验 |
| D | 切配置后新代际没有可复用完成记录，未修改文件会被重新嵌入（不存在跨代际复用钩子） |

## 迁移成本实测

`tests/core/index-migration-scale.test.ts`（默认跳过，`RATEL_SCALE_SUITE=1` 打开）：

- 生产批量接缝：100/300/600 → 1.64s / 4.63s / 9.72s，**线性**；每轮只做一次全量枚举。
- 逐条回退分支：`listItems` 条目访问量为 2N²（600 档 72 万次），隔离微基准 0.54 / 3.64 / 12.77 ms，确认为平方。
- 平方代价源：`vector-vectra.ts` 的 `inspectFile` 每次全量 `listItems()` 后 filter；批量入口快 56–77 倍。
- 真正的大库墙钟成本是线性项：每条完成记录一次 `writeJsonAtomically`（约 15–16 ms/文件），3000 篇外推 45–50 s。
- 退化入口：`index-generations.ts` 批量枚举缺失或抛错时**静默回退逐条**，无告警。

## 线程版装配

`src/core/index-thread-assembly.ts` 把「嵌入端口 → 桥接 → 客户端 → 协调器」接成一组，返回与主线程同端口的 `coordinator`。代际参数（root/generationId/fingerprint/维度/分块预算）在装配时透传；3 个用例覆盖参数透传、逐文件索引与单文件失败不清零。

代际解析已接入：`assembleIndexThreadRuntime` 先跑 `resolveIndexGeneration`（迁移/回收/配置切换都在锁内完成），再把解析出的代际根与指纹交给线程。尚未做：主线程装配点替换 —— 生产路径仍走主线程协调器。

## 宿主客户端（已接线到协议）

`src/worker/index-runtime-client.ts` 把宿主侧需要的动作收敛成一个类：`start()`（init + ping + session.open）、`indexFile`、`deleteFile`、`search`、`recover`、`status`、`close`。嵌入请求经仲裁器按 `index`/`query` 分流。

端到端用例（真实临时目录 + 真实 Vectra/日志 + 真实协议，只替换线程边界与模型）验证了「启动 → 写入 → 查询 → 关闭」闭环，并断言查询确实以 `query` 优先级发出。

## 嵌入桥接与实验链路

- `src/worker/index-runtime-embedding-bridge.ts`：把既有 `EmbeddingPort` 接成线程侧模型通道，按批切分、维度与条数强校验、取消错误原样上抛（6 用例）。
- 实验命令新增 `runtime` 段：用真实常驻 Worker 跑「init → 索引两篇 → 查询 → 状态 → 关闭」，记录主线程迟到。实验包已构建并链接预览库，**尚未在宿主内执行**。
- 构建侧：运行时 Worker 产物需要把 `node:` 前缀内置模块标为 external，并复用主包的 vectra/transformers 替身；否则 browser 平台会因无法解析 Node 内置而构建失败。

## 新模块（未接线）

| 模块 | 内容 | 接线待做 |
| --- | --- | --- |
| `src/core/index-manifest-recovery.ts` | 从 `recoverMissingManifest` 提炼的纯函数：15 个拒绝原因码，成功返回清单+构建戳，不写盘 | 后端改为调用它；需只读暴露日志的 `configFingerprint` |
| `src/adapters/index-write-flush.ts` | 共享落盘：临时文件 wx → 全量写 → sync → rename → 目录 sync；`onCommitted` 区分重试与重载；目录降级集含 ENOSYS | 原子存储 `upsertFile`/`flushPath` 待接线；迁移侧 `writeJsonAtomically`、清单 `save` 已改走它 |

两模块均零运行时耦合（只 `import type`），接线前不影响现役行为。

## T9 采集状态

- 实验命令新增 `mainThreadIndex` 对照：同一份两篇笔记在主线程切块 + Vectra 写入的主线程迟到，与线程内 `runtime` 段直接可比。
- 协议见 [T9 三区分验收协议](2026-11-02-adaptive-indexing-t9-protocol.md)：正确性/流畅度已有数据来源，效率组的构建耗时、峰值内存、累计写量尚无基准脚本，不得标通过。
- 宿主内尚未执行任何一次完整采集。

## 验证边界

- 已跑：Node 环境下 32 个运行时用例、7 个票据用例、11 个 T-REL 用例；生产构建与内联检查通过。
- 未跑：任何 Sandbox 真实链路（init → ping → 写 → 读）读数；未在 Obsidian 内验证常驻 Worker 复用。
- 未安装到日常主库；按用户要求延后到 spec 内容全部完成后再统一验证。
- 性能、流畅度、内存与写放大均无本轮读数，不能引用 T0 的对照数字当作新实现的结果。

## 下一步

1. T3：把索引会话（分块、日志、清单、Vectra）装配进 Worker，宿主侧只保留 API 与准入。
2. T-REL：派生清单恢复接线、配置切换复现测试。
3. T4～T6 → T9：查询仲裁、崩溃闭环、模型公平，再做三区分验收。
