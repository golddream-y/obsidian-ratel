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
| `vector.search` | `vector.search.result` | 向量检索 |
| `vector.upsert` | `vector.upsert.done` | 直接写入向量 |
| `vector.delete` | `vector.delete.done` | 按 docId 删除 |
| `index.status` | `index.status.result` | totalDocs / lastIndexTime |

处理中的进度消息形如：

```typescript
{ type: 'index.progress', payload: { done: 4, total: 10 }, _requestId: 'req_1_…' }
```

WorkerManager 先识别进度，再处理最终响应。仅活动索引请求的整数进度、正总量、未越界且递增的 done 会刷新等待时限并交给展示回调。无 ID、未知请求、已超时请求及倒退的进度被忽略。进度不会解析请求 Promise；只有最终响应才结束等待。

## 串行访问与超时

WorkerManager 的请求和 `runExclusive()` 共用串行通道。排队时间不计超时，任务实际开始后才启动计时。直接访问共享索引的清库操作必须通过 `runExclusive()`；该回调不能递归调用 `request()`，否则会等待自身释放通道。

默认超时为 600000 毫秒。`index.full`、`index.batch`、`index.incremental` 使用活动超时：每次有效进度续期；其他请求使用固定超时。搜索请求也会等待正在进行的索引操作。

| 场景 | 行为 |
|---|---|
| 正常最终响应 | 清计时器、移除 pending、返回响应并释放通道 |
| 请求无进展超时 | 拒绝调用方与排队调用，保留底层占用；新调用立即失败 |
| 超时后的迟到进度 | 忽略，不恢复进度或成功状态 |
| 超时后的迟到终态 | 移除 pending 并解锁；原调用保持失败 |
| Worker error / exit | 管理器关闭并拒绝所有等待；后续调用失败 |
| `destroy()` | 拒绝全部等待并调用 worker.terminate() |

超时不会主动 terminate，因为 InlineWorker 的异步嵌入和写入无法通过拒绝 Promise 中断。旧任务没有终态时，通道保持占用，防止重建或清库与它并行。上层不应在此状态自动清库重试。

## 错误与清理

handler 或入口通过 `{ type: 'error', payload: { code, message }, _requestId }` 返回结构化错误；调用方须检查业务响应类型，不能把收到任意响应视为成功。错误码包含 `NULL_PROCESSOR`、`UNKNOWN_REQUEST`、`WORKER_INIT_FAILED` 和 `WORKER_ERROR`。

卸载由 main 协调 IndexController、WorkerManager 和嵌入 Worker 的清理。InlineWorker terminate 会阻止后续消息和排队处理，并清空监听器；它不会中断已经进入异步调用的代码，不提供异常退出的断点恢复保证。

## 相关模块

- [索引控制器](index-controller.md)：启动、增量、手动重建与状态协调。
- [向量索引](../rag/vector-index.md)：索引与检索操作。
- [持久化](persistence.md)：本地数据职责。
