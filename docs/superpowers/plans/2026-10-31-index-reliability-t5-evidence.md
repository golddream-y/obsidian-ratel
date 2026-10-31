# T5 证据记录：活动、停滞恢复与取消

> 本文件是 P-INDEX-RELIABILITY 的 T5 执行证据。数字均为本机实测；未验证项与未接线项明确标注。
> 前置证据：[T0](2026-10-31-index-reliability-t0-evidence.md)、[T1/T2](2026-10-31-index-reliability-t1-t2-evidence.md)、[T3](2026-10-31-index-reliability-t3-evidence.md)、[T4](2026-10-31-index-reliability-t4-evidence.md)。

- 执行日期：2026-10-31
- 分支：`feat/index-reliability`（worktree `.worktrees/index-reliability`）
- 基线：T4 提交 `7947b8e`

## 1. 结论

T5 完成，6 个 checkbox 落地。全量 **291 文件 / 2558 passed / 5 skipped**；`tsc` **241 条存量、新增 0**。

**但必须明确一件事：T5 的头号机制目前尚未在生产接线**（见第 5 节），因此「请求超时不再抛弃真实终态」在生产仍与旧代码等价。其余机制（只读/写车道拆分、提交窗口、只读有界超时、`closed` 门）已无条件生效。

## 2. 事实更正（重要，审查者核对 HEAD 源码后确认）

实施者最初上报「旧代码会永久丢掉提交路径」，该结论**不成立**，已更正：

- 旧 manager（HEAD，197 行）在超时后设 `pending.timedOut = true`，但**保留 `pending` 与 `busy`**；真实终态到达时执行 `pending.delete` + `if (!pending.timedOut) resolve()` + `stalled = false; release()`。
- 因此旧代码**没有丢掉写保护**，丢的是**终态结果向调用方的投递**（调用方已超时 reject，后续不再 resolve）。
- 正确表述：**旧代码保留写保护但丢弃终态结果；T5 新增的是终态投递通道（`onLateTerminal`）**。在后端层面，「后端收不到响应 → 永不提交清单」成立；在 manager 层面「写保护被永久丢弃」不成立。
- 原「旧代码对照」用例（`worker-bridge.test.ts` 旧 :335-352）是一条**恒真断言**（`received` 数组从未被写入却断言长度为 0）。现已删除并替换为可失败的真对照：
  - 未登记回调时：停滞成立、`stallInfo().requestId` 命中、终态到达后写保护才释放；
  - 新增「迟到终态只投递给登记回调且 requestId 匹配的在途请求」——**未匹配 requestId 的终态不投递且不释放写保护**。
- 注释中明确标注：**旧代码对照为人工核对 HEAD 源码，非自动化红证**。

## 3. 交付与实测

| 项 | 证据 |
|---|---|
| 活动包与协议 | `IndexActivity` / `EmbedOptions` 与计划片段**逐字一致**（归一化比对）；`INDEX_ACTIVITY_STAGES = ['chunk','embed','persist']`；活动序号只在真实完成点递增（`replaceFile` 真实替换、embed 每真实批次、分块），**UI 计时器与 Worker 存活消息不产生活动**；`index.progress` 不再恢复停滞 |
| 跨 Worker | 所有新增 `postMessage` 载荷为纯数据，`AbortSignal` 与回调不入载荷（取消用 `index.cancel` 消息） |
| 停滞 | 停滞只改 `phase`，任务与队列继续持有（`queued > 0`、`canMarkReady === false`）；**`canMarkReady` 与 HEAD 逐字一致**（md5 相同），未另起终态判据 |
| 互斥拆分 | `StoreAccessGate` 的 `commitChain` 使**两个提交不可能重叠**；查询在提交期间等待（不读事务中间状态）；只读车道不穿提交窗口（manager 提交窗口 + Worker 侧车道双端守卫） |
| 取消 | `cancelIndex` 只发 `index.cancel` 消息、**不终止共享 Worker**；写保护保留到真实终态；排队中的只读请求取消后窗口关闭也不派发；`resetRuntime` 让 pending/排队只读/排队独占全部按真实失败结束且无遗留定时器 |
| 卸载与接管 | 旧实例 activity/progress/done **全部不触发回调**；存储保护经 T2 共享协调器交接，在途提交时新实例以 `predecessor-not-closed` 拒绝，结算后新 epoch 接管、旧租约不可写 |
| 隐私 | 诊断只含 id/阶段/序号/数量/时长，**无正文、向量、路径、密钥**；未新增外发目的地 |

修复轮补强（两阶段审查发现，均已带红证）：

- **B1**：只读车道曾可穿过 `replaceFile` **以外**的存储写事务（`deleteByPath`/`upsert`/`delete`/`reload` 未纳入门；`indexDelete` 是多步事务）。现已全部纳入 `StoreAccessGate`，并由请求本身开关提交窗口；补「写事务在途查询不得进入 + 窗口关闭后可进入」正反用例，manager 侧同款对照。
- **B2**：`resetRuntime` 曾不结束**已启动**的独占操作（只 reject 排队项）。现已对已启动操作按真实失败结束调用方等待，且 `busy`/`exclusiveActive` 保留到操作真实结束——**发布前 `worker.postMessage` 一次未被调用**，证明新写请求未与未结束的 `dropIndex` 并行。
- **I1**：只读请求曾泄漏调用方 `AbortSignal` 监听器（结算后残留 1 个）。现已记录 detach 并在派发/结算/取消/重置路径摘除，结算后监听器为 0。
- **I5**：一处 20ms 真实定时器负向断言改为等待正向可观察信号（`persist` 活动先于门等待上报）。
- **I6**：`abortActive` 由死代码改为可观察路径（顺序改为「先撤销在途调用、再停止调度新文件」），并有顺序用例 + `resume()` 正向对照。
- 另修：只读取消同步释放 `readBusy`；提交窗口由提交完成本身关闭；`findPending` 校验 `requestId`、活动序号加上界（`MAX_ACTIVITY_SEQUENCE_JUMP`）；`index-stalled` 等文案改中文（**错误码不变**）；`EmbeddingLocal` 补 `options` 转发（原会静默吞掉取消与批次活动）；`embedding-onnx.ts` 的批次回报与批次边界取消**用真实 ONNX 推理取证**（5 文本 / 批 2 → 3 批 3 次回报；首批回报内 abort → `InferenceSession.run` 恰好只跑 1 次）。

## 4. 测试与检查

- 定向：11 文件 / 171 passed。
- 全量：**291 文件 / 2558 passed / 5 skipped**。
- `tsc`：241 条存量、新增 0。`eslint`：改动源文件 0 error；新增 2 条 `globalThis` warning，与 T2 的 `OwnerClock` 同型（改 `window` 会破坏 Node 侧复用），已接受。`git diff --check` 干净。
- 新增结构性守卫 `tests/adapters/embedding-port-contract.test.ts`：枚举 `EmbeddingPort` 全部实现类、断言第二参保留、逐实现执行转发探针——**将来新增实现类忘记转发 `options` 会直接失败**（临时增加第 5 个实现类的红证已验证）。

## 5. 未接线项（必须有人接，否则 T5 头号机制为零收益）

| 缺口 | 影响 | 归属 |
|---|---|---|
| `onLateTerminal` 无生产调用方（`persistent-index-backend.ts` 的 4 处 `worker.request` 不传 options） | 迟到终态通道无消费者；停滞/取消后真实终态仍不会交回后端更新清单 | **T6**（该文件在 T6 文件表内） |
| `WorkerManager.resetRuntime()` 无生产调用方 | 「永久挂起唯一出口」未接线 | **T7** |
| `WorkerManager.cancelIndex()` 无生产调用方，生产 `worker.request` 均未传 `signal` | 取消路径整体未接线 | **T7**（`signal` 接线可归 T6） |
| `IndexTaskCoordinator.abortActive()` 无生产调用方（`index-manager.ts` 只调 `pause()`） | checkbox 5 的协调器侧取消缺执行路径（顺序已实现并有用例，但无生产入口） | **T7** |
| `IndexStallWatchdog` 无生产构造点；`main.ts` 的 `new WorkerManager(...)` 未传任何 options | 停滞看护、活动桥、onStall/onResume 全部未生效 | **T7** |
| `CoordinatorProcessorPort` 无生产实现 | 协调器整体（T4）尚未接线；`prepareBlocks(input, options?)` 的 options 转发守卫也因无实现而无法写出有意义的断言 | **T7** |
| `WORKER_MANAGER_ERROR_CODES`（`index-stalled`/`index-cancelled`/`runtime-reset`/`request-blocked`/`request-timeout`）无 i18n 映射 | 上屏文案缺失 | **T7** |
| `src/worker/index-processor.ts:197` 以单参调用 `embed(texts)` | 丢失 processor 级 options（经装饰仍能拿到 run signal） | **T7/T6** |
| `vector.upsert`/`vector.delete` 当前无生产调用方 | 将来新增直接写入入口时**必须同步登记进 `WORKER_STORE_WRITE_REQUEST_TYPES`**，否则该写事务不受提交窗口保护 | 长期约束 |

## 6. 裁定

| 项 | 裁定 |
|---|---|
| `resetRuntime` 对已启动独占操作只结束调用方等待、写通道保留到真实结束 | 接受：主线程不可中断的操作无法被取消；若 `dropIndex` 自身永久挂起，唯一出路是 `destroy()` 后重新装配 manager——**T7 必须把这一点写进装配与用户可见处置** |
| B1 路线选「把写路径纳入门」而非「收敛到 `replaceFile`」 | 接受：`indexDelete`（durable 删除凭据）与 `recoverStore/reload` 在不改 `vector-vectra.ts` 的前提下无法收敛，且收敛会改变 T3 的删除语义 |
| B1 证据用「与生产同构的替身 + 真实装饰入口」而非真实 `VectraStore` | 接受并记录限制：真实事务太短，无法在不改 store 的前提下撑开观测窗口；证据为「真实装饰路径 + 1→0 数值复现 + 正向对照」 |
| 2 条 `globalThis` warning | 接受（与 T2 同型先例） |
| 新增红线证据方式（`git archive HEAD` 快照 + 新测试 → 27 failed / 39 passed） | 接受，替代不可逐字节还原的 `git stash` 方案 |