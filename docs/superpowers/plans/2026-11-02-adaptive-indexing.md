# 独立索引线程与自适应调度实施计划

> **面向执行 Agent：** 使用 `subagent-driven-development` 逐任务实施，每个实现任务使用新的 subagent；先规范、后代码质量两阶段独立审查。本轮仅写计划，所有执行项保持未勾选。

**目标：** 将索引重计算与唯一存储视图迁出 Obsidian 界面线程，保留逐文件续建，再用自适应调度降低后台占用。

**架构：** 宿主线程负责 Obsidian API、OS owner lease、交互准入与 UI；独立 Node 能力索引 Worker 负责 hash、分块、日志、Vectra 和查询；既有嵌入 Worker 继续运行模型。通过有界数据 RPC、独立控制通道和提交 ticket 连接；自适应预算不改变数据内容、配置指纹及持久化格式。

**技术栈：** TypeScript、esbuild 内联 Worker bundle、现有 Node 文件 API/Vectra、Web Worker ONNX、Vitest、Svelte；不新增原生模块或外部服务。

计划 ID：`P-ADAPTIVE-INDEX`。关联 [S-ADAPTIVE-INDEX](../specs/2026-11-02-adaptive-indexing.md)、[索引总体架构提案](../../architecture/proposals/2026-11-02-index-runtime.md)、`BUG-1-INDEX-PERF-001`。状态 **Pending**；用户授权自审 spec 并编写 plan，不代表开始实现、合并或发布。

## 交付目标与里程碑

**本次交付目标：索引期间 Obsidian 能正常使用。** 输入、滚动、切换笔记和查询不被索引阻塞；索引正确性不回退；效率指标如实测量。自适应调速不是本里程碑的完成条件，界面不卡也不代表存储问题、正确性问题已解决。

| 里程碑 | 范围 | 完成判据 |
| --- | --- | --- |
| **M0 方向验证** | T0 真实 Obsidian 线程与大批提交实验 | 真线程可运行、界面阻塞量级可测；不满足则停在架构选择，不换模拟线程 |
| **M1 本次交付** | T-REL → T1～T6 → T9 | 正确性 / 流畅度 / 效率三组分别有证据 |
| **M2 后置** | T7、T8、T10 | 自适应策略与速度模式；不阻塞 M1 交付 |

顺序约束：T0 未通过不进入 T1；T-REL 未收口不进入 T3（先补可靠性缺口，再迁移同一套索引内核）；M1 未验收不启动 T7/T8。T-REL 与 T1/T2 文件不重叠，可并行，但必须在 T3 前完成。

## 顺序、前置门槛与提交组

执行顺序为 T0 → T-REL 与 T1/T2 → T3～T5 → T6 → T9（M1 验收）→ T7、T8 → T10（M2）。不先调速度再决定是否迁移线程。

T0 必须在真实 Obsidian Sandbox 证明 Node 能力、构建和消息传输可用；Node 测试通过不能替代。失败时停在架构选择，不把 InlineWorker 作为静默回退。T0 是独立实验，不能依赖 T1～T4 的生产实现。

T-REL 先在现役主线程内核上补齐派生清单恢复、配置切换等遗留缺口，并以复现测试固定；T3 迁移会话时直接沿用这些机制，不重新实现，也不把缺口留到线程里。

T3 的宿主模型接缝先采用独立、可测试的串行转发桥，原样调用既有 EmbeddingPort，不依赖 T6 的新仲裁器；T6 再在相同端口后加入 workload/批次公平调度。T0 只验证最小可运行场景和固定大 JSON 提交，完整 100/1000/3000 篇矩阵的最终对照由 T9 执行，不要求先完成生产迁移才能通过 T0。

提交分四组：T0 实验与基线；T-REL 可靠性缺口收口（独立提交，先于迁移）；T1～T5 线程与独立索引闭环；T6、T9 查询与 M1 验收。T7、T8、T10 属 M2，另起提交。每个任务先编写失败用例、运行确认真实失败，再实现和复测；协议两端一起提交，任务内部不机械拆成不可工作的碎提交。实施前读取各级 AGENTS、编码/i18n 规则及对应 Skill，采集基线，不混入用户已有改动。

## 文件结构

以下新增模块是计划中的职责，当前不存在，不得当作已实现 API 使用。

| 文件 | 动作与职责 |
| --- | --- |
| `src/worker/index-runtime-protocol.ts` | 新建：RPC、grant、ticket、控制 ACK 与校验的唯一声明 |
| `src/worker/index-runtime-worker.ts` | 新建：独立索引 Worker 入口，仅装配执行侧端口 |
| `src/worker/index-runtime-host.ts` | 新建：运行时生命周期、主线程数据/控制 RPC 与背压 |
| `src/worker/index-runtime-session.ts` | 新建：Worker 内的代际、journal、coordinator 与 store 装配 |
| `src/core/index-runtime-lease-bridge.ts` | 新建：宿主 lease 与 Worker 执行权/提交 ticket 桥接 |
| `src/worker/index-vault-proxy.ts` | 新建：Worker 侧 Vault RPC；宿主仅返回正文/stat/事件序号 |
| `src/core/index-embedding-bridge.ts` | 新建：T3 既有 EmbeddingPort 的串行转发桥，T6 再接批次仲裁，不形成先后依赖环 |
| `src/core/index-resource-governor.ts` | 新建：纯反馈策略、唯一预算账本与可取消准入 |
| `src/adapters/index-runtime-probe.ts` | 新建：宿主响应/交互/可见性探针 |
| `src/core/embedding-work-scheduler.ts` | 新建：共享模型批次仲裁及公平队列 |
| `src/core/index-performance-state.ts` | 新建：只读档位、原因、等待期限与阶段耗时 |
| `src/core/index-runtime-assembly.ts`、`src/core/index-processor-port.ts`、`src/core/index-task-coordinator.ts`、`src/core/index-file-journal.ts` | 修改：线程内装配、批次/流式准备与预算接缝 |
| `src/core/persistent-index-backend.ts`、`src/core/index-manager.ts`、`src/core/index-controller.ts` | 修改：宿主生命周期接口改为异步运行时端口，不留直接存储旁路 |
| `src/adapters/vector-vectra.ts`、`src/core/index-generations.ts`、`src/core/index-search-visibility.ts` | 修改：由唯一 Worker 会话使用；检查点/迁移/查询语义保持 |
| `src/ports/embedding.ts`、`src/adapters/embedding-api.ts`、`src/adapters/embedding-worker-proxy.ts`、`src/adapters/embedding-onnx.ts`、`src/worker/embedding-worker.ts` | 修改：一批一个真实调用、workload、取消及活动转发 |
| `src/main.ts`、`esbuild.config.mjs`、`src/svelte.d.ts`、`vitest.config.ts` | 修改：运行时装配、Worker 内联构建与测试别名 |
| `src/settings.ts`、`src/user-feedback/user-status.ts`、`src/ui/status/StatusDrawer.svelte`、`src/i18n/types.ts`、`src/i18n/zh.ts`、`src/i18n/en.ts` | 修改：速度模式、等待原因与状态，设置入口位于 `src/settings.ts` 的声明式索引设置 |
| `tests/helpers/index-thread-fixture.ts`、`tests/helpers/index-thread-child.ts` | 新建：临时磁盘、真实子线程、故障点及计数模型 |
| `tests/helpers/index-ui-probe.ts`、`vitest.index-thread.config.ts` | 新建：Sandbox 合成 UI 探针及独立测试配置，禁止默认下载模型 |

既有入口已核对：内联 Worker 虚拟声明在 `src/svelte.d.ts`，索引设置在 `src/settings.ts`。新增结构不整体重排既有大文件；迁移时保持存储格式不变，跨线程协议单独版本化。

## T0：真实 Obsidian 运行时实验与基线

**文件：** 新建 `tests/helpers/index-thread-capability.ts`、`tests/worker/index-thread-capability.test.ts`、`tests/helpers/index-ui-probe.ts`；实验构建接入 `esbuild.config.mjs`，尚不替换生产索引。

- [ ] 建立隔离实验：通过宿主可用的 Node Worker 能力执行 `threadId`、受限临时文件读写、Vectra 初始化与 JSON 提交；不复用 Skill 沙箱，不导入 Obsidian，不连接生产索引。
- [ ] 先用 Node 测试验证探针，再只在 Sandbox 加载实验 bundle；验证三文件插件产物可内联加载 Worker、资源路径/CSP 正常，记录线程身份和完整启动/退出。
- [ ] 固定后续合成矩阵为 100/1000/3000 篇短笔记，另含单篇超过 200 块；向量为 512 维确定性替身。T0 先采集当前 1.3.0 成功路径基线，以最小独立线程实验处理相同预构造数据，测线程能力与大 JSON 提交，不提前实现完整生产会话。T9 再跑全部最终路径矩阵。
- [ ] 先证明基线探针能检出人为注入的长阻塞，再记录实际主线程提交与实验线程提交的全部读数；实际基线若未出现明显阻塞则如实记录，不为了红灯制造或挑选测量结论。性能样本每组同机同负载三次，假嵌入与真实模型分开。
- [ ] 通过条件为真实 Obsidian 能执行独立线程/文件/Vectra、无原生模块、无主线程整库复制；不满足则停止 T1，不换成模拟线程继续。

**验证：** `npx vitest run tests/worker/index-thread-capability.test.ts`，以及 Sandbox 实验记录。Node 用例数不得为零；真实 Sandbox 无证据时 T0 未通过。证据写 `docs/superpowers/plans/2026-11-02-adaptive-indexing-t0-evidence.md`，不得含私人路径。

## T-REL：可靠性遗留复现与收口（T3 前置）

**文件：** 修改 `src/core/persistent-index-backend.ts`、`src/core/index-manager.ts`、`src/core/index-runtime-assembly.ts`、`src/core/index-file-journal.ts`、`src/worker/index-processor.ts`、`src/adapters/index-writer-flush.ts`（新建共享 flush）；新建 `tests/core/index-legacy-gaps.test.ts`、`tests/core/index-config-switch.test.ts`。

- [ ] **先写复现测试**：生产协调器路径缺清单时当前不做派生恢复；旧配置整库降级时检索不可用；`index-processor.ts:197` 单参 `embed(texts)` 丢失 processor 级 options；`reclaimOrphanQuarantinedTransactions` 无周期调用；迁移侧与运行期写入口 flush 语义不一致。每条先红后绿，不得以「迁移后再说」推后。
- [ ] 让生产协调器在核验通过时调用既有 `verifyReceipt` 派生清单恢复，核验不通过则继续 fail-closed；不允许退化为清库重建，也不新增第二套恢复入口。
- [ ] 固定配置切换语义：同会话变更拒绝、跨会话新代际切换、降级时不构造旧配置检索存储；复现测试断言「切换后未改文件零重复嵌入、无跨配置混读」。
- [ ] 抽出共享 flush 模块供迁移侧与运行期写入口共用；补周期回收孤儿 quarantine 事务；修正 processor 级 options 透传。
- [ ] 大库迁移兼容校验的 O(N²) 实测并记录；必要时优化，但不以取消校验换速度。
- [ ] 全部缺口收口后，把机制登记到 T3 的会话装配清单，注明迁移时逐项沿用；未收口项不得在 T3 中被「自然消失」。

**验证：** `npx vitest run tests/core/index-legacy-gaps.test.ts tests/core/index-config-switch.test.ts tests/core/persistent-index-backend.test.ts tests/core/index-file-journal.test.ts`，并核对真实磁盘 receipt 与块集合，不能只看状态字符串。

## T1：定义有界协议与独立控制通道

**文件：** 新建 `src/worker/index-runtime-protocol.ts`、`src/worker/index-runtime-host.ts`、`tests/worker/index-runtime-protocol.test.ts`、`tests/worker/index-runtime-host.test.ts`。

- [ ] 先测未知版本、错误 runtime/epoch、未知 requestId、重复终态、超预算载荷和取消时数据队列已满；错误必须结算一次，不能留悬挂 Promise。
- [ ] 集中定义信封与 grant；所有运行时 ID 与消息类型集中登记，不传函数、类实例或 AbortSignal。

```typescript
export interface IndexRuntimeGrant {
  protocolVersion: 1;
  runtimeId: string;
  epoch: number;
  generationId: string;
  indexRoot: string;
  generationRoot: string;
  access: 'read-only' | 'read-write';
}
export interface IndexRpcEnvelope<T> {
  protocolVersion: 1;
  runtimeId: string;
  epoch: number;
  requestId: string;
  payload: T;
}
export type IndexControlKind =
  | 'revoke' | 'cancel' | 'close' | 'revoked-and-drained'
  | 'cancel-ack' | 'rpc-settled'
  | 'commit-begin' | 'commit-granted' | 'commit-denied'
  | 'commit-status' | 'commit-settled';
```

- [ ] 数据与控制用独立 MessagePort/调度队列。数据区分顶层请求池（8 个、24 MiB）与依赖 RPC 保留池（4 个、8 MiB）：Vault/Embedding/预算等反向请求及响应用后者，不能等待父请求结算才能传输。大回复拆成不超过 1 MiB 的分片并逐片 credit/ACK；同一逻辑 RPC 的响应复用其保留池，不能为响应再次申请已满的顶层许可。控制消息不受数据配额限制，但只能携带有界元数据。
- [ ] 区分调用方结算和运行时结算。调用方 abort 可立即拒绝其 Promise，但已经发出的载荷持续计入配额，直到收到真实终态、确认释放数据的 cancel-ack，或确认旧运行时退出且数据已回收。仅未发送的排队请求可立即回收；超时/本地 reject 不返还底层 credit。取消风暴不能反复扩大在途数据。
- [ ] 返回/ACK/错误帧按 runtimeId/epoch/requestId 幂等释放，重复帧不重复减账。转移 buffer 后禁止读取源；分片释放以接收端 ACK 为准，不以 postMessage 已调用为准。

**验证：** `npx vitest run tests/worker/index-runtime-protocol.test.ts tests/worker/index-runtime-host.test.ts`。断言配额、终态次数、listener 清理与错误帧拒绝行为；控制通道及时送达不等于已抢占同步操作。

## T2：lease、提交 ticket 与安全交接

**文件：** 新建 `src/core/index-runtime-lease-bridge.ts`、`tests/core/index-runtime-lease-bridge.test.ts`；修改 `src/core/index-write-owner.ts` 仅增加所需适配接缝，保留 OS 锁语义。

- [ ] 先写两个运行时竞争、旧 epoch 迟到 mutation、未结算 ticket、重复 ACK、ACK 丢失和 Worker 退出时文件 I/O 尚未确认的失败用例。
- [ ] 宿主申请并保留唯一 lease；Worker 仅持 grant 和本地执行权适配器。`commit-begin` 先由宿主 `beginCommit()` 登记，`commit-granted` 后 Worker 才可开始 mutation，receipt/I/O 完成后 `commit-settled`。
- [ ] 既有 journal 的 beginCommit/settle 是同步接口，不能直接替换成远端 Promise；在其异步写入口外先申请 mutation ticket，再由 Worker 本地适配器提供已授予范围内的同步 ticket，最后经宿主确认结算。prepare、恢复、迁移、清理等所有写入口同样受限，不仅是 replaceFile。Gate 等待必须在该范围外，不能持 ticket 休息。
- [ ] 同一 mutation scope 内嵌套恢复/清理复用最外层远端 ticket，以本地引用计数管理同步 beginCommit/settle；只有最外层退出、引用数归零且子 I/O 全部完成才发送 commit-settled。内层清理不能提前释放 lease，也不能递归申请会等待自身结束的远端许可。独立并发 mutation 不能借用另一 scope 的 ticket。
- [ ] ticket ID 由 runtime/epoch/requestId 唯一绑定，重复 commit-begin 返回同一结论。grant/settled 丢失时通过 commit-status 查询或原 ID 重试，不能新建第二张票据；撤销后迟到 grant 不得开始新写，未确认终态的票据继续阻止 lease 转交。
- [ ] 撤销立即禁止新 ticket。Worker 拒绝旧 epoch 新写、停止新准备、收尾已有提交和在途 I/O 后返回 drain ACK；宿主只有确认 drain 或运行时与存储操作均终止，才能结算残留 ticket、释放 owner 并交接。
- [ ] 取消/请求超时只结束相应等待，不证明底层停写；未确认停止则报正在停止，禁止启动替代 writer。恢复必须先于开放查询，不能先转 lease 再异步关闭旧线程。

```text
host revoke → worker reject new mutations → drain commits and file I/O
→ ACK(runtimeId,epoch,pendingIO=0) → host release/transfer → recover new runtime
```

**验证：** `npx vitest run tests/core/index-runtime-lease-bridge.test.ts tests/core/index-write-owner.test.ts`。故障注入后对同一文件写操作的最大并发始终为 1；旧 ACK 不释放新 owner。

## T3：把完整索引会话迁到 Worker

**文件：** 新建 `src/worker/index-runtime-worker.ts`、`src/worker/index-runtime-session.ts`、`src/worker/index-vault-proxy.ts`、`src/core/index-embedding-bridge.ts`、`tests/worker/index-runtime-session.test.ts`、`tests/worker/index-vault-proxy.test.ts`、`tests/core/index-embedding-bridge.test.ts`；修改运行时装配、处理器端口与构建入口。

- [ ] 先写实际线程身份断言：hash、分块、校验、JSON 序列化、receipt/Vectra 写入均在非宿主线程；Vault 代理只能返回正文/stat/序号。
- [ ] Worker 会话内装配 coordinator、journal、代际、原子存储及唯一 Vectra。文件事件由宿主转发，读取通过 Vault RPC；嵌入请求先经本任务的 index-embedding-bridge 串行转发至既有模型实例，不在 Worker 加载第二份 ONNX。桥覆盖取消、活动与错误，T3 可独立测试运行；T6 原位接入批次仲裁，不要求提前实现它。
- [ ] 主线程撤除 Vault 索引的 Vectra/journal 直接实例；记忆索引等其他存储必须明确区分，不能顺手迁移或误删。检索、手动重建、Indexer Subagent 和配置切换均通过相同异步端口。
- [ ] Worker bundle 依照 T0 验证的 Node 模式内联到 main，构建顺序先 Worker 后主包；虚拟模块测试 stub 明确不代表真实线程测试。只发布既定三文件，不新增运行时下载。

Worker 的宿主文件读取结果约定为：

```typescript
export interface VaultReadResult {
  path: string;
  content: string;
  stat: { mtime: number; size: number } | null;
  sequence: number;
}
```

配置描述、路径权限检查仍须校验，但内容 hash 与配置指纹的计算/核对在 Worker；禁止代理悄悄调用旧主线程 `snapshot()`。

**验证：** `npx vitest run tests/worker/index-runtime-session.test.ts tests/worker/index-vault-proxy.test.ts tests/core/index-embedding-bridge.test.ts tests/main-index-lifecycle.test.ts`，加 `npm run build` 验证真实内联构建，无 Obsidian 导入或浏览器嵌入 Worker 的 Node 能力泄漏。

## T4：查询仲裁、只读模式与检查点复用

**文件：** 修改 `src/core/index-runtime-assembly.ts`、`src/core/index-search-visibility.ts`、`src/core/persistent-index-backend.ts`、`src/core/index-controller.ts`、`src/main.ts`；新建 `tests/worker/index-runtime-query.test.ts`、`tests/worker/index-runtime-readonly.test.ts`。

- [ ] 先测构建大文件时查询可在提交边界进入、旧结果/排除路径不进入模型、关闭自动索引时目录摘要不变；显式搜索仍可产生查询嵌入。
- [ ] Worker 不能用一条全库 request 独占存储队列至全部结束；准备推理期间允许查询，原子提交期间不插入读，提交结束后优先服务已排队查询。
- [ ] read-only 启动不取得写 lease、不 createIndex、不恢复/迁移、不扫描、不写任何元数据；仅采用可信记录，未决路径过滤，候选存在性/黑名单由宿主只读核验。切写模式先关闭旧实例，再经 grant 启动新会话。
- [ ] 保持目录、schema、模型/分块指纹不变；在线程切换、重启和模式变化后未改文件零重复嵌入。线程协议版本不能作为内容配置导致全量重建。

**验证：** `npx vitest run tests/worker/index-runtime-query.test.ts tests/worker/index-runtime-readonly.test.ts tests/core/persistent-index-backend.test.ts tests/tools/search-vault.test.ts tests/subagents/indexer.test.ts`。同时比较真实磁盘 receipt、块集合与文件摘要，不能只测显示 ready。

## T5：独立线程崩溃与生命周期闭环

**文件：** 新建 `tests/helpers/index-thread-child.ts`、`tests/helpers/index-thread-fixture.ts`、`tests/core/index-thread-recovery.test.ts`；修改 host/session 的退出与错误处理。

- [ ] 在 prepared、向量提交、receipt、清理前后分别终止真实子线程；确认旧执行者停止后重新创建完整运行时，验证未改文件复用、未结算日志恢复、旧事务不覆盖新 revision。
- [ ] 注入 Worker 消息损坏、数据超限、用户暂停、关闭/重开、宿主取消和丢 ACK；所有 pending 都获得唯一终态，无法证明停写时不接管。
- [ ] 线程退出后不能用主线程 Vectra 自动兜底；报告运行时不可用并保留检查点。错误通过安全错误码/i18n 显示，传输包不泄漏正文、私有路径或密钥。
- [ ] 完成这一任务后，先复测 Sandbox 大提交期间 UI 响应再进入自适应阶段；若主要界面阻塞仍在宿主线程，定位并修复，不把限速当作替代。

**验证：** `npx vitest run tests/core/index-thread-recovery.test.ts tests/core/index-runtime-lease-bridge.test.ts`，Sandbox 证据覆盖重开与提交中关闭。无真实线程/磁盘证据不得勾选。

## T6：共享模型批次仲裁

**文件：** 新建 `src/core/embedding-work-scheduler.ts`、`tests/core/embedding-work-scheduler.test.ts`；修改嵌入端口、代理、API/ONNX 适配器和 Worker 协议两端。

- [ ] 先测单篇 200+ 块、连续查询、取消一个索引请求、多请求公平和在途上限；必须能在文件内部批次边界插入查询。
- [ ] 以模型运行时为 key，每次只发一个真实批次；区分 `index`/`interactive`，未知来源保守视作 interactive。取消只作用于对应请求，不能 terminate 共享模型 Worker。
- [ ] 将 T3 串行转发桥的内部实现替换为本任务仲裁器，保留已有 RPC/取消/错误契约；Worker 与宿主两端同时接 workload，不能并存两套模型队列或重复转发。
- [ ] 最多连续 3 个交互批次后，条件满足时服务一个索引最小批次；输入/内存保护与预算债务仍优先。API 不增加原有并发上限、不改变限流重试、不换端点。
- [ ] 统计仅使用真实完成批次，排队/取消不假报进度；序号、runtimeId、epoch 与 requestId 一致校验。

```typescript
export type EmbeddingWorkload = 'index' | 'interactive';
export interface EmbeddingBatchContext {
  workload: EmbeddingWorkload;
  runtimeId: string;
  epoch: number;
  signal?: AbortSignal;
}
```

**验证：** `npx vitest run tests/core/embedding-work-scheduler.test.ts tests/adapters/embedding-worker-proxy.test.ts tests/adapters/embedding-api.test.ts tests/worker/embedding-worker.test.ts`。继续保留普通查询超时用例。

## T7：纯 Governor、响应探针与预算 Gate

**文件：** 新建 `src/core/index-resource-governor.ts`、`src/adapters/index-runtime-probe.ts`、`src/core/index-performance-state.ts` 及同名 `tests/core/`、`tests/adapters/` 测试；修改 coordinator、phase watchdog 和协议等待事件。

- [ ] 先以可控时钟输入压力轨迹，验证初始保守、立即降档、稳定窗口慢升档、隐藏/恢复重置、信号 unknown 不加速，以及真实长延迟没有恢复证据时不可丢弃。
- [ ] 实现架构提案四档及唯一量子账本；只计互不重叠的索引工作，父级、排队、休息和交互请求不重复记债。30 秒债务上限、2 秒分片等待和 oversized-quantum 状态均有确定测试。
- [ ] 等待带原因与期限，可取消；`waiting-budget` 从无进展时间中扣除，真实 running watchdog 保留。恢复不能伪造完成，模式切换不自动撤销用户暂停。
- [ ] 探针只在索引活跃时采集时间/可见性，无文本或坐标；`autoIndex=false` 零探针、零索引。跨 Worker 的工作耗时使用 duration，不比较不同线程的绝对 performance.now 值。

```typescript
export interface IndexBudgetDecision {
  level: 0 | 1 | 2 | 3;
  maxBatchTexts: number;
  scanConcurrency: number;
  waitMs: number;
  reason: 'none' | 'interaction' | 'pressure' | 'unknown'
    | 'budget' | 'memory' | 'oversized-quantum';
}
```

**验证：** `npx vitest run tests/core/index-resource-governor.test.ts tests/adapters/index-runtime-probe.test.ts tests/core/index-task-coordinator.test.ts`。压力被有效观测后 1 秒内不得继续授予更快档许可；已运行不可抢占量子单独记录。

## T8：流式准备、模式与反馈

**文件：** 修改 `src/core/index-processor-port.ts`、`src/core/index-file-journal.ts`、`src/core/index-task-coordinator.ts`、设置/反馈/i18n 文件；新建 `tests/core/index-streaming-preparation.test.ts`、`tests/ui/index-performance-settings.test.ts`。

- [ ] 先测超过准备预算的单篇文件，批次分片完成前不能发布 prepared 或替换旧向量；取消/硬预算超限不死等、不无限重试、不假报整库完成。
- [ ] 批次向量落既有 journal 分片，全部完成后原子发布 prepared；保留 32/64 MiB 自有缓冲软/硬限制，旧完整版本不受未完成准备影响。Vectra 仍需重组整篇时在提交前预检预算并明确受限。
- [ ] 默认自适应，提供低占用/全速；速度模式不进入 configFingerprint，不触发全量重建。全速保留单写入者、批次/内存安全与交互仲裁。
- [ ] 状态独立显示降速/预算等待与暂停/失败，不刷完成通知；仅保存用户模式，档位、样本、债务不跨进程恢复。新增字符串在 i18n types/zh/en 同步。
- [ ] 设置页实现前加载设置 UI Skill；仅修改检索设置现有入口，不新增与性能无关导航。

**验证：** `npx vitest run tests/core/index-streaming-preparation.test.ts tests/core/index-file-journal.test.ts tests/ui/index-performance-settings.test.ts tests/ui/chat/feedback-diagnostics.test.ts`，加 Sandbox 模式切换与取消测试。

## T9：M1 三区分验收与交付记录

三组验收互相独立，任何一组不得用另一组的改善替代。

| 验收组 | 通过条件 | 明确不可替代 |
| --- | --- | --- |
| **正确性** | 未变文件零重复嵌入；模式/线程切换零重建；每代际一份存储视图；单路径写并发为 1；零主线程整库克隆；旧配置不混读 | 界面不卡不能证明正确性 |
| **流畅度** | 输入/滚动/切换笔记可操作；查询不被索引阻塞；大提交窗口单独计量 | 平均 CPU 下降或吞吐提升不能替代 |
| **效率** | 全速构建中位耗时 ≤ 1.3.0 基线 1.5 倍；峰值 RSS ≤ 1.25 倍；累计磁盘写量如实记录 | UI 改善不能证明写放大已解决 |

**文件：** 新建 `tests/core/index-thread-performance.test.ts`、`vitest.index-thread.config.ts`、`docs/superpowers/plans/2026-11-02-adaptive-indexing-evidence.md`；更新现役架构、指南、Worker 规则及 CHANGELOG 未发布记录。

- [ ] 专用配置明确包含真实线程/故障/性能用例，设置 `passWithNoTests=false`；默认套件不下载模型。真实 ONNX 在已有资源的 Sandbox 单独验证，不自动产生 API 费用。
- [ ] 对 T0 同机同数据的基线进行三次完整对照，只比较全速线程迁移与 1.3.0 主线基线；自适应对照属 T10，不能混入全速迁移读数。
- [ ] UI 验收目标：固定 50 ms 探针的超额延迟 p95 ≤ 50 ms、最长 ≤ 250 ms，输入/滚动回调 p95 ≤ 100 ms。定时器按预定 deadline 计算超额延迟，不在迟到回调中重设起点。输入由外部/原生驱动记录注入时刻至实际处理回调；若使用另一 Worker 探针，先校准时钟，不直接比较不同线程的 performance.now。不得从同一阻塞 UI 线程迟到后 dispatchEvent，再从 dispatch 时刻起算低延迟。
- [ ] 探针用人为注入的 300 ms 主线程长任务自检，必须记录至少相应量级的迟到，否则测量工具不合格。单列每个大提交窗口和最差窗口，不能用空闲期稀释；缺少可信输入驱动时该项标未验证，不用 timer 指标代替。未达标定位来源后修正，不删除不利样本或静默放宽门槛。
- [ ] 全速完整构建中位耗时不超过 1.3.0 成功基线 1.5 倍；峰值进程 RSS 不超过基线 1.25 倍。RSS 按宿主进程计一次，不能把同进程 Worker 的 process RSS 重复相加；线程 heap、自有暂存和消息字节另列。旧路径失败的样本不能作成功分母，报告该档未得相对验证。
- [ ] 正确性硬门槛：未变文件零重复嵌入，模式/线程切换零重建，每代际一份存储视图，单路径写并发为 1，零主线程整库克隆。磁盘累计写量须如实记录；若仍是整库重写，不能宣称写放大已解决。
- [ ] 使用临时磁盘及 Sandbox 覆盖 V1～V8。Node 测试、真实 GUI、真实模型结果分别记录；未执行项保留未验证，不能将整个功能标为交付。性能门槛是设计目标，当前没有测试结果。
- [ ] 完成两阶段独立代码审查后同步现役 `docs/architecture/rag/vector-index.md`、`docs/architecture/host/worker-protocol.md`、`docs/architecture/host/index-controller.md`、`src/AGENTS.md`、`src/worker/AGENTS.md`、中英文用户指南；本提案按实现差异收口，不提前把拟议架构改写成现役事实。

**最终验证：**

```bash
npx vitest run --config vitest.index-thread.config.ts
npm test
npm run lint
npm run typecheck
npm run build
git diff --check
```

按执行时基线记录类型检查实际结果；当前存量报错不因此自动消失，无新增错误不能写成 typecheck 通过。本任务不自动合并、归档、打 tag 或发布。

## T10：自适应与速度模式验收（M2，后置）

**文件：** 修改 T7/T8 新建模块及设置、反馈、i18n；新建 `tests/core/index-adaptive-acceptance.test.ts`、`docs/superpowers/plans/2026-11-02-adaptive-indexing-adaptive-evidence.md`。

- [ ] M1 已验收后才启动；T7 的 Governor、T8 的流式准备与速度模式在真实线程基线上接入，不改变 T1～T5 的协议、owner 与存储格式。
- [ ] 场景矩阵覆盖架构提案 A1～A8：空闲加速、交互降速、压力降档、信号缺失保守、窗口隐藏、用户暂停不被自动恢复、模式切换、批次内部与文件间休息的差异。
- [ ] 重复 T9 的流畅度与效率对照，允许并记录「自适应相对全速的吞吐损失」，但正确性组不得回退；自适应未达标不撤销 M1 交付，如实标未验证。
- [ ] 速度模式仅保存用户选择，档位/样本/债务不跨进程恢复，不进入配置指纹、不触发重建；设置与状态文案中英文同步。
- [ ] 收口架构提案与现役文档的差异说明；M1 已交付结论不被 M2 改动覆盖。

**验证：** `npx vitest run tests/core/index-adaptive-acceptance.test.ts tests/core/index-resource-governor.test.ts tests/core/index-streaming-preparation.test.ts`，加 Sandbox 模式切换与暂停恢复记录。

## 遗留项承接映射

[原计划](2026-10-31-index-reliability.md)的记录与勾选状态保持原样，不因承接而改写；本表只说明新 plan 的落点。每项完成后按证据关闭，未完成项不因 M1 交付而消失。

| 遗留项（来源） | 承接任务 | 关闭证据 |
| --- | --- | --- |
| 生产协调器未接派生清单恢复（T8 §八-1） | T-REL 第 2 项；T3 沿用；T5 崩溃恢复 | 复现测试 + 真实磁盘 receipt/块集合 |
| 旧配置只读检索未实现，切换时整库降级（§八-2） | T-REL 第 3 项固定降级语义；T4 只读约束 | 零混读、零重复嵌入断言 |
| 迁移兼容校验 O(N²)（§八-4） | T-REL 第 5 项实测；T9 效率记录 | 大库实测读数 |
| durable writer 两侧 flush 不对称（§八-5） | T-REL 第 4 项共享模块 | 写入故障注入用例 |
| `index-processor.ts:197` options 丢失、quarantine 无周期回收（§八-6） | T-REL 第 4 项 | 单测 + 周期回收用例 |
| T8 checkbox 4 性能门槛未达标（小库档） | T9 效率组（全速）；T10（自适应） | 同口径三次对照 |
| T8 checkbox 6 Sandbox 宿主 11 项未验证 | T0 线程能力 + T9 宿主验收重跑 | Sandbox 记录，缺项标未验证 |
| `main.ts` 其余装配是否继续拆分（§八-8） | 不单独立项，T3 迁移内处理 | 迁移后无主线程存储旁路 |
| `tests/**` 未纳入 eslint（§八-9） | 工程债，不阻塞 M1 | 另行登记 |

## 自审与覆盖映射

| Spec 验收 | 负责任务 |
| --- | --- |
| V1 真线程/Node/构建 | T0 门槛，T3 内联生产构建，T9 Sandbox 验证 |
| V2 UI 重计算迁出与响应 | T3 身份断言、T5 UI 阶段复测、T9 大提交窗口指标 |
| V3 单视图与背压 | T1 预算/终态、T2 owner、T3 唯一会话、T9 字节/RSS 证据 |
| V4 查询不饿死 | T4 存储边界仲裁、T6 模型公平队列 |
| V5 取消/崩溃/复用 | T2 drain/ticket、T-REL 恢复机制、T4 格式兼容、T5 故障恢复 |
| V6 调速与压力 | T6 批次公平（M1）、T7～T8 策略/流式准备、T10 场景矩阵（M2） |
| V7 写放大独立测量 | T0 基线、T9 累计磁盘字节与未解决项 |
| V8 关闭自动索引只读 | T4 零隐式写与显式查询，T7 零探针（M2） |
| 旧计划遗留债 | T-REL 逐项收口，见「遗留项承接映射」 |

自审：不把 InlineWorker 当成线程，不跨线程传 owner/函数，不在宿主代理计算 hash，不通过迁移重建全部内容，不在持锁期间休息，不把消息超时当作停写，不以平均 CPU 或假模型通过替代客户端响应验收。所有源码和测试仍待实现；T0 真实环境能力、T9 性能目标均未验证。

2026-11-02 整体计划审查：主代理核对依赖、协议和验收，独立审查者全文检查后发现 3 个阻断、3 个影响。问题分别为本地取消过早释放在途 credit、反向依赖 RPC 预算自锁、嵌套 ticket 提前结算，以及 T3/T6 接缝依赖、UI 延迟探针假低延迟和 T0 前置范围过大。已逐项修订，并对原 6 项复跑，剩余 0 阻断、0 影响；主代理裁定 plan 审查通过。

未审/未验证范围：源码实现、Worker 平台能力、真实存储故障、Sandbox GUI 和 ONNX/性能目标。本轮仅修改架构提案及计划/登记，文档链接、隐私、层级和 diff 检查通过，不运行产品测试、不修改生产插件。计划保持 Pending，后续不得跳过 T0。

2026-11-02 交付范围收敛：用户确认以「索引期间 Obsidian 能正常使用」为下一次交付目标，统一收敛 1.3.0 遗留。据此新增 M0/M1/M2 里程碑与 T-REL 前置任务，把 T7、T8 与自适应验收后置到 M2，T9 拆为正确性/流畅度/效率三组独立验收；原计划的遗留记录与勾选状态不改，逐项承接关系见「遗留项承接映射」。仍未开始实现，T0 未执行。
