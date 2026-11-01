# Worker 通信协议

维护索引通信或排查超时、重复索引时，可据此判断请求何时完成、共享索引的占用何时释放。

主线程通过 `WorkerManager` 关联请求、进度与最终响应，并协调共享索引的访问。当前 Obsidian 使用 `InlineWorker` 在主线程调度分块与 Vectra IO；本地 ONNX 推理由独立的 Embedding Web Worker 执行。InlineWorker 不代表这些索引工作全部移出了主线程。

## 职责与执行边界

索引协议由 `src/types.ts` 的 `WorkerRequest` / `WorkerResponse` 定义，`handler.ts` 委托 `IndexProcessor` 操作索引。索引处理代码不导入 `obsidian`，也不直接发 HTTP；宿主读取笔记、准备资源并注入嵌入端口。具体环境限制以 `src/worker/AGENTS.md` 为准。

`InlineWorker` 与 `worker/index.ts` 入口均串行调用 handler，避免多个异步请求重叠访问同一处理器。当前产品使用 InlineWorker；Worker Threads 的 bootstrap 尚未实现嵌入注入，不能作为可用后台模式。

## 消息与请求关联

所有请求由 WorkerManager 注入 `_requestId`，最终响应和该请求产生的 `index.progress` 均回传同一 ID。该字段位于消息顶层，由传输封装附加；业务消息仍通过 `type` 判别联合收窄。

| 请求 | 最终响应 | 内容 |
|---|---|---|
| `index.full` | `index.done` | 全量文件列表、可选 `chunkOptions`；返回 indexed / errors |
| `index.incremental` | `index.done` | 单文件与可选 `chunkOptions`；返回 indexed / errors 及可选 chunkCount |
| `index.batch` | `index.batch.done` | 差异文件批处理；返回 indexed / errors / chunkCounts |
| `index.delete` | `vector.delete.done` | 按文件路径删除；返回 count |
| `index.cancel` | `index.cancel.done` | 取消单项索引任务；回执仅作诊断 |
| `vector.search` | `vector.search.result` | 向量检索 |
| `vector.upsert` | `vector.upsert.done` | 直接写入向量 |
| `vector.delete` | `vector.delete.done` | 按 docId 删除 |
| `index.status` | `index.status.result` | totalDocs / lastIndexTime |

处理中的进度消息形如：

```typescript
{ type: 'index.progress', payload: { done: 4, total: 10 }, _requestId: 'req_1_…' }
```

WorkerManager 先识别进度，再处理最终响应。仅活动索引请求的整数进度、正总量、未越界且递增的 done 会刷新等待时限并交给展示回调。无 ID、未知请求、已超时请求及倒退的进度被忽略。进度不会解析请求 Promise；只有最终响应才结束等待。

## 活动包与停滞判定

真正反映「任务在推进」的信号是**活动包** `IndexActivity`，而不是 UI 计时器或 Worker 存活消息：

```typescript
export interface IndexActivity {
  taskId: string;
  requestId: string;
  epoch: number;
  sequence: number;
  stage: 'chunk' | 'embed' | 'persist';
  completedUnits: number;
}
```

- `sequence` 单调递增，只在**真实完成的批次 / IO 步骤**产生（分块批次、每个真实嵌入批次、`replaceFile` 真实替换）。`index.progress` 不再恢复停滞状态。
- 活动序号有上界跳变校验；不匹配 `requestId` 或超出允许跳变的活动被忽略。
- 索引看护（`IndexStallWatchdog`）按最新活动与阈值判定停滞；停滞只更新阶段，**任务与队列继续持有**，写保护不释放。
- 恢复需要真实的新活动，或显式的运行时重置；恢复后阶段改回处理中并继续核对。

## 迟到终态与取消

调用方的等待可能因停滞或取消先结束，但**真实终态仍必须交付**，否则后端的提交路径会被丢弃：

- `onLateTerminal` 是调用方登记的迟到终态通道。终态到达时按 `requestId` 匹配在途请求：匹配则交付该回调，不匹配则既不交付也不释放写保护。
- `cancelIndex({ requestId, taskId, epoch, reason })` 只发送 `index.cancel` 消息，**不终止共享 Worker**；写保护保留到真实终态到达。
- 只读请求的取消信号在派发、结算、取消与重置各路径都会被摘除，不泄漏调用方监听器。
- `resetRuntime()` 是「写操作永久挂起」的唯一出口：结束所有受影响调用的等待，让运行时回到可用状态；已启动且无法中断的操作（如清库）保留写通道到真实结束，不与其后的写请求并行。
- `destroy()` 拒绝全部等待并调用 `worker.terminate()`。

## 串行访问与提交窗口

WorkerManager 的请求和 `runExclusive()` 共用串行通道。排队时间不计超时，任务实际开始后才启动计时。直接访问共享索引的清库操作必须通过 `runExclusive()`；该回调不能递归调用 `request()`，否则会等待自身释放通道。

- **读写车道:** 只读请求与写事务分离。`StoreAccessGate` 的提交链保证两个提交不可能重叠；查询在提交窗口内等待，不读事务中间状态。
- **提交窗口:** 由请求本身开闭。写事务（`replaceFile`、`deleteByPath`、`upsert`、`delete`、`reload`、`index.delete`）在途时，只读请求不得进入；窗口关闭后恢复。新增直接写入入口必须同步登记进写事务类型集合，否则该写事务不受提交窗口保护。
- **过期重排:** 只读请求排队期间若提交窗口开闭，取消中的排队只读请求在窗口关闭后也不再派发。

默认超时为 600000 毫秒。`index.full`、`index.batch`、`index.incremental` 使用活动超时：每次有效进度续期；其他请求使用固定超时。搜索请求也会等待正在进行的索引操作。

| 场景 | 行为 |
|---|---|
| 正常最终响应 | 清计时器、移除 pending、返回响应并释放通道 |
| 请求无进展超时 | 拒绝调用方与排队调用，保留底层占用；新调用立即失败 |
| 超时后的迟到进度 | 忽略，不恢复进度或成功状态 |
| 超时后的迟到终态 | 经 `onLateTerminal` 交付已登记的调用方，随后移除 pending 并解锁 |
| Worker error / exit | 管理器关闭并拒绝所有等待；后续调用失败 |
| `destroy()` | 拒绝全部等待并调用 worker.terminate() |

超时不会主动 terminate，因为 InlineWorker 的异步嵌入和写入无法通过拒绝 Promise 中断。旧任务没有终态时，通道保持占用，防止重建或清库与它并行。上层不应在此状态自动清库重试；永久挂起的唯一处置是用户显式恢复（重置运行时）或重载。

## epoch 校验

写所有权以 **epoch** 标识本次实例的提交权。每次实例接管产生新 epoch，旧 epoch 不能再开始提交；请求携带的 `epoch` 与当前实例不符时被拒绝，因此旧实例的迟到活动与终态不污染新实例。跨 renderer 的写所有权经共享协调器交接：旧实例未关闭时新实例以「前驱未结算」拒绝，结算完成后新 epoch 接管、旧租约不可写。

## 错误与清理

handler 或入口通过 `{ type: 'error', payload: { code, message }, _requestId }` 返回结构化错误；调用方须检查业务响应类型，不能把收到任意响应视为成功。错误码包含 `NULL_PROCESSOR`、`UNKNOWN_REQUEST`、`WORKER_INIT_FAILED`、`WORKER_ERROR`，以及索引看护的 `index-stalled`、`index-cancelled`、`runtime-reset`、`request-blocked`、`request-timeout`。

`NULL_PROCESSOR` 表示共享检索处理器尚未初始化。`main.startIndexRound` 在启动与重试时统一调用 `InlineWorker.initWithStore`：API 模式绑定当前嵌入端口，本地模式在代理预热完成后绑定代理；两者均复用已装配的存储。只读模式使用 `autoInit:false`，接线本身不初始化磁盘索引；无可用代际时跳过接线。历史上只在本地分支接线导致 API 模式返回空结果的问题，取证见 [T7 证据](../../superpowers/plans/2026-10-31-index-reliability-t7-evidence.md)。

卸载由 main 协调 IndexController、WorkerManager 和嵌入 Worker 的清理。InlineWorker terminate 会阻止后续消息和排队处理，并清空监听器；它不会中断已经进入异步调用的代码。

## 诊断边界

索引活动与停滞诊断只包含 id、阶段、序号、数量与时长，不含笔记正文、向量、路径或密钥；本次交付未新增任何外发目的地。

## 相关模块

- [索引控制器](index-controller.md)：启动、增量、手动重建与状态协调。
- [向量索引](../rag/vector-index.md)：索引与检索操作。
- [持久化](persistence.md)：本地数据职责。
