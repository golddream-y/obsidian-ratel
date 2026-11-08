# S-WEBGPU-EMBEDDING 执行记录

> 1.5 专项：本地向量推理改用 WebGPU，失败回退 WASM。随 [1.5.0](https://github.com/golddream-y/obsidian-ratel/releases/tag/1.5.0) 交付。

## 起点与范围

- 需求来源：索引速度优化。1.4.0 已把索引写入搬出主线程，剩余瓶颈是向量推理本身（WASM 单线程约 0.82–0.85 秒/块）。
- 目标：本机 GPU 可用时优先使用，不可用或失败时回退 CPU，且失败不得影响索引可用性。
- 硬约束：不换模型、不改维度、不改分块参数、不把执行后端写进配置指纹 —— 保证 1.4.0 的索引零重建。

## 根因链（四层，逐层剥开）

| 阶段 | 现象 | 真因 |
|---|---|---|
| 1 | `no available backend found` | esbuild IIFE 抹掉 `import.meta.url`，ORT 拼不出胶水与 wasm 路径，webgpu EP 从未注册 |
| 2 | `Failed to resolve module specifier 'worker_threads'` | 胶水里的 Node 判定在 Obsidian Blob Worker 中误判（`process.type` 是 `worker` 而非 `renderer`） |
| 3 | `c is not a function` | 胶水变体不匹配 |
| 4 | `webgpuInit is not a function` | `ort.webgpu.bundle` 固定按 **asyncify** 变体找胶水，此前喂的是 jsep 版 |

第 4 层是关键：胶水与运行时二进制必须同为 asyncify 变体。

## 实现要点

- **两份 Worker 产物**：`embedding-worker.js`(IIFE + wasm bundle) 与 `embedding-worker-gpu.js`(ESM + webgpu bundle)，同一份源码靠构建期 `define` 区分，都内联进 `main.js`。
- **两个独立 ORT 实例**：同一实例里 WebGPU 尝试失败会污染 `initWasm()`，连回退都不可用；因此 GPU 探测跑在一次性 Worker 里，失败即销毁、换全新 WASM Worker。
- **vendor 固化胶水**：`src/vendor/ort-wasm-simd-threaded.asyncify.mjs`，只改两处 Node 判定；esbuild 用上游 sha256 守卫，依赖升级会立即构建失败。
- **先探能力再决定下载**：`requestAdapter()` 判能力并排除软件适配器，GPU 可用才下 23 MB GPU 运行时，否则完全不碰。
- **探测成功后复用实例**：预热完的 Worker 直接交给代理层，避免初始化两次。

## 实测数据（Apple Silicon / metal-3）

| 填充策略 | 预热(8 块) | 端到端 |
|---|---|---|
| 固定 512 | 5508 ms | 0.64–0.66 秒/块 |
| 按真实长度、8 的倍数对齐 | 618 ms | 0.38–0.43 秒/块 |
| 按真实长度、13 个档位 | 618 ms | 0.38–0.41 秒/块 |

结论：**填充量本身就是主要成本**，固定 512 反而慢 1.6 倍。最终两个后端统一使用档位化填充。

早先一次 0.26 秒/块读数不可复现（同策略另一次测得 0.63），推断与当时库内块普遍偏短及后台同步抢占有关，已从基准剔除，不作为结论依据。

对比 WASM 基线 0.82–0.85 秒/块，净提升约 2.1–2.4 倍。纯推理约 0.10 秒/块。

## 同期收敛的问题

排查过程中发现并修复：

| 问题 | 处理 |
|---|---|
| 模型下载直接写目标文件，中断留下半截文件且被当成已完成 | 统一为「临时文件 + rename」原子落盘 |
| 下载只有单源、无重试 | 抽 `core/asset-downloader`，模型与两份运行时共用多源回退 + 逐源重试 |
| 下载源不考虑国内外网络 | 国内镜像优先（ModelScope / npmmirror），国际源兜底（HuggingFace / jsDelivr）；记住上次成功的源，24 小时内不重复测速 |
| GPU 运行时下载失败会让整个索引不可用 | 降级为可选组件，失败仅本轮走 CPU |
| 主线程提前构建 ONNX 会话（白下 13 MB CPU 运行时） | 改惰性构建，首次真正需要时才加载 |
| 启动时 WebGPU 探测日志打两次 | 删除残留的旧探测代码块 |
| 同一段文本被分词两次 | 复用首轮编码结果 |

## 索引恢复提示（同一分支，非 GPU 相关）

用户报告「重启后索引从 0 开始」。排查结论：**跳过机制一直正常**，三次重启的新增记录与历史路径零重复，是 UI 缺少恢复阶段提示。

过程中修正了四次判据错误，最终方案：

- 进度用「已完成记录总数」作分母，逐篇核对推进
- 提示只作为 **60 秒展示窗口**，不承担「全部核对完」的语义 —— 文件已删/内容已变/反复失败的记录不会产生成功事件，任何「核对数追平总数」的退出条件都会卡在末尾
- 恢复态必须参与进度发布签名，否则窗口到期后 UI 收不到更新

## 交付

- 分支：`feat/index-reliability`（与 `develop` / `main` 同步）
- 版本：1.5.0
- 遗留：非推理开销（分块 / 提交 / IPC）约占端到端 75%，未优化，留待 2.0 大批量场景

## 相关文档

- 现役架构：[嵌入推理的分层执行](../../../architecture/llm/embedding-inference.md)、[运行时资产下载](../../../architecture/host/asset-downloads.md)
- 决策记录：[ADR-006 商店发版资产分发](../../../adr/2026-06-28-release-asset-distribution.md)
