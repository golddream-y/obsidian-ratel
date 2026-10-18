# Worker 目录约束

本文件作用于 `src/worker/`。读取当前文件职责后再判断限制，不能把所有名字带 Worker 的模块当成相同执行环境。

- 本目录不导入 `obsidian`，宿主操作由主线程外观处理。
- `index.ts`、`inline-worker.ts` 等索引调度当前通过 InlineWorker 在主线程模拟；vectra 文件 IO、分块仍在主线程，不能据此宣称 UI 零负担。InlineWorker 不发 HTTP。
- `embedding-worker.ts` 在浏览器 Web Worker 中执行 ONNX/WASM 推理，不使用 Node API、`node:fs`、`node:path`，不发 HTTP；资源准备由主线程负责。
- 主线程通过 `EmbeddingWorkerProxy` 和消息协议调用嵌入线程，保持 requestId 对应、超时、异常和清理语义。
- `IndexProcessor` 一次提交需要处理的文本批次，由嵌入适配器继续分批，不逐 chunk 调用嵌入服务；批次上限以实现配置为准。
- 新协议、消息字段、线程迁移或构建产物变化，必须评估架构文档和兼容影响，不能只改发送方。
- `skill-script-worker.ts` 使用具备 Node 能力的技能脚本沙箱环境（测试/本地使用 worker_threads，Obsidian 使用 Electron Worker）；不能把其能力套用于纯浏览器 Embedding Web Worker。
